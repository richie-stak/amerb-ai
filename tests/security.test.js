// Regression tests for the production-hardening pass: the critical privilege-escalation path that was
// removed, the login-lockout race, account enumeration, password policy, security headers, the
// cross-site request guard, upload type neutralisation, error hygiene, audited backups, and the SSRF
// range check.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');

let server;
let admin;
let bootstrapServer;

async function signup(client, username, password = 'password12345', department = 'Credit') {
  const res = await client.post('/api/auth/signup', {
    username,
    email: `${username}@amenfimanbank.com`,
    password,
    department,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

before(async () => {
  server = await startTestServer({ env: { BOOTSTRAP_ADMIN_EMAIL: 'first.admin@amenfimanbank.com' } });
  admin = makeClient(server.baseUrl);
  const created = await signup(admin, 'first.admin');
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.user.role, 'admin', 'the bootstrap address becomes the first administrator');
});

after(async () => {
  for (const s of [server, bootstrapServer].filter(Boolean)) {
    try {
      await s.stop();
    } catch (err) {
      console.error('cleanup failed:', err.message);
    }
  }
});

// ---------- Privilege escalation (the critical finding) ----------

test('the reserved username "admin" cannot be registered, and never becomes an administrator', async () => {
  const attacker = makeClient(server.baseUrl);
  const res = await signup(attacker, 'admin');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /reserved/i);

  // Also try a legacy-looking account: a restart must not promote it (that rule was removed).
  const legacy = makeClient(server.baseUrl);
  const made = await signup(legacy, 'legacyadmin');
  assert.equal(made.status, 200);
  assert.equal(made.body.user.role, 'user');
  await server.restart();
  const me = await (await legacy.get('/api/auth/me')).json();
  assert.equal(me.user.role, 'user', 'a restart must not promote an existing account');
});

test('the first administrator is only ever created by the bootstrap address', async () => {
  const other = makeClient(server.baseUrl);
  const res = await signup(other, 'notbootstrap');
  assert.equal(res.body.user.role, 'user');

  // A second server with the same bootstrap address already taken in a fresh database: the address is
  // the switch, not the username.
  bootstrapServer = await startTestServer({ env: { BOOTSTRAP_ADMIN_EMAIL: 'boss@amenfimanbank.com' } });
  const boss = makeClient(bootstrapServer.baseUrl);
  const first = await boss.post('/api/auth/signup', {
    username: 'boss',
    email: 'boss@amenfimanbank.com',
    password: 'password12345',
    department: 'IT',
  });
  assert.equal((await first.json()).user.role, 'admin');
  const second = makeClient(bootstrapServer.baseUrl);
  const other2 = await second.post('/api/auth/signup', {
    username: 'deputy',
    email: 'deputy@amenfimanbank.com',
    password: 'password12345',
    department: 'IT',
  });
  assert.equal((await other2.json()).user.role, 'user');
});

// ---------- Login lockout and enumeration ----------

test('parallel wrong passwords still trigger the lockout', async () => {
  const victim = makeClient(server.baseUrl);
  assert.equal((await signup(victim, 'lockrace')).status, 200);

  // The old read-modify-write let concurrent guesses all count as "1". Fired at once, they must now
  // add up and lock the account. One retry covers a machine so busy that a burst request times out: the
  // property being tested is that simultaneous failures accumulate, not that this hardware is fast.
  const burst = async () => {
    const attempts = [];
    for (let i = 0; i < 10; i++) {
      attempts.push(makeClient(server.baseUrl).post('/api/auth/login', { identifier: 'lockrace', password: 'wrongpassword' }));
    }
    return Promise.all(attempts);
  };
  let results = await burst();
  const readState = () => {
    const db = server.openDb();
    const row = db.prepare('SELECT failed_login_count, locked_until FROM users WHERE username = ?').get('lockrace');
    db.close();
    return row;
  };
  if (!readState().locked_until) results = results.concat(await burst());
  assert.ok(results.every((r) => r.status === 401), 'every failure looks the same to the caller');

  const row = readState();
  assert.ok(row.failed_login_count >= 5, `failures are counted (got ${row.failed_login_count})`);
  assert.ok(row.locked_until, 'the account is locked');

  const right = await makeClient(server.baseUrl).post('/api/auth/login', { identifier: 'lockrace', password: 'password12345' });
  assert.equal(right.status, 401, 'the correct password is refused while locked');
});

test('an unknown account and a wrong password are indistinguishable', async () => {
  const client = makeClient(server.baseUrl);
  await signup(client, 'timinguser');

  const known = await client.post('/api/auth/login', { identifier: 'timinguser', password: 'definitely-wrong' });
  const unknown = await client.post('/api/auth/login', { identifier: 'nobody-at-all', password: 'definitely-wrong' });
  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await known.json(), await unknown.json(), 'the same body, not just the same status');
});

// ---------- Password policy ----------

test('passwords must be at least 12 characters, at signup and when changing one', async () => {
  const short = makeClient(server.baseUrl);
  const res = await short.post('/api/auth/signup', {
    username: 'shortpass',
    email: 'shortpass@amenfimanbank.com',
    password: 'elevenchars',
    department: 'Credit',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /12 characters/);

  const user = makeClient(server.baseUrl);
  assert.equal((await signup(user, 'policyuser')).status, 200);
  const change = await user.patch('/api/auth/me/password', { currentPassword: 'password12345', newPassword: 'short' });
  assert.equal(change.status, 400);
});

test('changing your own password signs out other sessions but keeps this one', async () => {
  const laptop = makeClient(server.baseUrl);
  const phone = makeClient(server.baseUrl);
  assert.equal((await signup(laptop, 'devices')).status, 200);
  // A second session for the same person (e.g. a shared PC left signed in).
  await phone.post('/api/auth/login', { identifier: 'devices', password: 'password12345' });
  assert.equal((await (await phone.get('/api/auth/me')).json()).user.username, 'devices');

  const changed = await laptop.patch('/api/auth/me/password', { currentPassword: 'password12345', newPassword: 'brandnewpassword1' });
  assert.equal(changed.status, 200);

  assert.equal((await phone.get('/api/auth/me')).status, 401, 'the other session is signed out');
  assert.equal((await laptop.get('/api/auth/me')).status, 200, 'the session that changed it stays signed in');
});

// ---------- Transport and headers ----------

test('every response carries the security headers', async () => {
  const res = await makeClient(server.baseUrl).get('/api/session');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'sha256-/, 'inline scripts are allowed by hash, not by unsafe-inline');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(res.headers.get('x-powered-by'), null, 'no version banner');
  assert.equal(res.headers.get('cache-control'), 'no-store', 'API responses are never cached');
});

test('a state-changing request from another site is refused', async () => {
  const client = makeClient(server.baseUrl);
  await signup(client, 'csrfuser');
  const cookie = client.getCookie();

  const evil = await fetch(`${server.baseUrl}/api/auth/me/language`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example', cookie },
    body: JSON.stringify({ language: 'en' }),
  });
  assert.equal(evil.status, 403);

  const fine = await fetch(`${server.baseUrl}/api/auth/me/language`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Origin': server.baseUrl, cookie },
    body: JSON.stringify({ language: 'en' }),
  });
  assert.equal(fine.status, 200);
});

test('an unknown API path answers in JSON, not with the app page', async () => {
  const res = await makeClient(server.baseUrl).get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

// ---------- Uploads ----------

test('an uploaded file is served with the type the app decided, never the uploader’s claim', async () => {
  const staff = makeClient(server.baseUrl);
  assert.equal((await signup(staff, 'uploader')).status, 200);

  // A real PDF, uploaded with a part header that claims something else entirely — the exact shape of
  // the report's stored-XSS finding: a "PDF" served back as text/html from the app's own origin.
  const PDFDocument = require('pdfkit');
  const pdf = await new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.text('Holiday policy: 20 days per year.');
    doc.end();
  });
  const res = await staff.upload('/api/documents', [{ name: 'policy.pdf', content: pdf }], { scope: 'personal' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const id = body.results[0].id;
  assert.ok(id, JSON.stringify(body));

  const file = await staff.get(`/api/documents/${id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf', 'served as a PDF, not as HTML');
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.match(file.headers.get('x-frame-options') || '', /SAMEORIGIN/);
  assert.match(file.headers.get('content-disposition'), /inline; filename=/);
  assert.ok((await file.arrayBuffer()).byteLength > 100);
});

test('a text file can never be served as javascript', async () => {
  const staff = makeClient(server.baseUrl);
  assert.equal((await signup(staff, 'jsuploader')).status, 200);
  const res = await staff.upload('/api/documents', [{ name: 'payload.txt', content: 'alert(document.domain)' }], {});
  const id = (await res.json()).results[0].id;
  const file = await staff.get(`/api/documents/${id}/file`);
  assert.equal(file.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(file.headers.get('content-disposition'), /^attachment/);
});

test('uploading too much at once is a clear client error, not a 500', async () => {
  const staff = makeClient(server.baseUrl);
  assert.equal((await signup(staff, 'biguploader')).status, 200);
  const big = 'x'.repeat(21 * 1024 * 1024);
  const res = await staff.upload('/api/documents', [{ name: 'huge.txt', content: big }], {});
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/i);
});

// ---------- Audit and SSRF ----------

test('downloading the whole database is recorded in the audit log', async () => {
  const res = await admin.get('/api/admin/backup');
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  const { rows } = await (await admin.get('/api/admin/audit?action=admin.backup_downloaded')).json();
  assert.ok(rows.length >= 1, 'the snapshot download is audited');
});

test('internal addresses cannot be reached through the web tools', () => {
  process.env.AMERB_DB_PATH = server.dbPath;
  const { isPrivateOrReservedIp } = require('../server/tools');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '198.18.0.1', '224.0.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.5']) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPrivateOrReservedIp(ip), false, ip);
  }
});

test('the CSP hashes follow a page after it is edited, so a static change cannot lock the browser out', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { contentSecurityPolicy } = require('../server/security');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amerb-csp-'));
  const page = path.join(dir, 'page.html');
  const hashOf = (script) => crypto.createHash('sha256').update(script, 'utf8').digest('base64');
  try {
    const firstScript = "console.log('first version');";
    fs.writeFileSync(page, `<html><body><script>${firstScript}</script></body></html>`);
    const firstPolicy = contentSecurityPolicy(dir);
    assert.ok(firstPolicy.includes(`sha256-${hashOf(firstScript)}`), 'the page as it is on disk is allowed');

    // Simulate editing the page while the server is running (this is what the sign-in prefill change was).
    const secondScript = "console.log('second version');";
    fs.writeFileSync(page, `<html><body><script>${secondScript}</script></body></html>`);
    const secondPolicy = contentSecurityPolicy(dir);
    assert.ok(secondPolicy.includes(`sha256-${hashOf(secondScript)}`), 'the edited page is allowed without a restart');
    assert.ok(!secondPolicy.includes(`sha256-${hashOf(firstScript)}`), 'the stale script is no longer allowed');
    assert.match(secondPolicy, /script-src 'self' 'sha256-/, 'still strict: hashes, not unsafe-inline');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(secondPolicy));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The audit log records sign-ins (good and bad), questions asked, document activity and admin
// changes; never records passwords or keys; is admin-only; and exports to a CSV that's safe to
// open in Excel.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');

let server;
let admin;
let staff;
const ids = {};

async function audit(query = '') {
  const res = await admin.get(`/api/admin/audit${query}`);
  return (await res.json()).rows;
}

before(async () => {
  server = await startTestServer();
  admin = makeClient(server.baseUrl);
  staff = makeClient(server.baseUrl);
  const signup = async (client, username) =>
    (await (await client.post('/api/auth/signup', {
      username,
      email: `${username}@amenfimanbank.com`,
      password: 'password123',
      department: 'Credit',
    })).json()).user;
  ids.admin = (await signup(admin, 'auditadmin')).id;
  ids.staff = (await signup(staff, 'auditstaff')).id;
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ids.admin);
  db.close();
});

after(async () => {
  await server.stop();
});

test('staff cannot read or export the audit log', async () => {
  assert.equal((await staff.get('/api/admin/audit')).status, 403);
  assert.equal((await staff.get('/api/admin/audit/export.csv')).status, 403);
});

test('sign-ups, failed sign-ins and sign-ins are recorded', async () => {
  const outsider = makeClient(server.baseUrl);
  await outsider.post('/api/auth/login', { identifier: 'auditstaff', password: 'wrong-password' });
  await outsider.post('/api/auth/login', { identifier: 'nobody-here', password: 'whatever1' });
  await outsider.post('/api/auth/login', { identifier: 'auditstaff', password: 'password123' });

  const rows = await audit('?action=auth');
  const actions = rows.map((r) => `${r.action}:${r.username || r.details.identifier}`);
  assert.ok(actions.includes('auth.signup:auditstaff'));
  assert.ok(actions.includes('auth.login_failed:auditstaff'));
  assert.ok(actions.includes('auth.login_failed:nobody-here'), 'attempts on unknown accounts are kept too');
  assert.ok(actions.includes('auth.login:auditstaff'));
  const wrong = rows.find((r) => r.action === 'auth.login_failed' && r.username === 'auditstaff');
  assert.equal(wrong.details.reason, 'wrong password');
  assert.equal(wrong.department, 'Credit');
  assert.ok(wrong.ip, 'the IP address is recorded');
});

test('questions asked in chat are recorded with the model used', async () => {
  // The model doesn't exist, so the reply fails — the question is still on record.
  await (await staff.post('/api/chat/stream', { model: 'no-such-model', content: 'What is our SME loan limit?' })).text();
  const [row] = await audit('?action=chat');
  assert.equal(row.username, 'auditstaff');
  assert.equal(row.details.question, 'What is our SME loan limit?');
  assert.equal(row.details.model, 'no-such-model');
  assert.equal(row.details.external, false);
});

test('document uploads and deletions are recorded', async () => {
  const up = await staff.upload('/api/documents', [{ name: 'credit-notes.txt', content: 'Notes about credit' }], { scope: 'department' });
  const docId = (await up.json()).results[0].id;
  await staff.delete(`/api/documents/${docId}`);
  const rows = await audit('?action=document');
  const upload = rows.find((r) => r.action === 'document.upload');
  assert.deepEqual(upload.details.files, ['credit-notes.txt']);
  assert.equal(upload.details.department, 'Credit');
  assert.equal(rows.find((r) => r.action === 'document.delete').details.filename, 'credit-notes.txt');
});

test('admin changes are recorded, and passwords never are', async () => {
  await admin.patch(`/api/admin/users/${ids.staff}`, { department: 'Loans' });
  await admin.post(`/api/admin/users/${ids.staff}/reset-password`);
  await admin.post('/api/admin/providers', { type: 'custom', apiKey: 'sk-should-never-be-logged', baseUrl: 'http://127.0.0.1:9/v1' });

  const rows = await audit('?action=admin');
  assert.ok(rows.some((r) => r.details.path === `/api/admin/users/${ids.staff}` && r.details.body.department === 'Loans'));
  assert.ok(rows.some((r) => r.details.path === `/api/admin/users/${ids.staff}/reset-password`));
  const everything = JSON.stringify(await audit('?limit=1000'));
  assert.ok(!everything.includes('password123'), 'no password in the log');
  assert.ok(!everything.includes('sk-should-never-be-logged'), 'no API key in the log');
});

test('the CSV export neutralises spreadsheet formulas', async () => {
  const sneaky = makeClient(server.baseUrl);
  await sneaky.post('/api/auth/login', { identifier: '=HYPERLINK("http://evil.example")', password: 'x' });
  const res = await admin.get('/api/admin/audit/export.csv?action=auth');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.ok(csv.includes('Time (UTC),User,Department,Action,Details,IP address'));
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv), 'a cell must never start with =');
});

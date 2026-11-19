// Knowledge base folders and the policy → approved-websites fallback.
//
//  - The three knowledge bases (bank-wide policies, department, personal) are kept in separate
//    folders under data/knowledge/ beside the database, in step with the database, while the app
//    keeps enforcing the same access rules.
//  - When none of them answers a policy question, AMERB AI searches only the websites an admin has
//    approved, and the reply says so.
//
// Everything here runs against a stand-in Ollama and a stand-in search page, so no model is needed
// and the test suite never touches the internet.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer, makeClient } = require('./helpers/testServer');
const { startMockOllama } = require('./helpers/mockOllama');

let server;
let ollama;
let search;
let admin;

// A DuckDuckGo-shaped results page, which is all tools.webSearch parses.
function startMockSearch() {
  const state = { requests: [], results: [], fail: false };
  const page = () =>
    `<!doctype html><html><body>${state.results
      .map(
        (r, i) =>
          `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}">${r.title}</a>` +
          `<a class="result__snippet" href="#">${r.snippet || `Snippet ${i + 1}`}</a>`
      )
      .join('\n')}</body></html>`;
  const httpServer = http.createServer((req, res) => {
    state.requests.push({ url: req.url });
    if (state.fail) {
      res.writeHead(500);
      return res.end('search is down');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(page());
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${httpServer.address().port}/html/`,
        state,
        stop: () =>
          new Promise((done) => {
            // The app keeps a keep-alive connection to the search page, so close those first or the
            // test run never finishes.
            httpServer.closeAllConnections?.();
            httpServer.close(done);
          }),
      });
    });
  });
}

const folderRoot = () => path.join(path.dirname(server.dbPath), 'knowledge');
const listFolder = (folder) => {
  try {
    return fs.readdirSync(path.join(folderRoot(), folder));
  } catch {
    return [];
  }
};

function parseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: /^data: (.*)$/m.exec(block)?.[1] }))
    .filter((e) => e.event)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}

async function signup(username, department = 'Credit') {
  const client = makeClient(server.baseUrl);
  const res = await client.post('/api/auth/signup', {
    username,
    email: `${username}@amenfimanbank.com`,
    password: 'password123',
    department,
  });
  assert.equal(res.status, 200, await res.clone().text());
  return client;
}

async function upload(client, name, content, fields = {}) {
  const res = await client.upload('/api/documents', [{ name, content }], fields);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const result = body.results[0];
  assert.ok(result.id, JSON.stringify(result));
  return result.id;
}

async function chat(client, content, model = 'good:latest') {
  const before = ollama.state.requests.length;
  const res = await client.post('/api/chat/stream', { model, content });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return { events: parseEvents(text), requests: ollama.state.requests.slice(before) };
}

const eventsOf = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);

before(async () => {
  search = await startMockSearch();
  ollama = await startMockOllama({ models: ['good'] });
  server = await startTestServer({
    env: {
      OLLAMA_URL: ollama.url,
      DEFAULT_MODEL: 'good',
      AMERB_SEARCH_URL: search.url,
      AMERB_DEFAULT_FALLBACK: 'off',
    },
  });
  admin = await signup('kbadmin', 'IT');
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'kbadmin'").run();
  db.close();
});

after(async () => {
  // Stop the stand-in services first: if the cleanup below ever throws, their listening sockets must
  // not be what keeps the test run from finishing.
  const stops = [() => ollama.stop(), () => search.stop(), () => server.stop()];
  for (const stop of stops) {
    try {
      await stop();
    } catch (err) {
      console.error('cleanup failed:', err.message);
    }
  }
});

// ---------- 1. Three folders ----------

test('each knowledge base gets its own folder on disk, with the file in it', async () => {
  const policyId = await upload(admin, 'credit-policy.txt', 'The SME loan limit is GHS 200,000.', { scope: 'global' });
  const staff = await signup('kbstaff', 'Credit');
  const deptId = await upload(staff, 'credit-notes.txt', 'Department credit notes.', { scope: 'department' });
  const personalId = await upload(staff, 'my-notes.txt', 'My own notes.', {});

  const bank = listFolder('Bank-wide');
  const credit = listFolder('Department - Credit');
  const personal = listFolder('Personal - kbstaff');
  assert.ok(bank.some((f) => f.startsWith(`${policyId} - `)), `bank-wide folder: ${bank}`);
  assert.ok(credit.some((f) => f.startsWith(`${deptId} - `)), `department folder: ${credit}`);
  assert.ok(personal.some((f) => f.startsWith(`${personalId} - `)), `personal folder: ${personal}`);

  // The copy is the file itself, not a summary.
  const written = fs.readFileSync(path.join(folderRoot(), 'Bank-wide', bank.find((f) => f.startsWith(`${policyId} - `))), 'utf8');
  assert.equal(written, 'The SME loan limit is GHS 200,000.');

  // And the API says which folder each document is in.
  const { documents } = await (await admin.get('/api/documents?all=1')).json();
  const byScope = (scope) => documents.find((d) => d.scope === scope && d.folder)?.folder;
  assert.equal(byScope('global'), 'Bank-wide');
  assert.equal(byScope('department'), 'Department - Credit');
  assert.equal(byScope('personal'), 'Personal - kbstaff');
});

test('only an admin can put a document in the bank-wide policies folder', async () => {
  const staff = await signup('kbstaff2', 'HR');
  const res = await staff.upload('/api/documents', [{ name: 'fake-policy.txt', content: 'x' }], { scope: 'global' });
  assert.equal(res.status, 403);
  assert.deepEqual(listFolder('Bank-wide').filter((f) => f.includes('fake-policy')), []);
});

test('a file that moves between knowledge bases moves between folders', async () => {
  const staff = await signup('kbmover', 'Loans');
  const id = await upload(staff, 'shared.txt', 'Loan recovery notes.', {});
  assert.ok(listFolder('Personal - kbmover').some((f) => f.startsWith(`${id} - `)));

  assert.equal((await staff.patch(`/api/documents/${id}/share`, { scope: 'department' })).status, 200);
  assert.ok(listFolder('Department - Loans').some((f) => f.startsWith(`${id} - `)));
  assert.ok(!listFolder('Personal - kbmover').some((f) => f.startsWith(`${id} - `)), 'the old copy is gone');

  assert.equal((await admin.patch(`/api/documents/${id}/share`, { scope: 'global' })).status, 200);
  assert.ok(listFolder('Bank-wide').some((f) => f.startsWith(`${id} - `)));
  assert.ok(!listFolder('Department - Loans').some((f) => f.startsWith(`${id} - `)));
});

test('deleting a document removes its copy', async () => {
  const id = await upload(admin, 'temporary-policy.txt', 'Temporary.', { scope: 'global' });
  const name = listFolder('Bank-wide').find((f) => f.startsWith(`${id} - `));
  assert.ok(name);
  assert.equal((await admin.delete(`/api/documents/${id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(folderRoot(), 'Bank-wide', name)));
});

// Runs the folder reconcile in its own process, exactly the way the server does at startup. Doing it
// in this test process would open the test database here as well, which stops the temporary files
// being cleaned up afterwards.
function runSync() {
  const script = `
    const k = require(${JSON.stringify('C:/Claude Projects/Amerb AI/server/knowledgeFolders')});
    process.stdout.write(JSON.stringify(k.sync()));
  `;
  const output = require('node:child_process').execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, AMERB_DB_PATH: server.dbPath, LOG_DIR: server.logDir },
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

test('the folders are repaired from the database: missing copies come back, strays go', async () => {
  const id = await upload(admin, 'restore-me.txt', 'Restored from the database.', { scope: 'global' });
  const name = listFolder('Bank-wide').find((f) => f.startsWith(`${id} - `));
  fs.rmSync(path.join(folderRoot(), 'Bank-wide', name)); // deleted by hand in Explorer
  fs.writeFileSync(path.join(folderRoot(), 'Bank-wide', 'copied-in-by-hand.txt'), 'not in the app');

  const result = runSync();
  assert.ok(fs.existsSync(path.join(folderRoot(), 'Bank-wide', name)), 'the missing copy is restored');
  assert.ok(!fs.existsSync(path.join(folderRoot(), 'Bank-wide', 'copied-in-by-hand.txt')), 'a file not in the app is removed');
  assert.ok(result.removed >= 1);

  // A folder left empty is cleaned up too, so the tree matches the three bases that are in use.
  fs.mkdirSync(path.join(folderRoot(), 'Department - Empty'), { recursive: true });
  runSync();
  assert.ok(!fs.existsSync(path.join(folderRoot(), 'Department - Empty')));
});

// ---------- 2. Querying the bank-wide policies ----------

test('staff can query the bank-wide policies, and the answer cites the policy', async () => {
  await upload(admin, 'savings-policy.txt', 'The minimum balance for a savings account is GHS 50.00 and the interest rate is 5 percent per year.', {
    scope: 'global',
  });
  const staff = await signup('kbquery', 'Customer Service');
  const { events, requests } = await chat(staff, 'What is the interest rate on a savings account?');
  const meta = events.find((e) => e.event === 'meta').data;
  assert.ok(meta.citations.some((c) => c.filename === 'savings-policy.txt'), JSON.stringify(meta.citations));
  const answer = [...requests].reverse().find((r) => !r.isTitle);
  assert.match(answer.system, /minimum balance for a savings account is GHS 50\.00/);
  // The bank's own document answered, so the approved websites were not searched.
  search.state.requests.length = 0;
  await chat(staff, 'What is the minimum balance for a savings account?');
  assert.equal(eventsOf(events, 'policy-web-search').length, 0);
});

// ---------- 3. The approved-websites fallback ----------

test('when the policies have no answer, only the approved websites are searched and the reply says so', async () => {
  // An admin approves one website. Nothing in the knowledge base mentions this.
  assert.equal((await admin.post('/api/admin/domains', { domain: 'bog.gov.gh' })).status, 200);
  search.state.requests.length = 0;
  search.state.results = [
    { title: 'Bank of Ghana — capital requirements', url: 'https://bog.gov.gh/capital-requirements', snippet: 'Minimum paid-up capital requirements.' },
    { title: 'Bank of Ghana — notice 12', url: 'https://bog.gov.gh/notice-12', snippet: 'A notice about capital.' },
  ];

  const staff = await signup('kbfallback', 'Compliance & Risk');
  const { events, requests } = await chat(staff, 'What are the current capital requirement rules for rural banks?');

  const fallback = eventsOf(events, 'policy-web-search')[0];
  assert.ok(fallback, `expected a policy-web-search event, got ${events.map((e) => e.event).join(',')}`);
  assert.deepEqual(fallback.sites, ['bog.gov.gh']);
  assert.equal(fallback.results.length, 2);
  assert.equal(fallback.results[0].url, 'https://bog.gov.gh/capital-requirements');
  assert.equal(fallback.error, undefined);

  // The search was restricted to the approved domain, never the open web.
  const sentQuery = decodeURIComponent(search.state.requests[0].url);
  assert.match(sentQuery, /site:bog\.gov\.gh/);
  assert.match(sentQuery, /capital requirement/);

  // The model was told where the answer came from and to cite the URL.
  const answer = [...requests].reverse().find((r) => !r.isTitle);
  assert.match(answer.system, /websites the bank has approved \(bog\.gov\.gh\)/);
  assert.match(answer.system, /https:\/\/bog\.gov\.gh\/capital-requirements/);
  assert.match(answer.system, /external website/);
});

test('the fallback is off when it should be: nothing approved, disabled by an admin, not a policy question, or already answered', async () => {
  const staff = await signup('kbskip', 'Credit');

  // 1. An ordinary question that the knowledge base can't answer but that isn't a policy question.
  search.state.requests.length = 0;
  await chat(staff, 'hello there');
  assert.equal(search.state.requests.length, 0, 'small talk must not trigger a web search');

  // 2. A policy question with no approved domain to search.
  const domains = await (await admin.get('/api/admin/domains')).json();
  for (const d of domains.domains) await admin.delete(`/api/admin/domains/${d.id}`);
  search.state.requests.length = 0;
  const noDomain = await chat(staff, 'What does the Bank of Ghana require for capital reserves?');
  assert.equal(eventsOf(noDomain.events, 'policy-web-search').length, 0);
  assert.equal(search.state.requests.length, 0);

  // 3. A policy question with a domain approved but the feature switched off.
  await admin.post('/api/admin/domains', { domain: 'bog.gov.gh' });
  assert.equal((await admin.post('/api/admin/settings', { kbOnlineFallback: false })).status, 200);
  search.state.requests.length = 0;
  const disabled = await chat(staff, 'What does the Bank of Ghana require for capital reserves?');
  assert.equal(eventsOf(disabled.events, 'policy-web-search').length, 0);
  assert.equal(search.state.requests.length, 0);
  assert.equal((await admin.post('/api/admin/settings', { kbOnlineFallback: true })).status, 200);

  // 4. Answered by the bank's own documents.
  await upload(admin, 'reserve-policy.txt', 'Rural banks must hold a capital reserve of 10 percent of deposits at all times.', {
    scope: 'global',
  });
  search.state.requests.length = 0;
  const answered = await chat(staff, 'What capital reserve must rural banks hold?');
  assert.equal(eventsOf(answered.events, 'policy-web-search').length, 0);
  assert.ok(search.state.requests.length === 0);
});

test('a failed search is reported instead of an invented policy answer', async () => {
  const staff = await signup('kbfail', 'IT');
  search.state.fail = true;
  try {
    const { events, requests } = await chat(staff, 'What is the Bank of Ghana policy on cyber security for banks?');
    const fallback = eventsOf(events, 'policy-web-search')[0];
    assert.ok(fallback);
    assert.deepEqual(fallback.results, []);
    assert.match(fallback.error, /search provider|status/i);
    const answer = [...requests].reverse().find((r) => !r.isTitle);
    assert.match(answer.system, /did not contain an answer/);
    assert.match(answer.system, /Do not invent a policy answer/);
  } finally {
    search.state.fail = false;
  }
});

test('the fallback setting is admin-only', async () => {
  const staff = await signup('kbsettings', 'HR');
  assert.equal((await staff.post('/api/admin/settings', { kbOnlineFallback: false })).status, 403);
  const settings = await (await admin.get('/api/admin/settings')).json();
  assert.equal(settings.kbOnlineFallback, true);
});

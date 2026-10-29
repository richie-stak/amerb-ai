// The three knowledge bases, checked at the API boundary and in chat retrieval:
//   bank-wide  — everyone reads, only admins add/delete
//   department — only that department reads; any member adds; uploader or admin deletes
//   personal   — chat attachments, visible to their owner only until shared
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');

let server;
let admin;
let creditA;
let creditB;
let hr;
let retrieval;
const users = {};
const ids = {};

async function signup(client, username, department) {
  const res = await client.post('/api/auth/signup', {
    username,
    email: `${username}@amenfimanbank.com`,
    password: 'password123',
    department,
  });
  users[username] = (await res.json()).user;
}

async function uploadOne(client, name, content, fields) {
  const res = await client.upload('/api/documents', [{ name, content }], fields);
  const body = await res.json();
  return { status: res.status, body, id: body.results?.[0]?.id };
}

async function listedIds(client) {
  const { documents } = await (await client.get('/api/documents')).json();
  return documents.map((d) => d.id);
}

before(async () => {
  server = await startTestServer();
  admin = makeClient(server.baseUrl);
  creditA = makeClient(server.baseUrl);
  creditB = makeClient(server.baseUrl);
  hr = makeClient(server.baseUrl);
  await signup(admin, 'kbadmin', 'IT');
  await signup(creditA, 'creditalice', 'Credit');
  await signup(creditB, 'creditbob', 'Credit');
  await signup(hr, 'hrhannah', 'HR');

  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(users.kbadmin.id);
  db.close();

  // Retrieval runs in-process against the test server's database file.
  process.env.AMERB_DB_PATH = server.dbPath;
  retrieval = require('../server/retrieval');
});

after(async () => {
  // Release this process's handle on the database first — Windows won't delete an open file.
  require('../server/db').close();
  await server.stop();
});

test('staff cannot add to the bank-wide knowledge base', async () => {
  const res = await uploadOne(creditA, 'fake-policy.txt', 'Totally official policy', { scope: 'global' });
  assert.equal(res.status, 403);
});

test('an admin can publish bank-wide, and every department can read it', async () => {
  const res = await uploadOne(admin, 'leave-policy.txt', 'Annual leave policy: staff get twenty days of annual leave', {
    scope: 'global',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].scope, 'global');
  ids.global = res.id;

  for (const client of [creditA, hr]) {
    assert.ok((await listedIds(client)).includes(ids.global));
    assert.equal((await client.get(`/api/documents/${ids.global}/file`)).status, 200);
  }
});

test('a department upload is visible to that department only', async () => {
  const res = await uploadOne(creditA, 'credit-scoring.txt', 'Credit scoring guideline: minimum score for SME loans is 650', {
    scope: 'department',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].scope, 'department');
  ids.credit = res.id;

  assert.ok((await listedIds(creditB)).includes(ids.credit), 'a Credit colleague sees it');
  assert.ok(!(await listedIds(hr)).includes(ids.credit), 'HR does not see it');
  assert.equal((await hr.get(`/api/documents/${ids.credit}/file`)).status, 403);
  assert.equal((await creditB.get(`/api/documents/${ids.credit}/file`)).status, 200);
});

test("staff cannot upload into another department's knowledge base", async () => {
  const res = await uploadOne(creditA, 'sneaky.txt', 'Not for HR', { scope: 'department', department: 'HR' });
  assert.equal(res.status, 403);
});

test('an admin can add files to a specific department', async () => {
  const res = await uploadOne(admin, 'hr-handbook.txt', 'HR handbook: disciplinary procedure steps', {
    scope: 'department',
    department: 'HR',
  });
  assert.equal(res.status, 200);
  ids.hrByAdmin = res.id;
  assert.ok((await listedIds(hr)).includes(ids.hrByAdmin));
  assert.ok(!(await listedIds(creditA)).includes(ids.hrByAdmin));
});

test('a chat attachment is personal: only its owner can see it', async () => {
  // No scope at all is how an old client would call it — it must default to the private option.
  const res = await uploadOne(creditA, 'my-payslip.txt', 'Private payslip salary figures for alice');
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].scope, 'personal');
  ids.personal = res.id;

  assert.ok((await listedIds(creditA)).includes(ids.personal));
  assert.ok(!(await listedIds(creditB)).includes(ids.personal), 'not even a same-department colleague');
  assert.equal((await creditB.get(`/api/documents/${ids.personal}/file`)).status, 403);
});

test('chat search only reaches bank-wide, own department, and own personal files', () => {
  const sourcesFor = (user, query) => retrieval.getAutoContext(user, query).sources.map((s) => s.id);
  const hrUser = users.hrhannah;
  const creditUser = users.creditbob;

  assert.ok(sourcesFor(hrUser, 'annual leave policy days').includes(ids.global), 'HR finds the bank-wide policy');
  assert.ok(!sourcesFor(hrUser, 'credit scoring minimum score SME loans').includes(ids.credit), "HR can't search Credit's files");
  assert.ok(sourcesFor(creditUser, 'credit scoring minimum score SME loans').includes(ids.credit));
  assert.ok(!sourcesFor(creditUser, 'private payslip salary figures').includes(ids.personal), "can't search a colleague's personal file");
  assert.ok(sourcesFor(users.creditalice, 'private payslip salary figures').includes(ids.personal), 'the owner can');
});

test("the bank's own name and search instructions don't drag in unrelated documents", () => {
  // Every bank document mentions the bank; asking about the bank itself shouldn't cite them.
  const sources = retrieval.getAutoContext(users.creditbob, 'search about amenfiman community bank on google').sources;
  assert.deepEqual(sources, []);
});

test('attaching a document by id is refused across departments', () => {
  const { docs } = retrieval.getExplicitContext([ids.credit, ids.personal], users.hrhannah);
  assert.equal(docs.length, 0);
});

test('sharing a personal file moves it into the owner\'s department knowledge base', async () => {
  assert.equal((await creditB.patch(`/api/documents/${ids.personal}/share`, { scope: 'department' })).status, 403, "can't share someone else's file");
  assert.equal((await creditA.patch(`/api/documents/${ids.personal}/share`, { scope: 'global' })).status, 403, 'staff cannot publish bank-wide');

  const res = await creditA.patch(`/api/documents/${ids.personal}/share`, { scope: 'department' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).scope, 'department');
  assert.ok((await listedIds(creditB)).includes(ids.personal));
  assert.ok(!(await listedIds(hr)).includes(ids.personal));
});

test('an admin can publish a department file bank-wide, and then every department can search it', async () => {
  assert.equal((await admin.patch(`/api/documents/${ids.hrByAdmin}/share`, { scope: 'global' })).status, 200);
  assert.ok((await listedIds(creditA)).includes(ids.hrByAdmin));
  const sources = retrieval.getAutoContext(users.creditbob, 'HR handbook disciplinary procedure steps').sources.map((s) => s.id);
  assert.ok(sources.includes(ids.hrByAdmin));
});

test("the admin overview lists everyone's files only when asked for all of them", async () => {
  const fresh = await uploadOne(hr, 'hr-private-note.txt', 'A private note');
  assert.ok(!(await listedIds(admin)).includes(fresh.id), 'not on the admin\'s everyday list');
  const { documents } = await (await admin.get('/api/documents?all=1')).json();
  assert.ok(documents.some((d) => d.id === fresh.id && d.scope === 'personal'), 'but present in the admin overview');
  const { documents: staffView } = await (await hr.get('/api/documents?all=1')).json();
  assert.ok(!staffView.some((d) => d.id === ids.credit), '?all=1 grants nothing to non-admins');
});

test('delete rules: staff cannot remove bank-wide or a colleague\'s files; uploader and admin can', async () => {
  assert.equal((await creditA.delete(`/api/documents/${ids.global}`)).status, 403);
  assert.equal((await creditB.delete(`/api/documents/${ids.credit}`)).status, 403);
  assert.equal((await creditA.delete(`/api/documents/${ids.credit}`)).status, 200);
  assert.equal((await admin.delete(`/api/documents/${ids.global}`)).status, 200);
});

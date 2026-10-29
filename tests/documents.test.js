// Confirms the department-scoped visibility rule actually holds at the API boundary — a Credit
// officer's uploads must stay invisible to HR, and vice versa, while bank-wide documents are
// visible to everyone. This is the same access rule the @-mention feature relies on to only ever
// offer documents the user is already allowed to see.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');

let server;
let financeUser;
let hrUser;
let financeDocId;
let bankwideDocId;

before(async () => {
  server = await startTestServer();

  financeUser = makeClient(server.baseUrl);
  const financeSignup = await financeUser.post('/api/auth/signup', {
    username: 'financeuser',
    email: 'financeuser@amenfimanbank.com',
    password: 'password123',
    department: 'Finance',
  });
  const financeData = await financeSignup.json();
  await financeUser.post('/api/auth/logout');

  hrUser = makeClient(server.baseUrl);
  await hrUser.post('/api/auth/signup', {
    username: 'hruser',
    email: 'hruser@amenfimanbank.com',
    password: 'password123',
    department: 'HR',
  });
  await hrUser.post('/api/auth/logout');

  await financeUser.post('/api/auth/login', { identifier: 'financeuser', password: 'password123' });
  await hrUser.post('/api/auth/login', { identifier: 'hruser', password: 'password123' });

  const db = server.openDb();
  const financeUserId = financeData.user.id;

  const financeInsert = db
    .prepare(
      `INSERT INTO documents (user_id, department, filename, mime_type, kind, char_count) VALUES (?, 'Finance', 'q3-budget.txt', 'text/plain', 'text', 20)`
    )
    .run(financeUserId);
  financeDocId = financeInsert.lastInsertRowid;
  db.prepare(`INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, 0, 'Q3 budget figures here')`).run(financeDocId);

  const bankwideInsert = db
    .prepare(
      `INSERT INTO documents (user_id, department, filename, mime_type, kind, char_count) VALUES (?, 'Bank-wide', 'staff-handbook.txt', 'text/plain', 'text', 20)`
    )
    .run(financeUserId);
  bankwideDocId = bankwideInsert.lastInsertRowid;
  db.prepare(`INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, 0, 'Staff handbook contents')`).run(bankwideDocId);

  db.close();
});

after(async () => {
  await server.stop();
});

test("a department's document is not listed for a user in a different department", async () => {
  const res = await hrUser.get('/api/documents');
  const data = await res.json();
  assert.ok(!data.documents.some((d) => d.id === financeDocId), 'HR must not see Finance\'s document in the listing');
});

test("a department's document IS listed for a user in that same department", async () => {
  const res = await financeUser.get('/api/documents');
  const data = await res.json();
  assert.ok(data.documents.some((d) => d.id === financeDocId), "Finance must see its own department's document");
});

test('fetching another department\'s document file directly is refused with 403', async () => {
  const res = await hrUser.get(`/api/documents/${financeDocId}/file`);
  assert.equal(res.status, 403);
});

test('fetching your own department\'s document file succeeds', async () => {
  const res = await financeUser.get(`/api/documents/${financeDocId}/file`);
  assert.equal(res.status, 200);
});

test('a bank-wide document is visible and fetchable by every department', async () => {
  const listRes = await hrUser.get('/api/documents');
  const listData = await listRes.json();
  assert.ok(listData.documents.some((d) => d.id === bankwideDocId), 'bank-wide doc must appear for HR too');

  const fileRes = await hrUser.get(`/api/documents/${bankwideDocId}/file`);
  assert.equal(fileRes.status, 200);
});

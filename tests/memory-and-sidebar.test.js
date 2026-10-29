// Covers long-term memory (add / dedupe / delete / clear, and that one user can never see or
// delete another's memories) and the sidebar's pin + rename on conversations.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');

let server;
let alice;
let bob;
let conversationId;

async function signup(client, name) {
  const res = await client.post('/api/auth/signup', {
    username: name,
    email: `${name}@amenfimanbank.com`,
    password: 'password123',
    department: 'Credit',
  });
  return (await res.json()).user;
}

before(async () => {
  server = await startTestServer();
  alice = makeClient(server.baseUrl);
  bob = makeClient(server.baseUrl);
  const aliceUser = await signup(alice, 'memoryalice');
  await signup(bob, 'memorybob');

  const db = server.openDb();
  conversationId = db
    .prepare(
      `INSERT INTO conversations (user_id, title, model, updated_at) VALUES (?, 'Original title', 'test-model', datetime('now', '-2 days'))`
    )
    .run(aliceUser.id).lastInsertRowid;
  db.prepare(`INSERT INTO conversations (user_id, title, model) VALUES (?, 'Newer chat', 'test-model')`).run(aliceUser.id);
  db.close();
});

after(async () => {
  await server.stop();
});

test('a memory can be added and is listed back', async () => {
  const res = await alice.post('/api/memories', { content: '  Works in   the Credit department ' });
  assert.equal(res.status, 200);
  const { memories } = await (await alice.get('/api/memories')).json();
  assert.deepEqual(memories.map((m) => m.content), ['Works in the Credit department']);
});

test('adding the same memory twice does not create a duplicate', async () => {
  await alice.post('/api/memories', { content: 'works in the credit department' });
  const { memories } = await (await alice.get('/api/memories')).json();
  assert.equal(memories.length, 1);
});

test('an empty memory is rejected', async () => {
  const res = await alice.post('/api/memories', { content: '   ' });
  assert.equal(res.status, 400);
});

test("another user can neither see nor delete someone else's memories", async () => {
  const { memories: aliceMemories } = await (await alice.get('/api/memories')).json();
  const { memories: bobMemories } = await (await bob.get('/api/memories')).json();
  assert.equal(bobMemories.length, 0);

  const del = await bob.delete(`/api/memories/${aliceMemories[0].id}`);
  assert.equal(del.status, 404);
  await bob.delete('/api/memories');
  const { memories: after } = await (await alice.get('/api/memories')).json();
  assert.equal(after.length, 1);
});

test('clear all removes every memory for that user', async () => {
  await alice.post('/api/memories', { content: 'Prefers answers in bullet points' });
  await alice.delete('/api/memories');
  const { memories } = await (await alice.get('/api/memories')).json();
  assert.equal(memories.length, 0);
});

test('pinning a conversation moves it to the top of the list', async () => {
  const before = await (await alice.get('/api/conversations')).json();
  assert.equal(before.conversations[0].title, 'Newer chat');

  const res = await alice.patch(`/api/conversations/${conversationId}`, { pinned: true });
  assert.equal(res.status, 200);
  const after = await (await alice.get('/api/conversations')).json();
  assert.equal(after.conversations[0].id, conversationId);
  assert.equal(after.conversations[0].pinned, 1);
});

test('renaming a conversation keeps its pin, and an empty title is rejected', async () => {
  const empty = await alice.patch(`/api/conversations/${conversationId}`, { title: '  ' });
  assert.equal(empty.status, 400);

  await alice.patch(`/api/conversations/${conversationId}`, { title: 'Loan review notes' });
  const { conversations } = await (await alice.get('/api/conversations')).json();
  const convo = conversations.find((c) => c.id === conversationId);
  assert.equal(convo.title, 'Loan review notes');
  assert.equal(convo.pinned, 1);
});

test("a user cannot pin or rename someone else's conversation", async () => {
  const res = await bob.patch(`/api/conversations/${conversationId}`, { title: 'Hijacked' });
  assert.equal(res.status, 404);
});

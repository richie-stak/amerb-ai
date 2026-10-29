// Covers the message-versioning invariant this session hit a real bug in earlier: exactly one
// sibling per alt_group_id must be is_active at a time, GET must return only the active one
// annotated with its correct position, and switching versions must flip that atomically.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');

let server;
let client;
let conversationId;
let firstMessageId;
let secondMessageId;

before(async () => {
  server = await startTestServer();
  client = makeClient(server.baseUrl);
  const signup = await client.post('/api/auth/signup', {
    username: 'versionuser',
    email: 'versionuser@amenfimanbank.com',
    password: 'password123',
    department: 'IT',
  });
  const { user } = await signup.json();

  const db = server.openDb();
  const convoResult = db
    .prepare(`INSERT INTO conversations (user_id, title, model) VALUES (?, 'Version test', 'test-model')`)
    .run(user.id);
  conversationId = convoResult.lastInsertRowid;

  db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'Say hi')`).run(conversationId);

  const first = db
    .prepare(`INSERT INTO messages (conversation_id, role, content, is_active) VALUES (?, 'assistant', 'Hello (v1)', 1)`)
    .run(conversationId);
  firstMessageId = first.lastInsertRowid;
  db.prepare('UPDATE messages SET alt_group_id = ? WHERE id = ?').run(firstMessageId, firstMessageId);

  const second = db
    .prepare(`INSERT INTO messages (conversation_id, role, content, is_active) VALUES (?, 'assistant', 'Hello (v2)', 0)`)
    .run(conversationId);
  secondMessageId = second.lastInsertRowid;
  db.prepare('UPDATE messages SET alt_group_id = ? WHERE id = ?').run(firstMessageId, secondMessageId);
  db.close();
});

after(async () => {
  await server.stop();
});

test('GET a conversation returns only the active version, annotated 1/2', async () => {
  const res = await client.get(`/api/conversations/${conversationId}`);
  const data = await res.json();
  const assistantMessages = data.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 1, 'only the active sibling should appear in the rendered conversation');
  assert.equal(assistantMessages[0].content, 'Hello (v1)');
  assert.equal(assistantMessages[0].versionIndex, 1);
  assert.equal(assistantMessages[0].versionTotal, 2);
});

test('the versions endpoint lists both siblings with correct is_active flags', async () => {
  const res = await client.get(`/api/conversations/${conversationId}/messages/${firstMessageId}/versions`);
  const data = await res.json();
  assert.equal(data.versions.length, 2);
  assert.equal(data.versions.find((v) => v.id === firstMessageId).is_active, 1);
  assert.equal(data.versions.find((v) => v.id === secondMessageId).is_active, 0);
});

test('activating the second version flips is_active atomically — exactly one stays active', async () => {
  const res = await client.patch(`/api/conversations/${conversationId}/messages/${secondMessageId}/activate`);
  assert.equal(res.status, 200);

  const db = server.openDb();
  const active = db
    .prepare('SELECT id FROM messages WHERE alt_group_id = ? AND is_active = 1')
    .all(firstMessageId);
  db.close();
  assert.equal(active.length, 1, 'exactly one sibling must be active after switching');
  assert.equal(active[0].id, secondMessageId);

  const getRes = await client.get(`/api/conversations/${conversationId}`);
  const getData = await getRes.json();
  const assistantMessage = getData.messages.find((m) => m.role === 'assistant');
  assert.equal(assistantMessage.content, 'Hello (v2)');
  assert.equal(assistantMessage.versionIndex, 2);
});

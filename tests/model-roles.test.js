// Model roles: an embedding model must never be offered as a chat model, must never be saved as one, and
// must never be silently swapped for a chat model at answer time.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');
const { startMockOllama } = require('./helpers/mockOllama');

let server;
let ollama;
let admin;
let staff;

async function signup(client, username, department = 'Credit') {
  const res = await client.post('/api/auth/signup', {
    username,
    email: `${username}@amenfimanbank.com`,
    password: 'password12345',
    department,
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res;
}

before(async () => {
  ollama = await startMockOllama({ models: ['good', 'nomic-embed-text', 'backup'] });
  server = await startTestServer({ env: { OLLAMA_URL: ollama.url, DEFAULT_MODEL: 'good', AMERB_DEFAULT_FALLBACK: 'off' } });
  admin = makeClient(server.baseUrl);
  await signup(admin, 'modeladmin', 'IT');
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'modeladmin'").run();
  db.close();
  staff = makeClient(server.baseUrl);
  await signup(staff, 'modelstaff');
});

after(async () => {
  for (const stop of [() => ollama.stop(), () => server.stop()]) {
    try {
      await stop();
    } catch (err) {
      console.error('cleanup failed:', err.message);
    }
  }
});

test('the model picker offers chat models only, and reports the embedding model it hid', async () => {
  const res = await staff.get('/api/models');
  assert.equal(res.status, 200);
  const body = await res.json();
  const names = body.models.map((m) => m.name);
  assert.ok(names.some((n) => n.startsWith('good')), 'the chat model is offered');
  assert.ok(!names.some((n) => /embed/i.test(n)), 'the embedding model is not offered as a chat model');
  assert.ok(body.hiddenEmbeddingModels.some((n) => /embed/i.test(n)), 'and staff are told it was hidden');
});

test('a chat request naming an embedding model is refused with an explanation, not swapped', async () => {
  const before = server.openDb().prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  const res = await staff.post('/api/chat/stream', { model: 'nomic-embed-text:latest', content: 'what is the loan rate?' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'model_role_mismatch', 'the reason is machine-readable too');
  assert.match(body.error, /embedding model/i);
  assert.match(body.error, /cannot answer questions/i);
  assert.match(body.error, /qwen3:4b-instruct|chat model/i);
  const after = server.openDb().prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  assert.equal(after, before, 'no conversation is created for a request that could never succeed');
  // The mock model was never asked: the refusal happens before the queue and Ollama.
  assert.ok(!ollama.state.requests.some((r) => r.model.includes('embed')), 'Ollama was never asked to chat with it');
});

test('model routing refuses an embedding model as a department or fallback model', async () => {
  const routing = await admin.get('/api/admin/routing');
  assert.equal(routing.status, 200);
  const body = await routing.json();
  assert.ok(!body.models.some((m) => /embed/i.test(m.name)), 'the routing screen does not offer it either');

  const res = await admin.post('/api/admin/routing', { departmentModels: { Credit: 'nomic-embed-text:latest' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /embedding model/i);
});

test('stored conversations whose model was an embedding model are repaired, with a report', async () => {
  const db = server.openDb();
  const created = db
    .prepare("INSERT INTO conversations (user_id, title, model) VALUES ((SELECT id FROM users WHERE username = 'modelstaff'), 'old broken chat', 'nomic-embed-text:latest')")
    .run();
  db.close();

  process.env.AMERB_DB_PATH = server.dbPath;
  const modelCapabilities = require('../server/modelCapabilities');
  modelCapabilities.clearCache();
  await modelCapabilities.modelInfo('nomic-embed-text:latest', { fresh: true });

  const repaired = modelCapabilities.repairStoredChatModels(server.openDb(), { target: 'good' });
  assert.equal(repaired.conversations, 1);
  assert.deepEqual(repaired.models, ['nomic-embed-text:latest']);
  assert.equal(repaired.with, 'good');
  const row = server.openDb().prepare('SELECT model FROM conversations WHERE id = ?').get(created.lastInsertRowid);
  assert.equal(row.model, 'good', 'the conversation now names a real chat model');
  const second = modelCapabilities.repairStoredChatModels(server.openDb(), { target: 'good' });
  assert.equal(second.conversations, 0, 'running the repair again changes nothing');
});

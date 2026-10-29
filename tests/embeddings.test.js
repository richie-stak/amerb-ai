// Meaning-based search, tested with a fake embedding server so it runs anywhere (no Ollama or model
// needed): passages are indexed in the background, matched by meaning, kept within each user's
// knowledge bases, and search falls back to keywords when the embedding model isn't there.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// A toy "embedding": one dimension per topic, so similarity is predictable.
const TOPICS = ['leave', 'loan', 'password'];
const SYNONYMS = { leave: ['leave', 'holiday', 'vacation'], loan: ['loan', 'borrow', 'credit facility'], password: ['password', 'login'] };
function fakeVector(text) {
  const t = text.toLowerCase();
  return [...TOPICS.map((topic) => (SYNONYMS[topic].some((w) => t.includes(w)) ? 1 : 0)), 0.2];
}

let fakeOllama;
let modelInstalled = true;
let dbPath;
let embeddings;
let retrieval;
let db;
const users = {};

before(async () => {
  fakeOllama = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/tags') {
        return res.end(JSON.stringify({ models: modelInstalled ? [{ name: 'nomic-embed-text:latest' }] : [] }));
      }
      const { input } = JSON.parse(raw);
      res.end(JSON.stringify({ embeddings: input.map(fakeVector) }));
    });
  });
  await new Promise((r) => fakeOllama.listen(0, '127.0.0.1', r));

  dbPath = path.join(os.tmpdir(), `amerb-embed-test-${process.pid}.sqlite`);
  process.env.AMERB_DB_PATH = dbPath;
  process.env.OLLAMA_URL = `http://127.0.0.1:${fakeOllama.address().port}`;
  db = require('../server/db');
  embeddings = require('../server/embeddings');
  retrieval = require('../server/retrieval');

  const addUser = (name, department) => {
    const id = db.prepare("INSERT INTO users (username, email, password_hash, department) VALUES (?, ?, 'x', ?)").run(name, `${name}@amenfimanbank.com`, department).lastInsertRowid;
    users[name] = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  };
  addUser('hruser', 'HR');
  addUser('credituser', 'Credit');
  const addDoc = (owner, department, filename, content) => {
    const docId = db.prepare("INSERT INTO documents (user_id, department, filename, kind) VALUES (?, ?, ?, 'text')").run(owner.id, department, filename).lastInsertRowid;
    db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, 0, ?)').run(docId, content);
    return docId;
  };
  users.hrDoc = addDoc(users.hruser, 'HR', 'hr-policy.txt', 'Every employee is entitled to 20 days of annual holiday per year.');
  users.creditDoc = addDoc(users.credituser, 'Credit', 'sme-guide.txt', 'SME credit facility guidelines and borrower requirements.');
});

after(async () => {
  db.close();
  await new Promise((r) => fakeOllama.close(r));
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
});

test('pending chunks get indexed', async () => {
  await embeddings.indexPendingChunks();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunk_embeddings').get().n, 2);
});

test('a question finds a passage that uses different words with the same meaning', async () => {
  // "leave entitlement" shares no keyword with "annual holiday", only the meaning.
  const keywordOnly = retrieval.getAutoContext(users.hruser, 'staff leave entitlement');
  assert.deepEqual(keywordOnly.sources, [], 'keyword search alone misses it');
  const { sources } = await retrieval.getHybridContext(users.hruser, 'staff leave entitlement');
  assert.deepEqual(sources.map((s) => s.id), [users.hrDoc]);
});

test("meaning search never reaches another department's documents", async () => {
  const { sources } = await retrieval.getHybridContext(users.hruser, 'how can a customer borrow money');
  assert.ok(!sources.some((s) => s.id === users.creditDoc));
  const credit = await retrieval.getHybridContext(users.credituser, 'how can a customer borrow money');
  assert.deepEqual(credit.sources.map((s) => s.id), [users.creditDoc]);
});

test('an unrelated question matches nothing', async () => {
  const { sources } = await retrieval.getHybridContext(users.hruser, 'what is the weather today');
  assert.deepEqual(sources, []);
});

test('deleting a document removes its index entries', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM chunk_embeddings').get().n;
  const docId = db.prepare("INSERT INTO documents (user_id, department, filename, kind) VALUES (?, 'HR', 'temp.txt', 'text')").run(users.hruser.id).lastInsertRowid;
  db.prepare("INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, 0, 'login help')").run(docId);
  await embeddings.indexPendingChunks();
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunk_embeddings').get().n, before);
});

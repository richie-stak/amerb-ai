// Retrieval regression tests: the questions staff actually type must find the bank-wide policies.
//
// "Summarize our password policy" once returned nothing even though the Information Security Policy was in
// the bank-wide knowledge base: the query's request words ("summarize", "our") counted towards the number
// of terms a chunk had to contain, so a chunk holding the password standard scored too low. These tests
// pin the behaviour at the retrieval layer, with a disposable database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amerb-retrieval-'));
process.env.AMERB_DB_PATH = path.join(tempDir, 'retrieval.sqlite');
process.env.LOG_DIR = path.join(tempDir, 'logs');

const db = require('../server/db');
const { getAutoContext, getHybridContext } = require('../server/retrieval');

const USER = { id: 1, username: 'staff', role: 'user', department: 'Credit' };

function addDocument({ filename, department = 'Bank-wide', kind = 'pdf', chunks, isPersonal = 0 }) {
  const docResult = db
    .prepare('INSERT INTO documents (user_id, department, filename, mime_type, kind, is_personal) VALUES (?, ?, ?, ?, ?, ?)')
    .run(USER.id, department, filename, 'text/plain', kind, isPersonal);
  const insert = db.prepare('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)');
  chunks.forEach((content, index) => insert.run(docResult.lastInsertRowid, index, content));
  return Number(docResult.lastInsertRowid);
}

let policyId;
let creditId;

before(() => {
  db.prepare('INSERT INTO users (id, username, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?, ?)').run(
    USER.id,
    USER.username,
    'staff@amenfimanbank.com',
    'x',
    USER.role,
    USER.department
  );

  policyId = addDocument({
    filename: 'AMERB Information Security Policy.pdf',
    chunks: [
      'Access control requires that passwords are complex and are not stored in clear text.',
      '6.4.3 Password Standards: passwords must be at least eight characters and include a mix of letters, numbers and special characters. Users should not add a numeric at the end of the password in sequence. Systems must keep a history of the last 13 passwords.',
      'Screensavers must activate after five minutes of inactivity and sessions terminate after thirty minutes.',
    ],
  });
  creditId = addDocument({
    filename: 'AMERB Credit Policy Manual.pdf',
    chunks: [
      'Loan approval: credit officers assess the applicant income and collateral before recommending approval.',
      'The maximum loan-to-value ratio for commercial loans is sixty percent.',
    ],
  });
});

after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a request phrased with extra words still finds the policy (the 20 Nov failure)', () => {
  for (const question of ['Summarize our password policy', 'summarise the password policy', 'what is the password policy']) {
    const context = getAutoContext(USER, question);
    assert.ok(context.sources.some((s) => s.id === policyId), `"${question}" should find the Information Security Policy, got ${JSON.stringify(context.sources)}`);
    assert.match(context.text, /Password Standards/, 'the relevant passage is included, not just the document');
  }
});

test('a question about loans finds the credit policy, not an unrelated form', () => {
  const context = getAutoContext(USER, 'Explain the loan approval process');
  assert.ok(context.sources.some((s) => s.id === creditId), JSON.stringify(context.sources));
});

test('a question with no matching document returns nothing rather than noise', () => {
  const context = getAutoContext(USER, 'What is the weather forecast for Kumasi tomorrow');
  assert.deepEqual(context.sources, []);
});

test('words that appear in no document cannot block a match', () => {
  const context = getAutoContext(USER, 'Could you please provide an overview of the password standards for me');
  assert.ok(context.sources.some((s) => s.id === policyId), JSON.stringify(context.sources));
});

test('the meaning-based path still returns the policy when embeddings exist (hybrid retrieval)', async () => {
  // No embeddings are created in this test database, so hybrid retrieval falls back to keywords; the point
  // is that the same question that failed end to end now returns a citation either way.
  const context = await getHybridContext(USER, 'Summarize our password policy');
  assert.ok(context.sources.some((s) => s.id === policyId), JSON.stringify(context.sources));
});

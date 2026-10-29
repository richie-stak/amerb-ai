// Regression coverage for a real incident: a manual test of conversation-retention cleanup
// deleted real production conversations that were well inside the retention window. These tests
// pin down the exact boundary behavior so that can't silently happen again.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');

let server;
let admin;
let userId;

before(async () => {
  server = await startTestServer();
  admin = makeClient(server.baseUrl);
  const signupRes = await admin.post('/api/auth/signup', {
    username: 'retentionadmin',
    email: 'retentionadmin@amenfimanbank.com',
    password: 'password123',
    department: 'IT',
  });
  const signupData = await signupRes.json();
  userId = signupData.user.id;

  const db = server.openDb();
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(userId);
  db.close();

  await admin.post('/api/auth/logout');
  await admin.post('/api/auth/login', { identifier: 'retentionadmin', password: 'password123' });
});

after(async () => {
  await server.stop();
});

function insertConversation(db, { title, daysOld }) {
  const result = db
    .prepare(
      `INSERT INTO conversations (user_id, title, model, created_at, updated_at)
       VALUES (?, ?, 'test-model', datetime('now', ?), datetime('now', ?))`
    )
    .run(userId, title, `-${daysOld} days`, `-${daysOld} days`);
  return result.lastInsertRowid;
}

test('preview and cleanup agree on count, and only conversations past the cutoff are removed', async () => {
  const db = server.openDb();
  const freshId = insertConversation(db, { title: 'Fresh — today', daysOld: 0 });
  const recentId = insertConversation(db, { title: 'Recent — 2 days old', daysOld: 2 });
  const oldId = insertConversation(db, { title: 'Old — 10 days old', daysOld: 10 });
  db.close();

  const previewRes = await admin.get('/api/admin/cleanup-old-conversations/preview?retentionDays=5');
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json();
  assert.equal(preview.count, 1, 'only the 10-day-old conversation should be previewed for deletion at a 5-day cutoff');
  assert.equal(preview.sample[0].id, oldId);

  const cleanupRes = await admin.post('/api/admin/cleanup-old-conversations', { retentionDays: 5 });
  const cleanup = await cleanupRes.json();
  assert.equal(cleanup.deleted, preview.count, 'the actual delete count must match what was previewed');

  const db2 = server.openDb();
  assert.ok(db2.prepare('SELECT id FROM conversations WHERE id = ?').get(freshId), 'fresh conversation must survive');
  assert.ok(db2.prepare('SELECT id FROM conversations WHERE id = ?').get(recentId), 'recent conversation must survive');
  assert.equal(db2.prepare('SELECT id FROM conversations WHERE id = ?').get(oldId), undefined, 'only the old conversation should be gone');
  db2.close();
});

test('a conversation from today is never deletable by any positive retention window', async () => {
  const db = server.openDb();
  const todayId = insertConversation(db, { title: 'Created moments ago', daysOld: 0 });
  db.close();

  // The exact bug from the incident: something dated today must never match a "days ago" cutoff,
  // no matter how small the configured retention window is.
  const previewRes = await admin.get('/api/admin/cleanup-old-conversations/preview?retentionDays=1');
  const preview = await previewRes.json();
  assert.ok(
    !preview.sample.some((c) => c.id === todayId),
    "today's conversation must not appear in a 1-day retention preview"
  );
});

test('cleanup rejects a non-positive or non-integer retentionDays instead of defaulting to something dangerous', async () => {
  for (const bad of [0, -1, 1.5, 'all', null]) {
    const res = await admin.post('/api/admin/cleanup-old-conversations', { retentionDays: bad });
    assert.equal(res.status, 400, `retentionDays=${JSON.stringify(bad)} must be rejected`);
  }
});

test('preview rejects a non-positive retentionDays the same way cleanup does', async () => {
  const res = await admin.get('/api/admin/cleanup-old-conversations/preview?retentionDays=0');
  assert.equal(res.status, 400);
});

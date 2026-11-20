// Versioned migrations: an existing database is upgraded in place, a snapshot is taken first, the
// embedding-model repair happens once, orphans are removed, and re-running changes nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { runMigrations, migrationStatus } = require('../server/migrations');
const { listBackups } = require('../server/dbMaintenance');

const ROOT = path.join(__dirname, '..');

// A database shaped like the ones in use before versioned migrations: no schema_migrations, no
// documents.mirror_path, documents.kind without 'webpage', users.role without 'auditor', a conversation
// naming an embedding model as its chat model, and one message whose conversation no longer exists.
function createLegacyDatabase(dir) {
  const file = path.join(dir, 'legacy.sqlite');
  const db = new DatabaseSync(file);
  // The orphan row below was written by an older build that did not enforce foreign keys; recreate that
  // situation so the repair migration has something real to clean up.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      department TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      department TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT,
      kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'docx', 'xlsx', 'pdf')),
      image_data TEXT,
      file_data TEXT,
      char_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE language_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      language TEXT NOT NULL CHECK (language IN ('tw', 'gaa', 'fr')),
      english_term TEXT NOT NULL,
      local_term TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (language, english_term)
    );
    CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE saved_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO users (username, email, password_hash, department) VALUES
      ('legacy', 'legacy@amenfimanbank.com', 'hash', 'Credit'),
      ('second', 'second@amenfimanbank.com', 'hash', 'IT');
    INSERT INTO conversations (user_id, title, model) VALUES
      (1, 'broken rate chat', 'nomic-embed-text:latest'),
      (1, 'normal chat', 'qwen3:4b-instruct'),
      (2, 'another', 'llama3.2:latest');
    INSERT INTO messages (conversation_id, role, content) VALUES (1, 'user', 'hello'), (999, 'assistant', 'orphan');
    INSERT INTO documents (user_id, department, filename, mime_type, kind) VALUES (1, 'Credit', 'a.txt', 'text/plain', 'text');
    INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (1, 0, 'text');
  `);
  db.close();
  return file;
}

test('a pre-versioning database is upgraded in place, with a backup and the model repair', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amerb-mig-'));
  const dbPath = createLegacyDatabase(dir);
  const logs = [];
  const db = new DatabaseSync(dbPath);
  try {
    const result = runMigrations(db, {
      dbPath,
      log: (message) => logs.push(message),
      context: { classifyChatModel: (name) => (/embed/i.test(name) ? 'embedding' : 'chat') },
    });
    assert.deepEqual(result.applied.map((m) => m.version), [1, 2, 3, 4]);
    assert.ok(result.backup, 'a snapshot was taken before the schema changed');
    assert.ok(fs.existsSync(result.backup), 'and it exists on disk');

    const status = migrationStatus(db);
    assert.ok(status.every((m) => m.applied), 'every migration is recorded as applied');

    const columns = db.prepare('PRAGMA table_info(documents)').all().map((c) => c.name);
    assert.ok(columns.includes('mirror_path'), 'the column from the reported error is in the schema');

    const repaired = db.prepare("SELECT model FROM conversations WHERE title = 'broken rate chat'").get();
    assert.equal(repaired.model, 'qwen3:4b-instruct', 'the embedding model saved as a chat model was replaced');
    const summary = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'model_roles_repaired'").get().value);
    assert.deepEqual(summary.replaced, ['nomic-embed-text:latest']);
    assert.equal(summary.conversations, 1);

    const orphan = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 999').get().n;
    assert.equal(orphan, 0, 'the unreachable message was removed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1, 'reachable messages are untouched');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2, 'users are untouched');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1, 'documents are untouched');
    // The users table is rebuilt for the "auditor" role without losing rows.
    assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql.includes("'auditor'"));

    // Running again is a no-op, and does not pile up backups.
    const backupsBefore = listBackups(dbPath).length;
    const again = runMigrations(db, { dbPath, log: () => {}, context: {} });
    assert.equal(again.applied.length, 0);
    assert.equal(listBackups(dbPath).length, backupsBefore);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(logs.some((line) => /Migration 1 \(baseline-schema\) applied/.test(line)));
});

test('a fresh database ends up with every migration recorded (via the real db module)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amerb-fresh-'));
  const dbPath = path.join(dir, 'fresh.sqlite');
  const script = `
    process.env.AMERB_DB_PATH = ${JSON.stringify(dbPath)};
    process.env.LOG_DIR = ${JSON.stringify(path.join(dir, 'logs'))};
    const db = require(${JSON.stringify(path.join(ROOT, 'server', 'db'))});
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
    console.log(JSON.stringify(rows));
    db.close();
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, AMERB_SKIP_INTEGRITY: '1' } });
    const versions = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(versions, [1, 2, 3, 4]);
    // A brand-new database has no data to protect, so no snapshot is taken.
    assert.equal(listBackups(dbPath).length, 0);
    const check = new DatabaseSync(dbPath);
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

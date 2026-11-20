const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Overridable so the test suite can point at a disposable file instead of the real database —
// after an incident where manual testing deleted real production conversations, tests must never
// be able to touch data/amerb-ai.sqlite even by accident.
const DB_PATH = process.env.AMERB_DB_PATH || path.join(dataDir, 'amerb-ai.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  -- Another process (a backup, a maintenance script) holding the write lock briefly should make a query
  -- wait, not fail with SQLITE_BUSY and turn into a 500 for the person asking.
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    department TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    attachments TEXT,
    citations TEXT,
    thinking TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    department TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT,
    kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'docx', 'xlsx', 'pptx', 'pdf', 'webpage')),
    image_data TEXT,
    file_data TEXT,
    char_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS document_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS allowed_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_saved_prompts_user ON saved_prompts(user_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_documents_department ON documents(department);
  CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks(document_id);
`);


// --- Versioned migrations ---
//
// Every schema change is a numbered, named migration in server/migrations.js. They run here, in order,
// inside transactions, and the database is snapshotted first when there is data to protect. This replaces
// the old inline "add the column if it isn't there" block: that approach left no record of what had been
// applied, and a runtime error ("no such column: mirror_path") showed what happens when code and schema
// can drift apart with no way to tell which database had which change.
const { runMigrations } = require('./migrations');
const modelCapabilities = require('./modelCapabilities');

// Operational messages are written straight to stderr: stdout is machine-readable in the tooling and tests
// that load this module in a child process (they parse JSON from it), and the structured logger captures
// console.* — writing there would record routine schema updates as "error" entries.
const databaseLog = (message) => process.stderr.write(`[database] ${message}\n`);
const MIGRATION_LOG = databaseLog;
try {
  const result = runMigrations(db, {
    dbPath: DB_PATH,
    log: MIGRATION_LOG,
    context: { classifyChatModel: modelCapabilities.classifyChatModel },
  });
  if (result.applied.length) {
    databaseLog(
      `Schema updated: ${result.applied.map((m) => `v${m.version} ${m.name}`).join(', ')}` +
        (result.backup ? ` (backup: ${result.backup})` : '')
    );
  }
  if (result.skipped.length) {
    databaseLog(
      `Left for the next start (needs model details from Ollama): ${result.skipped
        .map((m) => `v${m.version} ${m.name}`)
        .join(', ')}`
    );
  }
} catch (err) {
  // A schema that could not be migrated is not a database to keep serving from: report it loudly and let
  // the service restart rather than run code against a schema it was not written for.
  console.error('[database] Migration failed:', err.message);
  throw err;
}

// Integrity: quick_check only reads the b-tree structure, so it is cheap enough to run at every start
// and catches the damage that a power cut or a bad disk would cause before a person hits it mid-question.
if (process.env.AMERB_SKIP_INTEGRITY !== '1') {
  try {
    const result = db.prepare('PRAGMA quick_check').all();
    const value = result.length ? Object.values(result[0])[0] : null;
    if (value !== 'ok') {
      console.error('[database] INTEGRITY CHECK FAILED:', JSON.stringify(result));
      console.error('[database] Restore the most recent verified snapshot from data/backups and investigate the disk.');
    }
  } catch (err) {
    console.error('[database] Could not run the integrity check:', err.message);
  }
}

// Expired login sessions are deleted at startup so the table does not grow forever.
try {
  const removed = db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()).changes;
  if (removed) console.error(`[database] Removed ${removed} expired session(s)`);
} catch {
  /* the sessions table is created by express-session on first use */
}

module.exports = db;
module.exports.DB_PATH = DB_PATH;

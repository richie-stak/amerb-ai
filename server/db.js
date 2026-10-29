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
  PRAGMA foreign_keys = ON;

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

// --- Lightweight migrations for databases created before these columns existed ---

function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

if (!columnExists('conversations', 'pinned')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
}

// Long-term memory, like ChatGPT's: short facts a user asked AMERB AI to remember ("I work in
// Credit", "always answer in GHS"), injected into every future conversation of that same user.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id);
`);

if (!columnExists('users', 'role')) {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
}
if (!columnExists('users', 'department')) {
  db.exec(`ALTER TABLE users ADD COLUMN department TEXT`);
}
if (!columnExists('messages', 'attachments')) {
  db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
}
if (!columnExists('messages', 'citations')) {
  db.exec(`ALTER TABLE messages ADD COLUMN citations TEXT`);
}
if (!columnExists('document_chunks', 'heading')) {
  db.exec(`ALTER TABLE document_chunks ADD COLUMN heading TEXT`);
}
if (!columnExists('users', 'custom_instructions')) {
  db.exec(`ALTER TABLE users ADD COLUMN custom_instructions TEXT`);
}
if (!columnExists('messages', 'feedback')) {
  db.exec(`ALTER TABLE messages ADD COLUMN feedback TEXT`);
}
if (!columnExists('messages', 'thinking')) {
  db.exec(`ALTER TABLE messages ADD COLUMN thinking TEXT`);
}
// Groups an assistant message with its regenerated alternates (siblings share alt_group_id; only
// one per group is is_active) so a retry can keep prior answers around, switchable, instead of
// deleting them outright. Every pre-existing message backfills to its own single-member group.
if (!columnExists('messages', 'alt_group_id')) {
  db.exec(`ALTER TABLE messages ADD COLUMN alt_group_id INTEGER`);
  db.exec(`UPDATE messages SET alt_group_id = id WHERE alt_group_id IS NULL`);
}
if (!columnExists('messages', 'is_active')) {
  db.exec(`ALTER TABLE messages ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
}
if (!columnExists('documents', 'kind')) {
  db.exec(`ALTER TABLE documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`);
}
if (!columnExists('documents', 'image_data')) {
  db.exec(`ALTER TABLE documents ADD COLUMN image_data TEXT`);
}
if (!columnExists('documents', 'file_data')) {
  db.exec(`ALTER TABLE documents ADD COLUMN file_data TEXT`);
}
if (!columnExists('users', 'failed_login_count')) {
  db.exec(`ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('users', 'locked_until')) {
  db.exec(`ALTER TABLE users ADD COLUMN locked_until TEXT`);
}

// SQLite can't ALTER a CHECK constraint in place — rebuild the table if its `kind` constraint
// doesn't yet allow every kind this version of the app can produce.
{
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get();
  if (existing && !existing.sql.includes("'webpage'")) {
    db.exec(`
      ALTER TABLE documents RENAME TO documents_old;

      CREATE TABLE documents (
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

      INSERT INTO documents (id, user_id, department, filename, mime_type, kind, image_data, file_data, char_count, created_at)
        SELECT id, user_id, department, filename, mime_type, kind, image_data, file_data, char_count, created_at FROM documents_old;

      DROP TABLE documents_old;

      CREATE INDEX IF NOT EXISTS idx_documents_department ON documents(department);
    `);
  }
}

// SQLite's `ALTER TABLE ... RENAME TO` rewrites foreign-key references *in other tables* to
// point at the new name, so the `documents` rebuild above left `document_chunks`'s FK pointing at
// the now-dropped `documents_old`. Any insert into document_chunks then fails with "no such
// table: documents_old". Detect and repair that dangling reference by rebuilding document_chunks
// to point back at `documents`.
{
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'document_chunks'").get();
  if (existing && existing.sql.includes('documents_old')) {
    db.exec(`
      ALTER TABLE document_chunks RENAME TO document_chunks_old;

      CREATE TABLE document_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL
      );

      INSERT INTO document_chunks (id, document_id, chunk_index, content)
        SELECT id, document_id, chunk_index, content FROM document_chunks_old;

      DROP TABLE document_chunks_old;

      CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks(document_id);
    `);
  }
}

// Grandfather in the original local admin account created before roles existed.
db.prepare(`UPDATE users SET role = 'admin' WHERE username = 'admin' AND role != 'admin'`).run();

// Runs after the table rebuilds above, which recreate `documents` with a fixed column list.
// Personal documents (chat attachments, AI-generated files, fetched web pages) belong to the one
// user who created them — they're kept out of the shared department knowledge base, which is
// only for files deliberately uploaded for the whole department. Fetched web pages were always
// incidental to one person's chat, so existing ones are moved out of the shared base too.
if (!columnExists('documents', 'is_personal')) {
  db.exec(`ALTER TABLE documents ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0`);
  // PowerPoint files can't be uploaded, only generated, so they're always someone's chat output.
  db.exec(`UPDATE documents SET is_personal = 1 WHERE kind IN ('webpage', 'pptx') OR (kind = 'image' AND filename LIKE 'generated-%')`);
}

module.exports = db;
module.exports.DB_PATH = DB_PATH;

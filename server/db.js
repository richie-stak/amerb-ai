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
// 'en' | 'tw' | 'gaa' | 'fr' | 'auto' (match the language of the message); NULL = follow the bank
// default. See server/languages.js and server/languageSettings.js.
if (!columnExists('users', 'reply_language')) {
  db.exec(`ALTER TABLE users ADD COLUMN reply_language TEXT`);
}
// Which language an answer was written in, whether it was flagged as possibly garbled ("This answer
// may be unreliable in Twi"), and whether the staff member reported it as a bad translation. Stored
// on the message so the warning is still shown when the conversation is reopened, and so admins can
// count how often it happens.
if (!columnExists('messages', 'language')) {
  db.exec(`ALTER TABLE messages ADD COLUMN language TEXT`);
}
if (!columnExists('messages', 'language_warning')) {
  db.exec(`ALTER TABLE messages ADD COLUMN language_warning TEXT`);
}
if (!columnExists('messages', 'translation_flag')) {
  db.exec(`ALTER TABLE messages ADD COLUMN translation_flag TEXT`);
}

// The bank's approved wording for banking terms. One row per English term per language; the
// database enforces the pair being unique so an admin editing "loan" can't end up with two.
db.exec(`
  CREATE TABLE IF NOT EXISTS language_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language TEXT NOT NULL,
    english_term TEXT NOT NULL,
    local_term TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE (language, english_term)
  );
  CREATE INDEX IF NOT EXISTS idx_language_terms_language ON language_terms(language);

  -- One row per capability test run. A language is only offered to staff for a model while the most
  -- recent approved test for that model+language exists and nothing has failed since.
  CREATE TABLE IF NOT EXISTS language_capability_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    language TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('approved', 'failed')),
    score REAL,
    checks TEXT,
    tested_at TEXT NOT NULL DEFAULT (datetime('now')),
    tested_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_language_tests_model ON language_capability_tests(model, language, tested_at);
`);
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
// Which model actually wrote an answer (it can differ from the conversation's model when an
// answer falls back to another model), how long it took, and — for a fallback — which model was
// tried first. These feed the model-quality report in the admin portal.
if (!columnExists('messages', 'model')) {
  db.exec(`ALTER TABLE messages ADD COLUMN model TEXT`);
}
if (!columnExists('messages', 'duration_ms')) {
  db.exec(`ALTER TABLE messages ADD COLUMN duration_ms INTEGER`);
}
if (!columnExists('messages', 'fallback_from')) {
  db.exec(`ALTER TABLE messages ADD COLUMN fallback_from TEXT`);
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

// There is deliberately no "username admin becomes an admin" rule here any more. It used to
// grandparent the original account, but it also meant anyone who registered the name "admin" was
// promoted on the next restart, and that demoting that account never stuck. The first administrator is
// created explicitly instead — see BOOTSTRAP_ADMIN_EMAIL in routes/auth.js and the README.

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

// Where this document's copy lives inside data/knowledge/ (see server/knowledgeFolders.js). The
// database stays authoritative; the folders are kept in step for IT to open and back up.
if (!columnExists('documents', 'mirror_path')) {
  db.exec(`ALTER TABLE documents ADD COLUMN mirror_path TEXT`);
}

// --- Terminology: an optional context, who changed it, and an approval status ---
//
// `status` only matters when an administrator turns the approval workflow on: a term that is not
// approved is deliberately kept out of what the model is told, so an unreviewed translation can
// never be presented as the bank's approved wording.
if (!columnExists('language_terms', 'context')) {
  db.exec(`ALTER TABLE language_terms ADD COLUMN context TEXT`);
}
if (!columnExists('language_terms', 'status')) {
  db.exec(`ALTER TABLE language_terms ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);
}
if (!columnExists('language_terms', 'updated_by')) {
  db.exec(`ALTER TABLE language_terms ADD COLUMN updated_by INTEGER`);
}
if (!columnExists('language_terms', 'approved_by')) {
  db.exec(`ALTER TABLE language_terms ADD COLUMN approved_by INTEGER`);
}
if (!columnExists('language_terms', 'approved_at')) {
  db.exec(`ALTER TABLE language_terms ADD COLUMN approved_at TEXT`);
}

// Language-quality warnings, structured so an administrator can investigate a single event and spot
// a pattern ("this model keeps failing at Twi"). Deliberately holds references only — no question or
// answer text — so confidential banking content is not duplicated into a monitoring table.
db.exec(`
  CREATE TABLE IF NOT EXISTS language_quality_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    language TEXT NOT NULL,
    model TEXT,
    provider TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_language_events_at ON language_quality_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_language_events_model ON language_quality_events(model, language);

  -- One row per staff member per reply: their verdict on the translation. Replaced rather than
  -- appended so the counts stay honest, with the time of the latest change.
  CREATE TABLE IF NOT EXISTS response_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    category TEXT NOT NULL CHECK (category IN ('good', 'incorrect', 'unclear')),
    language TEXT,
    model TEXT,
    provider TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_response_feedback_category ON response_feedback(category, created_at);
`);

// --- Roles: add "auditor" (read-only access to records and reports) ---
//
// SQLite can't widen a CHECK constraint in place, so the table is rebuilt. Foreign keys are switched
// off for the swap on purpose: the new table is renamed into place, so every other table's
// `REFERENCES users(id)` keeps pointing at `users` (a plain rename of the *old* table would rewrite
// them to point at the old name — the bug already documented for `documents` below).
{
  const usersTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (usersTable && !usersTable.sql.includes("'auditor'")) {
    const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    const columnList = columns.join(', ');
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'auditor')),
        department TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        custom_instructions TEXT,
        reply_language TEXT,
        failed_login_count INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT
      );
      INSERT INTO users_new (${columnList}) SELECT ${columnList} FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
}

// One-time move of the old JSON glossary (app_settings.language_glossary) into language_terms, so an
// administrator's existing wording survives this upgrade. Only runs when the table is still empty.
{
  const existing = db.prepare('SELECT COUNT(*) AS n FROM language_terms').get().n;
  if (!existing) {
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'language_glossary'").get();
      const old = row ? JSON.parse(row.value) : null;
      const insert = db.prepare('INSERT OR IGNORE INTO language_terms (language, english_term, local_term) VALUES (?, ?, ?)');
      for (const language of ['tw', 'gaa']) {
        for (const [term, wording] of Object.entries(old?.[language] || {})) {
          if (typeof term === 'string' && typeof wording === 'string' && term.trim() && wording.trim()) {
            insert.run(language, term.trim().slice(0, 60), wording.trim().slice(0, 60));
          }
        }
      }
    } catch {
      /* an unreadable old glossary simply means starting empty */
    }
  }
}

module.exports = db;
module.exports.DB_PATH = DB_PATH;

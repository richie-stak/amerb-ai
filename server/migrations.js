// Versioned schema migrations.
//
// Before this file existed, db.js applied migrations inline as "add this column if it isn't there".
// That worked, but nothing recorded which changes had run, and there was no copy of the database taken
// before a start-up could change it — so a bug in an inline migration could damage the only copy of the
// bank's data with no way back. Now every change has a version and a name, is applied inside a
// transaction, is recorded in `schema_migrations`, and the database is snapshotted first (see
// dbMaintenance.js) whenever there is anything to apply.
//
// Rules for adding a migration:
//  1. Give it the next version number, and never edit one that has shipped — a fresh install and an
//     existing one must end up with the same schema.
//  2. Make it idempotent anyway (the runner wraps it in a transaction, but a crash between COMMIT and
//     the version row is possible if the process is killed mid-write).
//  3. No data loss without a backup — the runner takes one, but a migration should still say what it
//     removes in the commit message, and log repair counts rather than silently dropping rows.
const fs = require('node:fs');
const path = require('node:path');
const { backupDatabase } = require('./dbMaintenance');

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function tableSql(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row ? row.sql : null;
}

// ---------------------------------------------------------------------------
// Migration 1 — baseline: everything the schema had before versioning.
// It is idempotent, so it is correct for both an existing database (every column already present, no
// change) and a brand-new one (created by db.js just before this runs).
// ---------------------------------------------------------------------------
function baseline(db) {
  if (!columnExists(db, 'conversations', 'pinned')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id);
  `);

  const addColumn = (table, column, definition) => {
    if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };

  addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");
  addColumn('users', 'department', 'TEXT');
  addColumn('messages', 'attachments', 'TEXT');
  addColumn('messages', 'citations', 'TEXT');
  addColumn('document_chunks', 'heading', 'TEXT');
  addColumn('users', 'custom_instructions', 'TEXT');
  addColumn('users', 'reply_language', 'TEXT');
  addColumn('messages', 'language', 'TEXT');
  addColumn('messages', 'language_warning', 'TEXT');
  addColumn('messages', 'translation_flag', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS language_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      language TEXT NOT NULL CHECK (language IN ('tw', 'gaa', 'fr')),
      english_term TEXT NOT NULL,
      local_term TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      UNIQUE (language, english_term)
    );
    CREATE INDEX IF NOT EXISTS idx_language_terms_language ON language_terms(language);

    -- Evidence behind "may this language be offered with this model": one row per capability test.
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

  addColumn('messages', 'feedback', 'TEXT');
  addColumn('messages', 'thinking', 'TEXT');
  addColumn('messages', 'alt_group_id', 'INTEGER');
  db.exec('UPDATE messages SET alt_group_id = id WHERE alt_group_id IS NULL');
  addColumn('messages', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('messages', 'model', 'TEXT');
  addColumn('messages', 'duration_ms', 'INTEGER');
  addColumn('messages', 'fallback_from', 'TEXT');
  addColumn('documents', 'kind', "TEXT NOT NULL DEFAULT 'text'");
  addColumn('documents', 'image_data', 'TEXT');
  addColumn('documents', 'file_data', 'TEXT');
  addColumn('users', 'failed_login_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'locked_until', 'TEXT');

  // The documents table used to allow only some kinds; rebuild it when `webpage` is missing.
  const documentsSql = tableSql(db, 'documents');
  if (documentsSql && !documentsSql.includes("'webpage'")) {
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

  // SQLite's RENAME rewrites foreign-key references in other tables, so the documents rebuild above left
  // document_chunks pointing at the dropped documents_old. Repair that dangling reference.
  const chunksSql = tableSql(db, 'document_chunks');
  if (chunksSql && chunksSql.includes('documents_old')) {
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

  // Personal documents vs the shared department knowledge base.
  if (!columnExists(db, 'documents', 'is_personal')) {
    db.exec(`ALTER TABLE documents ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE documents SET is_personal = 1 WHERE kind IN ('webpage', 'pptx') OR (kind = 'image' AND filename LIKE 'generated-%')`);
  }

  // In-memory knowledge folders (data/knowledge/<base>/...). See server/knowledgeFolders.js.
  addColumn('documents', 'mirror_path', 'TEXT');

  // Terminology workflow: context, approval status and who changed/approved a term.
  addColumn('language_terms', 'context', 'TEXT');
  addColumn('language_terms', 'status', "TEXT NOT NULL DEFAULT 'approved'");
  addColumn('language_terms', 'updated_by', 'INTEGER');
  addColumn('language_terms', 'approved_by', 'INTEGER');
  addColumn('language_terms', 'approved_at', 'TEXT');

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

  // Roles: SQLite cannot widen a CHECK constraint in place, so the table is rebuilt. The rename keeps
  // every other table's REFERENCES users(id) pointing at `users`.
  const usersSql = tableSql(db, 'users');
  if (usersSql && !usersSql.includes("'auditor'")) {
    const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    const columnList = columns.join(', ');
    db.exec(`
      PRAGMA foreign_keys = OFF;
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
      PRAGMA foreign_keys = ON;
    `);
  }

  // One-time move of the old JSON glossary into the language_terms table.
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
}

// ---------------------------------------------------------------------------
// Migration 2 — record where the mirror_path column belongs to the schema, and make sure any future
// database gets it even if it is created by a code path that does not run the baseline.
// (It is already in the baseline above; keeping this entry documents the fix for the runtime error
// "no such column: mirror_path" that appeared on 19 Nov 2026.)
// ---------------------------------------------------------------------------
function ensureMirrorPath(db) {
  if (!columnExists(db, 'documents', 'mirror_path')) {
    db.exec(`ALTER TABLE documents ADD COLUMN mirror_path TEXT`);
  }
}

// ---------------------------------------------------------------------------
// Migration 3 — model roles (issue: an embedding model was stored as a conversation's chat model, so the
// app tried to chat with nomic-embed-text and silently fell back to qwen3). Remove that stale choice from
// the stored data and record what was changed, once per affected conversation. See
// server/modelCapabilities.js. Requires the model_catalog to exist, so the caller passes a classify
// function; when Ollama is unreachable the migration is left pending and retried on the next start.
// ---------------------------------------------------------------------------
function repairChatModelRoles(db, { classifyChatModel, chatModelDefault }) {
  if (typeof classifyChatModel !== 'function') {
    throw new Error('model role classification is not available yet');
  }
  const target = chatModelDefault || process.env.DEFAULT_MODEL || 'qwen3:4b-instruct';
  const conversations = db.prepare('SELECT id, model FROM conversations WHERE model IS NOT NULL').all();
  const affected = conversations.filter((row) => classifyChatModel(row.model) === 'embedding');
  const replacedModels = [...new Set(affected.map((row) => row.model))];
  if (affected.length) {
    // conversations.model is NOT NULL, so a conversation that named an embedding model is re-pointed at
    // the configured chat model rather than left empty. This is a repair of invalid saved data, reported
    // in the log and in app_settings, not a silent substitution at answer time.
    const update = db.prepare('UPDATE conversations SET model = ? WHERE id = ?');
    // The runner owns the transaction.
    for (const row of affected) update.run(target, row.id);
  }
  const messages = db.prepare('SELECT id, model FROM messages WHERE model IS NOT NULL').all();
  const clearMessage = db.prepare('UPDATE messages SET model = NULL WHERE id = ?');
  let cleared = 0;
  for (const row of messages) {
    if (classifyChatModel(row.model) === 'embedding') {
      clearMessage.run(row.id);
      cleared += 1;
    }
  }
  if (affected.length || cleared) {
    const summary = {
      at: new Date().toISOString(),
      conversations: affected.length,
      messages: cleared,
      replaced: replacedModels,
      with: target,
    };
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      'model_roles_repaired',
      JSON.stringify(summary)
    );
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      'model_roles_repaired_at',
      summary.at
    );
  }
  return { conversations: affected.length, messages: cleared, models: replacedModels, with: target };
}

// ---------------------------------------------------------------------------
// Migration 4 — remove orphaned rows left behind by older code paths.
//
// PRAGMA foreign_key_check reported one message whose conversation_id pointed at a conversation that no
// longer existed (a conversation deleted by an older build that did not cascade). Such a row can never be
// shown to anyone, but it makes every foreign-key check fail and hides real problems, so it is removed
// once, with the count logged. Nothing reachable is touched.
// ---------------------------------------------------------------------------
function removeOrphans(db) {
  const removed = { messages: 0, chunks: 0 };
  removed.messages = db
    .prepare('DELETE FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)')
    .run().changes;
  removed.chunks = db
    .prepare('DELETE FROM document_chunks WHERE document_id NOT IN (SELECT id FROM documents)')
    .run().changes;
  return removed;
}

const MIGRATIONS = [
  { version: 1, name: 'baseline-schema', up: baseline, ownTransaction: true },
  { version: 2, name: 'documents-mirror-path', up: ensureMirrorPath },
  {
    version: 3,
    name: 'chat-model-roles',
    description: 'Clear an embedding model stored as a conversation\'s chat model (it cannot chat).',
    needs: 'model-roles',
    up: (db, context) => repairChatModelRoles(db, context),
  },
  {
    version: 4,
    name: 'remove-orphaned-rows',
    description: 'Delete messages/chunks whose parent was removed by an older build (unreachable rows).',
    up: removeOrphans,
  },
];

function appliedVersions(db) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return new Set();
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// Runs every pending migration in order, with a snapshot of the database taken before the first change
// when there is existing data to protect. Returns { applied, skipped, backup }.
function runMigrations(db, { dbPath, log = () => {}, context = {}, appliedNow = new Set() } = {}) {
  ensureMigrationsTable(db);
  const done = appliedVersions(db);
  const pending = MIGRATIONS.filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version);
  const result = { applied: [], skipped: [], backup: null, pending: pending.length };
  if (!pending.length) {
    log('Database schema is up to date.');
    return result;
  }

  // A migration that needs model classification cannot run while Ollama is down; leave it for the next
  // start rather than guessing (guessing would be exactly the "silently substitute a model" bug).
  const runnable = [];
  for (const migration of pending) {
    if (migration.needs === 'model-roles' && !context.classifyChatModel) {
      result.skipped.push(migration);
      continue;
    }
    runnable.push(migration);
  }
  if (!runnable.length) return result;

  // Take a snapshot before changing anything — but not for an empty/new database, where there is no data
  // to lose and every start would leave a pointless file behind.
  const hasData = (() => {
    try {
      const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      return users > 0;
    } catch {
      return false;
    }
  })();
  if (dbPath && hasData) {
    try {
      result.backup = backupDatabase(dbPath, { tag: `pre-migration-v${runnable[0].version}`, log });
    } catch (err) {
      // Refusing to migrate is the safe response when the safety net cannot be created.
      throw new Error(`Refusing to apply schema changes: could not back up the database first (${err.message})`);
    }
  }

  for (const migration of runnable) {
    log(`Applying migration ${migration.version}: ${migration.name}…`);
    let detail;
    if (migration.ownTransaction) {
      // Some migrations have to run outside a transaction: switching foreign keys off to rebuild a table
      // is a no-op inside one. They are written to be idempotent, so a crash mid-way is repaired by the
      // next start rather than needing a rollback.
      detail = migration.up(db, context);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
    } else {
      db.exec('BEGIN IMMEDIATE');
      try {
        detail = migration.up(db, context);
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        // A failed migration must stop the app from starting against a half-changed schema.
        throw new Error(`Migration ${migration.version} (${migration.name}) failed and was rolled back: ${err.message}`);
      }
    }
    result.applied.push({ ...migration, detail });
    appliedNow.add(migration.version);
    log(`Migration ${migration.version} (${migration.name}) applied.`);
  }
  return result;
}

function migrationStatus(db) {
  const done = appliedVersions(db);
  return MIGRATIONS.map((m) => ({
    version: m.version,
    name: m.name,
    description: m.description || null,
    applied: done.has(m.version),
  }));
}

module.exports = { MIGRATIONS, runMigrations, migrationStatus, appliedVersions, ensureMigrationsTable };

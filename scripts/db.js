#!/usr/bin/env node
// Database operations for AMERB AI:  node scripts/db.js <command>
//
//   status   list the migrations and whether each has been applied (read-only)
//   migrate  apply pending migrations now (the server does this itself on start; this is for a
//            controlled change before a restart, e.g. during planned maintenance)
//   backup   take a verified snapshot into data/backups/ (safe while the app is running)
//   check    integrity_check + foreign_key_check + row counts (read-only)
//   list     list the snapshots in data/backups/
//   restore <file>   replace the live database with a snapshot (makes a safety copy of the current one
//                    first). Stop the app before restoring.
//
// Everything works on data/amerb-ai.sqlite (or AMERB_DB_PATH when set), the path the server itself uses.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const DB_PATH = process.env.AMERB_DB_PATH || path.join(ROOT, 'data', 'amerb-ai.sqlite');
const { backupDatabase, listBackups, checkIntegrity, defaultBackupDir } = require('../server/dbMaintenance');
const { migrationStatus } = require('../server/migrations');

const log = (message) => console.log(message);
const [command, ...args] = process.argv.slice(2);

function readOnly(fn) {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

const commands = {
  status() {
    readOnly((db) => {
      console.log(`Database: ${DB_PATH}`);
      const migrations = migrationStatus(db);
      const applied = migrations.filter((m) => m.applied).length;
      console.log(`Migrations: ${applied}/${migrations.length} applied\n`);
      for (const migration of migrations) {
        console.log(`  ${migration.applied ? '[applied]' : '[pending]'} v${migration.version}  ${migration.name}`);
        if (migration.description) console.log(`             ${migration.description}`);
      }
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
      if (!hasTable) console.log('\n(no schema_migrations table yet — this database predates versioned migrations)');
    });
  },

  migrate() {
    // Requiring the database module applies the migrations, with the same backup rule as a server start.
    const db = require('../server/db');
    const rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
    console.log('\nApplied migrations:');
    for (const row of rows) console.log(`  v${row.version}  ${row.name}  (${row.applied_at})`);
  },

  backup() {
    const file = backupDatabase(DB_PATH, { tag: 'manual', log });
    console.log(`Snapshot: ${file}`);
  },

  list() {
    const backups = listBackups(DB_PATH);
    if (!backups.length) return console.log(`No snapshots in ${defaultBackupDir(DB_PATH)}`);
    console.log(`Snapshots in ${defaultBackupDir(DB_PATH)}:`);
    for (const file of backups) console.log(`  ${file.name}  ${formatBytes(file.size)}  ${file.modified}`);
  },

  check() {
    readOnly((db) => {
      const integrity = checkIntegrity(db);
      console.log(`Database: ${DB_PATH}`);
      console.log(`quick_check: ${JSON.stringify(integrity.quickCheck)}`);
      console.log(`foreign_key_check: ${integrity.foreignKeyIssues.length ? JSON.stringify(integrity.foreignKeyIssues) : 'clean'}`);
      for (const table of ['users', 'conversations', 'messages', 'documents', 'document_chunks', 'document_chunks', 'audit_log', 'sessions']) {
        try {
          console.log(`  ${table}: ${db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n}`);
        } catch {
          /* table may not exist yet */
        }
      }
      console.log(`\nResult: ${integrity.ok ? 'integrity OK' : 'INTEGRITY PROBLEM — restore the newest snapshot from data/backups'}`);
    });
  },

  async restore() {
    const file = args[0];
    if (!file) {
      console.error('Usage: node scripts/db.js restore <path-to-snapshot.sqlite>');
      process.exit(2);
    }
    const source = path.resolve(file);
    if (!fs.existsSync(source)) {
      console.error(`No such snapshot: ${source}`);
      process.exit(1);
    }
    // Verify the snapshot before it replaces anything, and keep the current database as a snapshot too.
    const check = new DatabaseSync(source, { readOnly: true });
    try {
      if (!checkIntegrity(check).ok) {
        console.error('That snapshot fails its integrity check — not restoring it.');
        process.exit(1);
      }
    } finally {
      check.close();
    }
    if (fs.existsSync(DB_PATH)) backupDatabase(DB_PATH, { tag: 'pre-restore', log });
    // The app must be stopped: a second process writing to the same file would corrupt it.
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
    fs.copyFileSync(source, DB_PATH);
    console.log(`Restored ${source} -> ${DB_PATH}`);
    console.log('Start the app again: npm start');
  },
};

const run = commands[command];
if (!run) {
  console.error('Usage: node scripts/db.js <status|migrate|backup|list|check|restore>');
  process.exit(2);
}
Promise.resolve(run()).catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});

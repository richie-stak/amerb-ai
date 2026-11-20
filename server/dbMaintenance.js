// Database maintenance: safe snapshots and integrity checks.
//
// The bank's entire history — users, conversations, documents, provider keys, audit log — lives in one
// SQLite file. A copy that is taken by simply copying the file while the app is running can be torn
// (the write-ahead log holds committed pages that are not in the main file yet), so snapshots use
// `VACUUM INTO`, which produces a consistent, already-compacted database in one step. Every snapshot is
// integrity-checked before it is kept, and a snapshot that fails the check is deleted and reported
// rather than left behind looking like a backup.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function defaultBackupDir(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
}

// Filename-safe UTC timestamp, e.g. 2026-11-20T08-15-30.
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function checkIntegrity(db) {
  const quick = db.prepare('PRAGMA quick_check').all();
  const quickOk = quick.length === 1 && Object.values(quick[0])[0] === 'ok';
  let foreignKeyIssues = [];
  try {
    foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
  } catch {
    foreignKeyIssues = [];
  }
  // Structural damage (quick_check) decides whether a snapshot is usable. Dangling foreign keys are a
  // *data* problem, not a corrupted file: they are reported, but they must not block taking a backup —
  // refusing to back up a database because of a pre-existing orphan row would be exactly backwards.
  return { ok: quickOk, quickCheck: quick, foreignKeyIssues };
}

// Backs the database up to data/backups/<tag>-<timestamp>.sqlite (returns the path), verified.
function backupDatabase(dbPath, { dir, tag = 'backup', log = () => {}, keep = 20 } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const backupDir = dir || defaultBackupDir(dbPath);
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `${tag}-${stamp()}.sqlite`);

  const source = new DatabaseSync(dbPath);
  try {
    // A consistent snapshot including everything committed to the WAL.
    source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }

  const copy = new DatabaseSync(target, { readOnly: true });
  let integrity;
  try {
    integrity = checkIntegrity(copy);
  } finally {
    copy.close();
  }
  if (!integrity.ok) {
    fs.rmSync(target, { force: true });
    throw new Error(`the snapshot failed its integrity check (${JSON.stringify(integrity.quickCheck)})`);
  }
  if (integrity.foreignKeyIssues.length) {
    log(`Database backed up with ${integrity.foreignKeyIssues.length} pre-existing dangling foreign-key row(s) — inspect with PRAGMA foreign_key_check.`);
  }

  const { size } = fs.statSync(target);
  log(`Database backed up: ${target} (${(size / 1024 / 1024).toFixed(1)} MB, integrity ok)`);
  pruneBackups(backupDir, keep);
  return target;
}

function listBackups(dbPath) {
  const dir = defaultBackupDir(dbPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, path: full, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

// Keeps the most recent `keep` snapshots (never deletes the newest one, even if `keep` is 0).
function pruneBackups(backupDir, keep) {
  if (!Number.isFinite(keep)) return;
  const files = fs
    .readdirSync(backupDir)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => ({ name, modified: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  for (const file of files.slice(Math.max(1, keep))) {
    try {
      fs.rmSync(path.join(backupDir, file.name), { force: true });
    } catch {
      /* a locked old snapshot is harmless; it will be pruned next time */
    }
  }
}

module.exports = { backupDatabase, listBackups, checkIntegrity, defaultBackupDir, pruneBackups };

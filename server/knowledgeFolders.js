// One folder per knowledge base, on disk, next to the database:
//
//   data/knowledge/Bank-wide/                 every policy an admin published for the whole bank
//   data/knowledge/Department - Credit/       the Credit department's shared files
//   data/knowledge/Personal - ama.mensah/     one person's chat attachments and AI-made files
//
// The database remains the single source of truth: this module keeps the folders as a copy so IT can
// open them in Explorer, copy them to a backup drive, or hand a department its own folder — with the
// same access rules the app enforces. Files are written beside the database (which is also unencrypted
// on that disk), never somewhere new.
//
// Everything here is best-effort: a folder that can't be written must never fail an upload. A
// periodic reconcile (sync) repairs anything missed — a file deleted outside the app, a document
// created by a path that forgot to call mirrorDocument, a document deleted without its copy.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const logger = require('./logger');
const { BANKWIDE_DEPARTMENT } = require('./departments');

const ROOT = path.join(path.dirname(db.DB_PATH), 'knowledge');
const README = `AMERB AI knowledge base folders
================================

These folders are a copy of the documents in the AMERB AI database, kept in one place per knowledge
base so they can be opened, copied or backed up without the app:

  Bank-wide                  bank policies and procedures — visible to every staff member; only
                             administrators add or remove them
  Department - <name>        shared with that department only
  Personal - <username>      one person's own files (chat attachments, generated documents)

The database (data/amerb-ai.sqlite) is the authoritative copy and the app enforces access rules from
it. Files deleted by hand here are restored from the database by the next sync; files added here by
hand are removed by it. To remove a document, delete it in the app.
`;

// Windows forbids these characters in a file name, and a department or username could contain them.
function safeSegment(value, fallback = 'Unknown') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned || fallback).slice(0, 80);
}

function safeFilename(filename, fallback = 'file') {
  const safe = safeSegment(path.basename(String(filename || '')), fallback);
  return safe.slice(0, 120) || fallback;
}

// Which folder a document belongs in. Mirrors documentAccess.scopeOf, but by name because that is
// what a person opening Explorer needs to see.
function folderForDocument(doc) {
  if (doc.is_personal) return `Personal - ${safeSegment(doc.owner_username || `user ${doc.user_id}`)}`;
  if (doc.department === BANKWIDE_DEPARTMENT) return 'Bank-wide';
  return `Department - ${safeSegment(doc.department)}`;
}

function extensionFor(doc) {
  if (doc.kind === 'docx') return '.docx';
  if (doc.kind === 'xlsx') return '.xlsx';
  if (doc.kind === 'pptx') return '.pptx';
  if (doc.kind === 'pdf') return '.pdf';
  if (doc.kind === 'image') return '.png';
  if (doc.kind === 'webpage') return '.txt';
  return '.txt';
}

// The bytes to write: the original file when there is one, the image, or nothing (a fetched web page
// is handled separately, below).
function contentFor(doc) {
  if (doc.file_data) return { data: Buffer.from(String(doc.file_data), 'base64') };
  if (doc.image_data) return { data: Buffer.from(String(doc.image_data), 'base64') };
  return null;
}

function deleteQuietly(absolutePath) {
  try {
    if (absolutePath && fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch (err) {
    logger.debug('Could not remove a knowledge folder file', { path: absolutePath, error: err.message });
  }
}

// Writes (or moves) the copy for one document and records where it went. Never throws.
function mirrorDocument(doc) {
  if (!doc || !doc.id) return null;
  try {
    const folderPath = folderForDocument(doc);
    let relative = null;
    let data = null;

    const content = contentFor(doc);
    if (content) {
      data = content.data;
      // Keep the original name (and its extension) where it is meaningful, and give anything else the
      // extension its kind implies, so Explorer shows the right icon and opens it with the right app.
      const original = safeFilename(doc.filename);
      const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(original);
      const name = hasExtension ? original : `${original}${extensionFor(doc)}`;
      relative = path.join(folderPath, `${doc.id} - ${name}`);
    } else if (doc.kind === 'webpage') {
      // A fetched page has no file of its own: keep its extracted text so the folder still reflects
      // what the bank has, instead of silently omitting it.
      const chunks = db.prepare('SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC').all(doc.id);
      data = Buffer.from(chunks.map((c) => c.content).join('\n\n'), 'utf8');
      relative = path.join(folderPath, `${doc.id} - ${safeFilename(doc.filename, 'web page')}.txt`);
    }
    if (!relative) return null;

    const absolute = path.join(ROOT, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, data);

    // A document that moved between knowledge bases (a file shared with a department, then published
    // bank-wide) must not be left behind in the folder it no longer belongs to.
    if (doc.mirror_path && doc.mirror_path !== relative) deleteQuietly(path.join(ROOT, doc.mirror_path));
    if (doc.mirror_path !== relative) db.prepare('UPDATE documents SET mirror_path = ? WHERE id = ?').run(relative, doc.id);
    return relative;
  } catch (err) {
    logger.warn('Could not copy a document into its knowledge folder', { documentId: doc.id, error: err.message });
    return null;
  }
}

function mirrorDocumentById(id) {
  const doc = db
    .prepare(
      `SELECT d.*, u.username AS owner_username FROM documents d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = ?`
    )
    .get(id);
  return doc ? mirrorDocument(doc) : null;
}

// Removes the copy for a document (call it before the row is deleted, while the path is known).
function removeDocumentCopy(doc) {
  if (!doc) return;
  try {
    if (doc.mirror_path) deleteQuietly(path.join(ROOT, doc.mirror_path));
    else if (doc.id) {
      const row = db.prepare('SELECT mirror_path FROM documents WHERE id = ?').get(doc.id);
      if (row?.mirror_path) deleteQuietly(path.join(ROOT, row.mirror_path));
    }
  } catch (err) {
    logger.debug('Could not remove a knowledge folder copy', { documentId: doc.id, error: err.message });
  }
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, out);
    else out.push(path.relative(ROOT, absolute));
  }
  return out;
}

// Brings the folders back in line with the database: writes missing copies, drops files that no
// longer correspond to a document, and removes folders that have become empty. Returns counts so the
// admin portal (and the tests) can see what it did.
function sync() {
  const created = { written: 0, removed: 0, moved: 0 };
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    const readmePath = path.join(ROOT, 'README.txt');
    if (!fs.existsSync(readmePath)) fs.writeFileSync(readmePath, README);

    const docs = db
      .prepare(`SELECT d.*, u.username AS owner_username FROM documents d LEFT JOIN users u ON u.id = d.user_id`)
      .all();
    const expected = new Set();
    for (const doc of docs) {
      const folder = folderForDocument(doc);
      // Every document gets a file, including fetched pages (as text).
      const before = doc.mirror_path;
      const written = mirrorDocument({ ...doc, mirror_path: before && fs.existsSync(path.join(ROOT, before)) ? before : null });
      if (written) {
        expected.add(written);
        if (!before) created.written += 1;
        else if (before !== written) created.moved += 1;
      } else if (before) {
        expected.add(before);
      }
      // A folder that exists but is empty (e.g. every file deleted elsewhere) is cleaned at the end.
      void folder;
    }

    for (const relative of walk(ROOT)) {
      if (relative === 'README.txt' || expected.has(relative)) continue;
      deleteQuietly(path.join(ROOT, relative));
      created.removed += 1;
    }

    // Drop folders with nothing left in them, deepest first.
    const dirs = [];
    (function collect(dir) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const absolute = path.join(dir, entry.name);
        collect(absolute);
        dirs.push(absolute);
      }
    })(ROOT);
    for (const dir of dirs.sort((a, b) => b.length - a.length)) {
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        /* in use — try again next time */
      }
    }
  } catch (err) {
    logger.warn('Could not synchronise the knowledge folders', { error: err.message });
  }
  return created;
}

let timer = null;

// Keeps the folders current in the background. Runs shortly after start (so documents uploaded before
// this feature existed appear), then every few minutes for anything the per-upload hooks missed.
function startBackgroundSync({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (timer) return;
  const run = () => {
    try {
      sync();
    } catch (err) {
      logger.warn('Knowledge folder sync failed', { error: err.message });
    }
  };
  setTimeout(run, 5000).unref();
  timer = setInterval(run, intervalMs);
  timer.unref();
}

module.exports = { ROOT, folderForDocument, mirrorDocument, mirrorDocumentById, removeDocumentCopy, sync, startBackgroundSync };

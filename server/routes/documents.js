const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { extractText, chunkText, isImageFile, imageMimeType } = require('../documentExtract');
const { BANKWIDE_DEPARTMENT, DEPARTMENTS } = require('../departments');
const { SCOPES, scopeOf, canAccessDoc, canDeleteDoc, searchableWhere } = require('../documentAccess');

const router = express.Router();
router.use(requireAuth);

const ACCEPTED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.xls', '.xlsm', '.csv', '.txt', '.md',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif',
]);

// Kinds with a real preview renderer (mammoth for docx, SheetJS for xlsx, iframe for pdf) get
// their original bytes stored so the preview panel works the same way it does for generated
// files. Only below this size, to keep the database from ballooning on large uploads.
const PREVIEWABLE_KIND_BY_EXT = { '.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.xls': 'xlsx', '.xlsm': 'xlsx' };
const MAX_PREVIEW_FILE_BYTES = 15 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
  fileFilter(req, file, cb) {
    const path = require('node:path');
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.has(ext)) {
      return cb(new Error(`Unsupported file type: ${ext || 'unknown'}`));
    }
    cb(null, true);
  },
});

function currentUser(req) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
}

const DOC_COLUMNS = `d.id, d.user_id, d.filename, d.department, d.is_personal, d.mime_type, d.kind, d.char_count,
  d.created_at, u.username AS uploaded_by`;

function withScope(doc) {
  return { ...doc, scope: scopeOf(doc) };
}

// List documents visible to the current user: bank-wide, their department's shared files, and
// their own personal files. Admins see every document so they can manage them — except other
// people's personal chat files, unless they ask for them with ?all=1 (the admin portal does).
router.get('/', (req, res) => {
  const user = currentUser(req);
  let rows;
  if (user.role === 'admin' && req.query.all === '1') {
    rows = db.prepare(`SELECT ${DOC_COLUMNS} FROM documents d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC`).all();
  } else if (user.role === 'admin') {
    rows = db
      .prepare(
        `SELECT ${DOC_COLUMNS} FROM documents d JOIN users u ON u.id = d.user_id
         WHERE d.is_personal = 0 OR d.user_id = ? ORDER BY d.created_at DESC`
      )
      .all(user.id);
  } else {
    const where = searchableWhere(user);
    rows = db
      .prepare(`SELECT ${DOC_COLUMNS} FROM documents d JOIN users u ON u.id = d.user_id WHERE ${where.sql} ORDER BY d.created_at DESC`)
      .all(...where.params);
  }
  res.json({ documents: rows.map(withScope) });
});

// Works out where an upload goes from the `scope` form field (plus `department` for an admin
// uploading on a department's behalf). Returns { department, isPersonal } or { error, status }.
function uploadTarget(user, body) {
  // `bankwide=true` is the older form of scope=global, still accepted.
  const scope = body.bankwide === 'true' ? 'global' : body.scope || 'personal';
  if (!SCOPES.includes(scope)) return { error: `Unknown scope "${scope}"`, status: 400 };

  if (scope === 'global') {
    if (user.role !== 'admin') {
      return { error: 'Only an admin can add documents to the bank-wide knowledge base.', status: 403 };
    }
    return { department: BANKWIDE_DEPARTMENT, isPersonal: false };
  }

  if (scope === 'department') {
    const requested = typeof body.department === 'string' && body.department.trim();
    if (requested && requested !== user.department) {
      if (user.role !== 'admin') {
        return { error: "You can only add documents to your own department's knowledge base.", status: 403 };
      }
      if (!DEPARTMENTS.includes(requested)) return { error: `Unknown department "${requested}"`, status: 400 };
      return { department: requested, isPersonal: false };
    }
    if (!user.department) {
      return { error: 'Your account has no department set. Ask an admin to assign one.', status: 400 };
    }
    return { department: user.department, isPersonal: false };
  }

  // Personal files still record the owner's department, purely for the admin's reporting.
  return { department: user.department || 'General', isPersonal: true };
}

router.post('/', upload.array('files', 5), asyncHandler(async (req, res) => {
  const user = currentUser(req);
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files were uploaded' });
  }

  const target = uploadTarget(user, req.body || {});
  if (target.error) return res.status(target.status).json({ error: target.error });
  const targetDepartment = target.department;

  const path = require('node:path');
  const results = [];
  for (const file of req.files) {
    const isImage = isImageFile(file.originalname, file.mimetype);
    const ext = path.extname(file.originalname).toLowerCase();
    // Uploads previously stored every non-image file as a generic "text" kind, which meant the
    // docx/xlsx/pdf preview renderers (built for AI-generated files) never matched an uploaded
    // file's kind and silently never applied. Tagging uploads with their real kind, the same way
    // generated files already are, is what makes the preview panel work for them too.
    const previewKind = !isImage && PREVIEWABLE_KIND_BY_EXT[ext];

    try {
      const text = await extractText(file.buffer, file.originalname, file.mimetype);
      const chunks = chunkText(text);

      // Text documents are useless to us without extractable text (e.g. a scanned, image-only
      // PDF that pdf-parse can't read) — but images are still worth keeping even with no OCR
      // text, since a vision-capable model can look at the picture directly.
      if (!chunks.length && !isImage) {
        const hint =
          ext === '.pdf'
            ? 'No extractable text found — if this is a scanned document, try uploading it as an image (PNG/JPG) instead so it can be OCR\'d.'
            : 'No extractable text found';
        results.push({ filename: file.originalname, error: hint });
        continue;
      }

      const kind = isImage ? 'image' : previewKind || 'text';
      // Every non-image upload keeps its original bytes (size permitting) so it can be downloaded
      // exactly as uploaded later — not just the kinds with a rich preview renderer.
      const storeAsFileData = !isImage && file.buffer.length <= MAX_PREVIEW_FILE_BYTES;

      const docResult = db
        .prepare(
          'INSERT INTO documents (user_id, department, is_personal, filename, mime_type, kind, image_data, file_data, char_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          user.id,
          targetDepartment,
          target.isPersonal ? 1 : 0,
          file.originalname,
          isImage ? imageMimeType(file.originalname, file.mimetype) : file.mimetype || '',
          kind,
          isImage ? file.buffer.toString('base64') : null,
          storeAsFileData ? file.buffer.toString('base64') : null,
          text.length
        );

      if (chunks.length) {
        const insertChunk = db.prepare(
          'INSERT INTO document_chunks (document_id, chunk_index, content, heading) VALUES (?, ?, ?, ?)'
        );
        chunks.forEach((chunk, idx) => insertChunk.run(docResult.lastInsertRowid, idx, chunk.text, chunk.heading));
      }

      results.push({
        id: docResult.lastInsertRowid,
        filename: file.originalname,
        department: targetDepartment,
        scope: target.isPersonal ? 'personal' : targetDepartment === BANKWIDE_DEPARTMENT ? 'global' : 'department',
        kind,
        charCount: text.length,
      });
    } catch (err) {
      results.push({ filename: file.originalname, error: err.message || 'Failed to process file' });
    }
  }

  res.json({ results });
}));

// Serves the raw image bytes for preview (e.g. a thumbnail in the knowledge base or chat).
router.get('/:id/image', (req, res) => {
  const user = currentUser(req);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc || doc.kind !== 'image' || !doc.image_data) return res.status(404).end();

  const canView = canAccessDoc(doc, user);
  if (!canView) return res.status(403).end();

  res.setHeader('Content-Type', doc.mime_type || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(doc.image_data, 'base64'));
});

function chunkTextFor(documentId) {
  const chunks = db
    .prepare('SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC')
    .all(documentId);
  return chunks.map((c) => c.content).join('\n\n');
}

// Serves the document for download or preview. PDFs are inline by default so they can be embedded
// directly in an <iframe> preview; pass ?download=1 to force a save-as regardless of kind (used by
// the knowledge base page, which always wants a real download rather than an inline PDF view).
// Images use their own stored bytes; anything with no original bytes on file at all (e.g. a
// fetched webpage, which was never a file to begin with) falls back to a reconstructed .txt of
// whatever text was indexed for it, so nothing in the knowledge base is a dead end.
router.get('/:id/file', (req, res) => {
  const user = currentUser(req);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).end();
  if (!canAccessDoc(doc, user)) return res.status(403).end();

  const forceDownload = req.query.download === '1';

  if (doc.kind === 'image' && doc.image_data) {
    res.setHeader('Content-Type', doc.mime_type || 'image/png');
    res.setHeader('Content-Disposition', `${forceDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(doc.filename)}"`);
    return res.send(Buffer.from(doc.image_data, 'base64'));
  }

  if (doc.file_data) {
    const disposition = doc.kind === 'pdf' && !forceDownload ? 'inline' : 'attachment';
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(doc.filename)}"`);
    return res.send(Buffer.from(doc.file_data, 'base64'));
  }

  const text = chunkTextFor(doc.id);
  if (!text) return res.status(404).json({ error: 'Nothing to download for this document' });
  const safeName = doc.filename.replace(/[^a-z0-9._-]/gi, '_');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.txt"`);
  res.send(text);
});

// Best-effort inline preview for the side panel: docx/xlsx are converted to HTML on the fly;
// pptx/text/webpage return the plain text that was indexed for search; pdf doesn't need this
// route since the browser can render /file directly in an iframe.
router.get('/:id/preview', asyncHandler(async (req, res) => {
  const user = currentUser(req);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!canAccessDoc(doc, user)) return res.status(403).json({ error: 'Not authorized' });

  try {
    if ((doc.kind === 'docx' || doc.kind === 'xlsx') && !doc.file_data) {
      return res.json({ type: 'text', text: chunkTextFor(doc.id) || '(No preview available for this file.)' });
    }
    if (doc.kind === 'docx') {
      const mammoth = require('mammoth');
      const buffer = Buffer.from(doc.file_data, 'base64');
      const result = await mammoth.convertToHtml({ buffer });
      return res.json({ type: 'html', html: result.value });
    }
    if (doc.kind === 'xlsx') {
      const XLSX = require('xlsx');
      const buffer = Buffer.from(doc.file_data, 'base64');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const html = XLSX.utils.sheet_to_html(firstSheet);
      return res.json({ type: 'html', html });
    }
    if (doc.kind === 'pptx' || doc.kind === 'text' || doc.kind === 'webpage') {
      return res.json({ type: 'text', text: chunkTextFor(doc.id) || '(No extracted text available.)' });
    }
    return res.status(400).json({ error: 'No preview available for this file type' });
  } catch (err) {
    res.status(500).json({ error: 'Could not generate preview', details: err.message });
  }
}));

router.delete('/:id', (req, res) => {
  const user = currentUser(req);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!canDeleteDoc(doc, user)) {
    const reason =
      scopeOf(doc) === 'global'
        ? 'Only an admin can remove bank-wide documents.'
        : 'Only the person who uploaded this document (or an admin) can delete it.';
    return res.status(403).json({ error: reason });
  }

  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  res.json({ ok: true });
});

// Shares one of your personal files (a chat attachment or AI-generated file) with your whole
// department, moving it into the department knowledge base. Admins may share anyone's file, or
// publish it bank-wide with { scope: 'global' }.
router.patch('/:id/share', (req, res) => {
  const user = currentUser(req);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.user_id !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only share your own files.' });
  }

  const scope = (req.body && req.body.scope) || 'department';
  if (scope === 'global') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can publish documents bank-wide.' });
    db.prepare('UPDATE documents SET is_personal = 0, department = ? WHERE id = ?').run(BANKWIDE_DEPARTMENT, doc.id);
  } else if (scope === 'department') {
    const owner = db.prepare('SELECT department FROM users WHERE id = ?').get(doc.user_id);
    const department = owner?.department;
    if (!department) return res.status(400).json({ error: 'This file\'s owner has no department to share it with.' });
    db.prepare('UPDATE documents SET is_personal = 0, department = ? WHERE id = ?').run(department, doc.id);
  } else {
    return res.status(400).json({ error: 'scope must be "department" or "global"' });
  }
  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  res.json({ ok: true, scope: scopeOf(updated), department: updated.department });
});

module.exports = router;

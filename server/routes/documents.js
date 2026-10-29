const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { extractText, chunkText, isImageFile, imageMimeType } = require('../documentExtract');
const { BANKWIDE_DEPARTMENT } = require('../departments');

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

// List documents visible to the current user: their own department, or all if admin.
router.get('/', (req, res) => {
  const user = currentUser(req);
  const rows =
    user.role === 'admin'
      ? db
          .prepare(
            `SELECT d.id, d.filename, d.department, d.mime_type, d.kind, d.char_count, d.created_at, u.username AS uploaded_by
             FROM documents d JOIN users u ON u.id = d.user_id
             ORDER BY d.created_at DESC`
          )
          .all()
      : db
          .prepare(
            `SELECT d.id, d.filename, d.department, d.mime_type, d.kind, d.char_count, d.created_at, u.username AS uploaded_by
             FROM documents d JOIN users u ON u.id = d.user_id
             WHERE d.department = ? OR d.user_id = ? OR d.department = ?
             ORDER BY d.created_at DESC`
          )
          .all(user.department || '__none__', user.id, BANKWIDE_DEPARTMENT);

  res.json({ documents: rows });
});

router.post('/', upload.array('files', 5), asyncHandler(async (req, res) => {
  const user = currentUser(req);
  if (!user.department) {
    return res.status(400).json({ error: 'Your account has no department set. Ask an admin to assign one.' });
  }
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files were uploaded' });
  }

  // Only an admin can publish to the bank-wide section — it's visible to every department,
  // so it isn't something a regular department upload should be able to opt into.
  const targetDepartment =
    user.role === 'admin' && req.body.bankwide === 'true' ? BANKWIDE_DEPARTMENT : user.department;

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
          'INSERT INTO documents (user_id, department, filename, mime_type, kind, image_data, file_data, char_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          user.id,
          targetDepartment,
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

function canAccessDoc(doc, user) {
  return (
    user.role === 'admin' ||
    doc.user_id === user.id ||
    doc.department === user.department ||
    doc.department === BANKWIDE_DEPARTMENT
  );
}

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

  const canDelete = user.role === 'admin' || doc.user_id === user.id;
  if (!canDelete) return res.status(403).json({ error: 'Not authorized to delete this document' });

  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  res.json({ ok: true });
});

module.exports = router;

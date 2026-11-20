const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { extractText, chunkText, isImageFile, imageMimeType } = require('../documentExtract');
const { BANKWIDE_DEPARTMENT, DEPARTMENTS } = require('../departments');
const { SCOPES, scopeOf, canAccessDoc, canDeleteDoc, searchableWhere } = require('../documentAccess');
const knowledgeFolders = require('../knowledgeFolders');
const logger = require('../logger');
const { indexPendingChunks } = require('../embeddings');
const { logAudit } = require('../audit');

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

// Uploading is the most expensive thing a staff account can do (five files of up to 20 MB, parsed and
// indexed in-process), so it is throttled per person as well as per request.
const uploadThrottle = require('../security').keyedRateLimit({
  key: (req) => (req.session?.userId ? `upload:${req.session.userId}` : 'anon'),
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: 'Too many uploads in a short time. Wait a few minutes, then try again.',
});

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

// How a stored document may be served. The uploader's own Content-Type header is never trusted: a file
// called "policy.pdf" whose multipart part claimed text/html used to be served as an HTML page from the
// app's origin, which is a stored-XSS route into other staff members' sessions. The type is derived
// from the app's own `kind` and, for images, from the bytes themselves.
const MIME_BY_KIND = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  webpage: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
};

function imageMimeFromBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'application/octet-stream';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

// What to send back for a document: { type, inline }. Only PDFs and images may render in the browser;
// everything else is an attachment, so no stored file is ever interpreted as a page.
function servingInfo(doc, buffer) {
  if (doc.kind === 'image') {
    const type = imageMimeFromBytes(buffer);
    return { type, inline: type.startsWith('image/'), unrenderable: !type.startsWith('image/') };
  }
  const type = MIME_BY_KIND[doc.kind] || 'application/octet-stream';
  return { type, inline: doc.kind === 'pdf' };
}

// Headers for a response that carries a user-uploaded file: never let it run scripts, never let it be
// embedded anywhere but this app, and never let the browser sniff it into something else.
function setDocumentHeaders(res, { type, inline }) {
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  return inline;
}

const DOC_COLUMNS = `d.id, d.user_id, d.filename, d.department, d.is_personal, d.mime_type, d.kind, d.char_count,
  d.created_at, u.username AS uploaded_by`;

function withScope(doc) {
  // The folder the document lives in, by name: what the Knowledge base page and the admin list show,
  // and the same name as the folder on disk (see server/knowledgeFolders.js).
  let folder = doc.department === BANKWIDE_DEPARTMENT ? 'Bank-wide' : `Department - ${doc.department}`;
  if (doc.is_personal) {
    const owner = doc.user_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(doc.user_id) : null;
    folder = `Personal - ${owner ? owner.username : `user ${doc.user_id}`}`;
  }
  return { ...doc, scope: scopeOf(doc), folder };
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

router.post('/', uploadThrottle, upload.array('files', 5), asyncHandler(async (req, res) => {
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
          isImage ? imageMimeFromBytes(file.buffer) : MIME_BY_KIND[kind] || 'application/octet-stream',
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

      // Copy it into the knowledge-base folder on disk straight away, so a folder an administrator
      // opens in Explorer matches what was just uploaded.
      knowledgeFolders.mirrorDocumentById(docResult.lastInsertRowid);

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

  // Make the new files searchable by meaning straight away rather than at the next background pass.
  indexPendingChunks();
  logAudit(req, 'document.upload', {
    scope: target.isPersonal ? 'personal' : targetDepartment === BANKWIDE_DEPARTMENT ? 'global' : 'department',
    department: targetDepartment,
    files: results.map((r) => (r.error ? `${r.filename} (failed: ${r.error})` : r.filename)),
  }, user);
  res.json({ results });
}));

// Serves the raw image bytes for preview (e.g. a thumbnail in the knowledge base or chat).
router.get('/:id/image', (req, res) => {
  const user = currentUser(req);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc || doc.kind !== 'image' || !doc.image_data) return res.status(404).end();

  const canView = canAccessDoc(doc, user);
  if (!canView) return res.status(403).end();

  const buffer = Buffer.from(doc.image_data, 'base64');
  const { type, unrenderable } = servingInfo({ kind: 'image' }, buffer);
  if (unrenderable) return res.status(404).end();
  setDocumentHeaders(res, { type, inline: true });
  // Short and private: a shared PC must not keep someone's document in its cache after they sign out.
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(buffer);
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
    const buffer = Buffer.from(doc.image_data, 'base64');
    const { type, inline, unrenderable } = servingInfo({ kind: 'image' }, buffer);
    if (unrenderable) return res.status(404).end();
    setDocumentHeaders(res, { type, inline: inline && !forceDownload });
    res.setHeader('Content-Disposition', `${inline && !forceDownload ? 'inline' : 'attachment'}; filename="${encodeURIComponent(doc.filename)}"`);
    return res.send(buffer);
  }

  if (doc.file_data) {
    const buffer = Buffer.from(doc.file_data, 'base64');
    const { type, inline } = servingInfo(doc, buffer);
    const asAttachment = forceDownload || !inline;
    setDocumentHeaders(res, { type, inline: !asAttachment });
    res.setHeader('Content-Disposition', `${asAttachment ? 'attachment' : 'inline'}; filename="${encodeURIComponent(doc.filename)}"`);
    return res.send(buffer);
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
//
// The HTML comes from a library, but the *content* comes from a file somebody uploaded, and the panel
// puts it in the page — so it is stripped of everything that can act: scripts, event handlers, and
// javascript:/data: links (a spreadsheet cell with a hyperlink is enough to produce one). The CSP would
// block execution anyway; this is the layer that means one CSP change cannot turn into an XSS.
function sanitisePreviewHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|link|meta|base|form)[\s\S]*?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|action)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, ' $1="#"')
    .replace(/\s(href|src|action)\s*=\s*(javascript|data|vbscript):[^\s>]*/gi, ' $1="#"');
}

router.get('/:id/preview', asyncHandler(async (req, res) => {
  const user = currentUser(req);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!canAccessDoc(doc, user)) return res.status(403).json({ error: 'Not authorized' });

  try {
    if ((doc.kind === 'docx' || doc.kind === 'xlsx') && !doc.file_data) {
      return res.json({ type: 'text', text: chunkTextFor(doc.id) || '(No preview available for this file.)' });
    }
    if (doc.kind === 'image') {
      // An image is its own preview: the panel shows it from the image endpoint. This used to fall through
      // to "no preview available for this file type", which is why the chat UI logged repeated 400s for
      // an uploaded logo (GET /api/documents/69/preview).
      if (!doc.image_data) return res.status(404).json({ error: 'This image has no stored file to preview.' });
      return res.json({
        type: 'image',
        url: `/api/documents/${doc.id}/image`,
        filename: doc.filename,
        mimeType: doc.mime_type,
      });
    }
    if (doc.kind === 'docx') {
      const mammoth = require('mammoth');
      const buffer = Buffer.from(doc.file_data, 'base64');
      const result = await mammoth.convertToHtml({ buffer });
      return res.json({ type: 'html', html: sanitisePreviewHtml(result.value) });
    }
    if (doc.kind === 'xlsx') {
      const XLSX = require('xlsx');
      const buffer = Buffer.from(doc.file_data, 'base64');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const html = XLSX.utils.sheet_to_html(firstSheet);
      return res.json({ type: 'html', html: sanitisePreviewHtml(html) });
    }
    if (doc.kind === 'pptx' || doc.kind === 'text' || doc.kind === 'webpage') {
      return res.json({ type: 'text', text: chunkTextFor(doc.id) || '(No extracted text available.)' });
    }
    // Every kind the app stores has a preview path now (images above, pdf via /file, the rest as text),
    // so this is a genuinely unknown kind rather than a missing feature.
    logger.warn('No preview renderer for a stored document kind', { documentId: doc.id, kind: doc.kind });
    return res.status(400).json({ error: `No preview is available for this kind of file (${doc.kind}).` });
  } catch (err) {
    // The parser's own message can name internal paths; the log keeps it.
    logger.warn('Could not generate a document preview', { documentId: doc.id, error: err.message });
    return res.status(500).json({ error: 'Could not generate a preview for this file.' });
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

  // Remove the folder copy while its path is still known, then the row.
  knowledgeFolders.removeDocumentCopy(doc);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  logAudit(req, 'document.delete', { documentId: doc.id, filename: doc.filename, scope: scopeOf(doc), department: doc.department }, user);
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
    // It belongs to a different folder now: move the copy rather than leave it behind.
    knowledgeFolders.mirrorDocumentById(doc.id);
  } else if (scope === 'department') {
    const owner = db.prepare('SELECT department FROM users WHERE id = ?').get(doc.user_id);
    const department = owner?.department;
    if (!department) return res.status(400).json({ error: 'This file\'s owner has no department to share it with.' });
    db.prepare('UPDATE documents SET is_personal = 0, department = ? WHERE id = ?').run(department, doc.id);
    knowledgeFolders.mirrorDocumentById(doc.id);
  } else {
    return res.status(400).json({ error: 'scope must be "department" or "global"' });
  }
  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  logAudit(req, 'document.share', { documentId: doc.id, filename: doc.filename, from: scopeOf(doc), to: scopeOf(updated), department: updated.department }, user);
  res.json({ ok: true, scope: scopeOf(updated), department: updated.department });
});

module.exports = router;

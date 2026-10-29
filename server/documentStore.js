const db = require('./db');
const { chunkText } = require('./documentExtract');

const MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

// Saves a generated office/PDF file as a document row so it's downloadable, previewable, and
// shows up in the department knowledge base like any other file. `searchableText` (the source
// markdown, CSV-like rows, or slide outline) is chunked and indexed the same way uploaded
// documents are, so later chat questions can retrieve it without re-attaching the file.
function saveGeneratedFile(buffer, filename, kind, user, searchableText = '') {
  const department = user.department || 'General';
  const result = db
    .prepare(
      'INSERT INTO documents (user_id, department, filename, mime_type, kind, file_data, char_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(user.id, department, filename, MIME_TYPES[kind], kind, buffer.toString('base64'), searchableText.length);

  const chunks = chunkText(searchableText);
  if (chunks.length) {
    const insertChunk = db.prepare(
      'INSERT INTO document_chunks (document_id, chunk_index, content, heading) VALUES (?, ?, ?, ?)'
    );
    chunks.forEach((chunk, idx) => insertChunk.run(result.lastInsertRowid, idx, chunk.text, chunk.heading));
  }

  return { documentId: result.lastInsertRowid, filename };
}

module.exports = { saveGeneratedFile, MIME_TYPES };

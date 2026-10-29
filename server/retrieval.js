const db = require('./db');
const { BANKWIDE_DEPARTMENT } = require('./departments');

const MAX_EXPLICIT_CHARS_PER_DOC = 8000;
const MAX_AUTO_CHUNKS = 4;
const MAX_AUTO_CHARS = 4000;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'what', 'when',
  'where', 'which', 'who', 'why', 'how', 'are', 'was', 'were', 'been', 'will',
  'about', 'into', 'your', 'you', 'can', 'does', 'did', 'has', 'a', 'an', 'of',
  'to', 'in', 'on', 'is', 'it', 'as', 'be', 'or', 'at', 'by',
]);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w));
}

// Full content of explicitly attached documents (user picked these via the attach button).
function getExplicitContext(documentIds, user) {
  if (!documentIds || !documentIds.length) return { text: '', docs: [] };

  const placeholders = documentIds.map(() => '?').join(',');
  const docs = db
    .prepare(`SELECT * FROM documents WHERE id IN (${placeholders})`)
    .all(...documentIds)
    .filter(
      (d) =>
        user.role === 'admin' ||
        d.user_id === user.id ||
        d.department === user.department ||
        d.department === BANKWIDE_DEPARTMENT
    );

  if (!docs.length) return { text: '', docs: [] };

  const parts = [];
  for (const doc of docs) {
    const chunks = db
      .prepare('SELECT content, heading FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC')
      .all(doc.id);
    let lastHeading = null;
    let content = chunks
      .map((c) => {
        const prefix = c.heading && c.heading !== lastHeading ? `## ${c.heading}\n` : '';
        lastHeading = c.heading || lastHeading;
        return `${prefix}${c.content}`;
      })
      .join('\n\n');
    if (!content.trim()) continue; // e.g. an image with no OCR-legible text — nothing to add as text context
    let truncated = false;
    if (content.length > MAX_EXPLICIT_CHARS_PER_DOC) {
      content = content.slice(0, MAX_EXPLICIT_CHARS_PER_DOC);
      truncated = true;
    }
    parts.push(`### Document: ${doc.filename} (id: ${doc.id}${doc.kind === 'xlsx' ? ', use analyze_excel for real calculations' : ''})${truncated ? ' (truncated)' : ''}\n${content}`);
  }

  return { text: parts.join('\n\n'), docs };
}

// Lightweight keyword-overlap retrieval across the user's department knowledge base.
// Returns both the context text (for the model) and the distinct source documents used
// (for citations shown to the user) — the same retrieval pass answers both needs.
function getAutoContext(department, query, excludeDocumentIds = []) {
  const queryTerms = new Set(tokenize(query));
  if (!queryTerms.size) return { text: '', sources: [] };

  const excludeSet = new Set(excludeDocumentIds);
  const rows = db
    .prepare(
      `SELECT dc.content, dc.heading, dc.document_id, d.filename, d.kind
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE d.department = ? OR d.department = ?`
    )
    .all(department || '__none__', BANKWIDE_DEPARTMENT)
    .filter((r) => !excludeSet.has(r.document_id));

  if (!rows.length) return { text: '', sources: [] };

  // Require a real chunk of the query's distinct keywords to show up, not just one incidental
  // word in common — a single shared term between a 2-word query and an unrelated 40-page PDF is
  // noise, not a match, and was previously enough to drag irrelevant documents into every answer.
  const minMatches = queryTerms.size === 1 ? 1 : Math.max(2, Math.ceil(queryTerms.size / 2));

  const scored = rows
    .map((r) => {
      const chunkTermSet = new Set(tokenize(r.content));
      let score = 0;
      for (const term of queryTerms) {
        if (chunkTermSet.has(term)) score += 1;
      }
      return { ...r, score };
    })
    .filter((r) => r.score >= minMatches)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_AUTO_CHUNKS);

  if (!scored.length) return { text: '', sources: [] };

  let total = 0;
  const parts = [];
  const sourcesById = new Map();
  for (const chunk of scored) {
    if (total >= MAX_AUTO_CHARS) break;
    const heading = chunk.heading ? ` — ${chunk.heading}` : '';
    const analyzeHint = chunk.kind === 'xlsx' ? ', use analyze_excel for real calculations' : '';
    parts.push(`### From: ${chunk.filename} (id: ${chunk.document_id}${analyzeHint})${heading}\n${chunk.content}`);
    total += chunk.content.length;
    sourcesById.set(chunk.document_id, { id: chunk.document_id, filename: chunk.filename, kind: chunk.kind });
  }

  return { text: parts.join('\n\n'), sources: [...sourcesById.values()] };
}

module.exports = { getExplicitContext, getAutoContext };

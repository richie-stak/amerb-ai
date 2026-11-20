const db = require('./db');
const { canAccessDoc, searchableWhere } = require('./documentAccess');
const { semanticSearch } = require('./embeddings');

const MAX_EXPLICIT_CHARS_PER_DOC = 8000;
const MAX_AUTO_CHUNKS = 4;
const MAX_AUTO_CHARS = 4000;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'what', 'when',
  'where', 'which', 'who', 'why', 'how', 'are', 'was', 'were', 'been', 'will',
  'about', 'into', 'your', 'you', 'can', 'does', 'did', 'has', 'a', 'an', 'of',
  'to', 'in', 'on', 'is', 'it', 'as', 'be', 'or', 'at', 'by',
  'our', 'their', 'its', 'his', 'her', 'my', 'we', 'they', 'them', 'these', 'those',
]);

// Words in a question that say nothing about *which* document is wanted: the bank's own name
// (it's on nearly every bank document, so "search about Amenfiman Community Bank" used to match a
// loan form and the logo) and the instructions around a request ("search ... on google").
const QUERY_NOISE = new Set([
  'amenfiman', 'community', 'bank', 'banks', 'rural', 'plc', 'amerb',
  'search', 'google', 'online', 'web', 'internet', 'website', 'please', 'tell', 'find', 'look',
  'summarize', 'summarise', 'summary', 'describe', 'explain', 'outline', 'overview', 'brief',
  'detail', 'details', 'list', 'provide', 'give', 'show', 'state', 'according',
  'information', 'info', 'know', 'give', 'show', 'want', 'need', 'help',
]);

// A query word found in more than this share of the searchable documents doesn't tell them apart
// (like "loan" in a loans-only knowledge base), so it isn't counted as a match on its own.
const COMMON_TERM_SHARE = 0.5;
const COMMON_TERM_MIN_DOCS = 4;

// Unicode letters, not just a-z: staff write in Twi and Ga too ("sɛ", "wɔ", "kɛha"), and matching
// only ASCII used to drop those words entirely. English terms in a mixed Twi/English question still
// match the (English) knowledge base, which is the point.
function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOPWORDS.has(w));
}

// Full content of explicitly attached documents (user picked these via the attach button).
function getExplicitContext(documentIds, user) {
  if (!documentIds || !documentIds.length) return { text: '', docs: [] };

  const placeholders = documentIds.map(() => '?').join(',');
  const docs = db
    .prepare(`SELECT * FROM documents WHERE id IN (${placeholders})`)
    .all(...documentIds)
    .filter((d) => canAccessDoc(d, user));

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

// Keyword-overlap retrieval across every knowledge base this user may search: the bank-wide one,
// their own department's, and their own personal files (never another department's). Returns the
// best-matching chunks, most relevant first.
function keywordChunks(user, query, excludeDocumentIds = []) {
  let queryTerms = new Set(tokenize(query).filter((w) => !QUERY_NOISE.has(w)));
  if (!queryTerms.size) return [];

  const excludeSet = new Set(excludeDocumentIds);
  const where = searchableWhere(user);
  const rows = db
    .prepare(
      `SELECT dc.id AS chunk_id, dc.content, dc.heading, dc.document_id, d.filename, d.kind
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE ${where.sql}`
    )
    .all(...where.params)
    .filter((r) => !excludeSet.has(r.document_id));

  if (!rows.length) return [];

  const termsByChunk = rows.map((r) => new Set(tokenize(r.content)));

  // A word that appears in no chunk can never contribute to a score, so it must not raise the number of
  // terms a chunk has to contain. "Summarize our password policy" used to fail exactly this way: with
  // {summarize, our, password, policy} the threshold was two matches, and the password standard's chunk
  // scored one (password) because "summarize"/"our" are not in any policy document.
  const presentInAnyChunk = (term) => termsByChunk.some((set) => set.has(term));
  queryTerms = new Set([...queryTerms].filter(presentInAnyChunk));
  if (!queryTerms.size) return [];

  const documentIds = new Set(rows.map((r) => r.document_id));
  if (documentIds.size >= COMMON_TERM_MIN_DOCS) {
    const docsWithTerm = (term) => new Set(rows.filter((_, i) => termsByChunk[i].has(term)).map((r) => r.document_id)).size;
    queryTerms = new Set([...queryTerms].filter((term) => docsWithTerm(term) / documentIds.size <= COMMON_TERM_SHARE));
    if (!queryTerms.size) return [];
  }

  // Every term left has already been filtered: it appears somewhere in the knowledge base and is not so
  // common that it says nothing about which document is wanted. So one of them matching is a real signal;
  // requiring half the terms (minimum two) meant a single distinctive word — "password" — was not enough,
  // and the policy was reported as missing. Chunks matching more of the terms still rank higher below.
  const minMatches = 1;

  return rows
    .map((r, i) => {
      const chunkTermSet = termsByChunk[i];
      let score = 0;
      for (const term of queryTerms) {
        if (chunkTermSet.has(term)) score += 1;
      }
      return { ...r, score };
    })
    .filter((r) => r.score >= minMatches)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_AUTO_CHUNKS);
}

// Turns retrieved chunks into the context text the model reads and the citations the user sees —
// the same pass answers both needs.
function formatContext(chunks) {
  let total = 0;
  const parts = [];
  const sourcesById = new Map();
  for (const chunk of chunks) {
    if (total >= MAX_AUTO_CHARS) break;
    const heading = chunk.heading ? ` — ${chunk.heading}` : '';
    const analyzeHint = chunk.kind === 'xlsx' ? ', use analyze_excel for real calculations' : '';
    parts.push(`### From: ${chunk.filename} (id: ${chunk.document_id}${analyzeHint})${heading}\n${chunk.content}`);
    total += chunk.content.length;
    sourcesById.set(chunk.document_id, { id: chunk.document_id, filename: chunk.filename, kind: chunk.kind });
  }
  return { text: parts.join('\n\n'), sources: [...sourcesById.values()] };
}

// Keyword-only retrieval (no model needed).
function getAutoContext(user, query, excludeDocumentIds = []) {
  return formatContext(keywordChunks(user, query, excludeDocumentIds));
}

// What chat uses: passages that match by meaning (via the local embedding model) first, then
// exact keyword matches the meaning search missed — names, account codes and figures match best
// by keyword. Falls back to keywords alone when the embedding model isn't installed.
async function getHybridContext(user, query, excludeDocumentIds = []) {
  const byMeaning = await semanticSearch(user, query, { exclude: excludeDocumentIds, limit: MAX_AUTO_CHUNKS });
  const seen = new Set(byMeaning.map((c) => c.chunk_id));
  const byKeyword = keywordChunks(user, query, excludeDocumentIds).filter((c) => !seen.has(c.chunk_id));
  return formatContext([...byMeaning, ...byKeyword].slice(0, MAX_AUTO_CHUNKS + 1));
}

module.exports = { getExplicitContext, getAutoContext, getHybridContext };

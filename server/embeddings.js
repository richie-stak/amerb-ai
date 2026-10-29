// Meaning-based document search. Each document chunk gets an "embedding" — a list of numbers
// describing what it's about — from a small local model in Ollama, so a question finds passages
// that mean the same thing even with different words ("staff leave entitlement" finds "annual
// holidays"). Everything stays on this machine. If the embedding model isn't installed, search
// quietly falls back to keyword matching alone.
const db = require('./db');
const { OLLAMA_URL } = require('./ollama');
const { searchableWhere } = require('./documentAccess');

const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const BATCH_SIZE = 16;
const INDEX_INTERVAL_MS = 30 * 1000;
const MAX_CHUNK_CHARS = 2000;
// nomic-embed-text is trained with these task prefixes; using them noticeably improves matching.
const QUERY_PREFIX = 'search_query: ';
const DOCUMENT_PREFIX = 'search_document: ';
// Minimum similarity (0–1) for a passage to count as relevant. Calibrated on the bank's own
// documents: real matches scored 0.67–0.80, while unrelated questions still reached about 0.60
// against text on the same broad subject (e.g. "weather in Accra" vs a Ghana interest-rate sheet).
const MIN_SIMILARITY = Number(process.env.EMBED_MIN_SIMILARITY) || 0.65;

db.exec(`
  CREATE TABLE IF NOT EXISTS chunk_embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES document_chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    vector BLOB NOT NULL
  );
`);

let available = null; // null = not checked yet
let indexing = false;
let warnedUnavailable = false;

async function embed(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '30m' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Ollama embed responded with ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.embeddings.map((v) => Float32Array.from(v));
}

function toBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob) {
  const buf = Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function isAvailable() {
  if (available !== null) return available;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    const withTag = (n) => (n.includes(':') ? n : `${n}:latest`);
    available = (data.models || []).some((m) => withTag(m.name) === withTag(EMBED_MODEL));
  } catch {
    available = false;
  }
  if (!available && !warnedUnavailable) {
    warnedUnavailable = true;
    console.warn(`Embedding model "${EMBED_MODEL}" isn't installed — document search uses keywords only. Run: ollama pull ${EMBED_MODEL}`);
  }
  // Re-check now and then, so pulling the model later takes effect without a restart.
  setTimeout(() => (available = null), 5 * 60 * 1000).unref();
  return available;
}

// Embeds every chunk that doesn't have an embedding yet (new uploads, or everything the first time
// the model is installed). Runs in the background; safe to call often.
async function indexPendingChunks() {
  if (indexing || !(await isAvailable())) return;
  indexing = true;
  try {
    const pending = db.prepare(
      `SELECT dc.id, dc.content, dc.heading FROM document_chunks dc
       LEFT JOIN chunk_embeddings e ON e.chunk_id = dc.id AND e.model = ?
       WHERE e.chunk_id IS NULL LIMIT ?`
    );
    const save = db.prepare(
      'INSERT INTO chunk_embeddings (chunk_id, model, vector) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, vector = excluded.vector'
    );
    for (;;) {
      const batch = pending.all(EMBED_MODEL, BATCH_SIZE);
      if (!batch.length) break;
      const vectors = await embed(
        batch.map((c) => `${DOCUMENT_PREFIX}${c.heading ? `${c.heading}\n` : ''}${c.content}`.slice(0, MAX_CHUNK_CHARS))
      );
      batch.forEach((c, i) => save.run(c.id, EMBED_MODEL, toBlob(vectors[i])));
    }
  } catch (err) {
    console.warn(`Document indexing paused: ${err.message}`);
  } finally {
    indexing = false;
  }
}

function startBackgroundIndexing() {
  indexPendingChunks();
  setInterval(indexPendingChunks, INDEX_INTERVAL_MS).unref();
}

// The passages most similar in meaning to `query`, from the knowledge bases `user` may search.
// Returns [] when the embedding model isn't available, so callers fall back to keywords.
async function semanticSearch(user, query, { exclude = [], limit = 4 } = {}) {
  if (!query.trim() || !(await isAvailable())) return [];
  let queryVector;
  try {
    [queryVector] = await embed([`${QUERY_PREFIX}${query}`]);
  } catch {
    return [];
  }
  const where = searchableWhere(user);
  const excludeSet = new Set(exclude);
  const rows = db
    .prepare(
      `SELECT dc.id AS chunk_id, dc.content, dc.heading, dc.document_id, d.filename, d.kind, e.vector
       FROM chunk_embeddings e
       JOIN document_chunks dc ON dc.id = e.chunk_id
       JOIN documents d ON d.id = dc.document_id
       WHERE e.model = ? AND ${where.sql}`
    )
    .all(EMBED_MODEL, ...where.params);
  return rows
    .filter((r) => !excludeSet.has(r.document_id))
    .map(({ vector, ...r }) => ({ ...r, similarity: cosine(queryVector, fromBlob(vector)) }))
    .filter((r) => r.similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

module.exports = { semanticSearch, indexPendingChunks, startBackgroundIndexing, EMBED_MODEL, MIN_SIMILARITY, _cosine: cosine };

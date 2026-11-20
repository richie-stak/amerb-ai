// Which models can answer questions, and which can only turn text into vectors.
//
// This exists because of a real incident: a conversation had nomic-embed-text (an *embedding* model)
// saved as its chat model, the app tried to chat with it, Ollama refused, and the chat route silently
// fell back to a different model. Two wrongs there: an embedding model must never be offered or saved as
// a chat model, and a *category* substitution must never be silent. Ollama knows the answer — /api/show
// reports `capabilities` ("completion", "tools", "thinking", "vision", "embedding") — so that is the
// source of truth, with the model name as a fallback for when Ollama is unreachable.
const { OLLAMA_URL } = require('./ollama');

const CACHE_TTL_MS = 5 * 60 * 1000;
const showCache = new Map(); // model name -> { capabilities, family, at, failed }

// Names that are embedding models even if Ollama cannot be asked (or the installed Ollama is too old to
// report capabilities). Deliberately conservative: matching one of these means "never a chat model".
const EMBEDDING_NAME = /(?:^|[:/])(?:nomic-embed|mxbai-embed|bge[-_]|bge-|minilm|all-minilm|e5-|gte-|jina-embed|sentence-transformers|paraphrase|snowflake-arctic-embed|text-embedding)/i;
const EMBEDDING_FAMILY = new Set(['bert', 'nomic-bert', 'bge', 'xlm-roberta']);

function nameLooksEmbedding(name) {
  return EMBEDDING_NAME.test(String(name || ''));
}

// Synchronous classification from the name alone — safe whenever Ollama has not answered yet.
function roleFromName(name) {
  return nameLooksEmbedding(name) ? 'embedding' : 'unknown';
}

// Asks Ollama what the model can do. Cached briefly (the picker and the chat route both use it), and a
// failure is cached too so an unreachable Ollama does not mean a request per keystroke.
async function modelInfo(name, { fresh = false } = {}) {
  const key = String(name || '');
  if (!key) return { capabilities: [], family: null, role: 'unknown', source: 'empty' };
  const cached = showCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: key }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);
    const data = await res.json();
    const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
    const family = data.details?.family || null;
    const value = { capabilities, family, role: roleFrom({ capabilities, family, name: key }), source: 'ollama' };
    showCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    const value = {
      capabilities: [],
      family: null,
      role: roleFromName(key),
      source: 'name',
      error: err.message,
    };
    showCache.set(key, { at: Date.now(), value });
    return value;
  }
}

// What a model can do, from the capability list and family, falling back to its name.
function roleFrom({ capabilities = [], family = null, name = '' }) {
  if (capabilities.includes('embedding') && !capabilities.includes('completion')) return 'embedding';
  if (capabilities.includes('completion')) return 'chat';
  if (family && EMBEDDING_FAMILY.has(String(family).toLowerCase())) return 'embedding';
  if (nameLooksEmbedding(name)) return 'embedding';
  // Neither list nor name is decisive: not an embedding model, so it may be used for chat (it either
  // works or Ollama reports a clear error — which is not the same as guessing at another category).
  return 'unknown';
}

// Synchronous classification for callers that cannot wait (migrations, settings validation): uses the
// last Ollama answer when known, otherwise the name.
function classifyChatModel(name) {
  const cached = showCache.get(String(name || ''));
  if (cached && cached.value && cached.value.source === 'ollama') return cached.value.role;
  return roleFromName(name);
}

function isEmbeddingModel(name) {
  return classifyChatModel(name) === 'embedding';
}

// The list the model picker and the chat route both consult: installed models with their role.
async function catalog({ models } = {}) {
  const list = models || [];
  return Promise.all(
    list.map(async (model) => {
      const info = await modelInfo(model.name);
      return { ...model, role: info.role, capabilities: info.capabilities, family: info.family };
    })
  );
}

// Only chat-capable models may answer a message. Throws an Error with a message meant for the person
// asking (the route turns it into a 400), rather than letting the request reach Ollama and fail there.
function assertChatModel(name) {
  const role = classifyChatModel(name);
  if (role === 'embedding') {
    const error = new Error(
      `"${name}" is an embedding model — it turns text into numbers for document search and cannot answer ` +
        'questions. Choose a chat model (for example qwen3:4b-instruct).'
    );
    error.status = 400;
    error.code = 'model_role_mismatch';
    throw error;
  }
  return true;
}

// Embedding work must use an embedding model; a chat model would produce meaningless vectors.
function assertEmbeddingModel(name) {
  const role = classifyChatModel(name);
  if (role === 'chat') {
    const error = new Error(`"${name}" is a chat model and cannot be used for document search embeddings.`);
    error.status = 400;
    error.code = 'model_role_mismatch';
    throw error;
  }
  return true;
}

// One-off repair of data saved while embedding models could still be chosen: a conversation whose saved
// model is an embedding model is re-pointed at the configured chat model (its column cannot be empty),
// and a message's recorded model is cleared. Returns the counts so the caller can log/audit them — this is
// a repair of a broken saved choice, never a silent swap at answer time.
function repairStoredChatModels(db, { target = process.env.DEFAULT_MODEL || 'qwen3:4b-instruct' } = {}) {
  const conversations = db.prepare('SELECT id, model FROM conversations WHERE model IS NOT NULL').all();
  const affectedConversations = conversations.filter((row) => isEmbeddingModel(row.model));
  const messages = db.prepare('SELECT id, model FROM messages WHERE model IS NOT NULL').all();
  const affectedMessages = messages.filter((row) => isEmbeddingModel(row.model));
  if (!affectedConversations.length && !affectedMessages.length) {
    return { conversations: 0, messages: 0, models: [], with: target };
  }
  const models = [...new Set([...affectedConversations, ...affectedMessages].map((row) => row.model))];
  db.exec('BEGIN IMMEDIATE');
  try {
    const repoint = db.prepare('UPDATE conversations SET model = ? WHERE id = ?');
    for (const row of affectedConversations) repoint.run(target, row.id);
    const clearMessage = db.prepare('UPDATE messages SET model = NULL WHERE id = ?');
    for (const row of affectedMessages) clearMessage.run(row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { conversations: affectedConversations.length, messages: affectedMessages.length, models, with: target };
}

function clearCache() {
  showCache.clear();
}

module.exports = {
  modelInfo,
  catalog,
  classifyChatModel,
  isEmbeddingModel,
  assertChatModel,
  assertEmbeddingModel,
  repairStoredChatModels,
  nameLooksEmbedding,
  roleFrom,
  clearCache,
};

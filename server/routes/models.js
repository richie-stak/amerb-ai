const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const ollama = require('../llm/ollama');
const { listExternalModels } = require('../llm');
const db = require('../db');
const { departmentDefault } = require('../modelRouting');
const modelCapabilities = require('../modelCapabilities');

const router = express.Router();
router.use(requireAuth);

// The model picker's list: local Ollama models first, then any external-provider models an admin
// has enabled. If Ollama is down, the external models are still offered (and vice versa).
router.get('/', asyncHandler(async (req, res) => {
  let localModels = [];
  let ollamaError = null;
  try {
    localModels = await ollama.listModels();
  } catch (err) {
    ollamaError = err.message;
  }
  const externalModels = listExternalModels();
  // Embedding models turn text into vectors for document search; they cannot hold a conversation, and
  // offering one here is what let it be saved as a chat model (reported 20 Nov 2026). They are removed
  // from the picker — the embedding model is configured separately for document search.
  const withRoles = await modelCapabilities.catalog({ models: [...localModels, ...externalModels] });
  const models = withRoles.filter((m) => m.role !== 'embedding');
  const hiddenEmbeddingModels = withRoles.filter((m) => m.role === 'embedding').map((m) => m.name);

  if (!models.length && ollamaError) {
    return res.status(502).json({
      error: 'Could not reach Ollama. Make sure it is running (ollama serve).',
      details: ollamaError,
    });
  }

  // DEFAULT_MODEL may be written with or without a tag ("qwen3:4b-instruct" / "llama3.1"), and
  // may not be installed at all — only offer it as the default if it's really there; otherwise
  // the first tool-capable local model is the most useful starting point.
  const wanted = process.env.DEFAULT_MODEL || '';
  const withTag = (n) => (n.includes(':') || n.startsWith('ext/') ? n : `${n}:latest`);
  const configured = wanted && models.find((m) => withTag(m.name) === withTag(wanted));
  const globalDefault = (configured || localModels.find((m) => m.tools) || models[0])?.name || null;
  // An admin can give each department its own starting model (Admin → Model routing).
  const user = db.prepare('SELECT department FROM users WHERE id = ?').get(req.session.userId);
  const forDepartment = departmentDefault(user, models.map((m) => m.name));
  res.json({
    hiddenEmbeddingModels, models, defaultModel: forDepartment || globalDefault, departmentDefault: Boolean(forDepartment) });
}));

module.exports = router;

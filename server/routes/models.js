const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth);

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

router.get('/', asyncHandler(async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!r.ok) throw new Error(`Ollama responded with ${r.status}`);
    const data = await r.json();
    const models = (data.models || []).map((m) => ({
      name: m.name,
      vision: (m.capabilities || []).includes('vision'),
      tools: (m.capabilities || []).includes('tools'),
      thinking: (m.capabilities || []).includes('thinking'),
    }));
    res.json({ models });
  } catch (err) {
    res.status(502).json({
      error: 'Could not reach Ollama. Make sure it is running (ollama serve).',
      details: err.message,
    });
  }
}));

module.exports = router;

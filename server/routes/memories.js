const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { listMemories, addMemory } = require('../memory');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ memories: listMemories(req.session.userId) });
});

router.post('/', (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Memory text is required' });
  }
  const result = addMemory(req.session.userId, content);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ memory: result.memory });
});

// Clear every memory for the logged-in user (the Memory window's "Clear all").
router.delete('/', (req, res) => {
  db.prepare('DELETE FROM user_memories WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const memory = db
    .prepare('SELECT id FROM user_memories WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!memory) return res.status(404).json({ error: 'Memory not found' });
  db.prepare('DELETE FROM user_memories WHERE id = ?').run(memory.id);
  res.json({ ok: true });
});

module.exports = router;

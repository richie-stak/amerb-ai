const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const prompts = db
    .prepare('SELECT id, title, content, created_at FROM saved_prompts WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.session.userId);
  res.json({ prompts });
});

router.post('/', (req, res) => {
  const { title, content } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'A title is required' });
  }
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Prompt content is required' });
  }
  const result = db
    .prepare('INSERT INTO saved_prompts (user_id, title, content) VALUES (?, ?, ?)')
    .run(req.session.userId, title.trim(), content.trim());
  const prompt = db.prepare('SELECT id, title, content, created_at FROM saved_prompts WHERE id = ?').get(result.lastInsertRowid);
  res.json({ prompt });
});

router.delete('/:id', (req, res) => {
  const prompt = db
    .prepare('SELECT id FROM saved_prompts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
  db.prepare('DELETE FROM saved_prompts WHERE id = ?').run(prompt.id);
  res.json({ ok: true });
});

module.exports = router;

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { generateDocx, generatePdf } = require('../documentGen');
const { logAudit } = require('../audit');
const languageQuality = require('../languageQuality');

const router = express.Router();
router.use(requireAuth);

// List conversations for the logged-in user
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      'SELECT id, title, model, pinned, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC'
    )
    .all(req.session.userId);
  res.json({ conversations: rows });
});

// Full-text search across the user's own message content — the sidebar's own search box only
// ever matched conversation titles, which stops being useful once a chat's title doesn't mention
// what was actually discussed inside it. One matching snippet per conversation, most recent first.
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped}%`;
  const rows = db
    .prepare(
      `SELECT m.id AS message_id, m.conversation_id, m.content, c.title, c.updated_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ? AND m.is_active = 1 AND m.content LIKE ? ESCAPE '\\'
       ORDER BY c.updated_at DESC, m.id DESC
       LIMIT 300`
    )
    .all(req.session.userId, like);

  const lowerQ = q.toLowerCase();
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.conversation_id) || seen.size >= 30) continue;
    const idx = row.content.toLowerCase().indexOf(lowerQ);
    const start = Math.max(0, idx - 40);
    const end = Math.min(row.content.length, idx + lowerQ.length + 60);
    const snippet = `${start > 0 ? '…' : ''}${row.content.slice(start, end)}${end < row.content.length ? '…' : ''}`;
    seen.set(row.conversation_id, {
      conversationId: row.conversation_id,
      title: row.title,
      messageId: row.message_id,
      snippet,
    });
  }
  res.json({ results: [...seen.values()] });
});

// Get one conversation with its messages. Only the active version of each regenerated turn is
// returned — alternates the user switched away from stay in the database but out of the
// rendered conversation — annotated with its position among any sibling versions so the
// frontend can show "2/3"-style switcher controls without a second round-trip.
router.get('/:id', (req, res) => {
  const convo = db
    .prepare('SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const messages = db
    .prepare(
      `SELECT m.id, m.role, m.content, m.attachments, m.citations, m.thinking, m.feedback, m.alt_group_id, m.created_at,
              m.language, m.language_warning, m.translation_flag, f.category AS feedback_category
       FROM messages m
       LEFT JOIN response_feedback f ON f.message_id = m.id AND f.user_id = ?
       WHERE m.conversation_id = ? AND m.is_active = 1 ORDER BY m.id ASC`
    )
    .all(req.session.userId, convo.id);

  const versionIds = new Map();
  const versionCounts = new Map();
  for (const m of messages) {
    if (m.role !== 'assistant' || versionIds.has(m.alt_group_id)) continue;
    const siblingIds = db
      .prepare('SELECT id FROM messages WHERE alt_group_id = ? ORDER BY id ASC')
      .all(m.alt_group_id)
      .map((s) => s.id);
    versionIds.set(m.alt_group_id, siblingIds);
    versionCounts.set(m.alt_group_id, siblingIds.length);
  }

  const parsed = messages.map((m) => ({
    ...m,
    attachments: m.attachments ? JSON.parse(m.attachments) : [],
    citations: m.citations ? JSON.parse(m.citations) : [],
    versionIndex: m.role === 'assistant' ? versionIds.get(m.alt_group_id).indexOf(m.id) + 1 : undefined,
    versionTotal: m.role === 'assistant' ? versionCounts.get(m.alt_group_id) : undefined,
  }));

  res.json({ conversation: convo, messages: parsed });
});

// Export the full transcript as a downloadable Word or PDF file, reusing the same generators
// used for AI-generated documents so the output looks consistent with everything else the app produces.
router.get('/:id/export', asyncHandler(async (req, res) => {
  const convo = db
    .prepare('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const messages = db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? AND is_active = 1 ORDER BY id ASC')
    .all(convo.id);
  if (!messages.length) return res.status(400).json({ error: 'This conversation has no messages to export' });

  const transcript = messages
    .map((m) => `## ${m.role === 'user' ? 'You' : 'AMERB AI'}\n${m.content}`)
    .join('\n\n');

  const format = req.query.format === 'pdf' ? 'pdf' : 'docx';
  const safeName = (convo.title || 'conversation').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 60) || 'conversation';

  if (format === 'pdf') {
    const buffer = await generatePdf(convo.title, transcript);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    return res.send(buffer);
  }

  const buffer = await generateDocx(convo.title, transcript);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
  res.send(buffer);
}));

// Rename a conversation
// Rename and/or pin a conversation — either field can be sent on its own.
router.patch('/:id', (req, res) => {
  const { title, pinned } = req.body || {};
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
    return res.status(400).json({ error: 'Title cannot be empty' });
  }
  if (pinned !== undefined && typeof pinned !== 'boolean') {
    return res.status(400).json({ error: 'pinned must be true or false' });
  }
  if (title === undefined && pinned === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  const convo = db
    .prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  if (title !== undefined) {
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title.trim().slice(0, 200), convo.id);
  }
  if (pinned !== undefined) {
    db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, convo.id);
  }
  res.json({ ok: true });
});

// Delete a conversation
router.delete('/:id', (req, res) => {
  const convo = db
    .prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  db.prepare('DELETE FROM conversations WHERE id = ?').run(convo.id);
  res.json({ ok: true });
});

function loadOwnedMessage(conversationId, messageId, userId) {
  const convo = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
  if (!convo) return null;
  const message = db
    .prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversationId);
  return message || null;
}

// Delete a single message (e.g. an unwanted reply, or either side of an exchange). For an
// assistant reply this removes every regenerated alternate along with it — a version the user
// can no longer see shouldn't linger in the database as an un-deletable orphan.
router.delete('/:id/messages/:messageId', (req, res) => {
  const message = loadOwnedMessage(req.params.id, req.params.messageId, req.session.userId);
  if (!message) return res.status(404).json({ error: 'Message not found' });

  if (message.role === 'assistant') {
    db.prepare('DELETE FROM messages WHERE alt_group_id = ? AND conversation_id = ?').run(
      message.alt_group_id,
      message.conversation_id
    );
  } else {
    db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
  }
  res.json({ ok: true });
});

// Lists every regenerated alternate of an assistant reply, in order, for the version switcher.
router.get('/:id/messages/:messageId/versions', (req, res) => {
  const message = loadOwnedMessage(req.params.id, req.params.messageId, req.session.userId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.role !== 'assistant') return res.status(400).json({ error: 'Only assistant replies have versions' });

  const versions = db
    .prepare(
      'SELECT id, content, thinking, citations, is_active, created_at FROM messages WHERE alt_group_id = ? ORDER BY id ASC'
    )
    .all(message.alt_group_id);

  res.json({
    versions: versions.map((v) => ({ ...v, citations: v.citations ? JSON.parse(v.citations) : [] })),
  });
});

// Switches which regenerated alternate is the active (shown, and used as context going forward) one.
router.patch('/:id/messages/:messageId/activate', (req, res) => {
  const message = loadOwnedMessage(req.params.id, req.params.messageId, req.session.userId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.role !== 'assistant') return res.status(400).json({ error: 'Only assistant replies have versions' });

  db.prepare('UPDATE messages SET is_active = 0 WHERE alt_group_id = ? AND conversation_id = ?').run(
    message.alt_group_id,
    message.conversation_id
  );
  db.prepare('UPDATE messages SET is_active = 1 WHERE id = ?').run(message.id);
  res.json({ ok: true });
});

// Thumbs up/down on an assistant reply. Sending the same rating again clears it (toggle), the
// same interaction pattern as ChatGPT/Claude's feedback buttons.
router.patch('/:id/messages/:messageId/feedback', (req, res) => {
  const { rating } = req.body || {};
  if (rating !== 'up' && rating !== 'down' && rating !== null) {
    return res.status(400).json({ error: "rating must be 'up', 'down', or null" });
  }

  const message = loadOwnedMessage(req.params.id, req.params.messageId, req.session.userId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.role !== 'assistant') {
    return res.status(400).json({ error: 'Only assistant replies can be rated' });
  }

  const nextRating = message.feedback === rating ? null : rating;
  db.prepare('UPDATE messages SET feedback = ? WHERE id = ?').run(nextRating, message.id);
  res.json({ ok: true, feedback: nextRating });
});

// A staff member reporting that a reply translated something wrongly. Language answers are only as
// good as the model, and staff are the ones who notice a mistranslated term — this puts that in the
// record (and in the admin portal's usage figures) instead of it being lost in conversation.
router.patch('/:id/messages/:messageId/translation-flag', (req, res) => {
  const { flagged } = req.body || {};
  if (typeof flagged !== 'boolean') {
    return res.status(400).json({ error: 'flagged must be true or false' });
  }

  const message = loadOwnedMessage(req.params.id, req.params.messageId, req.session.userId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.role !== 'assistant') {
    return res.status(400).json({ error: 'Only replies can be reported' });
  }
  if (!message.language || message.language === 'en') {
    return res.status(400).json({ error: 'This reply is in English — there is no translation to report' });
  }

  const value = flagged ? 'incorrect' : null;
  db.prepare('UPDATE messages SET translation_flag = ? WHERE id = ?').run(value, message.id);
  // Keep the structured feedback table in step, so figures gathered from either endpoint agree.
  languageQuality.setFeedback({
    messageId: message.id,
    conversationId: message.conversation_id,
    userId: req.session.userId,
    category: value,
    language: message.language,
    model: message.model,
  });
  logAudit(req, 'chat.translation_flagged', { messageId: message.id, language: message.language, flagged });
  res.json({ ok: true, translationFlag: value });
});

// Staff feedback on a translated reply: was the translation good, wrong, or hard to follow? One
// verdict per person per reply (changing it replaces it; sending the same one again clears it, like
// the thumbs up/down). Recorded against the reply, with who, when, the language and the model, so an
// administrator can tell a model problem from a wording problem.
router.post('/:id/messages/:messageId/language-feedback', (req, res) => {
  const { category } = req.body || {};
  if (category !== null && category !== 'good' && category !== 'incorrect' && category !== 'unclear') {
    return res.status(400).json({ error: "category must be 'good', 'incorrect', 'unclear' or null" });
  }

  const message = loadOwnedMessage(req.params.id, req.params.messageId, req.session.userId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.role !== 'assistant') {
    return res.status(400).json({ error: 'Only replies can be given feedback' });
  }
  if (!message.language || message.language === 'en') {
    return res.status(400).json({ error: 'This reply is in English — there is no translation to comment on' });
  }

  const current = languageQuality.feedbackFor(message.id);
  const next = category === null || category === current ? null : category;
  languageQuality.setFeedback({
    messageId: message.id,
    conversationId: message.conversation_id,
    userId: req.session.userId,
    category: next,
    language: message.language,
    model: message.model,
  });
  // Keep the older flag in step, so a report made here still shows up wherever that column is read.
  db.prepare('UPDATE messages SET translation_flag = ? WHERE id = ?').run(next === 'incorrect' ? 'incorrect' : null, message.id);
  logAudit(req, 'chat.language_feedback', { messageId: message.id, language: message.language, category: next });
  res.json({ ok: true, category: next });
});

// Edit a user message's text. Every later message in the conversation is deleted too, since
// they were replies to a prompt that no longer exists — the client re-triggers a fresh
// assistant reply against the edited content afterward via POST /api/chat/regenerate.
router.patch('/:id/messages/:messageId', (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  const message = loadOwnedMessage(req.params.id, req.params.messageId, req.session.userId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.role !== 'user') {
    return res.status(400).json({ error: 'Only your own messages can be edited' });
  }

  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content.trim(), message.id);
  db.prepare('DELETE FROM messages WHERE conversation_id = ? AND id > ?').run(message.conversation_id, message.id);
  res.json({ ok: true });
});

module.exports = router;

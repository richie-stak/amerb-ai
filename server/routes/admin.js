const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { DatabaseSync, backup } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { DEPARTMENTS } = require('../departments');

// Excludes visually-ambiguous characters (0/O, 1/l/I) so a temporary password read aloud or typed
// from a screen doesn't trip people up.
const TEMP_PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generateTempPassword(length = 12) {
  const bytes = crypto.randomBytes(length);
  let pw = '';
  for (let i = 0; i < length; i++) pw += TEMP_PASSWORD_CHARS[bytes[i] % TEMP_PASSWORD_CHARS.length];
  return pw;
}

const router = express.Router();
router.use(requireAdmin);

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- Users ----------

router.get('/users', (req, res) => {
  const users = db
    .prepare('SELECT id, username, email, role, department, created_at FROM users ORDER BY created_at ASC')
    .all();
  res.json({ users, departments: DEPARTMENTS });
});

router.patch('/users/:id', (req, res) => {
  const { role, department } = req.body || {};
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (role !== undefined) {
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (target.role === 'admin' && role === 'user') {
      const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'At least one admin account must remain' });
      }
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  }

  if (department !== undefined) {
    if (department !== null && !DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: 'Invalid department' });
    }
    db.prepare('UPDATE users SET department = ? WHERE id = ?').run(department, targetId);
  }

  const updated = db
    .prepare('SELECT id, username, email, role, department, created_at FROM users WHERE id = ?')
    .get(targetId);
  res.json({ user: updated });
});

router.delete('/users/:id', (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.session.userId) {
    return res.status(400).json({ error: 'You cannot delete your own account from here' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'At least one admin account must remain' });
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ ok: true });
});

// Generates a random temporary password, hashes it, and returns the plaintext exactly once — it
// is never stored or logged anywhere, so this response is the only chance to see or hand it off.
router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);
  // Also clears any login lockout — an admin resetting the password is already restoring access,
  // so a stale lock from the account's earlier failed attempts shouldn't keep blocking it.
  db.prepare('UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?').run(
    hash,
    targetId
  );

  res.json({ ok: true, tempPassword });
}));

// ---------- Local LLMs (Ollama) ----------

router.get('/models', asyncHandler(async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!r.ok) throw new Error(`Ollama responded with ${r.status}`);
    const data = await r.json();
    res.json({ models: data.models || [] });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Ollama', details: err.message });
  }
}));

// Streams pull progress over SSE so the admin UI can show a progress bar.
router.post('/models/pull', asyncHandler(async (req, res) => {
  const { model } = req.body || {};
  if (typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'Model name is required' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.trim(), stream: true }),
      signal: controller.signal,
    });

    if (!ollamaRes.ok || !ollamaRes.body) {
      throw new Error(`Ollama responded with status ${ollamaRes.status}`);
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const chunk = JSON.parse(trimmed);
        sendEvent(res, 'progress', chunk);
      }
    }
    sendEvent(res, 'done', { model: model.trim() });
  } catch (err) {
    if (err.name !== 'AbortError') {
      sendEvent(res, 'error', { error: err.message || 'Pull failed' });
    }
  }

  res.end();
}));

// Creates (or re-creates) a derived Ollama model that wraps an existing base model with a fixed,
// permanent system prompt — a lightweight "house model" persona. This does not change the base
// model's weights or knowledge; it's a Modelfile wrapper, not fine-tuning.
router.post('/models/house', asyncHandler(async (req, res) => {
  const { name, baseModel, systemPrompt } = req.body || {};
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name.trim())) {
    return res.status(400).json({ error: 'Enter a valid model name (letters, numbers, ., _, - only)' });
  }
  if (typeof baseModel !== 'string' || !baseModel.trim()) {
    return res.status(400).json({ error: 'Choose a base model' });
  }
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    return res.status(400).json({ error: 'System prompt is required' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: name.trim(),
        from: baseModel.trim(),
        system: systemPrompt.trim(),
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!ollamaRes.ok || !ollamaRes.body) {
      const errBody = await ollamaRes.text().catch(() => '');
      let detail = `status ${ollamaRes.status}`;
      try {
        detail = JSON.parse(errBody).error || detail;
      } catch {
        if (errBody) detail = errBody;
      }
      throw new Error(`Ollama: ${detail}`);
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        sendEvent(res, 'progress', JSON.parse(trimmed));
      }
    }

    setSetting(
      'house_model',
      JSON.stringify({ name: name.trim(), baseModel: baseModel.trim(), systemPrompt: systemPrompt.trim() })
    );
    sendEvent(res, 'done', { model: name.trim() });
  } catch (err) {
    if (err.name !== 'AbortError') {
      sendEvent(res, 'error', { error: err.message || 'Create failed' });
    }
  }

  res.end();
}));

router.post('/models/delete', asyncHandler(async (req, res) => {
  const { model } = req.body || {};
  if (typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'Model name is required' });
  }
  try {
    const r = await fetch(`${OLLAMA_URL}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.trim() }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(text || `Ollama responded with ${r.status}`);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not delete model', details: err.message });
  }
}));

// ---------- Allowed domains (for the fetch_url tool) ----------

router.get('/domains', (req, res) => {
  const domains = db
    .prepare(
      `SELECT ad.id, ad.domain, ad.created_at, u.username AS added_by
       FROM allowed_domains ad LEFT JOIN users u ON u.id = ad.added_by
       ORDER BY ad.domain ASC`
    )
    .all();
  res.json({ domains });
});

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

router.post('/domains', (req, res) => {
  const { domain } = req.body || {};
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain.trim())) {
    return res.status(400).json({ error: 'Enter a valid domain, e.g. example.com' });
  }
  const clean = domain.trim().toLowerCase();
  try {
    db.prepare('INSERT INTO allowed_domains (domain, added_by) VALUES (?, ?)').run(clean, req.session.userId);
  } catch {
    return res.status(409).json({ error: 'That domain is already on the list' });
  }
  res.json({ ok: true });
});

router.delete('/domains/:id', (req, res) => {
  db.prepare('DELETE FROM allowed_domains WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Settings ----------

const { getSetting, setSetting, getHouseModel } = require('../settings');

router.get('/settings', (req, res) => {
  res.json({
    webSearchEnabled: getSetting('web_search_enabled', 'false') === 'true',
    searchRestricted: getSetting('search_restricted', 'false') === 'true',
    houseModel: getHouseModel(),
    retentionDays: Number(getSetting('retention_days', '0')) || 0,
  });
});

router.post('/settings', (req, res) => {
  const { webSearchEnabled, searchRestricted, retentionDays } = req.body || {};
  if (webSearchEnabled !== undefined) {
    if (typeof webSearchEnabled !== 'boolean') {
      return res.status(400).json({ error: 'webSearchEnabled must be true or false' });
    }
    setSetting('web_search_enabled', webSearchEnabled ? 'true' : 'false');
  }
  if (searchRestricted !== undefined) {
    if (typeof searchRestricted !== 'boolean') {
      return res.status(400).json({ error: 'searchRestricted must be true or false' });
    }
    setSetting('search_restricted', searchRestricted ? 'true' : 'false');
  }
  if (retentionDays !== undefined) {
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 0) {
      return res.status(400).json({ error: 'retentionDays must be 0 (disabled) or a positive integer' });
    }
    setSetting('retention_days', String(days));
  }
  res.json({ ok: true });
});

// ---------- Analytics ----------

router.get('/analytics', (req, res) => {
  const totals = {
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
    messages: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE is_active = 1").get().n,
    documents: db.prepare('SELECT COUNT(*) AS n FROM documents').get().n,
  };

  const messagesByDepartment = db
    .prepare(
      `SELECT COALESCE(u.department, '(none)') AS department, COUNT(*) AS count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN users u ON u.id = c.user_id
       WHERE m.role = 'user'
       GROUP BY u.department
       ORDER BY count DESC`
    )
    .all();

  const messagesByModel = db
    .prepare(
      `SELECT c.model AS model, COUNT(*) AS count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role = 'assistant' AND m.is_active = 1
       GROUP BY c.model
       ORDER BY count DESC`
    )
    .all();

  const feedbackRows = db
    .prepare(
      `SELECT feedback, COUNT(*) AS count
       FROM messages
       WHERE role = 'assistant' AND is_active = 1 AND feedback IS NOT NULL
       GROUP BY feedback`
    )
    .all();
  const feedback = { up: 0, down: 0 };
  for (const r of feedbackRows) feedback[r.feedback] = r.count;

  const topUsers = db
    .prepare(
      `SELECT u.username AS username, u.department AS department, COUNT(*) AS count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN users u ON u.id = c.user_id
       WHERE m.role = 'user'
       GROUP BY u.id
       ORDER BY count DESC
       LIMIT 10`
    )
    .all();

  // Citations are a JSON array per message, not a normalized table — tallying "most cited
  // documents" needs a pass over them in JS rather than pure SQL aggregation.
  const citationRows = db
    .prepare(
      `SELECT citations FROM messages WHERE role = 'assistant' AND is_active = 1 AND citations IS NOT NULL`
    )
    .all();
  const docCounts = new Map();
  for (const row of citationRows) {
    let citations;
    try {
      citations = JSON.parse(row.citations);
    } catch {
      continue;
    }
    for (const c of citations || []) {
      if (!c?.id) continue;
      const entry = docCounts.get(c.id) || { id: c.id, filename: c.filename, count: 0 };
      entry.count += 1;
      docCounts.set(c.id, entry);
    }
  }
  const topDocuments = [...docCounts.values()].sort((a, b) => b.count - a.count).slice(0, 10);

  res.json({ totals, messagesByDepartment, messagesByModel, feedback, topUsers, topDocuments });
});

// ---------- Database backup ----------

// Takes a consistent point-in-time snapshot via SQLite's own online-backup API — safe to run
// while the server keeps writing to the live database (WAL mode allows a concurrent reader) —
// rather than copying the raw file, which could grab it mid-write and produce a corrupt copy.
router.get('/backup', asyncHandler(async (req, res) => {
  const tmpPath = path.join(os.tmpdir(), `amerb-ai-backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  const source = new DatabaseSync(db.DB_PATH, { readOnly: true });
  try {
    await backup(source, tmpPath);
  } finally {
    source.close();
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.download(tmpPath, `amerb-ai-backup-${stamp}.sqlite`, () => {
    fs.unlink(tmpPath, () => {});
  });
}));

// ---------- Conversation retention ----------

// Lets the admin see exactly what a cleanup would remove — which users, which conversations,
// how many — before committing to an irreversible delete. Added after a real incident where a
// cleanup ran against production with only a day-count to go on and removed more than expected.
router.get('/cleanup-old-conversations/preview', (req, res) => {
  const days = Number(req.query.retentionDays);
  if (!Number.isInteger(days) || days < 1) {
    return res.status(400).json({ error: 'retentionDays must be a positive integer' });
  }
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.updated_at, u.username
       FROM conversations c
       JOIN users u ON u.id = c.user_id
       WHERE c.updated_at < datetime('now', '-${days} days')
       ORDER BY c.updated_at ASC`
    )
    .all();
  res.json({ count: rows.length, sample: rows.slice(0, 15) });
});

router.post('/cleanup-old-conversations', (req, res) => {
  const { retentionDays } = req.body || {};
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 1) {
    return res.status(400).json({ error: 'retentionDays must be a positive integer' });
  }
  const result = db
    .prepare(`DELETE FROM conversations WHERE updated_at < datetime('now', '-${days} days')`)
    .run();
  res.json({ ok: true, deleted: result.changes });
});

// ---------- Bulk staff onboarding (CSV import) ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_EMAIL_DOMAIN = 'amenfimanbank.com';

// A hand-rolled parser is enough here: the expected input is a plain, unquoted CSV of
// username,email,department rows exported from a spreadsheet — not general-purpose CSV with
// embedded commas/quotes, so pulling in a full CSV library would be more than this needs.
function parseStaffCsv(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

router.post('/users/import', asyncHandler(async (req, res) => {
  const { csv } = req.body || {};
  if (typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: 'CSV content is required' });
  }

  let rows = parseStaffCsv(csv);
  // Tolerate an optional header row (e.g. "username,email,department").
  if (rows.length && rows[0][0]?.toLowerCase() === 'username') {
    rows = rows.slice(1);
  }

  const created = [];
  const skipped = [];

  for (const [i, row] of rows.entries()) {
    const rowNum = i + 1;
    const [usernameRaw, emailRaw, departmentRaw] = row;
    const username = (usernameRaw || '').trim();
    const email = (emailRaw || '').trim().toLowerCase();
    const department = (departmentRaw || '').trim();

    if (username.length < 3 || username.length > 32) {
      skipped.push({ row: rowNum, username, reason: 'Username must be 3-32 characters' });
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      skipped.push({ row: rowNum, username, reason: 'Invalid email address' });
      continue;
    }
    if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      skipped.push({ row: rowNum, username, reason: `Email must end in @${ALLOWED_EMAIL_DOMAIN}` });
      continue;
    }
    if (department && !DEPARTMENTS.includes(department)) {
      skipped.push({ row: rowNum, username, reason: `"${department}" is not a recognized department` });
      continue;
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
      skipped.push({ row: rowNum, username, reason: 'Username or email already exists' });
      continue;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    db.prepare('INSERT INTO users (username, email, password_hash, department) VALUES (?, ?, ?, ?)').run(
      username,
      email,
      passwordHash,
      department || null
    );
    created.push({ username, email, tempPassword });
  }

  res.json({ created, skipped });
}));

module.exports = router;

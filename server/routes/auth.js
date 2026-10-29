const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { DEPARTMENTS } = require('../departments');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_EMAIL_DOMAIN = 'amenfimanbank.com';

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// SQLite's datetime('now') is UTC with no 'Z' suffix — Date can't tell that from local time
// unless told, the same fix already used for created_at timestamps elsewhere in this app.
function parseUtc(sqliteTimestamp) {
  return new Date(`${sqliteTimestamp}Z`);
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    department: row.department,
    customInstructions: row.custom_instructions || '',
  };
}

const MAX_CUSTOM_INSTRUCTIONS = 2000;

router.post('/signup', asyncHandler(async (req, res) => {
  const { username, email, password, department } = req.body || {};

  if (typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 32) {
    return res.status(400).json({ error: 'Username must be 3-32 characters' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
    return res.status(403).json({ error: `Registration is restricted to @${ALLOWED_EMAIL_DOMAIN} email addresses` });
  }

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (typeof department !== 'string' || !DEPARTMENTS.includes(department)) {
    return res.status(400).json({ error: 'Select a valid department' });
  }

  const cleanUsername = username.trim();

  const existing = db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get(cleanUsername, cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'Username or email is already taken' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = db
    .prepare('INSERT INTO users (username, email, password_hash, department) VALUES (?, ?, ?, ?)')
    .run(cleanUsername, cleanEmail, passwordHash, department);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { identifier, password } = req.body || {};

  if (typeof identifier !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  const clean = identifier.trim().toLowerCase();
  const user = db
    .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(identifier.trim(), clean);

  if (!user) {
    return res.status(401).json({ error: 'Invalid username/email or password' });
  }

  if (user.locked_until) {
    const lockedUntil = parseUtc(user.locked_until);
    if (lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((lockedUntil - new Date()) / 60000);
      return res
        .status(429)
        .json({ error: `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` });
    }
    // Lock has expired — clear it before continuing so a correct password on this attempt works.
    db.prepare('UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = ?').run(user.id);
    user.failed_login_count = 0;
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const failedCount = (user.failed_login_count || 0) + 1;
    if (failedCount >= MAX_FAILED_LOGIN_ATTEMPTS) {
      db.prepare(`UPDATE users SET failed_login_count = ?, locked_until = datetime('now', '+${LOCKOUT_MINUTES} minutes') WHERE id = ?`).run(
        failedCount,
        user.id
      );
      return res
        .status(429)
        .json({ error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` });
    }
    db.prepare('UPDATE users SET failed_login_count = ? WHERE id = ?').run(failedCount, user.id);
    return res.status(401).json({ error: 'Invalid username/email or password' });
  }

  if (user.failed_login_count) {
    db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: publicUser(user) });
});

// Lets a user set standing preferences (tone, role context, etc.) that get folded into the
// system prompt on every chat, the same way ChatGPT/Claude custom instructions work.
router.patch('/me/instructions', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { customInstructions } = req.body || {};
  if (typeof customInstructions !== 'string') {
    return res.status(400).json({ error: 'customInstructions must be a string' });
  }
  const trimmed = customInstructions.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS);
  db.prepare('UPDATE users SET custom_instructions = ? WHERE id = ?').run(trimmed || null, req.session.userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user: publicUser(user) });
});

// Lets a logged-in user change their own password, proving they know the current one first —
// unlike an admin-initiated reset, this doesn't need to work for someone who's locked out.
router.patch('/me/password', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
  res.json({ ok: true });
}));

router.get('/departments', (req, res) => {
  res.json({ departments: DEPARTMENTS, allowedEmailDomain: ALLOWED_EMAIL_DOMAIN });
});

module.exports = router;

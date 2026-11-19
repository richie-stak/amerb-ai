const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { logAudit } = require('../audit');
const { DEPARTMENTS } = require('../departments');
const L = require('../languages');
const languageSettings = require('../languageSettings');

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
    replyLanguage: row.reply_language || null,
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
  logAudit(req, 'auth.signup', { email: user.email }, user);

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
    logAudit(req, 'auth.login_failed', { identifier: identifier.trim(), reason: 'unknown account' }, null);
    return res.status(401).json({ error: 'Invalid username/email or password' });
  }

  if (user.locked_until) {
    const lockedUntil = parseUtc(user.locked_until);
    if (lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((lockedUntil - new Date()) / 60000);
      logAudit(req, 'auth.login_failed', { reason: 'account locked' }, user);
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
      logAudit(req, 'auth.account_locked', { failedAttempts: failedCount }, user);
      return res
        .status(429)
        .json({ error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` });
    }
    db.prepare('UPDATE users SET failed_login_count = ? WHERE id = ?').run(failedCount, user.id);
    logAudit(req, 'auth.login_failed', { reason: 'wrong password', failedAttempts: failedCount }, user);
    return res.status(401).json({ error: 'Invalid username/email or password' });
  }

  if (user.failed_login_count) {
    db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }

  logAudit(req, 'auth.login', {}, user);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
}));

router.post('/logout', (req, res) => {
  if (req.session?.userId) logAudit(req, 'auth.logout');
  req.session.destroy(() => {
    res.clearCookie('amerb.sid');
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

// Lets a logged-in user choose the language AMERB AI answers them in, independently of everyone
// else. Refused when an admin has taken the choice away (everyone then follows the bank default), and
// refused for a language the bank hasn't made available — a language only becomes available once a
// model has passed its capability test, so saving one that isn't offered yet would just be ignored
// at answer time.
router.patch('/me/language', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { language } = req.body || {};
  if (!L.CHOICES.includes(language)) {
    return res.status(400).json({ error: 'Choose a valid language' });
  }
  if (!languageSettings.choiceAllowed()) {
    return res.status(403).json({ error: 'Your administrator has fixed the reply language for everyone.' });
  }
  if (language !== L.DEFAULT_LANGUAGE && language !== L.AUTO) {
    if (!languageSettings.isEnabled(language)) {
      return res.status(400).json({ error: `${L.labelOf(language)} is not available at this bank.` });
    }
    if (!languageSettings.approvedModels(language).length && !languageSettings.isOverridden(language)) {
      return res.status(400).json({
        error: `${L.labelOf(language)} has not been approved for any model yet. Ask your administrator to run a language test first.`,
      });
    }
  }
  db.prepare('UPDATE users SET reply_language = ? WHERE id = ?').run(language, req.session.userId);
  logAudit(req, 'auth.language_changed', { language });
  res.json({ ok: true, language });
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
  logAudit(req, 'auth.password_changed', {}, user);
  res.json({ ok: true });
}));

router.get('/departments', (req, res) => {
  res.json({ departments: DEPARTMENTS, allowedEmailDomain: ALLOWED_EMAIL_DOMAIN });
});

module.exports = router;

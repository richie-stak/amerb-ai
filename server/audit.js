// Audit trail: who did what, when, from where — sign-ins, questions asked, document changes and
// every admin action. Rows are never edited or deleted through the app (internal audit relies on
// that), and they keep a copy of the username and department so they still read correctly after
// an account is deleted or moved. Passwords and API keys are never recorded.
const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER,
    username TEXT,
    department TEXT,
    action TEXT NOT NULL,
    details TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
`);

const SECRET_FIELD = /pass(word)?|api_?key|secret|token|key$/i;
const MAX_TEXT = 500;

// Copies an object for the log with secret-looking fields blanked and long text cut short.
function sanitize(value, depth = 0) {
  if (value == null || depth > 3) return value;
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELD.test(k) ? '[hidden]' : sanitize(v, depth + 1);
    return out;
  }
  return value;
}

function clientIp(req) {
  return req ? String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') : null;
}

const userStmt = () => db.prepare('SELECT id, username, department FROM users WHERE id = ?');

// Records one event. `who` is a user row, a user id, or null (e.g. a failed sign-in for an
// unknown name). Never throws — a logging hiccup must not break the action being logged.
function logAudit(req, action, details = {}, who = undefined) {
  try {
    let user = who;
    if (user === undefined) user = req?.session?.userId ?? null;
    if (typeof user === 'number' || typeof user === 'bigint') user = userStmt().get(user) || { id: Number(user) };
    db.prepare('INSERT INTO audit_log (user_id, username, department, action, details, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
      user?.id ?? null,
      user?.username ?? null,
      user?.department ?? null,
      action,
      JSON.stringify(sanitize(details)),
      clientIp(req)
    );
  } catch (err) {
    console.error('Could not write audit log entry:', err.message);
  }
}

// Express middleware for admin routers: records every successful change (anything but a GET)
// with its path and request body, so no admin action can slip by unrecorded.
function auditAdminChanges(req, res, next) {
  if (req.method === 'GET') return next();
  res.on('finish', () => {
    if (res.statusCode < 400) {
      logAudit(req, `admin.${req.method.toLowerCase()}`, { path: req.baseUrl + req.path, body: req.body || {} });
    }
  });
  next();
}

const ACTION_GROUPS = ['auth', 'chat', 'document', 'admin'];

function queryAudit({ user, action, from, to, limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (user) {
    where.push('(username LIKE ? OR CAST(user_id AS TEXT) = ?)');
    params.push(`%${user}%`, String(user));
  }
  if (action) {
    where.push(ACTION_GROUPS.includes(action) ? 'action LIKE ?' : 'action = ?');
    params.push(ACTION_GROUPS.includes(action) ? `${action}.%` : action);
  }
  if (from) {
    where.push('at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('at <= ?');
    params.push(`${to} 23:59:59`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(Number(limit) || 200, 5000), Number(offset) || 0)
    .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : {} }));
  return { total, rows };
}

module.exports = { logAudit, auditAdminChanges, queryAudit, ACTION_GROUPS };

const db = require('../db');

// Re-checks that the session's user still actually exists (not just that a session cookie is
// present) — an account can be deleted by an admin while its owner still has a live session, and
// several routes assume `currentUser(req)` never returns undefined once past this middleware.
// The body says *why* the request was refused, so the browser can send the person to the sign-in page
// with an explanation instead of showing a bare error or retrying forever. The requirement itself is
// unchanged: no session, no access.
const notAuthenticated = (res) =>
  res.status(401).json({ error: 'Not authenticated', code: 'unauthenticated', sessionExpired: true });

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return notAuthenticated(res);
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    return req.session.destroy(() => notAuthenticated(res));
  }
  return next();
}

// Roles, from most to least privileged:
//   admin   - changes anything
//   auditor - read-only access to records and reports (language settings, terminology, audit log,
//             usage figures); every route that writes refuses them
//   user    - ordinary staff
function roleOf(req) {
  if (!req.session || !req.session.userId) return null;
  return db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId)?.role || null;
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return notAuthenticated(res);
  }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// For reports an auditor is allowed to read but not change. Used on GET only — anything that writes
// stays behind requireAdmin, so auditing never becomes a way in.
function requireAdminOrAuditor(req, res, next) {
  if (!req.session || !req.session.userId) {
    return notAuthenticated(res);
  }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !['admin', 'auditor'].includes(user.role)) {
    return res.status(403).json({ error: 'Administrator or auditor access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireAdminOrAuditor, roleOf };

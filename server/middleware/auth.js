const db = require('../db');

// Re-checks that the session's user still actually exists (not just that a session cookie is
// present) — an account can be deleted by an admin while its owner still has a live session, and
// several routes assume `currentUser(req)` never returns undefined once past this middleware.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    return req.session.destroy(() => res.status(401).json({ error: 'Not authenticated' }));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };

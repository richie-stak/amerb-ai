// Login sessions kept in the app's SQLite database instead of memory, so restarting the server
// (an update, a reboot, the launcher restarting it) no longer signs every member of staff out.
const session = require('express-session');
const db = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`);

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function expiryOf(sess) {
  const expires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
  return Number.isFinite(expires) ? expires : Date.now() + DEFAULT_TTL_MS;
}

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this.prune();
    setInterval(() => this.prune(), PRUNE_INTERVAL_MS).unref();
  }

  prune() {
    try {
      this.pruneStmt.run(Date.now());
    } catch {
      /* a failed clean-up just leaves expired rows for next time */
    }
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires < Date.now()) return callback(null, null);
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), expiryOf(sess));
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      this.touchStmt.run(expiryOf(sess), sid);
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }
}

// Signs a user out everywhere — used when an admin deletes an account or resets its password.
function destroyUserSessions(userId) {
  for (const row of db.prepare('SELECT sid, sess FROM sessions').all()) {
    try {
      if (JSON.parse(row.sess).userId === userId) db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.sid);
    } catch {
      /* skip unreadable rows */
    }
  }
}

module.exports = { SqliteSessionStore, destroyUserSessions };

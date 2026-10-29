const db = require('./db');
const { getSetting } = require('./settings');

// Runs on a timer (see index.js) so an admin doesn't have to remember to trigger cleanup
// manually once retention is configured. A retentionDays of 0 (the default) means "keep forever"
// — nothing is ever deleted unless an admin opts in.
function runRetentionSweep() {
  const days = Number(getSetting('retention_days', '0')) || 0;
  if (days < 1) return;
  const result = db.prepare(`DELETE FROM conversations WHERE updated_at < datetime('now', '-${days} days')`).run();
  if (result.changes) {
    console.log(`Retention sweep: deleted ${result.changes} conversation(s) older than ${days} days.`);
  }
}

module.exports = { runRetentionSweep };

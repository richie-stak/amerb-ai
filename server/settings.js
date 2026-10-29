const db = require('./db');

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// Web search is off by default — it's the first tool in this app that sends user-typed query
// text to an external service (DuckDuckGo) rather than just fetching admin-approved pages, so an
// admin has to deliberately opt in.
function isWebSearchEnabled() {
  return getSetting('web_search_enabled', 'false') === 'true';
}

// When on, every web search (whether the model calls it or the globe-icon toggle forces it) is
// scoped to only the admin's approved domains list, instead of the open web.
function isSearchRestricted() {
  return getSetting('search_restricted', 'false') === 'true';
}

// A model's Modelfile-baked SYSTEM prompt is only a *default* — Ollama drops it entirely the
// moment a caller's request includes its own system message, which chat.js always does. So the
// house-model persona has to be re-injected into every turn's system messages when that model is
// selected, or it silently has no effect despite having been "baked in".
function getHouseModel() {
  try {
    return JSON.parse(getSetting('house_model', 'null'));
  } catch {
    return null;
  }
}

module.exports = { getSetting, setSetting, isWebSearchEnabled, isSearchRestricted, getHouseModel };

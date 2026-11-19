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

// When the bank-wide policies and the department files don't answer a question, may AMERB AI look
// in the administrator-approved websites? On by default; never the open web (see tools.js webSearch).
function isKbOnlineFallbackEnabled() {
  return getSetting('kb_online_fallback', 'true') !== 'false';
}

// Currency rates: an optional tool, off unless an administrator turns it on. Only the currency pair
// is sent to the rate service — no customer data — and the address can be pointed at the bank's own
// rate source instead of the public default.
function isExchangeRateEnabled() {
  return getSetting('exchange_rate_enabled', 'false') === 'true';
}

function exchangeRateUrl() {
  return getSetting('exchange_rate_url', '') || process.env.EXCHANGE_RATE_URL || 'https://open.er-api.com/v6/latest/GHS';
}

// A self-hosted SearXNG instance is the reliable way to search from inside a bank network: no
// scraping of a public engine, and no bot-check pages. Set SEARXNG_URL to use it.
function searxngUrl() {
  return process.env.SEARXNG_URL || '';
}

module.exports = {
  getSetting,
  setSetting,
  isWebSearchEnabled,
  isSearchRestricted,
  getHouseModel,
  isKbOnlineFallbackEnabled,
  isExchangeRateEnabled,
  exchangeRateUrl,
  searxngUrl,
};

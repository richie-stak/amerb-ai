// External AI providers an admin has connected (OpenAI, Anthropic, DeepSeek, or any
// OpenAI-compatible service), stored with their API keys encrypted. Staff only ever see the
// specific models an admin enabled, never the keys.
const db = require('../db');
const { encryptSecret, decryptSecret, maskSecret } = require('../secrets');

// Per-type defaults. `api` picks the wire format; contextTokens is a conservative budget for how
// much conversation history to send (well under each provider's real limit, to keep costs sane).
const PROVIDER_TYPES = {
  openai: { label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', contextTokens: 64000, vision: true },
  anthropic: { label: 'Anthropic (Claude)', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', contextTokens: 64000, vision: true },
  deepseek: { label: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', contextTokens: 32000, vision: false },
  custom: { label: 'Other (OpenAI-compatible)', api: 'openai', baseUrl: '', contextTokens: 16000, vision: false },
};

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_enc TEXT NOT NULL,
    available_models TEXT NOT NULL DEFAULT '[]',
    enabled_models TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function parseList(json) {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    baseUrl: row.base_url,
    availableModels: parseList(row.available_models),
    enabledModels: parseList(row.enabled_models),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    _apiKeyEnc: row.api_key_enc,
  };
}

// What the admin portal sees — the key only ever leaves the server masked.
function toPublic(provider) {
  if (!provider) return null;
  const { _apiKeyEnc, ...rest } = provider;
  let keyHint = '••••';
  try {
    keyHint = maskSecret(decryptSecret(_apiKeyEnc));
  } catch {
    keyHint = '(unreadable — re-enter the key)';
  }
  return { ...rest, typeLabel: PROVIDER_TYPES[provider.type]?.label || provider.type, keyHint };
}

function getProvider(id) {
  return hydrate(db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id));
}

function listProviders() {
  return db.prepare('SELECT * FROM ai_providers ORDER BY id ASC').all().map(hydrate);
}

function apiKeyOf(provider) {
  return decryptSecret(provider._apiKeyEnc);
}

function createProvider({ type, name, baseUrl, apiKey, availableModels }) {
  const result = db
    .prepare('INSERT INTO ai_providers (type, name, base_url, api_key_enc, available_models) VALUES (?, ?, ?, ?, ?)')
    .run(type, name, baseUrl, encryptSecret(apiKey), JSON.stringify(availableModels || []));
  return getProvider(result.lastInsertRowid);
}

function updateProvider(id, fields) {
  const sets = [];
  const params = [];
  const map = {
    name: (v) => ['name = ?', v],
    baseUrl: (v) => ['base_url = ?', v],
    apiKey: (v) => ['api_key_enc = ?', encryptSecret(v)],
    availableModels: (v) => ['available_models = ?', JSON.stringify(v)],
    enabledModels: (v) => ['enabled_models = ?', JSON.stringify(v)],
    enabled: (v) => ['enabled = ?', v ? 1 : 0],
  };
  for (const [key, toSql] of Object.entries(map)) {
    if (fields[key] === undefined) continue;
    const [sql, value] = toSql(fields[key]);
    sets.push(sql);
    params.push(value);
  }
  if (sets.length) db.prepare(`UPDATE ai_providers SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return getProvider(id);
}

function deleteProvider(id) {
  db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id);
}

module.exports = {
  PROVIDER_TYPES,
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  toPublic,
  apiKeyOf,
};

// Which model answers whom, what happens when it fails, and whether the answers are any good.
//
//  - Per-department defaults: Credit can start on one model, IT on another. Only the *default*
//    for people who haven't picked a model themselves; anyone can still choose from the picker.
//  - Fallback: if the chosen model can't answer (Ollama down, model not pulled, provider outage)
//    the turn is retried on the next model in an admin-ordered list — and finally on DEFAULT_MODEL
//    if it's local — instead of leaving the person with an error.
//  - Quality: the thumbs up/down staff already give, turned into a per-model (and per-department)
//    report, with a suggestion for the best-rated model in each department.
const db = require('./db');
const { getSetting, setSetting } = require('./settings');

const MIN_RATINGS_FOR_JUDGEMENT = 10;
const MIN_RATINGS_FOR_SUGGESTION = 5;

function readJson(key, fallback) {
  try {
    const value = JSON.parse(getSetting(key, 'null'));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function getRouting() {
  const departmentModels = readJson('department_models', {});
  const fallbackModels = readJson('fallback_models', []);
  return {
    departmentModels: departmentModels && typeof departmentModels === 'object' && !Array.isArray(departmentModels) ? departmentModels : {},
    fallbackModels: Array.isArray(fallbackModels) ? fallbackModels.filter((m) => typeof m === 'string') : [],
    fallbackEnabled: getSetting('fallback_enabled', 'true') !== 'false',
  };
}

// `known` is the list of model names that actually exist right now (local + enabled external);
// anything outside it is rejected so a typo can't silently break routing.
function setRouting({ departmentModels, fallbackModels, fallbackEnabled }, { known, departments, isChatModel }) {
  // A model that only produces embeddings cannot answer a message. Checking the role here as well as in
  // the route means every caller (routing, fallbacks, imports) gets the same rule.
  const requireChatModel = (model, where) => {
    // The role is checked first: an embedding model is usually not in the chat list at all, and
    // "not an available model" would hide why.
    if (isChatModel && !isChatModel(model)) {
      throw new Error(`"${model}" is an embedding model and cannot be used as a chat model — choose a chat model such as qwen3:4b-instruct`);
    }
    if (!known.includes(model)) throw new Error(`"${model}" is not an available model`);
    return model;
  };
  if (departmentModels !== undefined) {
    if (!departmentModels || typeof departmentModels !== 'object' || Array.isArray(departmentModels)) {
      throw new Error('departmentModels must be an object of department → model');
    }
    const clean = {};
    for (const [dept, model] of Object.entries(departmentModels)) {
      if (!model) continue; // empty = use the global default
      if (!departments.includes(dept)) throw new Error(`Unknown department "${dept}"`);
      clean[dept] = requireChatModel(model, dept);
    }
    setSetting('department_models', JSON.stringify(clean));
  }
  if (fallbackModels !== undefined) {
    if (!Array.isArray(fallbackModels)) throw new Error('fallbackModels must be a list');
    const clean = [];
    for (const model of fallbackModels) {
      requireChatModel(model, 'fallback');
      if (!clean.includes(model)) clean.push(model);
    }
    setSetting('fallback_models', JSON.stringify(clean));
  }
  if (fallbackEnabled !== undefined) {
    if (typeof fallbackEnabled !== 'boolean') throw new Error('fallbackEnabled must be true or false');
    setSetting('fallback_enabled', fallbackEnabled ? 'true' : 'false');
  }
}

const withTag = (n) => (n.includes(':') || n.startsWith('ext/') ? n : `${n}:latest`);
const sameModel = (a, b) => withTag(a) === withTag(b);

// The model a person starts on when they haven't chosen one: their department's, if set and
// available; otherwise null (the caller applies the global default).
function departmentDefault(user, availableNames) {
  const model = getRouting().departmentModels[user?.department];
  if (!model) return null;
  return availableNames.find((n) => sameModel(n, model)) || null;
}

// The models to try, in order, after `failed` models have already not worked.
function fallbackCandidates(failed) {
  const { fallbackModels, fallbackEnabled } = getRouting();
  if (!fallbackEnabled) return [];
  const list = [...fallbackModels];
  // The global default is the last resort, so "the model an admin told everyone to use" still
  // answers when someone's own pick breaks. AMERB_DEFAULT_FALLBACK=off turns that off (the test
  // suite does, so a test that expects a failure never quietly runs a real model instead).
  const globalDefault = process.env.DEFAULT_MODEL;
  if (globalDefault && process.env.AMERB_DEFAULT_FALLBACK !== 'off' && !list.some((m) => sameModel(m, globalDefault))) {
    list.push(globalDefault);
  }
  return list.filter((m) => !failed.some((f) => sameModel(f, m)));
}

// ---------- Live health of each model, as seen by real chats ----------

const health = new Map(); // model -> { ok, failed, lastError, lastErrorAt, lastOkAt }

function entryFor(model) {
  if (!health.has(model)) health.set(model, { ok: 0, failed: 0, lastError: null, lastErrorAt: null, lastOkAt: null });
  return health.get(model);
}

function recordSuccess(model) {
  const e = entryFor(model);
  e.ok += 1;
  e.lastOkAt = new Date().toISOString();
}

function recordFailure(model, error) {
  const e = entryFor(model);
  e.failed += 1;
  e.lastError = String(error).slice(0, 300);
  e.lastErrorAt = new Date().toISOString();
}

const healthSnapshot = () => Object.fromEntries(health);

// ---------- Quality report ----------

// The lower end of a 95% confidence interval for the true approval rate. Ranking by this rather
// than the raw percentage stops "1 of 1 thumbs up" from beating "90 of 100".
function wilsonLowerBound(up, total) {
  if (!total) return 0;
  const z = 1.96;
  const p = up / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denom);
}

function verdict(up, down) {
  const rated = up + down;
  if (rated < MIN_RATINGS_FOR_JUDGEMENT) return 'not-enough-ratings';
  const approval = up / rated;
  if (approval < 0.6) return 'review';
  if (approval >= 0.85) return 'good';
  return 'ok';
}

function qualityReport({ days = 0, now = null } = {}) {
  const since = days > 0 ? `AND m.created_at >= datetime('now', '-${Math.floor(days)} days')` : '';
  const rows = db
    .prepare(
      `SELECT COALESCE(m.model, c.model) AS model,
              COALESCE(u.department, '(none)') AS department,
              COUNT(*) AS answers,
              SUM(CASE WHEN m.feedback = 'up' THEN 1 ELSE 0 END) AS up,
              SUM(CASE WHEN m.feedback = 'down' THEN 1 ELSE 0 END) AS down,
              AVG(m.duration_ms) AS avg_ms,
              SUM(CASE WHEN m.fallback_from IS NOT NULL THEN 1 ELSE 0 END) AS fallbacks
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN users u ON u.id = c.user_id
       WHERE m.role = 'assistant' AND m.is_active = 1 ${since}
       GROUP BY 1, 2`
    )
    .all();

  const byModel = new Map();
  const byDepartment = new Map(); // department -> model -> counts
  for (const r of rows) {
    const m = byModel.get(r.model) || { model: r.model, answers: 0, up: 0, down: 0, msTotal: 0, msCount: 0, fallbacks: 0 };
    m.answers += r.answers;
    m.up += r.up;
    m.down += r.down;
    m.fallbacks += r.fallbacks;
    if (r.avg_ms != null) {
      m.msTotal += r.avg_ms * r.answers;
      m.msCount += r.answers;
    }
    byModel.set(r.model, m);

    const d = byDepartment.get(r.department) || new Map();
    d.set(r.model, { up: r.up, down: r.down, answers: r.answers });
    byDepartment.set(r.department, d);
  }

  const models = [...byModel.values()]
    .map((m) => {
      const rated = m.up + m.down;
      return {
        model: m.model,
        answers: m.answers,
        rated,
        up: m.up,
        down: m.down,
        approval: rated ? m.up / rated : null,
        score: rated ? wilsonLowerBound(m.up, rated) : null,
        averageSeconds: m.msCount ? Math.round(m.msTotal / m.msCount / 100) / 10 : null,
        servedAsFallback: m.fallbacks,
        verdict: verdict(m.up, m.down),
      };
    })
    .sort((a, b) => b.answers - a.answers);

  const { departmentModels } = getRouting();
  const suggestions = [];
  for (const [department, perModel] of byDepartment) {
    if (department === '(none)') continue;
    const ranked = [...perModel.entries()]
      .map(([model, c]) => ({ model, rated: c.up + c.down, score: wilsonLowerBound(c.up, c.up + c.down), approval: c.up / Math.max(1, c.up + c.down) }))
      .filter((x) => x.rated >= MIN_RATINGS_FOR_SUGGESTION)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) continue;
    const best = ranked[0];
    const current = departmentModels[department] || null;
    // Only worth saying something when it would change what the department uses.
    if (!current || !sameModel(current, best.model)) {
      suggestions.push({ department, current, suggested: best.model, approval: best.approval, rated: best.rated });
    }
  }

  const recentDownvotes = db
    .prepare(
      `SELECT m.id, m.created_at AS at, COALESCE(m.model, c.model) AS model, COALESCE(u.department, '(none)') AS department,
              SUBSTR(m.content, 1, 240) AS answer,
              (SELECT SUBSTR(q.content, 1, 240) FROM messages q
                 WHERE q.conversation_id = m.conversation_id AND q.role = 'user' AND q.id < m.id
                 ORDER BY q.id DESC LIMIT 1) AS question
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN users u ON u.id = c.user_id
       WHERE m.role = 'assistant' AND m.is_active = 1 AND m.feedback = 'down'
       ORDER BY m.id DESC LIMIT 15`
    )
    .all();

  return {
    models,
    suggestions,
    recentDownvotes,
    thresholds: { judgement: MIN_RATINGS_FOR_JUDGEMENT, suggestion: MIN_RATINGS_FOR_SUGGESTION, reviewBelow: 0.6, goodFrom: 0.85 },
    health: healthSnapshot(),
  };
}

module.exports = {
  getRouting,
  setRouting,
  departmentDefault,
  fallbackCandidates,
  recordSuccess,
  recordFailure,
  healthSnapshot,
  qualityReport,
  wilsonLowerBound,
  sameModel,
};

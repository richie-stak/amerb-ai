// Language quality monitoring: what staff think of the answers, which answers were automatically
// flagged as unreliable, and how to investigate a warning.
//
// Two deliberate choices:
//  - A warning stores a *reference* (message, conversation, language, model, provider, reason) and no
//    question or answer text. Monitoring records must not become a second copy of the bank's
//    confidential conversations.
//  - Feedback is one row per staff member per reply, replaced when they change their mind, so the
//    figures count people's current opinion rather than every click.
const db = require('./db');
const providers = require('./llm/providers');

const CATEGORIES = ['good', 'incorrect', 'unclear'];

// 'local' for models on this machine, otherwise the provider's display name — the distinction the
// bank's data-protection policy turns on.
function providerForModel(model) {
  const name = String(model || '');
  if (!name.startsWith('ext/')) return 'local';
  const [, id] = name.split('/');
  const provider = providers.getProvider(Number(id));
  return provider ? provider.name : 'external';
}

// ---------- Warnings (the same events shown in Operations → Recent warnings and errors) ----------

function recordEvent({ messageId, conversationId, userId, language, model, reason }) {
  db.prepare(
    'INSERT INTO language_quality_events (message_id, conversation_id, user_id, language, model, provider, reason) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(messageId ?? null, conversationId ?? null, userId ?? null, language, model || null, providerForModel(model), reason);
}

function eventFilters({ from, to, language, model, reason } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(`${to} 23:59:59`);
  }
  if (language) {
    where.push('language = ?');
    params.push(language);
  }
  if (model) {
    where.push('model = ?');
    params.push(model);
  }
  if (reason) {
    where.push('reason = ?');
    params.push(reason);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function listEvents({ from, to, language, model, reason, limit = 100 } = {}) {
  const { clause, params } = eventFilters({ from, to, language, model, reason });
  const events = db
    .prepare(
      `SELECT id, created_at AS at, reason, language, model, provider, conversation_id AS conversationId, message_id AS messageId
       FROM language_quality_events ${clause} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, Math.min(Math.max(Number(limit) || 100, 1), 500));

  const summary = db
    .prepare(`SELECT reason, COUNT(*) AS count FROM language_quality_events ${clause} GROUP BY reason ORDER BY count DESC`)
    .all(...params);

  // The recurring pattern, which is the point of the whole block: one model failing at one language
  // over and over is a different problem from the occasional odd answer.
  const recurring = db
    .prepare(
      `SELECT model, language, COUNT(*) AS count FROM language_quality_events ${clause}
       GROUP BY model, language HAVING COUNT(*) >= 2 ORDER BY count DESC LIMIT 20`
    )
    .all(...params);

  return { events, summary, recurring };
}

// ---------- Staff feedback ----------

function setFeedback({ messageId, conversationId, userId, category, language, model }) {
  if (category === null || category === undefined) {
    db.prepare('DELETE FROM response_feedback WHERE message_id = ? AND user_id = ?').run(messageId, userId);
    return null;
  }
  if (!CATEGORIES.includes(category)) throw new Error('Choose a valid feedback category');
  const existing = db.prepare('SELECT id FROM response_feedback WHERE message_id = ? AND user_id = ?').get(messageId, userId);
  if (existing) {
    db.prepare(
      "UPDATE response_feedback SET category = ?, language = ?, model = ?, provider = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(category, language || null, model || null, providerForModel(model), existing.id);
  } else {
    db.prepare(
      'INSERT INTO response_feedback (message_id, conversation_id, user_id, category, language, model, provider) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(messageId, conversationId, userId, category, language || null, model || null, providerForModel(model));
  }
  return category;
}

function feedbackFor(messageId) {
  return db.prepare('SELECT category FROM response_feedback WHERE message_id = ?').get(messageId)?.category || null;
}

// ---------- Usage and quality report ----------

const REPORT_DAYS_DEFAULT = 14;

function dayKey(iso) {
  return String(iso || '').slice(0, 10);
}

function usageReport({ from, to, language, provider, model } = {}) {
  const where = ["m.role = 'assistant'", 'm.is_active = 1'];
  const params = [];
  if (from) {
    where.push('m.created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('m.created_at <= ?');
    params.push(`${to} 23:59:59`);
  }
  if (language) {
    where.push('m.language = ?');
    params.push(language);
  }
  if (model) {
    where.push('m.model = ?');
    params.push(model);
  }
  const clause = `WHERE ${where.join(' AND ')}`;

  const answers = db
    .prepare(`SELECT m.id, m.created_at, m.language, m.model, m.language_warning FROM messages m ${clause}`)
    .all(...params);
  if (!answers.length) {
    return emptyReport({ from, to, language, provider, model });
  }

  // Provider is derived from the model name, so an external model can be told apart from a local one
  // without storing a second copy of the provider on every message.
  const withProvider = answers.map((row) => ({ ...row, provider: providerForModel(row.model) }));
  const providerByMessage = new Map(withProvider.map((row) => [row.id, row.provider]));
  const feedback = db
    .prepare(`SELECT message_id, category, provider FROM response_feedback`)
    .all()
    .map((row) => ({ ...row, provider: row.provider || providerByMessage.get(row.message_id) || 'local' }));

  const rows = provider ? withProvider.filter((row) => row.provider === provider) : withProvider;
  const allowed = new Set(rows.map((row) => row.id));
  const filteredFeedback = feedback.filter((row) => allowed.has(row.message_id));

  const perLanguage = new Map();
  const perModel = new Map();
  for (const row of rows) {
    const code = row.language || 'en';
    const lang = perLanguage.get(code) || { language: code, answers: 0, garbled: 0, good: 0, incorrect: 0, unclear: 0 };
    lang.answers += 1;
    if (row.language_warning) lang.garbled += 1;
    perLanguage.set(code, lang);

    const modelKey = row.model || '(none)';
    const modelEntry = perModel.get(modelKey) || { model: modelKey, provider: row.provider, answers: 0, garbled: 0, good: 0, incorrect: 0, unclear: 0 };
    modelEntry.answers += 1;
    if (row.language_warning) modelEntry.garbled += 1;
    perModel.set(modelKey, modelEntry);
  }
  for (const row of filteredFeedback) {
    const answer = rows.find((r) => r.id === row.message_id);
    const code = answer?.language || 'en';
    const lang = perLanguage.get(code);
    if (lang) lang[row.category] += 1;
    const modelEntry = perModel.get(answer?.model || '(none)');
    if (modelEntry) modelEntry[row.category] += 1;
  }

  const totalAnswers = rows.length;
  const byLanguage = [...perLanguage.values()]
    .map((entry) => ({ ...entry, percent: totalAnswers ? Math.round((entry.answers / totalAnswers) * 1000) / 10 : 0 }))
    .sort((a, b) => b.answers - a.answers);
  const byModel = [...perModel.values()].sort((a, b) => b.answers - a.answers);

  const totals = byLanguage.reduce(
    (acc, l) => ({
      answers: acc.answers + l.answers,
      garbled: acc.garbled + l.garbled,
      good: acc.good + l.good,
      incorrect: acc.incorrect + l.incorrect,
      unclear: acc.unclear + l.unclear,
    }),
    { answers: 0, garbled: 0, good: 0, incorrect: 0, unclear: 0 }
  );

  // Daily trend, filling in quiet days so a gap doesn't look like a drop.
  const trendMap = new Map();
  for (const row of rows) {
    const day = dayKey(row.created_at);
    const entry = trendMap.get(day) || { date: day, answers: 0, garbled: 0, good: 0, incorrect: 0, unclear: 0 };
    entry.answers += 1;
    if (row.language_warning) entry.garbled += 1;
    trendMap.set(day, entry);
  }
  for (const row of filteredFeedback) {
    const answer = rows.find((r) => r.id === row.message_id);
    const day = dayKey(answer?.created_at);
    const entry = trendMap.get(day);
    if (entry) entry[row.category] += 1;
  }
  const trend = [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    totals,
    byLanguage: byLanguage.map((l) => ({ ...l, label: languageLabel(l.language) })),
    byModel,
    trend,
    filters: { from: from || null, to: to || null, language: language || null, provider: provider || null, model: model || null },
    options: {
      languages: [...new Set([...byLanguage.map((l) => l.language), language].filter(Boolean))].map((code) => ({ code, label: languageLabel(code) })),
      providers: [...new Set(rows.map((row) => row.provider))].sort(),
      models: [...new Set(rows.map((row) => row.model).filter(Boolean))].sort(),
    },
  };
}

// The minimal set of labels this report needs, without importing the whole language module's logic.
function languageLabel(code) {
  const labels = { en: 'English', tw: 'Twi (Akan)', gaa: 'Ga', fr: 'French' };
  return labels[code] || code;
}

function emptyReport(filters) {
  return {
    totals: { answers: 0, garbled: 0, good: 0, incorrect: 0, unclear: 0 },
    byLanguage: [],
    byModel: [],
    trend: [],
    filters: { from: filters.from || null, to: filters.to || null, language: filters.language || null, provider: filters.provider || null, model: filters.model || null },
    options: { languages: [], providers: [], models: [] },
  };
}

module.exports = {
  CATEGORIES,
  providerForModel,
  recordEvent,
  listEvents,
  setFeedback,
  feedbackFor,
  usageReport,
  REPORT_DAYS_DEFAULT,
};

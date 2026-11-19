// Everything an administrator controls about reply languages, and the rules that decide what a
// given person is actually offered:
//
//  - which languages are enabled at all (English is always on — it is the bank's working language),
//  - the bank-wide default, and whether staff may choose for themselves,
//  - the approved wording for banking terms (never invented by the code),
//  - which models have passed a capability test for which language.
//
// The rule that matters: a language is only offered for a model after the latest capability test of
// that model in that language passed. Producing some text in a language is not evidence of being
// able to use it — see server/languageTests.js for what "passed" means.
const db = require('./db');
const { getSetting, setSetting } = require('./settings');
const { logAudit } = require('./audit');
const L = require('./languages');

const MAX_TERMS_PER_LANGUAGE = 200;
const MAX_TERM_LENGTH = 60;
const MAX_CONTEXT_LENGTH = 200;

// ---------- Settings ----------

function enabledLanguages() {
  let stored = null;
  try {
    stored = JSON.parse(getSetting('language_enabled', 'null'));
  } catch {
    stored = null;
  }
  const codes = new Set(Array.isArray(stored) ? stored.filter((c) => L.CODES.includes(c)) : L.CODES);
  codes.add(L.DEFAULT_LANGUAGE); // English cannot be turned off
  return [...L.CODES].filter((c) => codes.has(c));
}

function isEnabled(code) {
  return enabledLanguages().includes(code);
}

function defaultLanguage() {
  const value = getSetting('default_reply_language', L.DEFAULT_LANGUAGE);
  return L.CODES.includes(value) && isEnabled(value) ? value : L.DEFAULT_LANGUAGE;
}

function choiceAllowed() {
  return getSetting('language_choice_allowed', 'true') !== 'false';
}

// Whether a message in a local language is translated into English for document search (see
// chat.js). On by default: without it, a Twi question finds almost nothing in an English knowledge
// base.
function searchTranslationEnabled() {
  return getSetting('language_search_translation', 'true') !== 'false';
}

// What "the configured AI model" means for the purposes of showing a language to staff: the model
// the bank has told AMERB AI to use by default.
function bankDefaultModel() {
  return process.env.DEFAULT_MODEL || null;
}

function normaliseModel(model) {
  const value = String(model || '');
  if (!value || value.startsWith('ext/')) return value;
  return value.includes(':') ? value : `${value}:latest`;
}

const sameModel = (a, b) => normaliseModel(a) === normaliseModel(b);

// ---------- Capability approvals (what the tests recorded) ----------

// The most recent test for every model+language pair.
function latestTests() {
  return db
    .prepare(
      `SELECT t.* FROM language_capability_tests t
       JOIN (SELECT model, language, MAX(id) AS id FROM language_capability_tests GROUP BY model, language) newest
         ON newest.id = t.id
       ORDER BY t.tested_at DESC, t.id DESC`
    )
    .all();
}

// language code -> [model names whose latest test passed]
function approvalsByLanguage() {
  const out = Object.fromEntries(L.CODES.map((code) => [code, []]));
  for (const row of latestTests()) {
    if (row.status === 'approved' && out[row.language]) out[row.language].push(row.model);
  }
  return out;
}

function approvedModels(code) {
  return approvalsByLanguage()[code] || [];
}

function isApprovedForModel(code, model) {
  if (code === L.DEFAULT_LANGUAGE) return true;
  return approvedModels(code).some((m) => sameModel(m, model));
}

// Languages an administrator has chosen to offer anyway, although no model has passed a test in them.
// The decision is recorded, shown as "override" everywhere, and the quality warnings stay on — but it
// is the bank's call, not the software's, whether to wait for a capable model.
function overrideLanguages() {
  let stored = null;
  try {
    stored = JSON.parse(getSetting('language_override', '[]'));
  } catch {
    stored = null;
  }
  return Array.isArray(stored) ? stored.filter((c) => L.LOCAL_CODES.includes(c)) : [];
}

function isOverridden(code) {
  return overrideLanguages().includes(code);
}

// What staff can actually pick for a given model: enabled, and either approved for that model or
// covered by an administrator's override.
function usableForModel(code, model) {
  if (code === L.DEFAULT_LANGUAGE) return isEnabled(code);
  if (!isEnabled(code)) return false;
  return isApprovedForModel(code, model) || isOverridden(code);
}

// What staff are actually offered for a particular model: English always, plus any language that is
// both enabled and approved for that model. This is what GET /api/languages reports (per model) and
// what chat enforces.
function availabilityForModel(model, { forStaff = true } = {}) {
  const approvals = approvalsByLanguage();
  const results = {};
  for (const language of L.LANGUAGES) {
    const enabled = isEnabled(language.code);
    let available = true;
    let reason = null;
    if (language.code !== L.DEFAULT_LANGUAGE) {
      const approved = approvals[language.code].some((m) => sameModel(m, model));
      // `forStaff` is what the staff modal shows: a language only appears once the model in front of
      // them has passed. Admins see the same numbers with more detail.
      const overridden = isOverridden(language.code);
      available = enabled && (approved || overridden) && (forStaff ? Boolean(model) : true);
      if (!enabled) reason = 'Not enabled by your administrator';
      else if (!approved && !overridden) reason = 'Not yet approved for this model (an administrator has to test it first)';
      else if (!model) reason = 'Choose a model first';
    }
    results[language.code] = {
      available,
      reason,
      // Set when an administrator chose to offer a language the model has not passed a test in, so
      // the browser can say so rather than implying it was approved.
      warning:
        language.code !== L.DEFAULT_LANGUAGE && isOverridden(language.code) && !isApprovedForModel(language.code, model)
          ? 'Offered by an administrator without a passed language test — answers may be unreliable'
          : null,
    };
  }
  return results;
}

// Whether a language may be offered to staff *at all* — enabled, and approved for the bank's default
// model. Used by the admin panel's "Available to staff" column.
function availableToStaff(code) {
  if (code === L.DEFAULT_LANGUAGE) return isEnabled(code);
  if (!isEnabled(code)) return false;
  if (isOverridden(code)) return true;
  const model = bankDefaultModel();
  return Boolean(model) && isApprovedForModel(code, model);
}

// ---------- Persons whose chosen language is no longer available ----------

// Requirement: when a language stops being available, affected staff must quietly go back to the
// bank default rather than have their next message answered in a language the bank no longer
// supports. Their stored choice is cleared (they can choose again if it comes back), and the change
// is written to the audit log with how many people it affected.
function revertUsersFromLanguage(code, reason) {
  const result = db.prepare('UPDATE users SET reply_language = NULL WHERE reply_language = ?').run(code);
  const count = Number(result.changes || 0);
  if (count) {
    logAudit(null, 'language.reverted', { language: code, users: count, reason });
  }
  return count;
}

// Called after any settings change or capability test: any language that is now disabled, or that no
// model is approved for, has its users moved back to the bank default.
function revertUnavailableUsers(reason) {
  const reverted = {};
  for (const code of L.LOCAL_CODES) {
    const stillAvailable = isEnabled(code) && (approvedModels(code).length > 0 || isOverridden(code));
    if (!stillAvailable) {
      const count = revertUsersFromLanguage(code, reason);
      if (count) reverted[code] = count;
    }
  }
  return reverted;
}

// ---------- Saving the settings ----------

function saveSettings(
  { defaultLanguage: newDefault, choiceAllowed: newChoice, searchTranslation, enabledLanguages: newEnabled, terminologyApproval, overrideLanguages: newOverride },
  who
) {
  const before = enabledLanguages();

  // Validate against the enabled set *after* this change: switching French on and making it the
  // default in one request has to work, and switching a language off while selecting it must not.
  const effectiveEnabled = newEnabled === undefined ? before : L.CODES.filter((c) => c === L.DEFAULT_LANGUAGE || newEnabled.includes(c));

  if (newDefault !== undefined) {
    if (!L.CODES.includes(newDefault)) throw new Error('Unknown default language');
    if (!effectiveEnabled.includes(newDefault)) {
      throw new Error(`Enable ${L.labelOf(newDefault)} before making it the default`);
    }
    setSetting('default_reply_language', newDefault);
  }
  if (newChoice !== undefined) {
    if (typeof newChoice !== 'boolean') throw new Error('choiceAllowed must be true or false');
    setSetting('language_choice_allowed', newChoice ? 'true' : 'false');
  }
  if (searchTranslation !== undefined) {
    if (typeof searchTranslation !== 'boolean') throw new Error('searchTranslation must be true or false');
    setSetting('language_search_translation', searchTranslation ? 'true' : 'false');
  }
  if (newOverride !== undefined) {
    if (!Array.isArray(newOverride)) throw new Error('overrideLanguages must be a list');
    const codes = newOverride.filter((c) => L.LOCAL_CODES.includes(c));
    setSetting('language_override', JSON.stringify([...new Set(codes)]));
    logAudit(null, 'language.override_changed', { languages: codes }, who);
  }
  if (terminologyApproval !== undefined) {
    if (typeof terminologyApproval !== 'boolean') throw new Error('terminologyApproval must be true or false');
    setSetting('terminology_approval', terminologyApproval ? 'true' : 'false');
    // Turning the workflow on protects nothing if the terms already in use were never reviewed. They
    // are left as they are (they were approved by the only process the bank had at the time), but the
    // change is recorded so it is clear when the new rule started applying.
    logAudit(null, 'language.terminology_approval_changed', { enabled: terminologyApproval }, who);
  }
  if (newEnabled !== undefined) {
    if (!Array.isArray(newEnabled)) throw new Error('enabledLanguages must be a list');
    const codes = new Set(newEnabled.filter((c) => L.CODES.includes(c)));
    codes.add(L.DEFAULT_LANGUAGE); // English always stays on
    setSetting('language_enabled', JSON.stringify([...L.CODES].filter((c) => codes.has(c))));
  }

  // If the default was switched off, fall back to English and say why rather than leaving an
  // unusable default behind.
  let defaultWasReset = false;
  if (!isEnabled(defaultLanguage())) {
    setSetting('default_reply_language', L.DEFAULT_LANGUAGE);
    defaultWasReset = true;
  }

  const reverted = revertUnavailableUsers('the language became unavailable');
  const disabled = before.filter((c) => !isEnabled(c));
  if (disabled.length && who !== undefined) {
    logAudit(null, 'language.settings_changed', { disabled, reverted, defaultWasReset }, who);
  }
  return { reverted, defaultWasReset };
}

// ---------- The bank's approved wording for banking terms ----------

// Terms are stored trimmed. Too long is an error rather than a silent truncation: an administrator
// typing a long phrase should be told, not have half of it saved.
function cleanTerm(value, label) {
  const text = String(value || '').trim();
  if (text.length > MAX_TERM_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_TERM_LENGTH} characters`);
  }
  return text;
}

function listTerms({ language, q, status } = {}) {
  const where = [];
  const params = [];
  if (language) {
    if (!L.LOCAL_CODES.includes(language)) throw new Error('Unknown language');
    where.push('t.language = ?');
    params.push(language);
  }
  if (status) {
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new Error('Unknown status');
    where.push('t.status = ?');
    params.push(status);
  }
  if (q && String(q).trim()) {
    // The context is searchable too: "the wording we use for the thing that excludes staff loans" is
    // a real way to look for a term.
    where.push('(LOWER(t.english_term) LIKE ? OR LOWER(t.local_term) LIKE ? OR LOWER(COALESCE(t.context, \'\')) LIKE ?)');
    const needle = `%${String(q).trim().toLowerCase()}%`;
    params.push(needle, needle, needle);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT t.id, t.language, t.english_term AS englishTerm, t.local_term AS localTerm, t.context, t.status,
              t.created_at AS createdAt, t.updated_at AS updatedAt,
              creator.username AS createdBy, editor.username AS updatedBy,
              approver.username AS approvedBy, t.approved_at AS approvedAt
       FROM language_terms t
       LEFT JOIN users creator ON creator.id = t.created_by
       LEFT JOIN users editor ON editor.id = t.updated_by
       LEFT JOIN users approver ON approver.id = t.approved_by
       ${clause}
       ORDER BY t.language, t.english_term`
    )
    .all(...params);
}

function countTerms(language) {
  return db.prepare('SELECT COUNT(*) AS n FROM language_terms WHERE language = ?').get(language).n;
}

function termCounts() {
  const out = Object.fromEntries(L.LOCAL_CODES.map((code) => [code, 0]));
  for (const row of db.prepare('SELECT language, COUNT(*) AS n FROM language_terms GROUP BY language').all()) {
    if (row.language in out) out[row.language] = row.n;
  }
  return out;
}

// When the approval workflow is on, a term (new or edited) starts as "pending" and the model is not
// told it until an administrator approves it — so an unreviewed translation can never be presented as
// the bank's approved wording.
function approvalRequired() {
  return getSetting('terminology_approval', 'false') === 'true';
}

function statusOnSave() {
  return approvalRequired() ? 'pending' : 'approved';
}

function cleanContext(value) {
  const text = String(value || '').trim();
  if (text.length > MAX_CONTEXT_LENGTH) throw new Error(`The context must be at most ${MAX_CONTEXT_LENGTH} characters`);
  return text || null;
}

function upsertTerm({ language, englishTerm, localTerm, context }, who) {
  if (!L.LOCAL_CODES.includes(language)) throw new Error('Choose a language (not English)');
  const english = cleanTerm(englishTerm, 'The English term');
  const local = cleanTerm(localTerm, 'The approved wording');
  const note = cleanContext(context);
  if (!english || !local) throw new Error('Both the English term and the approved wording are required');

  const existing = db
    .prepare('SELECT id FROM language_terms WHERE language = ? AND LOWER(english_term) = LOWER(?)')
    .get(language, english);
  if (existing) {
    db.prepare(
      `UPDATE language_terms SET local_term = ?, context = ?, status = ?, approved_by = NULL, approved_at = NULL,
       updated_by = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(local, note, statusOnSave(), who?.id ?? null, existing.id);
    logAudit(null, 'language.term_updated', { language, englishTerm: english, localTerm: local, context: note }, who);
    return getTerm(existing.id);
  }
  if (countTerms(language) >= MAX_TERMS_PER_LANGUAGE) {
    throw new Error(`At most ${MAX_TERMS_PER_LANGUAGE} terms per language — delete one before adding another`);
  }
  const result = db
    .prepare(
      'INSERT INTO language_terms (language, english_term, local_term, context, status, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(language, english, local, note, statusOnSave(), who?.id ?? null, who?.id ?? null);
  logAudit(null, 'language.term_added', { language, englishTerm: english, localTerm: local, context: note }, who);
  return getTerm(result.lastInsertRowid);
}

function getTerm(id) {
  return db
    .prepare(
      `SELECT t.id, t.language, t.english_term AS englishTerm, t.local_term AS localTerm, t.context,
              t.status, t.created_at AS createdAt, t.updated_at AS updatedAt,
              creator.username AS createdBy, editor.username AS updatedBy,
              approver.username AS approvedBy, t.approved_at AS approvedAt
       FROM language_terms t
       LEFT JOIN users creator ON creator.id = t.created_by
       LEFT JOIN users editor ON editor.id = t.updated_by
       LEFT JOIN users approver ON approver.id = t.approved_by
       WHERE t.id = ?`
    )
    .get(id);
}

function updateTerm(id, { englishTerm, localTerm, context }, who) {
  const existing = getTerm(id);
  if (!existing) throw new Error('Term not found');
  const english = englishTerm === undefined ? existing.englishTerm : cleanTerm(englishTerm, 'The English term');
  const local = localTerm === undefined ? existing.localTerm : cleanTerm(localTerm, 'The approved wording');
  const note = context === undefined ? existing.context : cleanContext(context);
  if (!english || !local) throw new Error('Both the English term and the approved wording are required');
  const clash = db
    .prepare('SELECT id FROM language_terms WHERE language = ? AND LOWER(english_term) = LOWER(?) AND id != ?')
    .get(existing.language, english, id);
  if (clash) throw new Error(`"${english}" already has an approved wording in that language`);
  // An edit always has to be looked at again when the workflow is on: the wording changed, so the old
  // approval no longer applies to what would now be sent to the model.
  db.prepare(
    `UPDATE language_terms SET english_term = ?, local_term = ?, context = ?, status = ?, approved_by = NULL,
     approved_at = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(english, local, note, statusOnSave(), who?.id ?? null, id);
  logAudit(null, 'language.term_updated', { language: existing.language, englishTerm: english, localTerm: local, context: note }, who);
  return getTerm(id);
}

// Approve / reject a term (used when the approval workflow is on). Both are audited with the admin who
// did it, so "who approved this wording, and when" is answerable later.
function setTermStatus(id, status, who) {
  const existing = getTerm(id);
  if (!existing) throw new Error('Term not found');
  if (!['approved', 'rejected'].includes(status)) throw new Error('Unknown status');
  if (status === 'approved') {
    db.prepare("UPDATE language_terms SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(
      who?.id ?? null,
      id
    );
    logAudit(null, 'language.term_approved', { language: existing.language, englishTerm: existing.englishTerm }, who);
  } else {
    db.prepare("UPDATE language_terms SET status = 'rejected', approved_by = NULL, approved_at = NULL WHERE id = ?").run(id);
    logAudit(null, 'language.term_rejected', { language: existing.language, englishTerm: existing.englishTerm }, who);
  }
  return getTerm(id);
}

function deleteTerm(id, who) {
  const existing = getTerm(id);
  if (!existing) throw new Error('Term not found');
  db.prepare('DELETE FROM language_terms WHERE id = ?').run(id);
  logAudit(null, 'language.term_deleted', { language: existing.language, englishTerm: existing.englishTerm }, who);
  return { ok: true };
}

// The map the prompt and the search expansion use: { englishTerm: approvedWording }. Only approved
// terms are handed to the model when the approval workflow is on — an unapproved wording must never
// reach a customer as though the bank had approved it.
function glossaryFor(code) {
  if (!code || code === 'en') return {};
  const rows = approvalRequired()
    ? db.prepare("SELECT english_term AS e, local_term AS l FROM language_terms WHERE language = ? AND status = 'approved'").all(code)
    : db.prepare('SELECT english_term AS e, local_term AS l FROM language_terms WHERE language = ?').all(code);
  const out = {};
  for (const row of rows) out[row.e] = row.l;
  return out;
}

// ---------- Usage and quality ----------

function usageStats() {
  const rows = db
    .prepare(
      `SELECT COALESCE(language, 'en') AS language,
              COUNT(*) AS answers,
              SUM(CASE WHEN language_warning IS NOT NULL THEN 1 ELSE 0 END) AS warnings,
              SUM(CASE WHEN translation_flag IS NOT NULL THEN 1 ELSE 0 END) AS flags
       FROM messages WHERE role = 'assistant' AND is_active = 1
       GROUP BY 1 ORDER BY answers DESC`
    )
    .all();
  const byLanguage = L.LANGUAGES.map((l) => {
    const row = rows.find((r) => r.language === l.code);
    return { language: l.code, label: l.label, answers: row?.answers || 0, warnings: row?.warnings || 0, flags: row?.flags || 0 };
  });
  return {
    byLanguage,
    totals: {
      answers: byLanguage.reduce((n, r) => n + r.answers, 0),
      warnings: byLanguage.reduce((n, r) => n + r.warnings, 0),
      flags: byLanguage.reduce((n, r) => n + r.flags, 0),
    },
  };
}

// ---------- One object for the admin panel ----------

function adminSummary() {
  const approvals = approvalsByLanguage();
  const tests = latestTests();
  const latest = new Map();
  for (const row of tests) {
    const key = `${row.model}|${row.language}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const bankModel = bankDefaultModel();
  return {
    defaultLanguage: defaultLanguage(),
    choiceAllowed: choiceAllowed(),
    searchTranslation: searchTranslationEnabled(),
    terminologyApproval: approvalRequired(),
    termCounts: termCounts(),
    bankDefaultModel: bankModel,
    languages: L.LANGUAGES.map((language) => {
      const approved = approvals[language.code];
      // Show the test result for the bank's own default model when there is one — that is the one
      // that decides whether staff see the language — otherwise the most recent test of any model.
      const lastTest =
        (bankModel && latest.get(`${bankModel}|${language.code}`)) ||
        tests.find((t) => t.language === language.code) ||
        null;
      return {
        code: language.code,
        label: language.label,
        native: language.native,
        enabled: isEnabled(language.code),
        overridden: isOverridden(language.code),
        availableToStaff: availableToStaff(language.code),
        bankDefaultApproved: language.code === L.DEFAULT_LANGUAGE || (Boolean(bankModel) && isApprovedForModel(language.code, bankModel)),
        approvedFor: approved,
        lastTest: lastTest
          ? { model: lastTest.model, status: lastTest.status, score: lastTest.score, testedAt: lastTest.tested_at }
          : null,
      };
    }),
  };
}

module.exports = {
  enabledLanguages,
  isEnabled,
  defaultLanguage,
  choiceAllowed,
  searchTranslationEnabled,
  bankDefaultModel,
  sameModel,
  normaliseModel,
  latestTests,
  approvalsByLanguage,
  approvedModels,
  isApprovedForModel,
  overrideLanguages,
  isOverridden,
  usableForModel,
  availabilityForModel,
  availableToStaff,
  revertUsersFromLanguage,
  revertUnavailableUsers,
  saveSettings,
  listTerms,
  termCounts,
  approvalRequired,
  setTermStatus,
  MAX_CONTEXT_LENGTH,
  upsertTerm,
  updateTerm,
  deleteTerm,
  getTerm,
  glossaryFor,
  usageStats,
  adminSummary,
  MAX_TERMS_PER_LANGUAGE,
  MAX_TERM_LENGTH,
};

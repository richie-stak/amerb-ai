// The admin portal's Language tab: which languages exist and are enabled, the bank-wide default,
// the approved wording for banking terms, and the capability tests that decide whether a language
// may be offered at all.
//
// Who may do what: an administrator changes everything; an **auditor** may read the records and
// reports (GET only) but never change anything. Every change is written to the audit log by
// auditAdminChanges, plus a specific entry for the changes that matter (a language being turned off,
// a term being added/edited/deleted/approved, a test approving or rejecting a model).
const express = require('express');
const db = require('../db');
const { requireAdmin, requireAdminOrAuditor } = require('../middleware/auth');
const { auditAdminChanges } = require('../audit');
const asyncHandler = require('../middleware/asyncHandler');
const llm = require('../llm');
const ollama = require('../llm/ollama');
const L = require('../languages');
const languageSettings = require('../languageSettings');
const languageQuality = require('../languageQuality');
const languageTests = require('../languageTests');

const router = express.Router();

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Every model an admin could test or route to: installed local models plus any enabled external
// ones. External models are marked, because testing them sends sample sentences off this machine.
// `completeness: false` means Ollama couldn't be asked just now, so the local list is unknown.
async function availableModels() {
  let local = [];
  let reachable = true;
  try {
    local = await ollama.listModels();
  } catch {
    reachable = false;
  }
  const external = llm.listExternalModels();
  return {
    models: [
      ...local.map((m) => ({ name: m.name, label: m.name, external: false })),
      ...external.map((m) => ({ name: m.name, label: m.label, external: true })),
    ],
    reachable,
  };
}

// ---------- Reads (admins and auditors) ----------

router.get('/', requireAdminOrAuditor, (req, res) => {
  res.json(languageSettings.adminSummary());
});

router.get('/terms', requireAdminOrAuditor, (req, res) => {
  try {
    res.json({
      terms: languageSettings.listTerms({ language: req.query.language, q: req.query.q, status: req.query.status }),
      approvalRequired: languageSettings.approvalRequired(),
      limits: { maxTerms: languageSettings.MAX_TERMS_PER_LANGUAGE, maxLength: languageSettings.MAX_TERM_LENGTH, maxContext: languageSettings.MAX_CONTEXT_LENGTH },
      counts: languageSettings.termCounts(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/capabilities', requireAdminOrAuditor, asyncHandler(async (req, res) => {
  const tests = languageSettings.latestTests().map((t) => ({
    id: t.id,
    model: t.model,
    language: t.language,
    status: t.status,
    score: t.score,
    testedAt: t.tested_at,
    testedBy: t.tested_by ? db.prepare('SELECT username FROM users WHERE id = ?').get(t.tested_by)?.username || null : null,
    checks: t.checks ? JSON.parse(t.checks) : [],
  }));
  const models = await availableModels();
  res.json({
    tests,
    models: models.models,
    ollamaReachable: models.reachable,
    bankDefaultModel: languageSettings.bankDefaultModel(),
    // Which models are still to be tested, so the panel can point at the gap that matters.
    languages: L.LANGUAGES.filter((l) => l.code !== 'en').map((l) => ({
      code: l.code,
      label: l.label,
      enabled: languageSettings.isEnabled(l.code),
      approvedFor: languageSettings.approvedModels(l.code),
    })),
  });
}));

// Usage and quality, filterable by date range, language, provider and model.
router.get('/stats', requireAdminOrAuditor, (req, res) => {
  const { from, to, language, provider, model } = req.query;
  res.json(languageQuality.usageReport({ from, to, language, provider, model }));
});

// The same warning events Operations shows, structured for investigation — references only, never
// question or answer text.
router.get('/events', requireAdminOrAuditor, (req, res) => {
  const { from, to, language, model, reason, limit } = req.query;
  res.json(languageQuality.listEvents({ from, to, language, model, reason, limit }));
});

// ---------- Writes (admins only) ----------

// auditAdminChanges records every successful non-GET for the admin audit log.
router.use(requireAdmin);
router.use(auditAdminChanges);

router.post('/', (req, res) => {
  const body = req.body || {};
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  try {
    const { reverted, defaultWasReset } = languageSettings.saveSettings(body, admin);
    res.json({ ok: true, reverted, defaultWasReset, ...languageSettings.adminSummary() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Approved wording for banking terms ----------

router.post('/terms', (req, res) => {
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  try {
    res.json({ term: languageSettings.upsertTerm(req.body || {}, admin) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/terms/:id', (req, res) => {
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  try {
    res.json({ term: languageSettings.updateTerm(Number(req.params.id), req.body || {}, admin) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/terms/:id', (req, res) => {
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  try {
    res.json(languageSettings.deleteTerm(Number(req.params.id), admin));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Approval workflow: only these terms are given to the model while the workflow is on.
router.post('/terms/:id/approve', (req, res) => {
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  try {
    res.json({ term: languageSettings.setTermStatus(Number(req.params.id), 'approved', admin) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/terms/:id/reject', (req, res) => {
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  try {
    res.json({ term: languageSettings.setTermStatus(Number(req.params.id), 'rejected', admin) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Capability tests ----------

// Runs the capability suite for one model and one or more languages, streaming progress: a run makes
// several real model calls and takes minutes on a CPU-only machine, so the admin sees what is
// happening instead of a frozen page.
router.post('/capabilities/test', asyncHandler(async (req, res) => {
  const { model, languages } = req.body || {};
  if (typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'Choose a model to test' });
  }
  const wanted = Array.isArray(languages) && languages.length ? languages : L.LOCAL_CODES;
  for (const code of wanted) {
    if (!L.LOCAL_CODES.includes(code)) {
      return res.status(400).json({ error: `Unknown language "${code}"` });
    }
  }
  try {
    llm.resolve(model);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // A local model name is accepted by llm.resolve whatever it is, so check it really is installed —
  // otherwise a typo would run a "test" that can only ever fail, against nothing. If Ollama didn't
  // answer when the list was asked for, the test itself will report the connection problem with a
  // clear message, so the check is skipped rather than turning a momentary hiccup into a refusal.
  const known = await availableModels();
  if (known.reachable && !known.models.some((m) => languageSettings.sameModel(m.name, model))) {
    return res.status(400).json({ error: `"${model}" is not an available model. Pull it first, or choose another.` });
  }

  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Stopping the browser tab (or pressing Stop) cancels between checks — never mid-call, so a model
  // that is halfway through a generation isn't left running for nothing. Listening on the response
  // (not the request) is deliberate: a request whose body has already been read emits 'close'
  // straight away, which would cancel the very first check.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  sendEvent(res, 'start', { model, languages: wanted });
  const results = [];
  for (const language of wanted) {
    if (controller.signal.aborted) break;
    try {
      const result = await languageTests.runAndRecord({
        model,
        language,
        who: admin,
        signal: controller.signal,
        onProgress: (info) => sendEvent(res, 'progress', { language, ...info }),
      });
      results.push(result);
      sendEvent(res, 'result', result);
    } catch (err) {
      if (err.name === 'AbortError') break;
      const failed = {
        language,
        label: L.labelOf(language),
        model,
        status: 'failed',
        score: 0,
        checks: [{ key: 'error', label: 'Test could not run', passed: false, detail: err.message }],
      };
      // A test that could not even run must not be recorded as a pass; record the failure so the
      // panel shows the language still needs a successful test.
      languageTests.recordResult(failed, admin);
      results.push(failed);
      sendEvent(res, 'result', failed);
    }
  }
  sendEvent(res, 'done', { results, aborted: controller.signal.aborted });
  res.end();
}));

module.exports = router;

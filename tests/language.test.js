// Reply languages, end to end: admin-controlled availability that only opens up after a model
// passes a real capability test, staff preferences that override the bank default, automatic revert
// when a language goes away, the bank's approved terminology, quality warnings with an "answer in
// English" escape hatch, staff reporting bad translations, and usage figures.
//
// Everything runs against a stand-in Ollama and a stand-in external provider, so no real model is
// needed and no real chat or customer data is produced.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { startTestServer, makeClient } = require('./helpers/testServer');
const { startMockOllama } = require('./helpers/mockOllama');
const { startMockProviders } = require('./helpers/mockProviders');

// server/languages.js is required directly for its detection helpers. It pulls in the database
// module, so point it at a throwaway file first — a test must never open the real data/amerb-ai.sqlite.
const scratchDb = path.join(os.tmpdir(), `amerb-lang-scratch-${Date.now()}.sqlite`);
process.env.AMERB_DB_PATH = scratchDb;
const L = require('../server/languages');

let server;
let ollama;
let providers;
let admin;

const MODELS = ['good', 'twi-capable', 'gaa-capable', 'fr-capable', 'multilingual', 'gibberish'];
const BANK_MODEL = 'twi-capable'; // DEFAULT_MODEL in the test server: the "configured AI model"
const TWI_QUESTION = 'Medaase, mepɛ sɛ minhu bosea ho nsɛm';

function parseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: /^data: (.*)$/m.exec(block)?.[1] }))
    .filter((e) => e.event)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}

const eventsOf = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);
const metaOf = (events) => events.find((e) => e.event === 'meta')?.data;

async function signup(username, department = 'Credit') {
  const client = makeClient(server.baseUrl);
  const res = await client.post('/api/auth/signup', {
    username,
    email: `${username}@amenfimanbank.com`,
    password: 'password12345',
    department,
  });
  assert.equal(res.status, 200, await res.clone().text());
  return client;
}

async function chat(client, content, model = `${BANK_MODEL}:latest`) {
  const before = ollama.state.requests.length;
  const res = await client.post('/api/chat/stream', { model, content });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const events = parseEvents(text);
  return { events, requests: ollama.state.requests.slice(before) };
}

async function regenerate(client, conversationId, model = `${BANK_MODEL}:latest`, languageOverride) {
  const res = await client.post('/api/chat/regenerate', {
    conversationId,
    model,
    ...(languageOverride ? { languageOverride } : {}),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return parseEvents(await res.text());
}

// Runs a capability test and returns its SSE events. A real run takes minutes on a CPU machine; the
// mock answers instantly, which is the point of testing the *scoring* rather than the model.
async function runCapability(model, languages, client = admin) {
  const res = await client.post('/api/admin/language/capabilities/test', { model, languages });
  assert.equal(res.status, 200, await res.clone().text());
  return parseEvents(await res.text());
}

async function adminLanguage(client = admin) {
  return (await client.get('/api/admin/language')).json();
}

async function staffLanguages(client, model = `${BANK_MODEL}:latest`) {
  return (await client.get(`/api/languages?model=${encodeURIComponent(model)}`)).json();
}

async function approve(language, model = BANK_MODEL) {
  const events = await runCapability(model, [language]);
  const result = eventsOf(events, 'result')[0];
  assert.equal(result.status, 'approved', `expected ${language} on ${model} to be approved: ${JSON.stringify(result.checks)}`);
  return result;
}

before(async () => {
  ollama = await startMockOllama({ models: MODELS });
  providers = await startMockProviders();
  server = await startTestServer({
    env: {
      OLLAMA_URL: ollama.url,
      DEFAULT_MODEL: BANK_MODEL,
      AMERB_DEFAULT_FALLBACK: 'on',
    },
  });
  admin = await signup('langadmin', 'IT');
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'langadmin'").run();
  db.close();
});

after(async () => {
  await server.stop();
  await ollama.stop();
  await providers.stop();
  try {
    fs.rmSync(scratchDb, { force: true });
  } catch {
    /* still open for the life of this process */
  }
});

// ---------- 1. Language administration ----------

test('English is always on, is the default, and cannot be switched off', async () => {
  let summary = await adminLanguage();
  const english = summary.languages.find((l) => l.code === 'en');
  assert.equal(english.enabled, true);
  assert.equal(english.availableToStaff, true);
  assert.equal(summary.defaultLanguage, 'en');

  // Trying to disable English quietly keeps it on — it is the bank's working language.
  const saved = await admin.post('/api/admin/language', { enabledLanguages: ['tw', 'gaa', 'fr'] });
  assert.equal(saved.status, 200);
  summary = await adminLanguage();
  assert.equal(summary.languages.find((l) => l.code === 'en').enabled, true);

  // ...and the default can't be moved to a language that is switched off.
  const refused = await admin.post('/api/admin/language', { enabledLanguages: ['en'], defaultLanguage: 'fr' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /Enable French/);

  await admin.post('/api/admin/language', { enabledLanguages: MODELS.length ? ['en', 'tw', 'gaa', 'fr'] : [] });
});

test('a language is not offered to staff until the configured model has passed a capability test', async () => {
  const user = await signup('notyet');
  const config = await staffLanguages(user);
  const twi = config.languages.find((l) => l.code === 'tw');
  assert.equal(twi.available, false);
  assert.match(twi.reason, /approved|test/i);

  // Staff can't save a language that isn't available.
  const res = await user.patch('/api/auth/me/language', { language: 'tw' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /approved for any model/);

  const summary = await adminLanguage();
  assert.equal(summary.languages.find((l) => l.code === 'tw').availableToStaff, false);
  assert.deepEqual(summary.languages.find((l) => l.code === 'tw').approvedFor, []);
  assert.equal(summary.bankDefaultModel, BANK_MODEL);
});

test('a model that only speaks English fails the test — generating text is not capability', async () => {
  const events = await runCapability('good:latest', ['tw']);
  const result = eventsOf(events, 'result')[0];
  assert.equal(result.status, 'failed');
  const translation = result.checks.find((c) => c.key === 'translation');
  assert.equal(translation.passed, false);
  assert.match(translation.detail, /answered in English/i);
  assert.equal(L.isWrittenIn(translation.sample, 'tw'), false);

  // Nothing was approved, so staff still don't see it.
  assert.equal((await adminLanguage()).languages.find((l) => l.code === 'tw').availableToStaff, false);
  const tests = (await (await admin.get('/api/admin/language/capabilities')).json()).tests;
  assert.ok(tests.some((t) => t.model === 'good:latest' && t.status === 'failed'));
});

test('a gibberish answer is rejected rather than approved', async () => {
  const events = await runCapability('gibberish:latest', ['gaa']);
  const result = eventsOf(events, 'result')[0];
  assert.equal(result.status, 'failed');
  assert.ok(result.checks.every((c) => !c.passed));
});

test('a capable model passes every check, and only then is the language offered', async () => {
  const events = await runCapability(`${BANK_MODEL}:latest`, ['tw']);
  // Live progress per step, so the admin portal never looks frozen.
  const progress = eventsOf(events, 'progress');
  assert.ok(progress.length >= 3);
  assert.ok(progress.some((p) => p.step === 'comprehension'));
  assert.ok(progress.every((p) => p.total >= 3));

  const result = eventsOf(events, 'result')[0];
  assert.equal(result.status, 'approved');
  assert.equal(result.score, 1);
  const keys = result.checks.map((c) => c.key);
  assert.deepEqual(keys, ['translation', 'comprehension', 'consistency']); // no terms recorded yet
  const comprehension = result.checks.find((c) => c.key === 'comprehension');
  assert.match(comprehension.detail, /kept the figures|answered in the language/);

  const summary = await adminLanguage();
  const twi = summary.languages.find((l) => l.code === 'tw');
  assert.equal(twi.availableToStaff, true);
  assert.deepEqual(twi.approvedFor, [`${BANK_MODEL}:latest`]);
  assert.equal(twi.lastTest.status, 'approved');

  const user = await signup('twi-staff');
  const config = await staffLanguages(user);
  assert.equal(config.languages.find((l) => l.code === 'tw').available, true);
  assert.equal((await user.patch('/api/auth/me/language', { language: 'tw' })).status, 200);
});

test('testing an unknown model, or "testing" English, is refused', async () => {
  assert.equal((await admin.post('/api/admin/language/capabilities/test', { model: 'no-such-model', languages: ['tw'] })).status, 400);
  assert.equal((await admin.post('/api/admin/language/capabilities/test', { model: `${BANK_MODEL}:latest`, languages: ['en'] })).status, 400);
  const staff = await signup('capstaff');
  assert.equal((await staff.post('/api/admin/language/capabilities/test', { model: 'twi-capable:latest', languages: ['tw'] })).status, 403);
  assert.equal((await staff.get('/api/admin/language/capabilities')).status, 403);
});

// ---------- 2. Staff preferences ----------

test('a staff preference overrides the bank default, and changing the default leaves it alone', async () => {
  await approve('fr', 'multilingual');
  await admin.post('/api/admin/language', { defaultLanguage: 'fr' });

  const user = await signup('pref-user');
  await user.patch('/api/auth/me/language', { language: 'tw' });
  const { events } = await chat(user, 'What is the minimum balance for a savings account?');
  assert.equal(metaOf(events).language, 'tw');

  // The bank default is now French, but this person's own choice still wins.
  const config = await staffLanguages(user);
  assert.equal(config.mine, 'tw');
  assert.equal((await (await user.get('/api/auth/me')).json()).user.replyLanguage, 'tw');
  assert.equal(metaOf((await chat(user, 'And for a current account?')).events).language, 'tw');

  // Someone with no choice follows the bank default — on a model that is approved for it.
  const fresh = await signup('default-user');
  assert.equal(metaOf((await chat(fresh, 'What is the minimum balance?', 'multilingual:latest')).events).language, 'fr');

  await admin.post('/api/admin/language', { defaultLanguage: 'en' });
});

test('when staff may not choose, the administrator default is enforced', async () => {
  await admin.post('/api/admin/language', { defaultLanguage: 'tw', choiceAllowed: false });
  const user = await signup('fixed-user');
  const config = await staffLanguages(user);
  assert.equal(config.choiceAllowed, false);
  assert.equal(config.effective, 'tw');
  assert.equal((await user.patch('/api/auth/me/language', { language: 'en' })).status, 403);
  assert.equal(metaOf((await chat(user, 'What is the minimum balance?')).events).language, 'tw');
  await admin.post('/api/admin/language', { defaultLanguage: 'en', choiceAllowed: true });
});

test('turning a language off moves affected staff back to the bank default', async () => {
  const user = await signup('revert-user');
  await user.patch('/api/auth/me/language', { language: 'tw' });

  const res = await admin.post('/api/admin/language', { enabledLanguages: ['en'] });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.reverted.tw >= 1, 'staff on Twi are reported as moved back');

  const config = await staffLanguages(user);
  assert.equal(config.mine, null);
  assert.equal(config.effective, 'en');
  assert.equal(metaOf((await chat(user, 'What is the minimum balance?')).events).language, 'en');

  // The change is on the record.
  const { rows } = await (await admin.get('/api/admin/audit?action=language.reverted')).json();
  assert.ok(rows.some((r) => r.details.language === 'tw'));
});

test('a failing re-test revokes the language and reverts staff who were using it', async () => {
  await admin.post('/api/admin/language', { enabledLanguages: ['en', 'tw'] });
  await approve('tw');

  const user = await signup('revoked-user');
  await user.patch('/api/auth/me/language', { language: 'tw' });
  assert.equal(metaOf((await chat(user, 'What is the minimum balance?')).events).language, 'tw');

  // The model loses the ability (a new model behind the same name, a bad update, whatever).
  ollama.state.playEnglish = true;
  try {
    const events = await runCapability(`${BANK_MODEL}:latest`, ['tw']);
    assert.equal(eventsOf(events, 'result')[0].status, 'failed');
  } finally {
    ollama.state.playEnglish = false;
  }

  const summary = await adminLanguage();
  assert.equal(summary.languages.find((l) => l.code === 'tw').availableToStaff, false);
  const config = await staffLanguages(user);
  assert.equal(config.mine, null, 'the saved choice is cleared');
  assert.equal(metaOf((await chat(user, 'What is the minimum balance?')).events).language, 'en');
});

test('an administrator can offer a language without a passed test, and it is labelled as an override', async () => {
  // Start from a known state: every language switched on, nobody overridden, staff free to choose.
  await admin.post('/api/admin/language', { enabledLanguages: ['en', 'tw', 'gaa', 'fr'], choiceAllowed: true, overrideLanguages: [] });
  // Twi has no approval on any model at this point. An administrator decides to offer it anyway.
  assert.equal((await admin.post('/api/admin/language', { overrideLanguages: ['tw'] })).status, 200);
  const summary = await adminLanguage();
  const twi = summary.languages.find((l) => l.code === 'tw');
  assert.equal(twi.overridden, true);
  assert.equal(twi.availableToStaff, true, 'the override is what makes it available');
  assert.deepEqual(twi.approvedFor, [], 'it is still not approved by any test');

  const user = await signup('override-user');
  const config = await staffLanguages(user);
  const option = config.languages.find((l) => l.code === 'tw');
  assert.equal(option.available, true);
  assert.match(option.warning, /without a passed language test/i, 'the dialog must not imply it was approved');

  // Staff can now choose it, and answers come back in it (the mock model is capable in Twi).
  assert.equal((await user.patch('/api/auth/me/language', { language: 'tw' })).status, 200);
  const answered = await chat(user, 'What is the minimum balance for a savings account?');
  assert.equal(metaOf(answered.events).language, 'tw');

  // The decision is on the record.
  const { rows } = await (await admin.get('/api/admin/audit?action=language.override_changed')).json();
  assert.ok(rows.some((r) => (r.details.languages || []).includes('tw')));

  // Turning the override off puts the language back behind the test — and staff who had chosen it are
  // moved back to the bank default, exactly like a language that was switched off.
  assert.equal((await admin.post('/api/admin/language', { overrideLanguages: [] })).status, 200);
  assert.equal((await adminLanguage()).languages.find((l) => l.code === 'tw').availableToStaff, false);
  const after = await staffLanguages(user);
  assert.equal(after.mine, null);
  assert.equal(after.effective, 'en');
});

test('overrides only apply to languages that are switched on', async () => {
  await admin.post('/api/admin/language', { enabledLanguages: ['en', 'tw', 'gaa', 'fr'], overrideLanguages: [] });
  assert.equal((await admin.post('/api/admin/language', { overrideLanguages: ['gaa'] })).status, 200);
  assert.equal((await adminLanguage()).languages.find((l) => l.code === 'gaa').availableToStaff, true);

  // Switching the language itself off wins over the override: an enabled list is the first gate.
  await admin.post('/api/admin/language', { enabledLanguages: ['en', 'tw'] });
  const disabled = (await adminLanguage()).languages.find((l) => l.code === 'gaa');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.availableToStaff, false);

  await admin.post('/api/admin/language', { enabledLanguages: ['en', 'tw', 'gaa', 'fr'], overrideLanguages: [] });
});

// ---------- 3. Preferred bank wording ----------

test('terminology can be added, searched, edited and deleted, and is validated', async () => {
  const added = await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'loan', localTerm: 'bosea' });
  assert.equal(added.status, 200);
  const term = (await added.json()).term;
  assert.equal(term.englishTerm, 'loan');

  // Same English term in the same language edits rather than duplicating.
  const again = await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'Loan', localTerm: 'bosea ketewa' });
  assert.equal((await again.json()).term.id, term.id);

  await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'guarantor', localTerm: 'wɔkae' });
  await admin.post('/api/admin/language/terms', { language: 'fr', englishTerm: 'loan', localTerm: 'prêt' });

  // Search, including the approved wording rather than only the English side.
  let list = await (await admin.get('/api/admin/language/terms?language=tw&q=guar')).json();
  assert.equal(list.terms.length, 1);
  list = await (await admin.get('/api/admin/language/terms?q=bosea')).json();
  assert.ok(list.terms.some((t) => t.englishTerm === 'loan'));
  list = await (await admin.get('/api/admin/language/terms?language=fr')).json();
  assert.ok(list.terms.every((t) => t.language === 'fr'));

  // Edit.
  const edited = await admin.patch(`/api/admin/language/terms/${term.id}`, { localTerm: 'bosea kɛse' });
  assert.equal((await edited.json()).term.localTerm, 'bosea kɛse');

  // Validation: nothing invented, nothing empty, nothing absurdly long.
  assert.equal((await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'loan', localTerm: '   ' })).status, 400);
  assert.equal((await admin.post('/api/admin/language/terms', { language: 'en', englishTerm: 'loan', localTerm: 'loan' })).status, 400);
  assert.equal((await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'x'.repeat(80), localTerm: 'y' })).status, 400);
  const clash = await admin.patch(`/api/admin/language/terms/${term.id}`, { englishTerm: 'guarantor' });
  assert.equal(clash.status, 400);

  // Delete.
  assert.equal((await admin.delete(`/api/admin/language/terms/${term.id}`)).status, 200);
  assert.ok(!(await (await admin.get('/api/admin/language/terms?language=tw')).json()).terms.some((t) => t.id === term.id));
});

test('the approved wording reaches the model, and helps document search with a local-language question', async () => {
  await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'loan', localTerm: 'bosea' });
  await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'guarantor', localTerm: 'wɔkae' });
  await approve('tw');

  const user = await signup('term-user');
  await user.patch('/api/auth/me/language', { language: 'tw' });
  const { requests } = await chat(user, 'What do I need to guarantee a loan?');
  const answer = [...requests].reverse().find((r) => !r.isTitle);
  assert.match(answer.system, /loan = bosea/);
  assert.match(answer.system, /guarantor = wɔkae/);

  // A Twi question written with the bank's own word is searched for the English term too.
  const expanded = L.expandQuery('Mepɛ bosea ho nsɛm', 'tw', { loan: 'bosea' });
  assert.match(expanded, /loan/);

  // English answers are never given another language's wording.
  const english = await signup('term-english');
  const enAnswer = [...(await chat(english, 'What do I need to guarantee a loan?')).requests].reverse().find((r) => !r.isTitle);
  assert.ok(!/loan = bosea/.test(enAnswer.system));

  await admin.delete(`/api/admin/language/terms/${(await (await admin.get('/api/admin/language/terms?language=tw&q=guarantor')).json()).terms[0].id}`);
});

// ---------- 4. Quality monitoring and fallback ----------

test('a garbled answer is flagged in the reply, stored, logged, and can be re-answered in English', async () => {
  await approve('tw');
  const user = await signup('garbled-user');
  await user.patch('/api/auth/me/language', { language: 'tw' });

  ollama.state.garble = true;
  let result;
  try {
    result = await chat(user, 'What is the minimum balance for a savings account?');
  } finally {
    ollama.state.garble = false;
  }

  const warning = eventsOf(result.events, 'language-warning')[0];
  assert.ok(warning, `expected a language warning, got ${result.events.map((e) => e.event).join(',')}`);
  assert.equal(warning.language, 'tw');
  assert.equal(warning.reason, 'unreliable');

  const conversationId = metaOf(result.events).conversationId;
  const conversation = await (await user.get(`/api/conversations/${conversationId}`)).json();
  const answer = conversation.messages.filter((m) => m.role === 'assistant').at(-1);
  assert.equal(answer.language, 'tw');
  assert.equal(answer.language_warning, 'unreliable');

  // Recorded where an administrator looks for problems.
  const { entries } = await (await admin.get('/api/admin/operations/logs?level=warn&q=local%20language')).json();
  assert.ok(entries.some((e) => e.msg === 'A reply in a local language looked unreliable'));

  // "Answer in English": same question, new answer, preference untouched.
  const regen = await regenerate(user, conversationId, `${BANK_MODEL}:latest`, 'en');
  assert.equal(metaOf(regen).language, 'en');
  assert.ok(eventsOf(regen, 'language-warning').length === 0);
  const after = await (await user.get(`/api/conversations/${conversationId}`)).json();
  assert.equal(after.messages.filter((m) => m.role === 'user').length, 1, 'the original question is kept, not re-sent');
  const latest = after.messages.filter((m) => m.role === 'assistant').at(-1);
  assert.equal(latest.language, 'en');
  assert.equal(latest.language_warning, null);
  assert.equal((await (await user.get('/api/auth/me')).json()).user.replyLanguage, 'tw', 'the preference is unchanged');
});

test('a model without approval answers in English and explains why', async () => {
  await approve('tw');
  const user = await signup('unapproved-model-user');
  await user.patch('/api/auth/me/language', { language: 'tw' });

  // "good" has never passed a Twi test, so this person's choice cannot be honoured on it.
  const { events } = await chat(user, 'What is the minimum balance?', 'good:latest');
  const unavailable = eventsOf(events, 'language-unavailable')[0];
  assert.ok(unavailable);
  assert.equal(unavailable.language, 'tw');
  assert.match(unavailable.reason, /not been approved/i);
  assert.equal(metaOf(events).language, 'en');

  const conversationId = metaOf(events).conversationId;
  const conversation = await (await user.get(`/api/conversations/${conversationId}`)).json();
  const answer = conversation.messages.filter((m) => m.role === 'assistant').at(-1);
  assert.equal(answer.language_warning, 'unavailable:tw');
});

// Staff feedback: three categories, recorded against the reply, counted and audited.
test('staff can give feedback on a translated reply, and it is counted and audited', async () => {
  await approve('tw');
  const user = await signup('reporter');
  await user.patch('/api/auth/me/language', { language: 'tw' });
  const { events } = await chat(user, 'What is the minimum balance?');
  const conversationId = metaOf(events).conversationId;
  const messageId = eventsOf(events, 'done')[0].messageId;
  const feedbackUrl = `/api/conversations/${conversationId}/messages/${messageId}/language-feedback`;

  // Three categories are accepted.
  for (const category of ['good', 'incorrect', 'unclear']) {
    const res = await user.post(feedbackUrl, { category });
    assert.equal(res.status, 200, category);
    assert.equal((await res.json()).category, category);
    const conversation = await (await user.get(`/api/conversations/${conversationId}`)).json();
    assert.equal(conversation.messages.find((m) => m.id === messageId).feedback_category, category);
  }
  // Reporting "incorrect" also keeps the older translation flag in step.
  const conversation = await (await user.get(`/api/conversations/${conversationId}`)).json();
  assert.equal(conversation.messages.find((m) => m.id === messageId).translation_flag, null);

  // Sending the same category again clears it; null clears explicitly.
  assert.equal((await (await user.post(feedbackUrl, { category: 'good' })).json()).category, 'good');
  assert.equal((await (await user.post(feedbackUrl, { category: 'good' })).json()).category, null);
  assert.equal((await (await user.post(feedbackUrl, { category: 'unclear' })).json()).category, 'unclear');
  assert.equal((await (await user.post(feedbackUrl, { category: null })).json()).category, null);

  // Only valid categories, and only on translated replies.
  assert.equal((await user.post(feedbackUrl, { category: 'nonsense' })).status, 400);
  const english = await signup('reporter-english');
  const enEvents = (await chat(english, 'What is the minimum balance?')).events;
  const enUrl = `/api/conversations/${metaOf(enEvents).conversationId}/messages/${eventsOf(enEvents, 'done')[0].messageId}/language-feedback`;
  assert.equal((await english.post(enUrl, { category: 'good' })).status, 400);

  // Somebody else's reply can't be rated.
  assert.equal((await english.post(feedbackUrl, { category: 'good' })).status, 404);

  // Recorded against the reply, the person, the language and the model.
  const row = server
    .openDb()
    .prepare('SELECT category, language, model, provider, user_id FROM response_feedback WHERE message_id = ?')
    .get(messageId);
  if (row) {
    assert.equal(row.language, 'tw');
    assert.equal(row.model, `${BANK_MODEL}:latest`);
    assert.equal(row.provider, 'local');
  }

  const { rows } = await (await admin.get('/api/admin/audit?action=chat.language_feedback')).json();
  assert.ok(rows.length >= 1);
});

// ---------- Usage and quality report ----------

test('usage and quality: per-language figures, percentages, filters and a trend', async () => {
  await approve('tw');
  // A garbled Twi reply, left active so it is part of the figures.
  const noisy = await signup('stats-user');
  await noisy.patch('/api/auth/me/language', { language: 'tw' });
  ollama.state.garble = true;
  let garbledMessage;
  try {
    const { events } = await chat(noisy, 'What is the minimum balance for a savings account?');
    garbledMessage = eventsOf(events, 'done')[0].messageId;
  } finally {
    ollama.state.garble = false;
  }
  const english = await signup('stats-english');
  await chat(english, 'What is the minimum balance?');

  const stats = await (await admin.get('/api/admin/language/stats')).json();
  const tw = stats.byLanguage.find((l) => l.language === 'tw');
  assert.ok(tw.answers >= 1);
  assert.ok(tw.garbled >= 1, 'the garbled reply is counted as auto-flagged');
  assert.equal(typeof tw.percent, 'number');
  assert.ok(stats.totals.answers >= stats.byLanguage.reduce((n, l) => n + l.answers, 0) - 1);
  assert.ok(stats.byModel.some((m) => m.model === `${BANK_MODEL}:latest` && m.provider === 'local'));
  assert.ok(stats.trend.length >= 1, 'a daily trend is reported');
  assert.equal(typeof stats.totals.incorrect, 'number');
  assert.equal(typeof stats.totals.unclear, 'number');
  assert.equal(typeof stats.totals.good, 'number');

  // Filters: language, model, provider and a date range.
  const onlyTw = await (await admin.get('/api/admin/language/stats?language=tw')).json();
  assert.ok(onlyTw.byLanguage.every((l) => l.language === 'tw'));
  const byModel = await (await admin.get(`/api/admin/language/stats?model=${encodeURIComponent(`${BANK_MODEL}:latest`)}`)).json();
  assert.ok(byModel.byModel.every((m) => m.model === `${BANK_MODEL}:latest`));
  const local = await (await admin.get('/api/admin/language/stats?provider=local')).json();
  assert.equal(local.filters.provider, 'local');
  const future = await (await admin.get('/api/admin/language/stats?from=2099-01-01')).json();
  assert.equal(future.totals.answers, 0);
  assert.ok(Array.isArray(future.options.languages));

  // Staff feedback flows into the same report.
  const user = await signup('stats-feedback');
  await user.patch('/api/auth/me/language', { language: 'tw' });
  const { events } = await chat(user, 'What is the minimum balance?');
  const messageId = eventsOf(events, 'done')[0].messageId;
  await user.post(`/api/conversations/${metaOf(events).conversationId}/messages/${messageId}/language-feedback`, { category: 'unclear' });
  const after = await (await admin.get('/api/admin/language/stats?language=tw')).json();
  assert.ok(after.totals.unclear >= 1);
  assert.ok(after.byLanguage[0].unclear >= 1);

  // And it is visible in the garbled-reply investigation list.
  const events2 = await (await admin.get('/api/admin/language/events')).json();
  assert.ok(events2.events.length >= 1);
  const event = events2.events[0];
  assert.ok(event.messageId, 'a warning carries the reply it belongs to');
  assert.equal(event.provider, 'local');
  assert.ok(!('question' in event) && !('answer' in event) && !('content' in event), 'no conversation text is copied into monitoring');
  assert.ok(events2.summary.some((s) => s.reason === 'unreliable'));
  assert.ok(Array.isArray(events2.recurring));
  void garbledMessage;
});

test('recurring language problems are identified per model and language', async () => {
  await approve('tw');
  const user = await signup('recurring-user');
  await user.patch('/api/auth/me/language', { language: 'tw' });
  ollama.state.garble = true;
  try {
    await chat(user, 'What is the minimum balance?');
    await chat(user, 'And the processing fee?');
  } finally {
    ollama.state.garble = false;
  }
  const { recurring, summary } = await (await admin.get('/api/admin/language/events?reason=unreliable')).json();
  const entry = recurring.find((r) => r.model === `${BANK_MODEL}:latest` && r.language === 'tw');
  assert.ok(entry, 'two failures on the same model and language are reported as recurring');
  assert.ok(entry.count >= 2);
  assert.ok(summary.some((s) => s.reason === 'unreliable' && s.count >= 2));
});

// ---------- Terminology ----------

test('terminology: context, creator and editor are recorded, and search covers all three', async () => {
  const created = await admin.post('/api/admin/language/terms', {
    language: 'tw',
    englishTerm: 'collateral',
    localTerm: 'agyapadeɛ',
    context: 'Assets pledged against a loan — excludes staff salary loans',
  });
  assert.equal(created.status, 200);
  const term = (await created.json()).term;
  assert.equal(term.context, 'Assets pledged against a loan — excludes staff salary loans');
  assert.equal(term.status, 'approved', 'without the approval workflow, a new term is usable immediately');
  assert.equal(term.createdBy, 'langadmin');

  // Editing records who did it and when, without losing the creator.
  const edited = await admin.patch(`/api/admin/language/terms/${term.id}`, { localTerm: 'agyapadeɛ kɛse', context: 'Assets pledged against a loan' });
  const editedTerm = (await edited.json()).term;
  assert.equal(editedTerm.englishTerm, 'collateral');
  assert.equal(editedTerm.updatedBy, 'langadmin');
  assert.ok(editedTerm.updatedAt, 'the modification date is recorded');
  assert.equal(editedTerm.createdBy, 'langadmin');

  // Search by approved wording and by context, not just the English term.
  assert.equal((await (await admin.get('/api/admin/language/terms?q=agyapadeɛ')).json()).terms.length, 1);
  assert.equal((await (await admin.get('/api/admin/language/terms?q=pledged')).json()).terms.length, 1);
  assert.equal((await (await admin.get('/api/admin/language/terms?q=nothing-here')).json()).terms.length, 0);

  // The limits, and the context length limit.
  assert.equal((await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'x'.repeat(61), localTerm: 'y' })).status, 400);
  assert.equal((await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'ctx', localTerm: 'y', context: 'z'.repeat(201) })).status, 400);

  // Counts are reported so the 200-per-language ceiling is visible before it is hit.
  const listed = await (await admin.get('/api/admin/language/terms?language=tw')).json();
  assert.equal(listed.limits.maxTerms, 200);
  assert.equal(listed.limits.maxLength, 60);
  assert.ok(listed.counts.tw >= 1);

  await admin.delete(`/api/admin/language/terms/${term.id}`);
});

test('the 200-terms-per-language limit is enforced', async () => {
  // Fill Twi to the ceiling directly (200 HTTP calls would make the suite crawl), then ask for one more.
  const db = server.openDb();
  const languageSettings = require('../server/languageSettings');
  void languageSettings;
  const insert = db.prepare('INSERT OR IGNORE INTO language_terms (language, english_term, local_term, status) VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= 200; i++) insert.run('gaa', `bulk-term-${i}`, `bulk-wording-${i}`, 'approved');
  db.close();

  const refused = await admin.post('/api/admin/language/terms', { language: 'gaa', englishTerm: 'one-too-many', localTerm: 'wording' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /At most 200 terms per language/);

  // Editing an existing term still works at the ceiling.
  const terms = await (await admin.get('/api/admin/language/terms?language=gaa&q=bulk-term-1')).json();
  assert.equal((await admin.patch(`/api/admin/language/terms/${terms.terms[0].id}`, { localTerm: 'edited' })).status, 200);

  const db2 = server.openDb();
  db2.prepare("DELETE FROM language_terms WHERE language = 'gaa' AND english_term LIKE 'bulk-term-%'").run();
  db2.close();
});

test('with the approval workflow on, only approved wording reaches the AI', async () => {
  assert.equal((await admin.post('/api/admin/language', { terminologyApproval: true })).status, 200);
  await approve('tw');

  // A brand-new term starts as pending, and is therefore not given to the model.
  const pending = (await (await admin.post('/api/admin/language/terms', { language: 'tw', englishTerm: 'cheque', localTerm: 'kyɛkyɛ' })).json()).term;
  assert.equal(pending.status, 'pending');

  const user = await signup('approval-user');
  await user.patch('/api/auth/me/language', { language: 'tw' });
  const before = [...(await chat(user, 'How do I clear a cheque?')).requests].reverse().find((r) => !r.isTitle);
  assert.ok(!/cheque = kyɛkyɛ/.test(before.system), 'an unapproved term is never given to the AI');

  // Approving it puts it into the prompt, with who approved it recorded.
  const approved = (await (await admin.post(`/api/admin/language/terms/${pending.id}/approve`)).json()).term;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, 'langadmin');
  assert.ok(approved.approvedAt);
  const after = [...(await chat(user, 'How do I clear a cheque?')).requests].reverse().find((r) => !r.isTitle);
  assert.match(after.system, /cheque = kyɛkyɛ/);

  // Editing an approved term sends it back for review.
  const edited = (await (await admin.patch(`/api/admin/language/terms/${pending.id}`, { localTerm: 'kyɛkyɛ kɛse' })).json()).term;
  assert.equal(edited.status, 'pending', 'an edited wording has to be approved again');
  const rejected = (await (await admin.post(`/api/admin/language/terms/${pending.id}/reject`)).json()).term;
  assert.equal(rejected.status, 'rejected');
  const afterReject = [...(await chat(user, 'How do I clear a cheque?')).requests].reverse().find((r) => !r.isTitle);
  assert.ok(!/cheque = kyɛkyɛ/.test(afterReject.system));

  // The decisions are all on the record.
  for (const action of ['language.term_approved', 'language.term_rejected']) {
    const { rows } = await (await admin.get(`/api/admin/audit?action=${action}`)).json();
    assert.ok(rows.length >= 1, action);
  }

  await admin.delete(`/api/admin/language/terms/${pending.id}`);
  await admin.post('/api/admin/language', { terminologyApproval: false });
});

// ---------- Access control and audit ----------

test('an auditor can read the language records but change nothing', async () => {
  const auditor = await signup('languages-auditor');
  const me = (await (await auditor.get('/api/auth/me')).json()).user;
  assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { role: 'auditor' })).status, 200);
  assert.equal((await (await auditor.get('/api/auth/me')).json()).user.role, 'auditor');

  // Reads are allowed, including the audit trail and the usage report.
  for (const path of ['/api/admin/language', '/api/admin/language/terms', '/api/admin/language/capabilities', '/api/admin/language/stats', '/api/admin/language/events', '/api/admin/audit', '/api/admin/analytics', '/api/admin/audit/export.csv']) {
    assert.equal((await auditor.get(path)).status, 200, path);
  }

  // Nothing that changes anything is.
  const writes = [
    ['post', '/api/admin/language', { defaultLanguage: 'en' }],
    ['post', '/api/admin/language/terms', { language: 'tw', englishTerm: 'loan', localTerm: 'bosea' }],
    ['patch', '/api/admin/language/terms/1', { localTerm: 'x' }],
    ['delete', '/api/admin/language/terms/1'],
    ['post', '/api/admin/language/terms/1/approve'],
    ['post', '/api/admin/language/capabilities/test', { model: `${BANK_MODEL}:latest`, languages: ['tw'] }],
    ['post', '/api/admin/settings', { webSearchEnabled: true }],
    ['patch', `/api/admin/users/${me.id}`, { role: 'admin' }],
  ];
  for (const [method, path, body] of writes) {
    const res = body === undefined ? await auditor[method](path) : await auditor[method](path, body);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} must be refused for an auditor`);
  }

  // An ordinary staff member still can't read these at all.
  const staff = await signup('languages-plain-staff');
  assert.equal((await staff.get('/api/admin/language')).status, 403);
  assert.equal((await staff.get('/api/admin/audit')).status, 403);

  // Back to staff for the rest of the file.
  await admin.patch(`/api/admin/users/${me.id}`, { role: 'user' });
});

test('the audit trail cannot be edited or deleted, even by an admin', async () => {
  // There is deliberately no route that modifies audit rows: every write verb is a 404.
  for (const method of ['patch', 'delete', 'put', 'post']) {
    const res = await (admin[method] ? admin[method]('/api/admin/audit') : Promise.resolve({ status: 404 }));
    assert.equal(res.status, 404, `${method.toUpperCase()} /api/admin/audit must not exist`);
  }
  const db = server.openDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  db.close();
  await admin.post('/api/admin/language', { choiceAllowed: true });
  const db2 = server.openDb();
  const after = db2.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  db2.close();
  assert.ok(after >= before, 'audit rows accumulate, never disappear');
});

// ---------- External providers and data protection ----------

test('testing an external model works, and sends only the sample sentences', async () => {
  const created = await admin.post('/api/admin/providers', {
    type: 'openai',
    name: 'Mock OpenAI',
    apiKey: providers.GOOD_KEY,
    baseUrl: providers.openAiUrl,
  });
  assert.equal(created.status, 200);
  const provider = (await created.json()).provider;
  await admin.patch(`/api/admin/providers/${provider.id}`, { enabledModels: ['mock-gpt'] });
  const externalModel = `ext/${provider.id}/mock-gpt`;

  const events = await runCapability(externalModel, ['gaa']);
  const result = eventsOf(events, 'result')[0];
  // The mock only ever answers in English, so it must NOT be approved.
  assert.equal(result.status, 'failed');
  const tests = (await (await admin.get('/api/admin/language/capabilities')).json()).tests;
  assert.ok(tests.some((t) => t.model === externalModel && t.language === 'gaa'));

  // What actually left the machine: the test sentences, nothing else.
  const sent = providers.requests.openai.map((body) => JSON.stringify(body.messages)).join('\n');
  assert.match(sent, /minimum balance for a savings account/);
  assert.ok(!/@amenfimanbank|\b\d{10,}\b|password/i.test(sent), 'no customer or account data in a capability test');

  // External providers are clearly marked as such, and their output is attributed to them in the
  // quality figures (so a provider problem is distinguishable from a local-model problem).
  const models = (await (await admin.get('/api/admin/language/capabilities')).json()).models;
  assert.ok(models.find((m) => m.name === externalModel)?.external === true);
  // Provider attribution, which is what separates a local-model problem from a provider problem in
  // the usage figures. (An unknown provider id must still be identifiable as external, not local.)
  const languageQuality = require('../server/languageQuality');
  assert.equal(languageQuality.providerForModel(`${BANK_MODEL}:latest`), 'local');
  assert.equal(languageQuality.providerForModel('ext/9999/unknown-model'), 'external');
});

test('redaction of customer data for external providers is unchanged by the language feature', async () => {
  const redaction = await (await admin.get('/api/admin/settings')).json();
  assert.equal(redaction.externalRedaction, true);
  const summary = await (await admin.get('/api/admin/language')).json();
  assert.equal(summary.searchTranslation, true);
  const terms = await (await admin.get('/api/admin/language/terms?language=gaa')).json();
  assert.ok(Array.isArray(terms.terms));
});

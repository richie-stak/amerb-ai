// Language capability testing: does this model actually work in this language, well enough for a
// bank to put in front of staff?
//
// Producing text in a language is not evidence of that — this project measured qwen3:4b-instruct
// answering a Twi question with "wɔ bɔɔ kɛ bɔɔ kɛ wɔ kɔnɛ kɔnɛ…". So each test checks the things a
// bank needs, and a language is only approved for a model when every applicable check passes:
//
//   translation      the sentence comes back in the target language, not English, and the figures
//                    survive exactly (GHS 200.00, 6 months) rather than being invented or dropped
//   comprehension    a question asked in the target language about an English bank paragraph is
//                    answered with the right fact, not fluent-sounding noise
//   terminology      the bank's own approved wording is used, when the bank has recorded any
//   consistency      the same sentence translated twice reads the same way both times
//   quality          every answer is real prose, not a loop of repeated words
//
// Results are stored (language_capability_tests) with the model, the date and who ran it, so the
// decision to offer a language can be reviewed later.
const db = require('./db');
const llm = require('./llm');
const L = require('./languages');
const languageSettings = require('./languageSettings');

const TEST_SENTENCES = {
  // Deliberately about ordinary banking business, with figures and a date, because those are what
  // must never be mangled in translation.
  translation: 'The minimum balance for a savings account is GHS 200.00 and interest is paid every 6 months.',
  translationTwo: 'A customer who wants a loan above GHS 50,000 must provide two guarantors and a Ghana Card.',
  comprehensionText:
    'Amenfiman Community Bank requires two guarantors for any loan above GHS 50,000. The processing fee is 2 percent of the loan amount and is paid at the branch.',
};

// `required` figures are the amounts a bank officer would read to a customer, and they must survive
// the translation. `advisory` ones are small counts: a good translation may write them as words
// ("six", "deux"), and inventing number words for Twi or Ga is exactly what this project refuses to
// do — so an advisory figure that can't be found is noted, not treated as a failure.
const NUMBERS = {
  translation: { required: [200], advisory: [6] },
  translationTwo: { required: [50000], advisory: [2] },
  comprehension: { required: [50000] },
};

// Number words this project is certain about (English and French are standardised; the code does not
// guess at Twi or Ga number words, which is why small counts there are advisory only).
const WORD_NUMBERS = {
  en: { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 },
  fr: { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 },
};

const MAX_TOKENS = 220;
const CALL_TIMEOUT_MS = 90_000;

// Every number in a piece of text, as values. Handles French formatting ("200,00", "50 000"), English
// thousands separators ("50,000") and the number words this project is sure of.
function numbersIn(text, language) {
  // French writes thousands with a space ("50 000", sometimes a narrow no-break space): glue those
  // groups back together first, so the amount is read as one figure rather than 50 and 000.
  const value = String(text || '')
    .replace(/(\d)[\u00a0\u202f\u2009 ](?=\d{3}(\D|$))/g, '$1')
    .replace(/[\u00a0\u202f\u2009]/g, ' ');
  const found = new Set();
  for (const raw of value.match(/\d+(?:[.,]\d+)?/g) || []) {
    // A single separator followed by one or two digits is a decimal comma/dot; anything else is a
    // thousands separator.
    const decimal = /[.,]\d{1,2}$/.test(raw);
    const normalised = decimal ? raw.replace(',', '.') : raw.replace(/[.,]/g, '');
    const n = Number(normalised);
    if (Number.isFinite(n)) found.add(Math.round(n));
  }
  for (const [word, n] of Object.entries(WORD_NUMBERS[language] || {})) {
    if (new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, 'iu').test(value)) found.add(n);
  }
  return found;
}

// Words that show the model simply repeated the English prompt back instead of translating it.
function isEchoOf(response, prompt) {
  const words = (text) =>
    new Set(
      String(text || '')
        .toLowerCase()
        .match(/[\p{L}]{4,}/gu) || []
    );
  const a = words(response);
  const b = words(prompt);
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / a.size > 0.85;
}

// Words shared between two answers, as a share of the larger one — a rough read on whether two
// translations of the same sentence agree. Deliberately generous: two good translations need not be
// word-for-word identical.
function similarity(a, b) {
  const set = (text) => new Set((String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []));
  const x = set(a);
  const y = set(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.max(x.size, y.size);
}

function hasNumbers(response, expected, language) {
  if (!expected) return { ok: true, missingRequired: [], missingAdvisory: [] };
  const found = numbersIn(response, language);
  const missingRequired = (expected.required || []).filter((n) => !found.has(n));
  const missingAdvisory = (expected.advisory || []).filter((n) => !found.has(n));
  return { ok: missingRequired.length === 0, missingRequired, missingAdvisory };
}

async function ask(model, prompt, capabilities, signal) {
  const reply = await llm.completeChat(model, {
    messages: [{ role: 'user', content: prompt }],
    // A capability test is about language, not reasoning: skip it, it only makes a CPU wait longer.
    ...(capabilities.thinking ? { think: false } : {}),
    maxTokens: MAX_TOKENS,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  return (reply.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// One probe result: does this answer pass the bar for this check?
function judge({ key, label, response, prompt, language, expectedNumbers, requiredWords }) {
  const inLanguage = L.isWrittenIn(response, language);
  const garbled = L.looksUnreliableAnswer(response);
  const echo = prompt ? isEchoOf(response, prompt) : false;
  const numbers = hasNumbers(response, expectedNumbers, language);
  const termsOk = requiredWords && requiredWords.length ? requiredWords.some((w) => response.toLowerCase().includes(w.toLowerCase())) : true;

  const problems = [];
  const notes = [];
  if (!response) problems.push('no answer at all');
  else {
    if (!inLanguage) problems.push(`answered in English, not ${L.nameOf(language)}`);
    if (garbled) problems.push('looks like repeated nonsense rather than prose');
    if (echo) problems.push('repeated the English prompt instead of translating');
    if (!numbers.ok) problems.push(`lost or changed the amount (expected ${numbers.missingRequired.join(', ')})`);
    if (numbers.missingAdvisory.length) {
      notes.push(`could not confirm the count (${numbers.missingAdvisory.join(', ')}) — it may be written as a word`);
    }
    if (!termsOk) problems.push('did not use the bank’s approved wording');
  }
  return {
    key,
    label,
    passed: problems.length === 0,
    detail: problems.length
      ? problems.join('; ')
      : `answered in the language, kept the amount, and read as real prose${notes.length ? `; ${notes.join('; ')}` : ''}`,
    sample: response.slice(0, 400),
  };
}

// Runs the whole suite for one language against one model, reporting progress as it goes.
// `onProgress({ step, label, index, total })` lets the admin portal show what is happening — a run
// takes minutes on a CPU-only machine, so silence would look like a hang.
async function testLanguage({ model, language, onProgress = () => {}, signal }) {
  const capabilities = await llm.getCapabilities(model);
  const glossary = languageSettings.glossaryFor(language);
  const glossaryTerms = Object.entries(glossary).slice(0, 2);
  // The steps are fixed up front so the progress bar has an honest total: the terminology step only
  // exists when the bank has recorded any wording, and consistency makes two calls but is one step.
  const steps = [
    ['translation', 'Checking translation accuracy'],
    ['comprehension', 'Checking comprehension and meaning'],
    ...(glossaryTerms.length ? [['terminology', 'Checking the bank’s approved wording']] : []),
    ['consistency', 'Checking consistency (same sentence twice)'],
  ];
  const total = steps.length;
  const stepIndex = (key) => {
    const i = steps.findIndex(([k]) => k === key);
    if (i >= 0) onProgress({ step: key, label: steps[i][1], index: i + 1, total });
  };

  const checks = [];
  const name = L.nameOf(language);

  // 1. Translation, with figures that must survive.
  stepIndex('translation');
  const translationPrompt = `Translate this bank sentence into ${name}. Reply with the translation only — no explanation and no English:\n\n"${TEST_SENTENCES.translation}"`;
  const translation = await ask(model, translationPrompt, capabilities, signal);
  checks.push(
    judge({
      key: 'translation',
      label: 'Translation accuracy',
      response: translation,
      prompt: TEST_SENTENCES.translation,
      language,
      expectedNumbers: NUMBERS.translation,
    })
  );

  // 2. Comprehension: an English bank paragraph, a question asked in the target language. This is
  //    the check that catches "fluent-sounding nonsense" — the right amount has to come back.
  stepIndex('comprehension');
  const comprehensionPrompt =
    `Here is a bank notice in English:\n\n"${TEST_SENTENCES.comprehensionText}"\n\n` +
    `Answer this question in ${name}, briefly: Above what amount does a loan need guarantors? Give the amount.`;
  const comprehension = await ask(model, comprehensionPrompt, capabilities, signal);
  checks.push(
    judge({
      key: 'comprehension',
      label: 'Comprehension and meaning',
      response: comprehension,
      prompt: null,
      language,
      expectedNumbers: NUMBERS.comprehension,
    })
  );

  // 3. The bank's approved wording, only when the bank has recorded any — the code never invents a
  //    translation, so it can only check the ones an administrator approved.
  if (glossaryTerms.length) {
    stepIndex('terminology');
    const englishTerms = glossaryTerms.map(([term]) => term).join(' and ');
    const terminologyPrompt = `Translate into ${name}, using the bank's approved wording for the banking terms "${englishTerms}". Reply with the translation only:\n\n"Customers can apply for a ${glossaryTerms[0][0]} at any branch."`;
    const terminology = await ask(model, terminologyPrompt, capabilities, signal);
    checks.push(
      judge({
        key: 'terminology',
        label: 'Banking terminology',
        response: terminology,
        prompt: null,
        language,
        requiredWords: glossaryTerms.map(([, wording]) => wording),
      })
    );
  }

  // 4. Consistency: the same sentence twice. A model that produces a different invention each time
  //    cannot be relied on for anything staff will quote to a customer.
  stepIndex('consistency');
  const consistencyPrompt = `Translate this bank sentence into ${name}. Reply with the translation only:\n\n"${TEST_SENTENCES.translationTwo}"`;
  const first = await ask(model, consistencyPrompt, capabilities, signal);
  const second = await ask(model, consistencyPrompt, capabilities, signal);
  const agreement = similarity(first, second);
  const bothInLanguage = L.isWrittenIn(first, language) && L.isWrittenIn(second, language);
  const bothClean = !L.looksUnreliableAnswer(first) && !L.looksUnreliableAnswer(second);
  const consistent = bothInLanguage && bothClean && agreement >= 0.5;
  checks.push({
    key: 'consistency',
    label: 'Consistency',
    passed: consistent,
    detail: consistent
      ? `two runs agreed (${Math.round(agreement * 100)}% of the wording shared)`
      : !bothInLanguage
        ? 'one or both answers were not in the language'
        : !bothClean
          ? 'one or both answers looked like repeated nonsense'
          : `the two answers disagreed (only ${Math.round(agreement * 100)}% shared) — the model is inventing each time`,
    sample: first.slice(0, 200),
  });

  const passedCount = checks.filter((c) => c.passed).length;
  const status = passedCount === checks.length ? 'approved' : 'failed';
  return {
    language,
    label: L.labelOf(language),
    model,
    status,
    score: checks.length ? Math.round((passedCount / checks.length) * 100) / 100 : 0,
    checks,
  };
}

// Runs and records the test(s). Persisting here (not in the route) means every caller leaves an
// audit trail: who approved a language, when, with which model, and what the evidence was.
function recordResult(result, who) {
  // The model is stored normalised ("qwen3:4b-instruct" and "qwen3:4b-instruct:latest" are the same
  // model, and Ollama reports the tagged name), so approvals aren't split across two spellings.
  const model = languageSettings.normaliseModel(result.model);
  db.prepare(
    'INSERT INTO language_capability_tests (model, language, status, score, checks, tested_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(model, result.language, result.status, result.score, JSON.stringify(result.checks), who?.id ?? null);
  const reverted = result.status === 'approved' ? {} : languageSettings.revertUnavailableUsers('a capability test failed');
  return { ...result, model, reverted };
}

async function runAndRecord({ model, language, who, onProgress, signal }) {
  if (language === 'en') throw new Error('English needs no capability test');
  const result = await testLanguage({ model, language, onProgress, signal });
  return recordResult(result, who);
}

module.exports = { runAndRecord, testLanguage, recordResult };

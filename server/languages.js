// The languages AMERB AI can answer in, and the text-level helpers for them: detecting what a
// message is written in, telling the model how to answer, watching for garbled output, and helping
// document search cope with a local-language question.
//
// Settings, availability and approval live in server/languageSettings.js — this file is purely
// about the languages themselves, so it can be unit-tested without a database.
//
// Three things are deliberately NOT done here:
//  - The app's own interface is not translated. Staff read English menu labels; only the model's
//    answers change language. A half-translated interface would be worse than none.
//  - No banking term is translated by the code. A wrong translation of "interest" or "guarantor" in
//    a bank is worse than no translation; approved wording comes from an admin-maintained
//    terminology list, and the model is told to keep established Ghanaian banking terms as staff
//    already use them.
//  - A language is never assumed to work because a model produced some text in it. That is what the
//    capability tests in server/languageTests.js are for.

// `name` is how the language is named to the model (and in the prompt instructions); `label` is the
// admin-facing name, `native` the name people call it themselves.
const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', name: 'English' },
  { code: 'tw', label: 'Twi (Akan)', native: 'Twi', name: 'Twi (Akan)' },
  { code: 'gaa', label: 'Ga', native: 'Ga', name: 'Ga' },
  { code: 'fr', label: 'French', native: 'Français', name: 'French' },
];
const CODES = LANGUAGES.map((l) => l.code);
const LOCAL_CODES = CODES.filter((c) => c !== 'en');
const AUTO = 'auto';
const CHOICES = [...CODES, AUTO];
const DEFAULT_LANGUAGE = 'en';

function byCode(code) {
  return LANGUAGES.find((l) => l.code === code) || null;
}

function labelOf(code) {
  if (code === AUTO) return 'Match my message';
  return byCode(code)?.label || 'English';
}

function nameOf(code) {
  return byCode(code)?.name || 'English';
}

// ---------- Detecting what language a message is written in ----------
//
// Deliberately conservative: guessing wrong and answering a Ga speaker in Twi is worse than
// answering in English, so a message has to show real evidence before it counts as one of the local
// languages. Mixed Twi/English — how most people actually write — is normal input here; when an
// English sentence merely contains a local word, it stays English.

const TWI_MARKERS = new Set([
  'medaase', 'mepaakyɛw', 'mepaakyew', 'maakye', 'maaha', 'akyɛ', 'akyie', 'yɛ', 'wɔ', 'sɛ', 'kɔ',
  'bɛyɛ', 'nso', 'pii', 'kakra', 'asɛm', 'nsɛm', 'adwuma', 'sika', 'bosea', 'ɛka', 'mmuae', 'kasa',
  'tumi', 'sɛnea', 'nea', 'wɔn', 'yɛn', 'mennim', 'mekae', 'boa', 'nkora', 'akatua', 'obla',
  'aboafoɔ', 'kabɔ', 'tirimu', 'nkyekyɛmu', 'sɛn', 'te', 'ho', 'mu', 'bi',
]);

const GAA_MARKERS = new Set([
  'oyiwaladɔŋŋ', 'oyiwaladong', 'ojekoo', 'mataa', 'miishɛɛ', 'ofainɛ', 'ofaine', 'kɛha', 'mli',
  'nɔ', 'kɛ', 'gbɛ', 'sane', 'shika', 'wolo', 'nuu', 'haomɔ', 'akɛ', 'gbɛɛ', 'kome', 'hulu',
  'nyɔŋmɔ', 'bɔni', 'kɛjɛ', 'fɛɛ', 'wiemɔ', 'gbe', 'atsɛ', 'bii',
]);

// French is closer to English than Twi or Ga are, so it needs more evidence: function words that
// barely appear in English banking sentences, plus the accented characters English doesn't use.
const FRENCH_MARKERS = new Set([
  'le', 'la', 'les', 'des', 'du', 'est', 'et', 'pour', 'avec', 'vous', 'nous', 'votre', 'notre',
  'compte', 'comptes', 'prêt', 'prets', 'épargne', 'epargne', 'intérêt', 'interet', 'taux', 'frais',
  'montant', 'client', 'clients', 'banque', 'garant', 'garants', 'quel', 'quelle', 'combien',
  'puis', 'je', 'ce', 'cette', 'sur', 'dans', 'par', 'au', 'aux', 'être', 'etre', 'avoir', 'fait',
  'doit', 'peut', 'sommes', 'versement', 'retrait', 'succursale', 'agence',
]);

const ENGLISH_MARKERS = new Set([
  'the', 'and', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'for', 'with', 'what', 'how',
  'when', 'where', 'which', 'who', 'why', 'please', 'can', 'could', 'we', 'our', 'should', 'would',
  'this', 'that', 'it', 'my', 'your', 'have', 'has', 'need', 'want', 'tell', 'give', 'about',
  'much', 'many', 'does', 'do', 'be', 'by', 'from', 'as', 'at', 'or', 'not',
]);

function countMarkers(text, markers) {
  let count = 0;
  const seen = new Set();
  for (const word of text.toLowerCase().match(/[\p{L}]+/gu) || []) {
    if (markers.has(word) && !seen.has(word)) {
      seen.add(word);
      count += 1;
    }
  }
  return count;
}

// Returns 'tw', 'gaa', 'fr', or null (English, or not confident). `fallback` is what to use when the
// message shows local-language writing but not enough to tell which language apart.
function detectLanguage(text, fallback = null) {
  const value = String(text || '');
  if (!value.trim()) return null;

  const twi = countMarkers(value, TWI_MARKERS);
  const ga = countMarkers(value, GAA_MARKERS);
  const french = countMarkers(value, FRENCH_MARKERS);
  const english = countMarkers(value, ENGLISH_MARKERS);
  // ɛ and ɔ are not used in English (or French) at all; é/è/ê/à/ç are French.
  const localLetters = (value.match(/[ɛɔ]/giu) || []).length;
  const frenchLetters = (value.match(/[éèêëàâäçùûôîïœ]/giu) || []).length;

  const localEvidence = twi + ga + localLetters + french * 0.5;
  if (localEvidence + frenchLetters * 0.5 === 0) return null;
  if (english >= 6 && localEvidence <= 2 && frenchLetters === 0) return null; // English with a local word or two

  // Twi/Ga first: their spellings are unmistakable.
  if (twi >= 2 && twi > ga) return 'tw';
  if (ga >= 2 && ga > twi) return 'gaa';
  if (localLetters >= 2 || twi + ga >= 3) {
    if (twi > ga) return 'tw';
    if (ga > twi) return 'gaa';
    return LOCAL_CODES.includes(fallback) && fallback !== 'fr' ? fallback : 'tw';
  }
  // French: needs several function words or accented characters, and more than the English markers.
  if (french >= 3 || (frenchLetters >= 2 && french >= 1)) {
    if (french > english || frenchLetters >= 2) return 'fr';
  }
  return null;
}

// ---------- The prompt text ----------

function replyInstruction(code, glossaryForLanguage = {}) {
  if (!code || code === 'en') return null;
  const name = nameOf(code);
  const lines = [
    `The user wants answers in ${name}. Write every reply in ${name}, in the natural, everyday register a bank officer would speak — ` +
      'not a word-for-word translation of an English answer.',
    'Keep these exactly as they appear, never translated: numbers, amounts and currencies (e.g. GHS 5,000.00), percentages, dates, ' +
      'account and card numbers, customer and staff names, product names, document titles and filenames, and any policy wording you quote.',
    'Keep established Ghanaian banking terms as staff already say them (loan, interest, account, cheque, ATM, overdraft, guarantor, ' +
      'collateral, statement) rather than inventing local words for them; you may add a short gloss in brackets the first time one comes up ' +
      'if that helps the reader, but the English term must stay recognisable, because policies and systems use it.',
    "The bank's documents are in English. Read the English excerpts in your context and explain what they mean in the user's language; " +
      'quote the original English when exact wording matters.',
    `If the user asks for a document to be created (letter, memo, report, spreadsheet), produce it in English — official bank documents ` +
      `stay in English — and say so briefly in ${name}.`,
    'Proper nouns and names of regulators (Bank of Ghana, BoG) stay as they are.',
    'If you genuinely cannot express something in the language without guessing, say so in the language and give the English term too.',
  ];
  const terms = Object.entries(glossaryForLanguage || {});
  if (terms.length) {
    lines.push(
      `Use the bank's approved wording for these terms: ${terms.map(([term, wording]) => `${term} = ${wording}`).join('; ')}.`
    );
  }
  return lines.join('\n');
}

// ---------- Helping document search cope with a local-language question ----------
//
// The knowledge base is in English and the embedding model is English-trained, so a Twi/Ga/French
// question matches almost nothing on its own. Two cheap aids: swap in the English side of any
// approved term the question uses, and (in chat.js, when enabled) have the model translate the
// question once for search purposes only.
function expandQuery(text, code, glossaryForLanguage = {}) {
  if (!code || code === 'en') return text;
  const lower = String(text || '').toLowerCase();
  const additions = [];
  for (const [term, wording] of Object.entries(glossaryForLanguage || {})) {
    if (lower.includes(wording.toLowerCase()) && !lower.includes(term.toLowerCase())) additions.push(term);
  }
  return additions.length ? `${text}\n${additions.join(' ')}` : text;
}

// Prompt for that search-only translation. Deliberately tiny: one line out, no commentary, so it's
// cheap enough to run on a CPU-only machine before every local-language message.
function translationPrompt(text) {
  return (
    'Translate the following question into plain English for use as a document search query. ' +
    'Keep names, numbers and amounts unchanged. Reply with the translation only — no explanation, no quotes.\n\n' +
    `Question: ${text}`
  );
}

// ---------- Spotting an answer that reads as nonsense ----------
//
// Small local models (the 4B-class ones a bank machine can run on CPU) have almost no Twi or Ga
// training data, and what they produce tends to be repetitive nonsense — measured on this machine:
// qwen3:4b-instruct answered a Twi question with "wɔ bɔɔ kɛ bɔɔ kɛ wɔ kɔnɛ kɔnɛ…". French has more
// training data but the same failure mode is possible. Two signals are enough in practice: a short
// handful of words repeated over and over, and a vocabulary too small to be real prose.
function looksUnreliableAnswer(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 40) return false;

  const pairs = new Map();
  for (let i = 0; i < words.length - 1; i++) {
    const key = `${words[i]} ${words[i + 1]}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  const mostRepeatedPair = pairs.size ? Math.max(...pairs.values()) : 0;
  const distinctShare = new Set(words).size / words.length;
  return mostRepeatedPair >= 6 || distinctShare < 0.35;
}

// Whether an answer is actually written in the requested language. Used both by the quality warning
// and by the capability tests — a model that answers an English question in English has not done a
// translation, however fluent it looks.
function isWrittenIn(text, code) {
  if (code === 'en') return true;
  return detectLanguage(text, code) === code;
}

module.exports = {
  LANGUAGES,
  CODES,
  LOCAL_CODES,
  CHOICES,
  AUTO,
  DEFAULT_LANGUAGE,
  byCode,
  labelOf,
  nameOf,
  detectLanguage,
  replyInstruction,
  expandQuery,
  translationPrompt,
  looksUnreliableAnswer,
  isWrittenIn,
};

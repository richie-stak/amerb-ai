// Currency questions, recognised deterministically.
//
// Why this exists: a small local model calls the exchange_rate tool reliably in a fresh conversation,
// but stops doing so as soon as the conversation history contains its own earlier "I don't have
// real-time data access" refusal — it simply repeats itself. Depending on the model to choose the tool
// is therefore not good enough for the question staff ask most, so the lookup is performed server-side
// and the result is handed to the model (and appended to the reply if the model still will not state
// it). This module is only the sentence parsing; it performs no network calls.

// Words people actually use for the currencies this bank deals with.
const CURRENCY_PATTERNS = [
  { code: 'GHS', re: /(?:\bcedis?\b|\bghs\b|gh₵|₵)/i },
  { code: 'USD', re: /(?:\bdollars?\b|\busd\b|\bbucks\b|\bgreenbacks?\b)/i },
  { code: 'EUR', re: /(?:\beuros?\b|\beur\b)/i },
  { code: 'GBP', re: /(?:\bpounds?\b|\bsterling\b|\bgbp\b)/i },
  { code: 'NGN', re: /(?:\bnairas?\b|\bngn\b)/i },
  { code: 'XOF', re: /(?:\bcfa\b|\bxof\b)/i },
  { code: 'ZAR', re: /(?:\brands?\b|\bzar\b)/i },
  { code: 'CAD', re: /(?:\bcanadian dollars?\b|\bcad\b)/i },
  { code: 'CNY', re: /(?:\byuan\b|\brenminbi\b|\bcny\b)/i },
];

// Something that asks for a rate rather than, say, a document about exchange-rate policy.
const ASKS_FOR_RATE = /(?:\bconvert|\bconversion|\bexchange rate|\bexchange-rate|\brate\b|\bworth\b|\bhow much\b|\bequivalent\b|\bto (?:cedis?|dollars?|euros?|pounds?|naira)\b|=\s*\?|→|->)/i;

function currencyCodesIn(text) {
  const found = [];
  for (const { code, re } of CURRENCY_PATTERNS) {
    const match = re.exec(text);
    if (match) found.push({ code, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.code);
}

// "1,000 cedis in dollars", "convert 1000 cedis to dollars", "how much is 500 dollars in cedis" —
// returns the amount only when a number clearly belongs to the source currency (either it sits directly
// before the from-word, or the question is "convert <n> <from> to <to>").
function amountIn(text, fromWords) {
  const number = /(\d[\d,]*(?:\.\d+)?)/g;
  let match;
  while ((match = number.exec(text))) {
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const after = text.slice(match.index + match[1].length, match.index + match[1].length + 24);
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    const near = `${before} ${after}`;
    if (fromWords.some((word) => word.test(near))) return value;
  }
  return null;
}

// Returns { from, to, amount? } when the sentence is a currency conversion, otherwise null. A single
// currency named on its own ("what is the dollar rate today?") is read against the cedi, which is the
// question a Ghanaian bank's staff are asking; the reverse ("the cedi rate") is read against the dollar.
function parseCurrencyRequest(text) {
  const question = String(text || '').replace(/\s+/g, ' ').trim();
  if (!question || question.length > 300) return null;
  if (!ASKS_FOR_RATE.test(question)) return null;

  const codes = currencyCodesIn(question);
  const unique = codes.filter((code, index) => codes.indexOf(code) === index);
  if (unique.length < 2) {
    if (unique.length !== 1) return null;
    const only = unique[0];
    if (only === 'GHS') {
      const request = { from: 'GHS', to: 'USD' };
      const ghs = CURRENCY_PATTERNS.find((entry) => entry.code === 'GHS');
      const amount = amountIn(question, [ghs.re]);
      if (amount) request.amount = amount;
      return request;
    }
    const request = { from: only, to: 'GHS' };
    const fromPattern = CURRENCY_PATTERNS.find((entry) => entry.code === only);
    const amount = fromPattern ? amountIn(question, [fromPattern.re]) : null;
    if (amount) request.amount = amount;
    return request;
  }

  const from = unique[0];
  const to = unique[1];
  if (from === to) return null;

  const request = { from, to };
  const fromPattern = CURRENCY_PATTERNS.find((entry) => entry.code === from);
  const amount = fromPattern ? amountIn(question, [fromPattern.re]) : null;
  if (amount) request.amount = amount;
  return request;
}

// The figures a correct answer must contain, so a reply can be checked for them. Handles the tool's
// wording: "1 GHS = 0.085085 USD as published Thu, 19 Nov 2026 ... 1000 GHS = 85.08 USD." Roundings are
// kept to significant digits for values below 1 (0.085, 0.0851, 0.085085) — never "0.1", which almost
// any reply would contain.
function rateFigures(toolText) {
  const figures = new Set();
  for (const match of String(toolText || '').matchAll(/=\s*([\d,]+(?:\.\d+)?)/g)) {
    const raw = match[1].replace(/,/g, '');
    const value = Number(raw);
    if (!Number.isFinite(value) || value === 0) continue;
    figures.add(raw);
    if (value < 1) {
      for (let precision = 2; precision <= 6; precision++) figures.add(String(Number(value.toPrecision(precision))));
    } else {
      for (const decimals of [0, 1, 2]) figures.add(String(Number(value.toFixed(decimals))));
    }
  }
  return [...figures];
}

function answerStatesRate(answer, figures) {
  const text = String(answer || '');
  return figures.some((figure) => text.includes(figure));
}

module.exports = { parseCurrencyRequest, rateFigures, answerStatesRate, currencyCodesIn };

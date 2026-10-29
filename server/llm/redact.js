// Masks customer identifiers before a conversation is sent to an external AI provider, and puts
// them back in what comes back — so an account number typed by staff, or sitting in a retrieved
// document, never leaves the bank, while the reply staff read still shows the real value.
//
//   "Customer 0241234567, acct 1020304050607"  →  "Customer [PHONE_1], acct [ACCOUNT_NUMBER_1]"
//
// Each distinct value gets one placeholder for the whole request, so the model can still tell
// that two mentions are the same customer.
const PATTERNS = [
  // Ghana Card (national ID): GHA-123456789-0
  { label: 'GHANA_CARD', regex: /\bGHA-?\d{9}-?\d\b/gi },
  // Email addresses
  { label: 'EMAIL', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Ghana TIN: a letter (P, C, G, Q or V) and 10 digits
  { label: 'TIN', regex: /\b[PCGQV]\d{10}\b/g },
  // Ghana phone numbers: 024 123 4567, +233 24 123 4567, 233241234567
  { label: 'PHONE', regex: /(?<![\d+])(?:\+?233[\s-]?|0)[2-5]\d[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g },
  // Account and card numbers: 10–19 digits, optionally grouped with spaces or dashes. Amounts,
  // dates and ordinary figures are far shorter, so they're left alone — as is the tail of a
  // decimal number like 1,250,000.00, while a full stop that just ends a sentence doesn't count.
  { label: 'ACCOUNT_NUMBER', regex: /(?<!\d|\d[.,])\d(?:[ -]?\d){9,18}(?!\d|[.,]\d)/g },
];

const PLACEHOLDER = /\[(GHANA_CARD|EMAIL|TIN|PHONE|ACCOUNT_NUMBER)_(\d+)\]/g;

function createRedactor() {
  const byValue = new Map(); // real value -> placeholder
  const byPlaceholder = new Map(); // placeholder -> real value
  const counters = {};

  function mask(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const { label, regex } of PATTERNS) {
      out = out.replace(regex, (match) => {
        if (/^\[.*\]$/.test(match)) return match;
        const key = match.replace(/[\s-]/g, '').toUpperCase();
        if (!byValue.has(key)) {
          counters[label] = (counters[label] || 0) + 1;
          const placeholder = `[${label}_${counters[label]}]`;
          byValue.set(key, placeholder);
          byPlaceholder.set(placeholder, match);
        }
        return byValue.get(key);
      });
    }
    return out;
  }

  function restore(text) {
    if (typeof text !== 'string' || !byPlaceholder.size) return text;
    return text.replace(PLACEHOLDER, (placeholder) => byPlaceholder.get(placeholder) ?? placeholder);
  }

  // Tool-call arguments may quote placeholders (e.g. a letter to "[PHONE_1]") — the tool runs
  // locally, so it gets the real values.
  function restoreDeep(value) {
    if (typeof value === 'string') return restore(value);
    if (Array.isArray(value)) return value.map(restoreDeep);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreDeep(v)]));
    return value;
  }

  // Streamed text arrives in fragments, and a placeholder can be split across two of them
  // ("[ACCOUNT_NUM" + "BER_1]"). Holds back a possible partial placeholder until it's complete.
  function streamRestorer(emit) {
    let pending = '';
    return {
      push(delta) {
        pending += delta;
        const open = pending.lastIndexOf('[');
        let ready = pending;
        if (open !== -1 && !pending.includes(']', open) && pending.length - open < 30) {
          ready = pending.slice(0, open);
          pending = pending.slice(open);
        } else {
          pending = '';
        }
        if (ready) emit(restore(ready));
      },
      flush() {
        if (pending) emit(restore(pending));
        pending = '';
      },
    };
  }

  function maskMessages(messages) {
    return messages.map((m) => ({ ...m, content: mask(m.content) }));
  }

  return { mask, restore, restoreDeep, streamRestorer, maskMessages, get count() { return byPlaceholder.size; } };
}

module.exports = { createRedactor };

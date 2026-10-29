// What counts as a customer identifier (and what doesn't) when masking text for external AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRedactor } = require('../server/llm/redact');

test('Ghana Card, phone, email, TIN, account and card numbers are masked', () => {
  const r = createRedactor();
  const masked = r.mask(
    'Card GHA-123456789-0, phones 024 123 4567 and +233 20 765 4321, ama.mensah@gmail.com, TIN P0012345678, ' +
      'account 1020304050607, card 4111-1111-1111-1111.'
  );
  assert.equal(
    masked,
    'Card [GHANA_CARD_1], phones [PHONE_1] and [PHONE_2], [EMAIL_1], TIN [TIN_1], ' +
      'account [ACCOUNT_NUMBER_1], card [ACCOUNT_NUMBER_2].'
  );
});

test('amounts, rates, dates and decimals are left alone', () => {
  const r = createRedactor();
  const text = 'GHS 50,000 at 24% over 12 months from 2026-10-29; balance 1,250,000.00 and 12345678901.50 cedis.';
  assert.equal(r.mask(text), text);
});

test('the same value always gets the same placeholder, however it is written', () => {
  const r = createRedactor();
  assert.equal(r.mask('024 123 4567 / 0241234567 / 024-123-4567'), '[PHONE_1] / [PHONE_1] / [PHONE_1]');
});

test('placeholders in a reply, or in tool arguments, are swapped back for the real values', () => {
  const r = createRedactor();
  r.mask('account 1020304050607');
  assert.equal(r.restore('Account [ACCOUNT_NUMBER_1] is active. [PHONE_9] is unknown.'), 'Account 1020304050607 is active. [PHONE_9] is unknown.');
  assert.deepEqual(r.restoreDeep({ content: 'Re: [ACCOUNT_NUMBER_1]', rows: [['[ACCOUNT_NUMBER_1]', 5]] }), {
    content: 'Re: 1020304050607',
    rows: [['1020304050607', 5]],
  });
});

test('a placeholder split across streamed fragments is still restored', () => {
  const r = createRedactor();
  r.mask('call 0241234567');
  let out = '';
  const stream = r.streamRestorer((text) => (out += text));
  for (const piece of ['Please call [PHO', 'NE_1] today [see note', '] thanks']) stream.push(piece);
  stream.flush();
  assert.equal(out, 'Please call 0241234567 today [see note] thanks');
});

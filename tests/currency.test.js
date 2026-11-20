// The sentence parsing behind the deterministic currency answers: which currencies, which direction,
// and how much. A wrong parse here would answer a different question, so the ambiguous cases matter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCurrencyRequest, rateFigures, answerStatesRate, currencyCodesIn } = require('../server/currency');

test('recognises the ways staff ask for the cedi rate', () => {
  assert.deepEqual(parseCurrencyRequest('what is the current cedi to dollar conversion'), { from: 'GHS', to: 'USD' });
  assert.deepEqual(parseCurrencyRequest('what is the dollar rate today'), { from: 'USD', to: 'GHS' });
  assert.deepEqual(parseCurrencyRequest('exchange rate ghs to usd'), { from: 'GHS', to: 'USD' });
  assert.deepEqual(parseCurrencyRequest('how much is 500 dollars in cedis'), { from: 'USD', to: 'GHS', amount: 500 });
  assert.deepEqual(parseCurrencyRequest('convert 1,000 cedis to dollars'), { from: 'GHS', to: 'USD', amount: 1000 });
  assert.deepEqual(parseCurrencyRequest('what is the GBP to GHS rate'), { from: 'GBP', to: 'GHS' });
  assert.deepEqual(parseCurrencyRequest('cedi to euro'), { from: 'GHS', to: 'EUR' });
});

test('leaves questions that are not conversions to the model', () => {
  assert.equal(parseCurrencyRequest('explain our exchange rate policy'), null, 'policy questions are answered from the documents');
  assert.equal(parseCurrencyRequest('hello'), null);
  assert.equal(parseCurrencyRequest('what is our loan interest rate'), null, 'no currency named');
  assert.equal(parseCurrencyRequest('reset my password'), null);
  assert.equal(parseCurrencyRequest(''), null);
  assert.equal(parseCurrencyRequest('x'.repeat(400)), null, 'not a sentence anyone typed');
});

test('finds the currency codes in order of appearance', () => {
  assert.deepEqual(currencyCodesIn('dollars to cedis'), ['USD', 'GHS']);
  assert.deepEqual(currencyCodesIn('cedis, dollars'), ['GHS', 'USD']);
  assert.deepEqual(currencyCodesIn('nothing here'), []);
});

test('the figures a correct answer must contain are exact enough to matter', () => {
  const tool = '1 GHS = 0.085085 USD as published Thu, 19 Nov 2026 00:00:01 +0000 (source: open.er-api.com). 1000 GHS = 85.08 USD.';
  const figures = rateFigures(tool);
  assert.ok(figures.includes('0.085085'));
  assert.ok(figures.includes('0.0851'), 'a 4-decimal rounding still counts');
  assert.ok(!figures.includes('0.1'), 'but not a rounding so coarse that any number would match');
  assert.equal(answerStatesRate('1 GHS is about 0.0851 USD.', figures), true);
  assert.equal(answerStatesRate('I have no real-time data.', figures), false);
  assert.equal(answerStatesRate('Roughly 0.12 USD.', figures), false, 'a wrong rate is not accepted');
});

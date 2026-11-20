// Page fetching: readable text extraction, honest "cannot read this page" results, and the real Google
// Finance quote. (The failed "check on google.com" printed CSS because a truncated <style> was kept, and
// reported nothing usable because Google Search is a JavaScript redirect page.)
process.env.AMERB_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `amerb-fetch-${Date.now()}.sqlite`);
process.env.LOG_DIR = require('node:path').join(require('node:os').tmpdir(), `amerb-fetch-logs-${Date.now()}`);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripHtml, looksUnreadablePage, parseGoogleFinanceQuote, parseBogRates } = require('../server/tools');

test('a truncated page (cut inside a <style>) does not leak CSS as text', () => {
  // The reader stops at a byte cap, so a large page can end in the middle of a style block.
  const truncated = '<html><head><style>body{color:red}.a{margin:0}.b{padding:2px}';
  const text = stripHtml(truncated);
  assert.equal(text, '', `CSS leaked: ${text}`);
  assert.ok(!/\{[\s\S]*:[^;]*;/.test(text));
});

test('scripts, styles and comments are removed and entities are decoded', () => {
  const html =
    '<html><head><style>.x{color:red}</style><script>var a = "{\\"not\\": \\"text\\"}";</script></head>' +
    '<body><!-- hidden --><h1>Bank of Ghana &#8211; Monetary Policy</h1><p>Rate &amp; cedi&nbsp;note &#x2019;today</p></body></html>';
  const text = stripHtml(html);
  assert.equal(text, 'Bank of Ghana – Monetary Policy Rate & cedi note ’today');
  assert.ok(!text.includes('var a'));
  assert.ok(!text.includes('color:red'));
});

test('a JavaScript/redirect/consent page is reported as unreadable, real content is not', () => {
  assert.equal(looksUnreadablePage('Google Search Please click here if you are not redirected within a few seconds. If you are having trouble accessing Google Search, please click here.'), true);
  assert.equal(looksUnreadablePage('Please enable JavaScript to continue.'), true);
  assert.equal(
    looksUnreadablePage(
      'Bank of Ghana has kept its monetary policy rate at 11 percent following the November meeting of the Monetary Policy Committee. The committee said inflation remains within the target band and the cedi has been stable against the dollar over the period.'.repeat(2)
    ),
    false
  );
});

test('the Google Finance main quote is parsed from its label, not from a related-quote figure', () => {
  // A related quote appears first in the document; the pair's own figure follows its label.
  const html =
    '<div class="related"><span jsname="Pdsbrc"><span>1,049.19</span></span></div>' +
    '<div class="KycIzb"><div class="YTGvuc"><div class="gO24Ff">United States Dollar / Ghanaian Cedi</div></div>' +
    '<div class="LhDNu"><div class="zhtAvb"><div class="ujg0He"><div class="N6SYTe">' +
    '<span jsname="Pdsbrc" class=""><span>11.7666</span></span></div></div></div></div></div>';
  const quote = parseGoogleFinanceQuote(html);
  assert.deepEqual(quote, { label: 'United States Dollar / Ghanaian Cedi', rate: 11.7666 });

  // A page without the quote structure yields nothing rather than a wrong number.
  assert.equal(parseGoogleFinanceQuote('<html><body><p>No quote here</p></body></html>'), null);
});

test('the Bank of Ghana rates panel is parsed into the policy rate, T-bill and inflation target', () => {
  const html =
    '<div><h2 class="elementor-heading-title elementor-size-default"><a href="https://www.bog.gov.gh/monetary-policy/policy-rate-trends/">11.00</a></h2>' +
    '<h2 class="elementor-heading-title elementor-size-default"><a href="https://www.bog.gov.gh/monetary-policy/policy-rate-trends/">Current Monetary Policy Rate (%)</a></h2></div>' +
    '<div><h2 class="elementor-heading-title elementor-size-default"><a href="https://www.bog.gov.gh/treasury-and-the-markets/treasury-bill-rates/">4.5058</a></h2>' +
    '<h2 class="elementor-heading-title elementor-size-default"><a href="https://www.bog.gov.gh/treasury-and-the-markets/treasury-bill-rates/">91-Day Treasury Bill Rate (%)</a></h2></div>' +
    '<div><h2 class="elementor-heading-title elementor-size-default">8.0 ± 2</h2><h2 class="elementor-heading-title elementor-size-default">Inflation Target (%)</h2></div>';
  assert.deepEqual(parseBogRates(html), { policyRate: '11.00', treasuryBill91: '4.5058', inflationTarget: '8.0 ± 2' });
  // A page without the panel (or a restyle that loses the series links) yields nothing rather than a guess.
  assert.equal(parseBogRates('<html><body><p>No rates here</p></body></html>'), null);
});

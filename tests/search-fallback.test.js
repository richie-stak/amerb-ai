// Web-search fallback: DuckDuckGo's two endpoints first, Bing News RSS last. The news engine does not
// understand the "(site:a OR site:b)" form, so it gets the plain question and the approved-domain filter
// decides what may be shown. These tests use local stand-ins for all three endpoints.
process.env.AMERB_DB_PATH = require('node:path').join(require('node:os').tmpdir(), `amerb-search-${Date.now()}.sqlite`);
process.env.LOG_DIR = require('node:path').join(require('node:os').tmpdir(), `amerb-search-logs-${Date.now()}`);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let servers = [];
let tools;
let db;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}/`);
    });
  });
}

const BOT_PAGE = '<html><body>Unfortunately, bots use DuckDuckGo too. Please complete the anomaly check.</body></html>';
const NEWS_RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Bank of Ghana holds policy rate</title>
    <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fwww.bog.gov.gh%2fmonetary-policy%2f</link>
    <description>The Bank of Ghana kept its policy rate unchanged at its November meeting.</description></item>
  <item><title>Analysts react to the rate decision</title>
    <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fwww.graphic.com.gh%2fbusiness%2frates.html</link>
    <description>Analysts expect the cedi to stay stable.</description></item>
</channel></rss>`;

let newsState = 'ok';

before(async () => {
  const htmlUrl = await listen((req, res) => {
    res.writeHead(202, { 'Content-Type': 'text/html' });
    res.end(BOT_PAGE);
  });
  const liteUrl = await listen((req, res) => {
    res.writeHead(202, { 'Content-Type': 'text/html' });
    res.end(BOT_PAGE);
  });
  const newsUrl = await listen((req, res) => {
    if (newsState === 'down') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('down');
    }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    return res.end(NEWS_RSS);
  });

  process.env.AMERB_SEARCH_URL = htmlUrl;
  process.env.AMERB_SEARCH_LITE_URL = liteUrl;
  process.env.AMERB_BING_NEWS_URL = newsUrl;

  db = require('../server/db');
  const { setSetting } = require('../server/settings');
  setSetting('search_restricted', 'true');
  db.prepare("INSERT OR REPLACE INTO allowed_domains (domain) VALUES ('bog.gov.gh')").run();
  tools = require('../server/tools');
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
  }
  servers = [];
  try {
    db.close();
  } catch {
    /* already closed */
  }
});

test('when both DuckDuckGo endpoints refuse, the news fallback still answers — and restricted search keeps only approved domains', async () => {
  const { setSetting } = require('../server/settings');
  setSetting('search_restricted', 'true');
  const results = await tools.webSearch('Bank of Ghana monetary policy rate');
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.match(results[0].url, /bog\.gov\.gh/, 'only the approved domain is returned');
  assert.match(results[0].title, /policy rate/i);
  assert.match(results[0].snippet, /unchanged/i, 'the news snippet comes through');
});

test('with restriction off, the same fallback returns the open-web results too', async () => {
  const { setSetting } = require('../server/settings');
  setSetting('search_restricted', 'false');
  try {
    const results = await tools.webSearch('Bank of Ghana monetary policy rate');
    assert.equal(results.length, 2, JSON.stringify(results));
    assert.ok(results.some((r) => /graphic\.com\.gh/.test(r.url)));
    assert.ok(results.some((r) => /bog\.gov\.gh/.test(r.url)));
    // The link wrapper must be unwrapped to the publisher's address, never left as a bing.com redirect.
    assert.ok(results.every((r) => !/bing\.com/.test(r.url)));
  } finally {
    setSetting('search_restricted', 'true');
  }
});

test('when every engine fails, the error says what each one did', async () => {
  newsState = 'down';
  try {
    await assert.rejects(
      () => tools.webSearch('Bank of Ghana monetary policy rate'),
      (err) => {
        assert.match(err.message, /DuckDuckGo/);
        assert.match(err.message, /anti-bot/);
        assert.match(err.message, /Bing News/);
        assert.match(err.message, /SEARXNG_URL/);
        return true;
      }
    );
  } finally {
    newsState = 'ok';
  }
});

// Tests for the two fixes behind "what is the cedi to dollar rate?": a rate tool that actually
// answers it, and an honest report when a web search is refused by the provider (DuckDuckGo now
// answers this bank's server with an anti-bot page, which used to look like "no results").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startTestServer, makeClient } = require('./helpers/testServer');
const { startMockOllama } = require('./helpers/mockOllama');

let server;
let ollama;
let admin;
let rateService;
let searchService;

// A stand-in for the rate service (the same shape as open.er-api.com).
function startRateService() {
  const state = { requests: [], fail: false };
  const srv = http.createServer((req, res) => {
    state.requests.push(req.url);
    if (state.fail) {
      res.writeHead(503);
      return res.end('down');
    }
    if (state.invalidKey) {
      // exchangerate-api.com answers HTTP 200 with an error payload, not an HTTP error.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: 'error', 'error-type': 'invalid-key' }));
    }
    if (req.url.includes('/latest/USD')) {
      // exchangerate-api.com v6: base USD, conversion_rates, result/base_code fields.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          result: 'success',
          base_code: 'USD',
          time_last_update_utc: 'Fri, 20 Nov 2026 00:00:03 +0000',
          time_next_update_utc: 'Sat, 21 Nov 2026 00:00:03 +0000',
          conversion_rates: { USD: 1, GHS: 11.7835, EUR: 0.9108, GBP: 0.7624 },
        })
      );
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        result: 'success',
        base_code: 'GHS',
        time_last_update_utc: 'Wed, 19 Nov 2026 00:00:01 +0000',
        rates: { GHS: 1, USD: 0.0862, EUR: 0.0795, GBP: 0.0681 },
      })
    );
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${srv.address().port}/v6/latest/GHS`,
        state,
        stop: () =>
          new Promise((done) => {
            srv.closeAllConnections?.();
            srv.close(done);
          }),
      })
    );
  });
}

// A stand-in search provider that can behave like DuckDuckGo does on this bank's server: HTTP 202 and
// a bot-check page, with no results.
function startSearchService() {
  const state = { blocked: false, results: [] };
  const srv = http.createServer((req, res) => {
    if (state.blocked) {
      res.writeHead(202, { 'Content-Type': 'text/html' });
      return res.end('<html><body>Unfortunately, bots use DuckDuckGo too. Please complete the anomaly check.</body></html>');
    }
    const links = state.results
      .map((r) => `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}">${r.title}</a>`)
      .join('');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<html><body>${links}</body></html>`);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${srv.address().port}/html/`,
        state,
        stop: () =>
          new Promise((done) => {
            srv.closeAllConnections?.();
            srv.close(done);
          }),
      })
    );
  });
}

function parseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: /^data: (.*)$/m.exec(block)?.[1] }))
    .filter((e) => e.event)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}

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

async function chat(client, content) {
  const res = await client.post('/api/chat/stream', { model: 'good:latest', content });
  assert.equal(res.status, 200, await res.clone().text());
  return parseEvents(await res.text());
}

before(async () => {
  rateService = await startRateService();
  searchService = await startSearchService();
  // tools.js (used directly by the search tests) reads its endpoint when first required; set it before any
  // test requires it so these tests talk to the local stand-in rather than the real search engines.
  process.env.AMERB_SEARCH_URL = searchService.url;
  delete process.env.AMERB_SEARCH_LITE_URL;
  delete process.env.AMERB_BING_NEWS_URL;
  ollama = await startMockOllama({ models: ['good'] });
  server = await startTestServer({
    env: {
      OLLAMA_URL: ollama.url,
      DEFAULT_MODEL: 'good',
      AMERB_SEARCH_URL: searchService.url,
      // Not https:// in the test (the ticket's own address), taken from the setting instead.
      AMERB_DEFAULT_FALLBACK: 'off',
    },
  });
  admin = await signup('ratesadmin', 'IT');
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'ratesadmin'").run();
  db.close();
});

after(async () => {
  for (const stop of [() => ollama.stop(), () => searchService.stop(), () => rateService.stop(), () => server.stop()]) {
    try {
      await stop();
    } catch (err) {
      console.error('cleanup failed:', err.message);
    }
  }
});

test('exchange rates are off until an administrator enables them', async () => {
  const settings = await (await admin.get('/api/admin/settings')).json();
  assert.equal(settings.exchangeRateEnabled, false);

  // Point this process at the test database *before* loading any server module, so these checks never
  // touch the real data/amerb-ai.sqlite.
  process.env.AMERB_DB_PATH = server.dbPath;
  process.env.LOG_DIR = server.logDir;
  const tools = require('../server/tools');
  assert.ok(!tools.toolDefs().some((t) => t.function.name === 'exchange_rate'), 'the model is not offered a disabled tool');
  const result = await tools.executeTool('exchange_rate', { from: 'GHS', to: 'USD' }, { user: null });
  assert.match(result.text, /switched off/i);
});

test('once enabled, the rate tool answers with the rate, its date and its source', async () => {
  const saved = await admin.post('/api/admin/settings', {
    exchangeRateEnabled: true,
    exchangeRateUrl: rateService.url.replace('http://', 'https://'),
  });
  assert.equal(saved.status, 200);

  const tools = require('../server/tools');
  assert.ok(tools.toolDefs().some((t) => t.function.name === 'exchange_rate'), 'the tool is offered once enabled');

  // The test rate service is local http, so point the setting at it directly through the database
  // (the admin API only accepts https:// addresses, which is right for a real deployment).
  const db = server.openDb();
  db.prepare("UPDATE app_settings SET value = ? WHERE key = 'exchange_rate_url'").run(rateService.url);
  db.close();

  const result = await tools.executeTool('exchange_rate', { from: 'GHS', to: 'USD', amount: 1000 }, { user: null });
  assert.match(result.text, /1 GHS = 0\.086200 USD/);
  assert.match(result.text, /Wed, 19 Nov 2026/);
  assert.match(result.text, /127\.0\.0\.1/, 'the source is named');
  assert.match(result.text, /1000 GHS = 86\.20 USD/, 'the amount is converted');
  assert.equal(result.meta.exchangeRate.to, 'USD');

  // An unknown currency is refused instead of invented.
  const unknown = await tools.executeTool('exchange_rate', { from: 'GHS', to: 'XXX' }, { user: null });
  assert.match(unknown.text, /does not list XXX/);

  // A rate service that is down never produces a made-up rate. A different address is used so the
  // short-lived cache above cannot answer for it.
  const db2 = server.openDb();
  db2.prepare("UPDATE app_settings SET value = ? WHERE key = 'exchange_rate_url'").run(`${rateService.url}-down`);
  db2.close();
  rateService.state.fail = true;
  const failed = await tools.executeTool('exchange_rate', { from: 'GHS', to: 'USD' }, { user: null });
  assert.match(failed.text, /could not get an exchange rate/i);
  assert.match(failed.text, /Do not guess a rate/);
  rateService.state.fail = false;
});

test('a search provider that answers with a bot check is reported as a failure, not as "no results"', async () => {
  const tools = require('../server/tools');

  searchService.state.blocked = true;
  try {
    await assert.rejects(
      () => tools.webSearch('cedi to dollar rate'),
      (err) => {
        assert.match(err.message, /refused the request \(HTTP 202, anti-bot check\)/);
        assert.match(err.message, /SEARXNG_URL/);
        return true;
      }
    );
  } finally {
    searchService.state.blocked = false;
  }
});

test('a refused or empty search is shown to staff in the reply, with what actually went wrong', async () => {
  const user = await signup('ratesstaff');
  const db = server.openDb();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('web_search_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run();
  db.close();

  // The mock model calls web_search for a message that mentions "search" (see helpers/mockOllama.js),
  // and the provider then refuses the request the way DuckDuckGo does from this bank's server.
  searchService.state.blocked = true;
  try {
    const events = await chat(user, 'search for the current cedi dollar rate');
    const notice = events.find((e) => e.event === 'web-search-result');
    assert.ok(notice, `expected a web-search-result event, got: ${events.map((e) => e.event).join(',')}`);
    assert.deepEqual(notice.data.results, []);
    assert.match(notice.data.error, /refused the request|anti-bot/i);
    // The tool's own error is what the model was given, so it can say what happened.
    const answer = events.filter((e) => e.event === 'token').map((e) => e.data.delta).join('');
    assert.match(answer, /refused the request|anti-bot/i);
  } finally {
    searchService.state.blocked = false;
  }

  // With results, no warning block is shown and the answer uses them.
  searchService.state.results = [{ title: 'Bank of Ghana — rates', url: 'https://bog.gov.gh/rates' }];
  const ok = await chat(user, 'search for the current cedi dollar rate');
  assert.equal(ok.filter((e) => e.event === 'web-search-result').length, 0);
  const okAnswer = ok.filter((e) => e.event === 'token').map((e) => e.data.delta).join('');
  assert.match(okAnswer, /bog\.gov\.gh/);
});

test('answers a currency question even when the model refuses to call the tool', async () => {
  // Reproduces the live failure: with a conversation history containing its own "I don't have real-time
  // data access" answer, qwen3:4b-instruct stops calling exchange_rate and repeats the refusal. The mock
  // model never calls tools, which is exactly that behaviour. The rate must still reach the person.
  const db = server.openDb();
  const settings = db.prepare("SELECT value FROM app_settings WHERE key = 'exchange_rate_enabled'").get();
  if (!settings || settings.value !== 'true') {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('exchange_rate_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  }
  db.prepare("UPDATE app_settings SET value = ? WHERE key = 'exchange_rate_url'").run(rateService.url);
  db.close();

  const staff = await signup('rateasker');
  const events = await chat(staff, 'what is the current cedi to dollar conversion');

  const toolEvents = events.filter((e) => e.event === 'tool' && e.data.name === 'exchange_rate');
  assert.ok(toolEvents.length >= 1, 'the rate lookup happens server-side');
  assert.ok(toolEvents.some((e) => e.data.status === 'done'), 'and its result is shown');

  const answer = events
    .filter((e) => e.event === 'token')
    .map((e) => e.data.delta)
    .join('');
  assert.match(answer, /0\.0?862|86\.2|Current exchange rate/i, `the reply carries the rate (got: ${answer.slice(0, 200)})`);
  assert.ok(!/^\s*I (don't|do not) have real-time/i.test(answer.trim()), 'the reply does not stop at a refusal');

  // It is stored with the reply, so reopening the conversation does not lose it.
  const row = server.openDb().prepare('SELECT content FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE user_id = (SELECT id FROM users WHERE username = ?)) ORDER BY id DESC LIMIT 1').get('rateasker');
  assert.match(row.content, /0\.0?862|Current exchange rate/i);
});

test('answers a plain rate question at once, straight from the fetched rate', async () => {
  const db = server.openDb();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('exchange_rate_enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run();
  db.prepare("UPDATE app_settings SET value = ? WHERE key = 'exchange_rate_url'").run(rateService.url);
  db.close();

  const staff = await signup('ratefast');
  const events = await chat(staff, 'what is the current cedi to dollar conversion');
  const answer = events.filter((e) => e.event === 'token').map((e) => e.data.delta).join('');

  // The fetched fact is the whole reply: no waiting for a model to restate it (minutes on this bank's
  // CPU) and no chance of a "no real-time data" refusal.
  assert.match(answer, /\*\*Exchange rate\*\*/);
  assert.match(answer, /0\.0?862/);
  assert.match(answer, /Wed,|19 Nov 2026/);
  assert.match(answer, /127\.0\.0\.1/, 'the source is named');

  // A question that needs reasoning still goes to the model, with the rate handed to it as a fact.
  const reasoning = await chat(staff, 'convert 1000 cedis to dollars and explain whether that is a good rate for a loan');
  const reasoningAnswer = reasoning.filter((e) => e.event === 'token').map((e) => e.data.delta).join('');
  assert.ok(reasoning.filter((e) => e.event === 'tool' && e.data.name === 'exchange_rate').length >= 1, 'the rate was fetched');
  assert.match(reasoningAnswer, /0\.0?862|Current exchange rate/);
});

test('the bank-authorised API shape (USD base, conversion_rates) converts in both directions', async () => {
  const db = server.openDb();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('exchange_rate_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    rateService.url.replace('/v6/latest/GHS', '/v6/latest/USD')
  );
  db.close();

  const tools = require('../server/tools');
  const { text: usdToGhs, meta: m1 } = await tools.executeTool('exchange_rate', { from: 'USD', to: 'GHS' }, { user: null });
  assert.match(usdToGhs, /1 USD = 11\.783500 GHS/, usdToGhs);
  assert.match(usdToGhs, /Fri, 20 Nov 2026/, 'the publication time from the v6 response is used');
  assert.equal(m1.exchangeRate.rate, 11.7835);

  const { text: ghsToUsd } = await tools.executeTool('exchange_rate', { from: 'GHS', to: 'USD', amount: 1000 }, { user: null });
  assert.match(ghsToUsd, /1 GHS = 0\.084864 USD/, ghsToUsd);
  assert.match(ghsToUsd, /1000 GHS = 84\.86 USD/, 'the amount is converted with the correct direction');
  assert.ok(!/1 GHS = 11\.78/.test(ghsToUsd), 'the base rate is never returned the wrong way round');

  const { text: eur } = await tools.executeTool('exchange_rate', { from: 'GHS', to: 'EUR' }, { user: null });
  assert.match(eur, /0\.077295 EUR/, 'cross-rates are computed as a ratio of the two quoted rates');

  // Put the original address back for any later test.
  const db2 = server.openDb();
  db2.prepare("UPDATE app_settings SET value = ? WHERE key = 'exchange_rate_url'").run(rateService.url);
  db2.close();
});

test('a rejected API key is reported clearly instead of "no rates"', async () => {
  rateService.state.invalidKey = true;
  const db = server.openDb();
  db.prepare("UPDATE app_settings SET value = ? WHERE key = 'exchange_rate_url'").run(`${rateService.url}-invalid-key`);
  db.close();
  try {
    const { text: errorText } = await require('../server/tools').executeTool('exchange_rate', { from: 'GHS', to: 'USD' }, { user: null });
    assert.match(errorText, /rejected the API key/i, errorText);
    assert.match(errorText, /Do not guess a rate/);
  } finally {
    rateService.state.invalidKey = false;
    const db2 = server.openDb();
    db2.prepare("UPDATE app_settings SET value = ? WHERE key = 'exchange_rate_url'").run(rateService.url);
    db2.close();
  }
});

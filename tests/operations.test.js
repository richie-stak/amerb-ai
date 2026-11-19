// Operations: the health probe, the waiting line for the local model, per-person rate limits,
// fallback to another model when one fails, per-department default models, the model-quality
// report, and the admin-only status/log endpoints — all against a mock Ollama.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');
const { startMockOllama } = require('./helpers/mockOllama');

let server;
let ollama;
let admin;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Sends a chat message; resolves to { status, headers, events } with the whole stream read.
async function chat(client, content, { model = 'good:latest', conversationId } = {}) {
  const res = await client.post('/api/chat/stream', { model, content, ...(conversationId ? { conversationId } : {}) });
  const text = await res.text();
  const isStream = (res.headers.get('content-type') || '').includes('event-stream');
  return {
    status: res.status,
    headers: res.headers,
    body: isStream ? null : JSON.parse(text || '{}'),
    events: isStream ? parseEvents(text) : [],
  };
}

const replyText = (events) => events.filter((e) => e.event === 'token').map((e) => e.data.delta).join('');
const eventsOf = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);

before(async () => {
  ollama = await startMockOllama();
  server = await startTestServer({ env: { OLLAMA_URL: ollama.url, DEFAULT_MODEL: 'good', AMERB_DEFAULT_FALLBACK: 'on' } });
  admin = await signup('opsadmin', 'IT');
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'opsadmin'").run();
  db.close();
});

after(async () => {
  await server.stop();
  await ollama.stop();
});

test('/health needs no login and reports the app is up', async () => {
  const res = await makeClient(server.baseUrl).get('/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'ok');
  assert.ok(body.uptimeSeconds >= 0);
});

test('/health?deep=1 checks Ollama; a missing Ollama is "degraded", not a failure', async () => {
  const client = makeClient(server.baseUrl);
  let body = await (await client.get('/health?deep=1')).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.ollama, 'ok');

  ollama.setUp(false);
  try {
    const res = await client.get('/health?deep=1');
    assert.equal(res.status, 200, 'a supervisor must not restart the app just because Ollama is down');
    body = await res.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.ollama, 'unreachable');
    assert.equal((await client.get('/health?deep=1&strict=1')).status, 503);
  } finally {
    ollama.setUp(true);
  }
});

test('staff cannot use the operations, routing or quality endpoints', async () => {
  const staff = await signup('opsstaff');
  for (const path of ['/api/admin/operations/status', '/api/admin/operations/logs', '/api/admin/operations/limits', '/api/admin/routing', '/api/admin/quality']) {
    assert.equal((await staff.get(path)).status, 403, path);
  }
  assert.equal((await staff.post('/api/admin/routing', {})).status, 403);
});

test('the status endpoint reports the machine, Ollama, queue and storage', async () => {
  const status = await (await admin.get('/api/admin/operations/status')).json();
  assert.equal(status.ollama.reachable, true);
  assert.equal(status.ollama.version, '0.0.0-mock');
  assert.equal(status.ollama.installedModels, 5);
  assert.equal(status.ollama.loadedModels[0].name, 'good:latest');
  assert.equal(status.database.ok, true);
  assert.ok(status.machine.memoryTotalMb > 0);
  assert.ok(status.app.uptimeSeconds >= 0);
  assert.ok(status.storage.databaseBytes > 0);
  assert.equal(typeof status.queue.concurrency, 'number');
  assert.equal(typeof status.rateLimit.perMinute, 'number');
});

test('limits validate their input and are saved', async () => {
  const bad = await admin.post('/api/admin/operations/limits', { queueConcurrency: 0 });
  assert.equal(bad.status, 400);
  assert.equal((await admin.post('/api/admin/operations/limits', { rateLimitPerMinute: 'lots' })).status, 400);

  assert.equal((await admin.post('/api/admin/operations/limits', { queueConcurrency: 1, queuePerUser: 2, rateLimitPerMinute: 100 })).status, 200);
  const limits = await (await admin.get('/api/admin/operations/limits')).json();
  assert.equal(limits.queueConcurrency, 1);
  assert.equal(limits.queuePerUser, 2);
  assert.equal(limits.rateLimitPerMinute, 100);
});

// Waits until the server reports the queue in a given state, instead of sleeping a guessed number
// of milliseconds — on a busy machine (or under a parallel test run) fixed sleeps make these timing
// tests flaky, and the server already exposes exactly what is happening.
async function waitForQueue(predicate, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await (await admin.get('/api/admin/operations/status')).json()).queue;
    if (predicate(last)) return last;
    await sleep(50);
  }
  throw new Error(`the queue never reached the expected state — last seen: ${JSON.stringify(last)}`);
}

test('with one slot, people wait in line, are told their place, and only one model call runs at a time', async () => {
  await admin.post('/api/admin/operations/limits', { queueConcurrency: 1, queuePerUser: 2, rateLimitPerMinute: 100 });
  ollama.setDelay(2500);
  ollama.state.maxInFlight = 0;
  try {
    const [a, b, c] = [await signup('queue_a'), await signup('queue_b'), await signup('queue_c')];

    // Start them in a known order, waiting each time until the server says the line looks the way
    // it should, so the assertions below don't depend on how fast this machine happens to be.
    const runs = [chat(a, 'question 0')];
    await waitForQueue((q) => q.active === 1);
    runs.push(chat(b, 'question 1'));
    await waitForQueue((q) => q.waiting === 1);
    runs.push(chat(c, 'question 2'));
    await waitForQueue((q) => q.waiting === 2);

    const results = await Promise.all(runs);
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(replyText(r.events), 'Hello from good');
    }
    assert.equal(ollama.state.maxInFlight, 1, 'the model must never be asked to do two things at once');

    assert.equal(eventsOf(results[0].events, 'queue').length, 0, 'the first person never waits');
    const second = eventsOf(results[1].events, 'queue');
    assert.equal(second[0].state, 'waiting');
    assert.equal(second[0].position, 1);
    assert.equal(second.at(-1).state, 'running');
    const third = eventsOf(results[2].events, 'queue');
    assert.equal(third[0].position, 2);
    assert.ok(third.some((e) => e.state === 'waiting' && e.position === 1), 'their place improves as the line moves');
    assert.ok(third[0].etaSeconds >= 1);
  } finally {
    ollama.setDelay(0);
  }
  await waitForQueue((q) => q.active === 0 && q.waiting === 0);
});

test('one person cannot have more messages going than the per-person limit', async () => {
  await admin.post('/api/admin/operations/limits', { queueConcurrency: 1, queuePerUser: 2, rateLimitPerMinute: 100 });
  ollama.setDelay(2500);
  try {
    const user = await signup('greedy');
    const runs = [chat(user, 'one')];
    await waitForQueue((q) => q.active === 1);
    runs.push(chat(user, 'two'));
    await waitForQueue((q) => q.waiting === 1);

    const third = await chat(user, 'three');
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'per_user_limit');
    assert.match(third.body.error, /already have 2 messages/);

    const done = await Promise.all(runs);
    assert.ok(done.every((r) => r.status === 200));

    // A refused message must not leave a conversation behind.
    const { conversations } = await (await user.get('/api/conversations')).json();
    assert.equal(conversations.length, 2);
  } finally {
    ollama.setDelay(0);
  }
});

test('someone who closes the page while waiting leaves the line', async () => {
  await admin.post('/api/admin/operations/limits', { queueConcurrency: 1, queuePerUser: 2, rateLimitPerMinute: 100 });
  ollama.setDelay(2500);
  try {
    const holder = await signup('holder');
    const leaver = await signup('leaver');
    const first = chat(holder, 'hold the slot');
    await waitForQueue((q) => q.active === 1);

    // makeClient has no abort support, so talk to the server directly with the same cookie.
    const controller = new AbortController();
    const res = await fetch(`${server.baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: leaver.getCookie() },
      body: JSON.stringify({ model: 'good:latest', content: 'I will leave' }),
      signal: controller.signal,
    });
    await waitForQueue((q) => q.waiting === 1);

    controller.abort();
    await res.body?.cancel().catch(() => {});
    await waitForQueue((q) => q.waiting === 0);
    await first;
  } finally {
    ollama.setDelay(0);
  }
  await waitForQueue((q) => q.active === 0 && q.waiting === 0);
});

test('the per-minute rate limit refuses with 429 and says when to retry', async () => {
  await admin.post('/api/admin/operations/limits', { queueConcurrency: 2, rateLimitPerMinute: 2 });
  const user = await signup('chatty');
  assert.equal((await chat(user, 'a')).status, 200);
  assert.equal((await chat(user, 'b')).status, 200);
  const third = await chat(user, 'c');
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'rate_limited');
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
  assert.match(third.body.error, /2 messages a minute/);

  // Other people aren't affected.
  const other = await signup('quiet');
  assert.equal((await chat(other, 'hello')).status, 200);

  // Turning the limit off lets them through again.
  await admin.post('/api/admin/operations/limits', { rateLimitPerMinute: 0 });
  assert.equal((await chat(user, 'd')).status, 200);
});

test('a failing model falls back to the next one in the admin list, and the answer records both', async () => {
  await admin.post('/api/admin/operations/limits', { queueConcurrency: 2, rateLimitPerMinute: 0 });
  const saved = await admin.post('/api/admin/routing', { fallbackModels: ['backup:latest'], fallbackEnabled: true });
  assert.equal(saved.status, 200);

  const user = await signup('fallbacker');
  const r = await chat(user, 'please answer', { model: 'broken:latest' });
  assert.equal(r.status, 200);
  const [fb] = eventsOf(r.events, 'fallback');
  assert.equal(fb.from, 'broken:latest');
  assert.equal(fb.to, 'backup:latest');
  assert.match(fb.reason, /failed to load/);
  assert.equal(replyText(r.events), 'Hello from backup');
  assert.equal(eventsOf(r.events, 'error').length, 0);

  const db = server.openDb();
  const row = db.prepare("SELECT model, fallback_from, duration_ms FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1").get();
  db.close();
  assert.equal(row.model, 'backup:latest');
  assert.equal(row.fallback_from, 'broken:latest');
  assert.ok(row.duration_ms >= 0);
});

test('when every fallback fails, or fallback is off, the person gets a clear error', async () => {
  const user = await signup('nofallback');
  await admin.post('/api/admin/routing', { fallbackEnabled: false });
  let r = await chat(user, 'hello', { model: 'broken:latest' });
  assert.equal(eventsOf(r.events, 'fallback').length, 0);
  assert.match(eventsOf(r.events, 'error')[0].error, /failed to load/);

  // Enabled, but the only fallbacks are themselves broken.
  await admin.post('/api/admin/routing', { fallbackModels: ['broken:latest'], fallbackEnabled: true });
  r = await chat(user, 'hello again', { model: 'broken:latest' });
  // DEFAULT_MODEL ("good") is always the last resort, so this one still succeeds.
  assert.equal(replyText(r.events), 'Hello from good');
  assert.equal(eventsOf(r.events, 'fallback').at(-1).to, 'good');
});

test('a model that fails halfway through a reply is not swapped for another (no spliced answers)', async () => {
  await admin.post('/api/admin/routing', { fallbackModels: ['backup:latest'], fallbackEnabled: true });
  const user = await signup('halfway');
  const r = await chat(user, 'tell me something', { model: 'midfail:latest' });
  assert.equal(eventsOf(r.events, 'fallback').length, 0);
  assert.ok(replyText(r.events).startsWith('Hello'));
  assert.equal(eventsOf(r.events, 'error').length, 1);
});

test('routing settings reject models and departments that do not exist', async () => {
  let res = await admin.post('/api/admin/routing', { fallbackModels: ['nonexistent:latest'] });
  assert.equal(res.status, 400);
  res = await admin.post('/api/admin/routing', { departmentModels: { Credit: 'nonexistent:latest' } });
  assert.equal(res.status, 400);
  res = await admin.post('/api/admin/routing', { departmentModels: { Gardening: 'good:latest' } });
  assert.equal(res.status, 400);
});

test("a department's default model is what its staff start on", async () => {
  const credit = await signup('creditperson', 'Credit');
  const hr = await signup('hrperson', 'HR');
  assert.equal((await (await credit.get('/api/models')).json()).defaultModel, 'good:latest');

  const res = await admin.post('/api/admin/routing', { departmentModels: { Credit: 'backup:latest' } });
  assert.equal(res.status, 200);
  const creditModels = await (await credit.get('/api/models')).json();
  assert.equal(creditModels.defaultModel, 'backup:latest');
  assert.equal(creditModels.departmentDefault, true);
  assert.equal((await (await hr.get('/api/models')).json()).defaultModel, 'good:latest', 'other departments are unchanged');

  const routing = await (await admin.get('/api/admin/routing')).json();
  assert.equal(routing.departmentModels.Credit, 'backup:latest');
  assert.ok(routing.departments.includes('Credit'));
  assert.ok(routing.models.some((m) => m.name === 'backup:latest'));

  await admin.post('/api/admin/routing', { departmentModels: { Credit: '' } });
  assert.equal((await (await credit.get('/api/models')).json()).defaultModel, 'good:latest', 'cleared = back to the global default');
});

test('the quality report turns thumbs up/down into per-model approval and flags weak models', async () => {
  await admin.post('/api/admin/routing', { fallbackModels: [], fallbackEnabled: false });
  const user = await signup('rater', 'Finance');

  // 12 answers from "backup": 3 up, 9 down -> 25% approval, enough ratings to judge. 12 from "good": all up.
  async function rate(model, rating, n) {
    for (let i = 0; i < n; i++) {
      const r = await chat(user, `question for ${model} ${i}`, { model });
      const done = eventsOf(r.events, 'done')[0];
      const meta = eventsOf(r.events, 'meta')[0];
      const res = await user.patch(`/api/conversations/${meta.conversationId}/messages/${done.messageId}/feedback`, { rating });
      assert.equal(res.status, 200);
    }
  }
  await rate('backup:latest', 'down', 9);
  await rate('backup:latest', 'up', 3);
  await rate('good:latest', 'up', 12);

  const report = await (await admin.get('/api/admin/quality')).json();
  const backup = report.models.find((m) => m.model === 'backup:latest');
  const good = report.models.find((m) => m.model === 'good:latest');
  assert.equal(backup.up, 3);
  assert.equal(backup.down, 9);
  assert.equal(backup.verdict, 'review');
  assert.equal(good.verdict, 'good');
  assert.equal(good.approval, 1);
  assert.ok(good.score > backup.score);

  // Finance's best-rated model differs from the default, so it is suggested.
  const suggestion = report.suggestions.find((s) => s.department === 'Finance');
  assert.equal(suggestion.suggested, 'good:latest');

  assert.ok(report.recentDownvotes.length >= 9);
  assert.match(report.recentDownvotes[0].question, /question for backup/);
  assert.equal(report.recentDownvotes[0].model, 'backup:latest');
});

test('the structured log records model failures and can be read back by an admin', async () => {
  const { entries, file } = await (await admin.get('/api/admin/operations/logs?level=warn')).json();
  assert.ok(file.endsWith('amerb-ai.log'));
  const fallbackEntry = entries.find((e) => e.msg === 'Model failed — falling back');
  assert.ok(fallbackEntry, 'the fallback should be logged as a warning');
  assert.equal(fallbackEntry.from, 'broken:latest');
  assert.equal(fallbackEntry.level, 'warn');
  assert.ok(Date.parse(fallbackEntry.t));
  assert.ok(entries.some((e) => e.msg === 'Rate limit hit'));

  const filtered = await (await admin.get('/api/admin/operations/logs?level=warn&q=Rate%20limit')).json();
  assert.ok(filtered.entries.length >= 1 && filtered.entries.every((e) => JSON.stringify(e).includes('Rate limit')));
});

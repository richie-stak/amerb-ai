// Regression tests for the 19–20 Nov 2026 log issues: document preview 400s on an image, provider
// configuration errors that said nothing useful, and 401 responses that could not be told apart from
// other failures.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');
const { startMockOllama } = require('./helpers/mockOllama');

let server;
let ollama;
let admin;
let staff;

// A real 1×1 PNG, so the stored document is an image the browser can render.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function signup(client, username, department = 'Credit') {
  const res = await client.post('/api/auth/signup', {
    username,
    email: `${username}@amenfimanbank.com`,
    password: 'password12345',
    department,
  });
  assert.equal(res.status, 200, await res.clone().text());
}

before(async () => {
  ollama = await startMockOllama({ models: ['good', 'nomic-embed-text'] });
  server = await startTestServer({ env: { OLLAMA_URL: ollama.url, DEFAULT_MODEL: 'good', AMERB_DEFAULT_FALLBACK: 'off' } });
  admin = makeClient(server.baseUrl);
  await signup(admin, 'remediation.admin', 'IT');
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'remediation.admin'").run();
  db.close();
  staff = makeClient(server.baseUrl);
  await signup(staff, 'remediation.staff');
});

after(async () => {
  for (const stop of [() => ollama.stop(), () => server.stop()]) {
    try {
      await stop();
    } catch (err) {
      console.error('cleanup failed:', err.message);
    }
  }
});

test('an uploaded image can be previewed instead of failing with 400', async () => {
  const upload = await staff.upload('/api/documents', [{ name: 'chatbot-logo.png', content: PNG_1PX }], { scope: 'personal' });
  const body = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(body));
  const id = body.results[0]?.id;
  assert.ok(id, JSON.stringify(body));

  // The exact request from the log: GET /api/documents/<id>/preview.
  const preview = await staff.get(`/api/documents/${id}/preview`);
  assert.equal(preview.status, 200, 'an image has a preview now');
  const data = await preview.json();
  assert.equal(data.type, 'image');
  assert.equal(data.url, `/api/documents/${id}/image`);
  assert.equal(data.filename, 'chatbot-logo.png');

  // And the file it points at really is the image.
  const image = await staff.get(data.url);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('an unknown document kind is reported as such, never as a bare 400 with no reason', async () => {
  const upload = await staff.upload('/api/documents', [{ name: 'readme.txt', content: 'plain text' }], {});
  const id = (await upload.json()).results[0].id;
  const preview = await staff.get(`/api/documents/${id}/preview`);
  assert.equal(preview.status, 200);
  const data = await preview.json();
  assert.equal(data.type, 'text');
  assert.match(data.text, /plain text/);
});

test('a provider that cannot be reached is reported with the reason and a hint', async () => {
  const res = await admin.post('/api/admin/providers', {
    type: 'custom',
    name: 'Broken provider',
    apiKey: 'sk-not-a-real-key',
    baseUrl: 'https://127.0.0.1:1/v1',
  });
  assert.equal(res.status, 400, 'a failed connection check is still a client-actionable error');
  const body = await res.json();
  assert.match(body.error, /Could not connect to/, 'the provider is named in the message');
  assert.ok(body.details, 'structured details are attached');
  assert.equal(body.details.baseUrl, 'https://127.0.0.1:1/v1');
  assert.match(body.details.hint, /could not reach/i, 'the hint says what to check');
  // Never echo the key back.
  assert.ok(!JSON.stringify(body).includes('sk-not-a-real-key'));
});

test('an unauthenticated request says the session ended, in a way the UI can act on', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.get('/api/documents');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, 'unauthenticated');
  assert.equal(body.sessionExpired, true);
  // Authentication itself is unchanged: the data is not served.
  assert.equal(res.headers.get('content-length') !== undefined, true);
});

test('a client error keeps its explanation (not an opaque 500)', async () => {
  const res = await staff.post('/api/chat/stream', { model: 'nomic-embed-text:latest', content: 'hello there' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'model_role_mismatch');
  assert.match(body.error, /embedding model/i);
});

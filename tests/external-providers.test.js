// External AI providers end to end, against local mock OpenAI-style and Anthropic servers: an
// admin connects one (bad keys rejected, keys never exposed or stored in plain text), enables
// models, and staff chat with them — streaming, tool calls and all — through the same chat API
// used for local models.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, makeClient } = require('./helpers/testServer');
const { startMockProviders } = require('./helpers/mockProviders');

let server;
let mock;
let admin;
let staff;
const ids = {};

// Sends a chat message and returns the parsed SSE events.
async function chat(client, model, content) {
  const res = await client.post('/api/chat/stream', { model, content });
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: /^data: (.*)$/m.exec(block)?.[1] }))
    .filter((e) => e.event)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}

const replyText = (events) => events.filter((e) => e.event === 'token').map((e) => e.data.delta).join('');

before(async () => {
  mock = await startMockProviders();
  server = await startTestServer();
  admin = makeClient(server.baseUrl);
  staff = makeClient(server.baseUrl);
  for (const [client, username] of [[admin, 'extadmin'], [staff, 'extstaff']]) {
    await client.post('/api/auth/signup', {
      username,
      email: `${username}@amenfimanbank.com`,
      password: 'password123',
      department: 'Credit',
    });
  }
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'extadmin'").run();
  db.close();
});

after(async () => {
  await server.stop();
  await mock.stop();
});

test('staff cannot see or manage providers', async () => {
  assert.equal((await staff.get('/api/admin/providers')).status, 403);
  assert.equal((await staff.post('/api/admin/providers', { type: 'custom', apiKey: 'x', baseUrl: mock.openAiUrl })).status, 403);
});

test('a wrong API key is rejected before anything is saved', async () => {
  const res = await admin.post('/api/admin/providers', { type: 'deepseek', apiKey: 'sk-wrong', baseUrl: mock.openAiUrl });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Incorrect API key/);
  const { providers } = await (await admin.get('/api/admin/providers')).json();
  assert.equal(providers.length, 0);
});

test('connecting lists the models, and the key is never returned or stored in plain text', async () => {
  const res = await admin.post('/api/admin/providers', {
    type: 'openai',
    name: 'Mock OpenAI',
    apiKey: mock.GOOD_KEY,
    baseUrl: `${mock.openAiUrl}/`,
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes(mock.GOOD_KEY), 'key must not be echoed back');
  const { provider } = JSON.parse(raw);
  ids.openai = provider.id;
  // OpenAI's non-chat models (embeddings etc.) are filtered out of the list.
  assert.deepEqual(provider.availableModels, ['mock-gpt']);
  assert.equal(provider.keyHint, 'sk-…3456');

  const db = server.openDb();
  const stored = db.prepare('SELECT api_key_enc FROM ai_providers WHERE id = ?').get(ids.openai).api_key_enc;
  db.close();
  assert.ok(!stored.includes(mock.GOOD_KEY));
});

test('a model only reaches the staff model picker once an admin enables it', async () => {
  let { models } = await (await staff.get('/api/models')).json();
  assert.ok(!models.some((m) => m.external));

  const bad = await admin.patch(`/api/admin/providers/${ids.openai}`, { enabledModels: ['not-a-model'] });
  assert.equal(bad.status, 400);
  await admin.patch(`/api/admin/providers/${ids.openai}`, { enabledModels: ['mock-gpt'] });

  ({ models } = await (await staff.get('/api/models')).json());
  const ext = models.find((m) => m.external);
  assert.equal(ext.name, `ext/${ids.openai}/mock-gpt`);
  assert.equal(ext.label, 'Mock OpenAI · mock-gpt');
});

test('chatting with an OpenAI-style model streams its reply', async () => {
  const events = await chat(staff, `ext/${ids.openai}/mock-gpt`, 'Hi there');
  assert.equal(replyText(events), 'Hello from mock OpenAI');
  assert.ok(events.some((e) => e.event === 'thinking'), 'reasoning_content is shown as thinking');
  const sent = mock.requests.openai[0];
  assert.equal(sent.model, 'mock-gpt');
  assert.ok(sent.messages[0].role === 'system' && /AMERB AI/.test(sent.messages[0].content), 'gets the AMERB AI system prompt');
  assert.ok(sent.tools.some((t) => t.function.name === 'run_code'), 'tools are offered');
});

test('an OpenAI-style model can call a tool and use its result', async () => {
  mock.requests.openai.length = 0;
  const events = await chat(staff, `ext/${ids.openai}/mock-gpt`, 'Please calculate six times seven');
  const tool = events.find((e) => e.event === 'tool' && e.data.status === 'done');
  assert.equal(tool.data.name, 'run_code');
  assert.equal(tool.data.result.trim(), '42');
  assert.equal(replyText(events), 'The answer is 42');

  const followUp = mock.requests.openai[1];
  const assistantTurn = followUp.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  const toolTurn = followUp.messages.find((m) => m.role === 'tool');
  assert.equal(assistantTurn.tool_calls[0].id, 'call_abc');
  assert.equal(JSON.parse(assistantTurn.tool_calls[0].function.arguments).code, '6 * 7');
  assert.equal(toolTurn.tool_call_id, 'call_abc', 'the result refers back to the call');
});

test('Claude models work through the Anthropic adapter, including tool use', async () => {
  const res = await admin.post('/api/admin/providers', { type: 'anthropic', apiKey: mock.GOOD_KEY, baseUrl: mock.anthropicUrl });
  ids.anthropic = (await res.json()).provider.id;
  await admin.patch(`/api/admin/providers/${ids.anthropic}`, { enabledModels: ['claude-mock'] });
  const model = `ext/${ids.anthropic}/claude-mock`;

  assert.equal(replyText(await chat(staff, model, 'Hello')), 'Hello from mock Claude');
  const first = mock.requests.anthropic[0];
  assert.match(first.system, /AMERB AI/, 'system messages become the top-level system prompt');
  assert.ok(first.messages.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.ok(first.tools.some((t) => t.name === 'run_code' && t.input_schema), 'tools converted to Claude format');

  mock.requests.anthropic.length = 0;
  const events = await chat(staff, model, 'calculate ten plus five');
  assert.equal(events.find((e) => e.event === 'tool' && e.data.status === 'done').data.result.trim(), '15');
  assert.equal(replyText(events), 'Let me work that out.\n\nClaude says 15');
  const followUp = mock.requests.anthropic[1];
  const assistant = followUp.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant.content.some((b) => b.type === 'tool_use' && b.id === 'toolu_1' && b.input.code === '10 + 5'));
  const results = followUp.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
  assert.equal(results[0].tool_use_id, 'toolu_1');
});

test('disabling a provider removes its models and refuses further chats with them', async () => {
  await admin.patch(`/api/admin/providers/${ids.openai}`, { enabled: false });
  const { models } = await (await staff.get('/api/models')).json();
  assert.ok(!models.some((m) => m.name.startsWith(`ext/${ids.openai}/`)));

  const events = await chat(staff, `ext/${ids.openai}/mock-gpt`, 'Hi');
  const error = events.find((e) => e.event === 'error');
  assert.match(error.data.error, /no longer available/);
});

test('removing a provider deletes it', async () => {
  assert.equal((await admin.delete(`/api/admin/providers/${ids.openai}`)).status, 200);
  const { providers } = await (await admin.get('/api/admin/providers')).json();
  assert.ok(!providers.some((p) => p.id === ids.openai));
});

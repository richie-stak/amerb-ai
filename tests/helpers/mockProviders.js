// A stand-in for external AI providers, speaking just enough of OpenAI's Chat Completions and
// Anthropic's Messages streaming formats to exercise the app's adapters end to end — without a
// real API key, network access, or cost. Every request body is recorded for assertions.
const http = require('node:http');

const GOOD_KEY = 'sk-test-good-key-123456';

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const line of events) res.write(line);
  res.end();
}

// The mock calls the calculator when asked to "calculate", and otherwise just says hello; after a
// tool result comes back it reports it. That covers plain streaming and a full tool round-trip.
function openAiReply(body) {
  const toolResult = body.messages.find((m) => m.role === 'tool');
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content : lastUser?.content?.[0]?.text || '';
  const chunk = (delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;

  if (toolResult) return [chunk({ content: 'The answer is ' }), chunk({ content: toolResult.content.trim() }), 'data: [DONE]\n\n'];
  if (/calculate/i.test(lastText) && body.tools) {
    return [
      chunk({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'run_code', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"code":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"6 * 7"}' } }] }),
      'data: [DONE]\n\n',
    ];
  }
  return [chunk({ reasoning_content: 'thinking...' }), chunk({ content: 'Hello from ' }), chunk({ content: 'mock OpenAI' }), 'data: [DONE]\n\n'];
}

function anthropicReply(body) {
  const ev = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  const blocks = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const toolResult = blocks.find((b) => b.type === 'tool_result');
  const lastUser = body.messages[body.messages.length - 1];
  const lastText = (Array.isArray(lastUser.content) ? lastUser.content : []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');

  if (toolResult) {
    return [
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Claude says ${String(toolResult.content).trim()}` } }),
      ev({ type: 'message_stop' }),
    ];
  }
  if (/calculate/i.test(lastText) && body.tools) {
    return [
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me work that out.' } }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_code', input: {} } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"code": "10' } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' + 5"}' } }),
      ev({ type: 'message_stop' }),
    ];
  }
  return [
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from mock Claude' } }),
    ev({ type: 'message_stop' }),
  ];
}

async function startMockProviders() {
  const requests = { openai: [], anthropic: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const unauthorized = () => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      };

      if (req.url.startsWith('/openai/')) {
        if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return unauthorized();
        if (req.method === 'GET' && req.url === '/openai/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: 'mock-gpt' }, { id: 'text-embedding-3-small' }] }));
        }
        if (req.method === 'POST' && req.url === '/openai/chat/completions') {
          requests.openai.push(body);
          return sse(res, openAiReply(body));
        }
      }

      if (req.url.startsWith('/anthropic/')) {
        if (req.headers['x-api-key'] !== GOOD_KEY) return unauthorized();
        if (req.method === 'GET' && req.url.startsWith('/anthropic/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: 'claude-mock' }] }));
        }
        if (req.method === 'POST' && req.url === '/anthropic/messages') {
          requests.anthropic.push(body);
          return sse(res, anthropicReply(body));
        }
      }

      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    openAiUrl: `${base}/openai`,
    anthropicUrl: `${base}/anthropic`,
    requests,
    GOOD_KEY,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startMockProviders };

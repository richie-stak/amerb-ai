// Anthropic's Messages API (Claude models).
const { forEachLine, responseError, imageMediaType } = require('./sse');

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

function headers(apiKey) {
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
}

async function listModels({ baseUrl, apiKey }) {
  const r = await fetch(`${baseUrl}/models?limit=100`, { headers: headers(apiKey), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw await responseError(r, 'Anthropic');
  const data = await r.json();
  return (data.data || []).map((m) => m.id).filter((id) => typeof id === 'string');
}

function toBlocks(content) {
  return typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : content;
}

// The app's messages interleave system notes (search results, corrections) with the conversation,
// and send tool results as their own role. Claude takes one system prompt, strictly alternating
// user/assistant turns, and tool results inside a user turn — so convert and merge accordingly.
function toAnthropic(messages) {
  const systemParts = [];
  const turns = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = [...toBlocks(last.content), ...blocks];
    else turns.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '(no output)' }]);
    } else if (m.role === 'assistant') {
      const blocks = toBlocks(m.content || '');
      for (const call of m.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: call.function.arguments || {} });
      }
      push('assistant', blocks);
    } else {
      const images = (m.images || []).map((b64) => ({ type: 'image', source: { type: 'base64', media_type: imageMediaType(b64), data: b64 } }));
      push('user', [...images, ...toBlocks(m.content || '')]);
    }
  }
  // A conversation must open with a user turn.
  if (turns.length && turns[0].role !== 'user') turns.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing the conversation)' }] });
  return { system: systemParts.join('\n\n'), messages: turns };
}

async function streamChat({ baseUrl, apiKey, model, messages, tools, maxTokens, signal, onContent }) {
  const { system, messages: turns } = toAnthropic(messages);
  const body = { model, messages: turns, max_tokens: maxTokens || DEFAULT_MAX_TOKENS, stream: true };
  if (system) body.system = system;
  if (tools) {
    body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  }

  const r = await fetch(`${baseUrl}/messages`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal });
  if (!r.ok || !r.body) throw await responseError(r, 'Anthropic');

  let content = '';
  const blocks = new Map(); // index -> { id, name, json } for tool_use blocks
  await forEachLine(r, (line) => {
    if (!line.startsWith('data:')) return;
    const event = JSON.parse(line.slice(5).trim());
    if (event.type === 'error') throw new Error(event.error?.message || 'Anthropic stream error');
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      blocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        content += event.delta.text;
        onContent(event.delta.text);
      } else if (event.delta?.type === 'input_json_delta') {
        const block = blocks.get(event.index);
        if (block) block.json += event.delta.partial_json;
      }
    }
  });

  const toolCalls = [...blocks.values()].map((b) => {
    let args = {};
    try {
      args = b.json ? JSON.parse(b.json) : {};
    } catch {
      /* malformed arguments — run the tool with none rather than failing the whole reply */
    }
    return { id: b.id, function: { name: b.name, arguments: args } };
  });
  return { content, thinking: '', toolCalls };
}

module.exports = { listModels, streamChat };

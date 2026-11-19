// Local models via Ollama. The app's internal message format *is* Ollama's, so messages go
// through as they are.
const { OLLAMA_URL, ollamaRuntime } = require('../ollama');
const { forEachLine, responseError } = require('./sse');

async function streamChat({ model, messages, tools, think, maxTokens, signal, onThinking, onContent }) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      // Ollama doesn't know the ids the app gives tool calls; it matches tool results by name.
      messages: messages.map(({ tool_call_id, ...m }) => m),
      stream: true,
      ...(tools ? { tools } : {}),
      ...(think !== undefined ? { think } : {}),
      ...ollamaRuntime(maxTokens ? { num_predict: maxTokens } : {}),
    }),
    signal,
  });
  if (!r.ok || !r.body) throw await responseError(r, 'Ollama');

  let content = '';
  let thinking = '';
  const toolCalls = [];
  await forEachLine(r, (line) => {
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.message?.thinking) {
      thinking += chunk.message.thinking;
      onThinking(chunk.message.thinking);
    }
    if (chunk.message?.content) {
      content += chunk.message.content;
      onContent(chunk.message.content);
    }
    if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
  });
  return { content, thinking, toolCalls };
}

async function listModels() {
  // One retry: this is a cheap, idempotent GET, and the connection can be dropped by a keep-alive
  // socket the server closed a moment earlier ("other side closed") — which used to make the model
  // picker and the capability-test screen claim the model list was empty for no reason.
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`);
      if (!r.ok) throw await responseError(r, 'Ollama');
      const data = await r.json();
      return (data.models || []).map((m) => ({
        name: m.name,
        vision: (m.capabilities || []).includes('vision'),
        tools: (m.capabilities || []).includes('tools'),
        thinking: (m.capabilities || []).includes('thinking'),
      }));
    } catch (err) {
      if (attempt >= 1 || !/fetch failed|other side closed|ECONNRESET/i.test(`${err.message} ${err.cause?.code || ''}`)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

module.exports = { streamChat, listModels };

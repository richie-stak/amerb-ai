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
  const r = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!r.ok) throw await responseError(r, 'Ollama');
  const data = await r.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    vision: (m.capabilities || []).includes('vision'),
    tools: (m.capabilities || []).includes('tools'),
    thinking: (m.capabilities || []).includes('thinking'),
  }));
}

module.exports = { streamChat, listModels };

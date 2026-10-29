// OpenAI's Chat Completions API — also spoken by DeepSeek and most other hosted providers
// (Groq, Mistral, OpenRouter, Together, ...), which is why "Other (OpenAI-compatible)" works too.
const { forEachLine, responseError, imageMediaType, parseArguments } = require('./sse');

// OpenAI's /models lists everything on the account, including embedding, audio and image models
// that can't hold a conversation — hide those so the admin only picks from chat models.
const NON_CHAT_MODEL = /(embed|whisper|tts|dall-e|moderation|davinci|babbage|transcribe|realtime|audio|image|search|sora)/i;

function headers(apiKey) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

async function listModels({ baseUrl, apiKey, filterNonChat }) {
  const r = await fetch(`${baseUrl}/models`, { headers: headers(apiKey), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw await responseError(r, 'The provider');
  const data = await r.json();
  return (data.data || [])
    .map((m) => m.id)
    .filter((id) => typeof id === 'string' && !(filterNonChat && NON_CHAT_MODEL.test(id)))
    .sort();
}

function toOpenAiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content || '' };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments || {}) },
        })),
      };
    }
    if (m.images?.length) {
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content || '' },
          ...m.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:${imageMediaType(b64)};base64,${b64}` } })),
        ],
      };
    }
    return { role: m.role, content: m.content || '' };
  });
}

async function streamChat({ baseUrl, apiKey, model, messages, tools, maxTokens, isOpenAi, signal, onThinking, onContent }) {
  const body = { model, messages: toOpenAiMessages(messages), stream: true };
  if (tools) body.tools = tools;
  // OpenAI's newer models reject max_tokens in favour of max_completion_tokens; most compatible
  // providers (DeepSeek included) only understand max_tokens.
  if (maxTokens) body[isOpenAi ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;

  const r = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal });
  if (!r.ok || !r.body) throw await responseError(r, 'The provider');

  let content = '';
  let thinking = '';
  const callsByIndex = new Map();
  await forEachLine(r, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    const chunk = JSON.parse(payload);
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    // DeepSeek's reasoner streams its reasoning as reasoning_content; OpenRouter calls it reasoning.
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) {
      thinking += reasoning;
      onThinking(reasoning);
    }
    if (delta.content) {
      content += delta.content;
      onContent(delta.content);
    }
    // Tool calls stream in fragments keyed by index: the id and name first, then the JSON
    // arguments a few characters at a time.
    for (const part of delta.tool_calls || []) {
      const entry = callsByIndex.get(part.index ?? 0) || { id: null, name: '', args: '' };
      if (part.id) entry.id = part.id;
      if (part.function?.name) entry.name += part.function.name;
      if (part.function?.arguments) entry.args += part.function.arguments;
      callsByIndex.set(part.index ?? 0, entry);
    }
  });

  const toolCalls = [...callsByIndex.values()].map((c) => ({ id: c.id, function: { name: c.name, arguments: parseArguments(c.args) } }));
  return { content, thinking, toolCalls };
}

module.exports = { listModels, streamChat };

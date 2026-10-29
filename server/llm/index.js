// The single entry point the chat engine uses to talk to any model. Local Ollama models keep
// their plain names ("qwen3:4b-instruct"); a model from an external provider an admin connected
// is named "ext/<providerId>/<modelId>" (e.g. "ext/2/deepseek-chat") so the two can never clash
// and the browser never needs to know a provider's URL or key.
const crypto = require('node:crypto');
const ollama = require('./ollama');
const openai = require('./openai');
const anthropic = require('./anthropic');
const { PROVIDER_TYPES, listProviders, getProvider, apiKeyOf } = require('./providers');
const { NUM_CTX } = require('../ollama');
const { createRedactor } = require('./redact');
const { getSetting } = require('../settings');

function isRedactionEnabled() {
  return getSetting('external_redaction', 'true') !== 'false';
}

const EXTERNAL_PREFIX = 'ext/';

function externalModelName(providerId, modelId) {
  return `${EXTERNAL_PREFIX}${providerId}/${modelId}`;
}

// Resolves a model name to where it runs. Throws a message fit for the user if it's an external
// model that's been switched off or removed since the chat started.
function resolve(name) {
  if (!String(name).startsWith(EXTERNAL_PREFIX)) return { kind: 'ollama', model: name };
  const [, providerId, ...rest] = String(name).split('/');
  const modelId = rest.join('/');
  const provider = getProvider(Number(providerId));
  if (!provider || !provider.enabled || !provider.enabledModels.includes(modelId)) {
    throw new Error('This model is no longer available — an admin has disabled or removed it. Pick another model.');
  }
  return { kind: 'external', provider, model: modelId, type: PROVIDER_TYPES[provider.type] || PROVIDER_TYPES.custom };
}

function isExternal(name) {
  return String(name).startsWith(EXTERNAL_PREFIX);
}

// Every external model enabled by an admin, in the shape the model picker uses.
function listExternalModels() {
  const models = [];
  for (const provider of listProviders()) {
    if (!provider.enabled) continue;
    const type = PROVIDER_TYPES[provider.type] || PROVIDER_TYPES.custom;
    for (const modelId of provider.enabledModels) {
      models.push({
        name: externalModelName(provider.id, modelId),
        label: `${provider.name} · ${modelId}`,
        provider: provider.name,
        external: true,
        masked: isRedactionEnabled(),
        vision: type.vision,
        tools: true,
        thinking: false,
      });
    }
  }
  return models;
}

async function getCapabilities(name) {
  if (isExternal(name)) {
    try {
      const { type } = resolve(name);
      return { vision: type.vision, tools: true, thinking: false, external: true };
    } catch {
      return { vision: false, tools: false, thinking: false, external: true };
    }
  }
  try {
    const models = await ollama.listModels();
    const withTag = (n) => (n.includes(':') ? n : `${n}:latest`);
    const entry = models.find((m) => withTag(m.name) === withTag(name));
    return { vision: Boolean(entry?.vision), tools: Boolean(entry?.tools), thinking: Boolean(entry?.thinking), external: false };
  } catch {
    return { vision: false, tools: false, thinking: false, external: false };
  }
}

// How many tokens of conversation to send this model at most.
function contextTokens(name) {
  if (!isExternal(name)) return NUM_CTX;
  try {
    return resolve(name).type.contextTokens;
  } catch {
    return NUM_CTX;
  }
}

// External APIs require every tool call to carry an id that its result refers back to; Ollama's
// don't always have one. Give each call an id so a conversation can move between both kinds.
function withCallIds(toolCalls) {
  return toolCalls.map((call) => (call.id ? call : { ...call, id: `call_${crypto.randomBytes(6).toString('hex')}` }));
}

// Streams one model call. `messages` use the app's internal (Ollama-shaped) format; tool calls in
// the result are normalised to { id, function: { name, arguments: object } }.
async function streamChat(name, { messages, tools, think, maxTokens, signal, onThinking = () => {}, onContent = () => {} }) {
  const target = resolve(name);
  let result;
  if (target.kind === 'ollama') {
    result = await ollama.streamChat({ model: target.model, messages, tools, think, maxTokens, signal, onThinking, onContent });
  } else {
    // Customer identifiers are masked on the way out and restored on the way back, so the
    // provider never sees them but staff (and locally run tools) do. On unless an admin turns it off.
    const redactor = isRedactionEnabled() ? createRedactor() : null;
    const contentOut = redactor ? redactor.streamRestorer(onContent) : { push: onContent, flush: () => {} };
    const thinkingOut = redactor ? redactor.streamRestorer(onThinking) : { push: onThinking, flush: () => {} };
    const common = {
      baseUrl: target.provider.baseUrl,
      apiKey: apiKeyOf(target.provider),
      model: target.model,
      messages: redactor ? redactor.maskMessages(messages) : messages,
      tools,
      maxTokens,
      signal,
      onThinking: (delta) => thinkingOut.push(delta),
      onContent: (delta) => contentOut.push(delta),
    };
    result =
      target.type.api === 'anthropic'
        ? await anthropic.streamChat(common)
        : await openai.streamChat({ ...common, isOpenAi: target.provider.type === 'openai' });
    contentOut.flush();
    thinkingOut.flush();
    if (redactor) {
      result = {
        ...result,
        content: redactor.restore(result.content),
        thinking: redactor.restore(result.thinking),
        toolCalls: result.toolCalls.map((call) => ({
          ...call,
          function: { ...call.function, arguments: redactor.restoreDeep(call.function.arguments) },
        })),
        maskedCount: redactor.count,
      };
    }
  }
  return { ...result, toolCalls: withCallIds(result.toolCalls) };
}

// A whole reply at once, for behind-the-scenes calls (titles, corrections).
async function completeChat(name, options) {
  return streamChat(name, { ...options, onThinking: () => {}, onContent: () => {} });
}

// Lists the chat models a provider offers, to test a new connection and let the admin pick.
async function fetchProviderModels({ type, baseUrl, apiKey }) {
  const info = PROVIDER_TYPES[type];
  if (!info) throw new Error(`Unknown provider type "${type}"`);
  return info.api === 'anthropic'
    ? anthropic.listModels({ baseUrl, apiKey })
    : openai.listModels({ baseUrl, apiKey, filterNonChat: type === 'openai' });
}

module.exports = {
  resolve,
  isExternal,
  listExternalModels,
  getCapabilities,
  contextTokens,
  streamChat,
  completeChat,
  fetchProviderModels,
  externalModelName,
};

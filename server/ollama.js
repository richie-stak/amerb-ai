// Shared Ollama runtime settings. Every call that loads a model must use the same num_ctx —
// Ollama reloads the whole model from disk whenever the requested context size changes.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
// Ollama's own default context window is small and varies by version — pin it so long chats and
// retrieved documents behave the same everywhere, and so history can be trimmed to a known budget.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;
// Keep the model resident between messages: on a CPU-only machine reloading a model from disk
// adds tens of seconds to whichever message happens to arrive after Ollama's default 5 minutes.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';

function ollamaRuntime(extraOptions = {}) {
  return { keep_alive: KEEP_ALIVE, options: { num_ctx: NUM_CTX, ...extraOptions } };
}

// Loads the default model into memory at startup, so the first person to send a message after
// the server starts doesn't wait a minute or more for it to load from disk. Best-effort: if
// Ollama isn't running yet, chatting will report that clearly later on.
async function warmUpDefaultModel() {
  const model = process.env.DEFAULT_MODEL;
  if (!model) return;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...ollamaRuntime() }),
    });
    if (res.ok) console.log(`Model "${model}" loaded and ready.`);
    else console.warn(`Could not preload model "${model}" (Ollama said ${res.status}) — is it pulled?`);
  } catch (err) {
    console.warn(`Could not preload model "${model}": ${err.message}`);
  }
}

module.exports = { OLLAMA_URL, NUM_CTX, KEEP_ALIVE, ollamaRuntime, warmUpDefaultModel };

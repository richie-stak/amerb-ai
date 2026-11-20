// A stand-in for Ollama, speaking just enough of its HTTP API (/api/tags, /api/chat, /api/ps,
// /api/version) to exercise the app's queue, fallback and monitoring without a real model.
//
// Models behave according to their name:
//   "broken..."    every chat request fails with HTTP 500
//   "midfail..."   streams a few words, then fails mid-reply
//   "gibberish..." answers with repetitive nonsense, like a small model asked in a language it
//                  doesn't know (see server/languages.js looksUnreliableAnswer)
//   anything else  answers "Hello from <model>" (after `delayMs`, split into small pieces)
// Chat requests whose last user message starts with "title" (the app's title generator) are
// answered instantly so they don't hold slots.
const http = require('node:http');

const GIBBERISH = `${'kɔnɛ kɔnɛ '.repeat(20)}na wɔ bɔɔ kɛ bɔɔ kɔnɛ ${'mɔkɔ kɔnɛ '.repeat(15)}`;

// Plausible-looking answers in each language, for the models that are supposed to be good at them.
// The figures are copied out of the prompt, because keeping the numbers intact is exactly what a
// capability test checks. Each template carries enough distinct words and language markers to read as
// real prose to server/languages.js (not a repetition loop, and unmistakably in the language).
const LANGUAGE_TEMPLATES = {
  tw: (numbers) =>
    `Mepaakyɛw, wei ne nsɛm a ɛfa ${numbers || 'sika'} ho. Bosea no ho nsɛm no, wɔbɛka kyerɛ wo wɔ adwuma no mu. ` +
    'Sɛ wopɛ sɛ wuhu nsɛm pii a, bisa sikakorabea no so. Yɛn adwuma ne sɛ yɛboa obiara wɔ kuro no mu.',
  gaa: (numbers) =>
    `Oyiwaladɔŋŋ, wolo nɛ mli saji kɛha ${numbers || 'shika'}. Shika lɛ kɛha akɔnta lɛ, ni wɔɔkɛɛ bo mli saji lɛ. ` +
    'Kɛha mi niyenii kɛ nibii krokomɛi, bi akɔnta lɛ nɔ. Wɔɔye bo ohia wɔ shia lɛ mli.',
  fr: (numbers) =>
    `Le compte indique ${numbers || 'le montant'}, et le taux est fixé par la banque pour chaque période. ` +
    "L'intérêt est versé sur votre compte, et le garant est requis pour un prêt plus important. " +
    'Vous pouvez obtenir les frais dans votre agence.',
};

function targetLanguage(prompt) {
  if (/Twi \(Akan\)/.test(prompt)) return 'tw';
  if (/\bin Ga\b|\binto Ga\b|\(Ga\)/.test(prompt)) return 'gaa';
  if (/French/.test(prompt)) return 'fr';
  return null;
}

// What this model answers. Model names describe their ability, the same way "broken" and "midfail" do:
//   twi-capable / gaa-capable / fr-capable  good at that one language
//   multilingual                            good at whichever language is asked for
//   anything else                           only speaks English (so it fails language tests, like a
//                                           small local model asked to translate)
// state.playEnglish pretends a previously capable model has lost the ability, so a re-test can be made
// to fail and the "revert staff back to the default" path can be exercised.
function replyText(model, lastUser, state) {
  if (model.startsWith('gibberish') || state.garble) return GIBBERISH;
  // The app's search-only translation step asks for English on behalf of a local-language question.
  if (/^Translate the following question into plain English/.test(lastUser)) {
    return 'What is the minimum balance for a savings account?';
  }
  const numbers = (lastUser.match(/\b\d[\d,.]*\b/g) || []).join(', ');
  const asked = targetLanguage(lastUser);
  const ability = model.includes('twi') ? 'tw' : model.includes('gaa') ? 'gaa' : model.includes('fr') ? 'fr' : model.includes('multi') ? asked : null;
  if (ability && !state.playEnglish && LANGUAGE_TEMPLATES[ability]) return LANGUAGE_TEMPLATES[ability](numbers);
  return `Hello from ${model}`;
}

async function startMockOllama({ models = ['good', 'broken', 'midfail', 'backup', 'gibberish'], delayMs = 0 } = {}) {
  const state = { delayMs, requests: [], inFlight: 0, maxInFlight: 0, up: true, playEnglish: false };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!state.up) return req.socket.destroy();
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/api/tags') {
        return json(200, {
          models: models.map((name) => ({
            name: `${name}:latest`,
            capabilities: name.includes('embed') ? ['embedding'] : ['completion', 'tools'],
          })),
        });
      }
      if (req.method === 'POST' && req.url === '/api/show') {
        // Ollama reports what a model can do; the mock follows the naming convention the tests use.
        const body = JSON.parse(raw);
        const name = String(body.model || body.name || '');
        const embedding = name.includes('embed');
        return json(200, {
          capabilities: embedding ? ['embedding'] : ['completion', 'tools', 'thinking'],
          details: { family: embedding ? 'nomic-bert' : 'qwen3', parameter_size: embedding ? '137M' : '4.0B' },
        });
      }
      if (req.method === 'GET' && req.url === '/api/version') return json(200, { version: '0.0.0-mock' });
      if (req.method === 'GET' && req.url === '/api/ps') {
        return json(200, { models: [{ name: 'good:latest', size: 2 * 1048576 * 1024, size_vram: 0, expires_at: null }] });
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        const body = JSON.parse(raw);
        const model = String(body.model).replace(/:latest$/, '');
        const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
        const isTitle = /^Reply with ONLY a short title/.test(lastUser);
        state.requests.push({
          model,
          isTitle,
          hadImages: body.messages.some((m) => m.images),
          tools: Boolean(body.tools),
          // Enough of the request to assert what the model was actually told (persona, language
          // instructions, retrieved context) without keeping whole documents in memory.
          system: body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n'),
          user: lastUser,
        });

        if (model.startsWith('broken')) return json(500, { error: `model "${model}" failed to load` });

        // Tool calls: a message containing "search" makes the mock call web_search the way a real
        // model would, and the next round reports what the tool returned. This is how the suite
        // exercises the whole tool path (including a search the provider refuses) without a real
        // model or a real search engine.
        const toolMessage = body.messages.find((m) => m.role === 'tool');
        if (body.tools && /search/i.test(lastUser) && !toolMessage) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(
            `${JSON.stringify({
              message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: lastUser } } }] },
              done: false,
            })}\n`
          );
          res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`);
          res.end();
          if (!isTitle) state.inFlight -= 1;
          return undefined;
        }
        if (toolMessage) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          const answer = `Tool said: ${String(toolMessage.content).replace(/\s+/g, ' ').slice(0, 160)}`;
          for (const piece of answer.match(/.{1,24}/g)) {
            res.write(`${JSON.stringify({ message: { role: 'assistant', content: piece }, done: false })}\n`);
          }
          res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`);
          res.end();
          if (!isTitle) state.inFlight -= 1;
          return undefined;
        }

        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const line = (content) => res.write(`${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`);
        const finish = () => {
          res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`);
          res.end();
          if (!isTitle) state.inFlight -= 1;
        };
        if (!isTitle) {
          state.inFlight += 1;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        }
        // If the app gives up on the request (stop button, fallback), the slot is no longer in use.
        let closed = false;
        res.on('close', () => {
          if (!closed && !res.writableEnded && !isTitle) state.inFlight -= 1;
          closed = true;
        });
        const delay = isTitle ? 0 : state.delayMs;
        setTimeout(() => {
          if (closed) return;
          if (isTitle) {
            line('Mock title');
            return finish();
          }
          const text = replyText(model, lastUser, state);
          if (model.startsWith('midfail')) {
            line(text.slice(0, 5));
            state.inFlight -= 1;
            closed = true;
            return setTimeout(() => res.destroy(), 20);
          }
          for (const piece of text.match(/.{1,6}/g)) line(piece);
          finish();
        }, delay);
        return undefined;
      }
      res.writeHead(404);
      res.end();
      return undefined;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    setDelay: (ms) => {
      state.delayMs = ms;
    },
    // Simulates Ollama being switched off: connections are dropped.
    setUp: (up) => {
      state.up = up;
    },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

module.exports = { startMockOllama };

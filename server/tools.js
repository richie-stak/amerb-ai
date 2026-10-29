const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const { Worker } = require('node:worker_threads');
const { Agent } = require('undici');
const db = require('./db');
const { canAccessDoc } = require('./documentAccess');
const { addMemory } = require('./memory');

const MAX_ANALYZE_SHEETS = 5;
const MAX_ANALYZE_ROWS = 5000;

const RUN_CODE_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_FETCH_BYTES = 300_000;
const MAX_IMAGE_BYTES = 6_000_000;
const MAX_REDIRECTS = 3;
const MAX_RETURNED_CHARS = 4000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'run_code',
      description:
        'Evaluate a math/data expression for calculations — arithmetic, sums, averages, loan/interest ' +
        'math, unit conversions, matrix operations. Multiple statements can be separated by newlines; each ' +
        'line\'s value is returned, in order. Use ^ for powers (e.g. (1 + r)^n). Always use this for any figure ' +
        'you report — never do multi-step arithmetic in your head. ' +
        'This is a restricted math language, not general-purpose code — no loops, files, or network access.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'The math expression(s) to evaluate, e.g. "5000 * 0.24 / 12" or "a = 100\\nsum(a, 50, 25)"',
          },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch a URL. If it is a normal web page, returns its text content. If the URL points directly at an ' +
        'image file, the actual image is fetched and shown to the user for real — use this whenever asked to ' +
        'find, get, or display a picture/photo/image from the web (a direct image URL, e.g. ending in .jpg/.png, ' +
        'or one found via web_search). Never write your own markdown image syntax for a URL you have not fetched ' +
        'this way — you cannot see or verify images you have not actually retrieved with this tool, so pretending ' +
        'to show one is misleading. Works for domains an admin has explicitly approved, and for any URL returned ' +
        'by a web_search call earlier in this conversation turn. Otherwise it will fail and you should tell the ' +
        'user to ask an admin to add the domain.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to fetch, including https://' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public internet for current information (news, rates, regulations, anything not in the ' +
        'bank\'s internal documents). Returns a list of titled results with short snippets and URLs. Use ' +
        'fetch_url afterward on one of the returned URLs to read a page in full. Must be enabled by an admin. ' +
        'Do not use this for greetings, small talk, or anything you can already answer yourself — only call it ' +
        'when the user is actually asking for information you would need to look up.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Generate an image from a text description using a local Stable Diffusion model. Use this whenever ' +
        'the user asks you to create, generate, draw, design, or redesign an image, logo, illustration, or picture. ' +
        'This actually produces and shows the image — it is not hypothetical. Note: this model cannot render ' +
        'legible text/words inside images reliably — describe visual composition only, do not expect readable ' +
        'text/labels/letters to come out correctly.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'A clear, visual description of the image to generate.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_word_document',
      description:
        'Create a real, downloadable Microsoft Word (.docx) document. Use this whenever the user asks to save, ' +
        'write, or generate a letter, memo, report, or any document as Word. This actually produces a file — ' +
        'it is not hypothetical, and you should not describe manual steps for the user to do it themselves instead.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title' },
          content: {
            type: 'string',
            description:
              'The document body. Use "# Heading" for headings (up to 3 levels), "- item" for bullet points, ' +
              'plain lines for paragraphs, and a markdown table (a "| Col A | Col B |" row followed by a ' +
              '"|---|---|" separator row, then data rows in the same "| ... |" form) for any tabular data — ' +
              'tables render as real, bordered, professionally-styled tables, not plain text, so always use ' +
              'this form for anything row/column shaped (loan schedules, comparisons, itemized lists, etc).',
          },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pdf_document',
      description:
        'Create a real, downloadable PDF document. Use this whenever the user asks to save or generate something as a PDF. ' +
        'This actually produces a file — it is not hypothetical.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title' },
          content: {
            type: 'string',
            description:
              'The document body. Use "# Heading" for headings (up to 3 levels), "- item" for bullet points, ' +
              'plain lines for paragraphs, and a markdown table (a "| Col A | Col B |" row followed by a ' +
              '"|---|---|" separator row, then data rows in the same "| ... |" form) for any tabular data — ' +
              'tables render as real, bordered, professionally-styled tables, not plain text, so always use ' +
              'this form for anything row/column shaped (loan schedules, comparisons, itemized lists, etc).',
          },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_excel_document',
      description:
        'Create a real, downloadable Microsoft Excel (.xlsx) spreadsheet from tabular data. Use this whenever the ' +
        'user asks for data saved/exported/generated as Excel or a spreadsheet. This actually produces a file.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Spreadsheet/sheet title' },
          rows: {
            type: 'array',
            description:
              'Rows of the spreadsheet as an array of arrays. The first row is treated as the header row. ' +
              'Example: [["Name","Amount"],["Kwame Mensah",35000]]',
            items: { type: 'array', items: {} },
          },
        },
        required: ['title', 'rows'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_powerpoint',
      description:
        'Create a real, downloadable PowerPoint (.pptx) presentation. Use this whenever the user asks for a ' +
        'presentation, slide deck, or slides. This actually produces a file with a title slide plus one slide per entry.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Presentation title (shown on the title slide)' },
          slides: {
            type: 'array',
            description: 'One entry per content slide (the title slide is added automatically, do not include it here).',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: 'Slide heading' },
                bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet points for this slide' },
              },
              required: ['heading', 'bullets'],
            },
          },
        },
        required: ['title', 'slides'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Save a short fact about the user so you remember it in all their future conversations. Use this ' +
        'when the user asks you to remember something ("remember that...", "from now on...", "note that I...") ' +
        'or states a lasting preference about how you should respond. Write the fact in third person, e.g. ' +
        '"Works in the Credit department" or "Prefers answers in bullet points". If the user gives several ' +
        'facts at once, call this once per fact. Do not save passwords, ' +
        'account numbers, or other sensitive personal data.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The fact to remember, in one short sentence.' },
        },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_excel',
      description:
        'Computes real statistics (row count, column names, and for numeric columns: sum, average, min, max) ' +
        'over an uploaded or previously-generated Excel spreadsheet. Use this whenever the user asks to analyze, ' +
        'summarize, total, or ask questions about numbers in a spreadsheet they attached or that was generated ' +
        'earlier in this conversation — this reads and computes the actual values, rather than you estimating ' +
        'from a text preview. The spreadsheet\'s id and filename are given in the document context above.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'integer', description: 'The id of the Excel (.xlsx) document to analyze' },
        },
        required: ['documentId'],
      },
    },
  },
];

function runCode(code) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'tools', 'runCodeWorker.js'), {
      workerData: { code },
    });

    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, error: 'Execution timed out' });
    }, RUN_CODE_TIMEOUT_MS);

    worker.once('message', (msg) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(msg);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || 'Worker error' });
    });
  });
}

function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
  }
  return true; // unrecognized format — treat as unsafe
}

function isDomainAllowed(hostname, extraAllowed) {
  const lowerHost = hostname.toLowerCase();
  const rows = db.prepare('SELECT domain FROM allowed_domains').all();
  const matchesAny = (domains) =>
    domains.some((d) => {
      const lowerD = d.toLowerCase();
      return lowerHost === lowerD || lowerHost.endsWith(`.${lowerD}`);
    });
  if (matchesAny(rows.map((r) => r.domain))) return true;
  if (extraAllowed && matchesAny([...extraAllowed])) return true;
  return false;
}

// Resolves and validates the hostname, returning the exact IP that passed the check. The caller
// must pin its actual connection to this IP (see `pinnedDispatcher` below) rather than letting
// fetch() re-resolve DNS itself — otherwise a fast-flipping DNS record could return a safe IP for
// this check and a private one for the real connection (classic DNS-rebinding TOCTOU).
async function assertSafeToFetch(urlObj, extraAllowed) {
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  if (!isDomainAllowed(urlObj.hostname, extraAllowed)) {
    throw new Error(
      `"${urlObj.hostname}" is not on the approved domain list and wasn't part of a recent web search. Ask an admin to add it, or search for it first.`
    );
  }
  let addresses;
  try {
    addresses = await dns.lookup(urlObj.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve "${urlObj.hostname}"`);
  }
  if (!addresses.length) {
    throw new Error(`Could not resolve "${urlObj.hostname}"`);
  }
  if (addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new Error(`"${urlObj.hostname}" resolves to a private/internal address and cannot be fetched`);
  }
  return addresses[0];
}

// An undici dispatcher that forces the TCP/TLS connection to a specific pre-validated IP, while
// still using the real hostname for the Host header and TLS SNI — closes the DNS-rebinding gap.
function pinnedDispatcher(address, family) {
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => callback(null, [{ address, family }]),
    },
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchUrl(rawUrl, extraAllowed) {
  let current = new URL(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await assertSafeToFetch(current, extraAllowed);
    const dispatcher = pinnedDispatcher(validated.address, validated.family);

    // The dispatcher must stay open for the whole hop, including streaming the body — only
    // closed once we're done with it (redirect, success, or error), never right after fetch().
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': DEFAULT_USER_AGENT },
          dispatcher,
        });
      } finally {
        clearTimeout(timer);
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`Redirect with no Location header from ${current.hostname}`);
        current = new URL(location, current);
        continue;
      }

      if (!res.ok) {
        throw new Error(`${current.hostname} responded with status ${res.status}`);
      }

      const contentType = res.headers.get('content-type') || '';

      // A URL that actually points at an image gets fetched and shown for real, rather than
      // leaving the model to fabricate fake markdown image links around a page it can't see.
      if (contentType.startsWith('image/')) {
        const reader = res.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > MAX_IMAGE_BYTES) {
            controller.abort();
            throw new Error(`Image at ${current.hostname} is too large to fetch`);
          }
          chunks.push(value);
        }
        return { kind: 'image', buffer: Buffer.concat(chunks), contentType, sourceUrl: current.href };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        text += decoder.decode(value, { stream: true });
        if (bytes >= MAX_FETCH_BYTES) {
          controller.abort();
          break;
        }
      }

      const plain = contentType.includes('html') ? stripHtml(text) : text.trim();
      return { kind: 'text', text: plain.slice(0, MAX_RETURNED_CHARS), sourceUrl: current.href };
    } finally {
      dispatcher.close().catch(() => {});
    }
  }

  throw new Error('Too many redirects');
}

const SEARCH_TIMEOUT_MS = 10000;
const MAX_SEARCH_RESULTS = 5;

// Scrapes DuckDuckGo's plain-HTML search endpoint (no API key required, no JS involved). Result
// links are wrapped in a DDG redirect ("/l/?uddg=<encoded target>&rut=...") — extract the real URL.
// When the admin has turned on restricted search mode, the query is scoped to only the approved
// domains list via DuckDuckGo's own "site:" operator, rather than searching the open web.
async function webSearch(query) {
  const { isSearchRestricted } = require('./settings');
  let effectiveQuery = query;
  if (isSearchRestricted()) {
    const domains = db.prepare('SELECT domain FROM allowed_domains').all().map((r) => r.domain);
    if (!domains.length) {
      throw new Error(
        'Restricted search mode is on, but no domains are approved yet — ask an admin to add some in the Tools tab.'
      );
    }
    effectiveQuery = `${query} (${domains.map((d) => `site:${d}`).join(' OR ')})`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(effectiveQuery)}`, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Could not reach the search provider: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Search provider responded with status ${res.status}`);

  const html = await res.text();

  const links = [];
  const linkRe = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRe.exec(html)) && links.length < MAX_SEARCH_RESULTS) {
    const uddgMatch = match[1].match(/uddg=([^&]+)/);
    if (!uddgMatch) continue;
    let targetUrl;
    try {
      targetUrl = decodeURIComponent(uddgMatch[1]);
      new URL(targetUrl); // validate
    } catch {
      continue;
    }
    links.push({ title: stripHtml(match[2]), url: targetUrl });
  }

  const snippets = [];
  const snippetRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((match = snippetRe.exec(html)) && snippets.length < links.length) {
    snippets.push(stripHtml(match[1]));
  }

  return links.map((link, i) => ({ ...link, snippet: snippets[i] || '' }));
}

// Returns { text, meta? } — `text` is what gets fed back to the model, `meta` carries extra
// structured data (e.g. a generated image's document id) for the caller to act on.
// Small local models sometimes emit a nested array/object argument as a JSON- or Python-literal
// string instead of real structured JSON. Best-effort recovery rather than silently dropping data.
function coerceArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
    try {
      const parsed = JSON.parse(value.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* give up */
    }
  }
  return [];
}

// Like coerceArray, but a plain non-JSON string (e.g. one comma-separated sentence instead of a
// real list of bullets) becomes a single-item array rather than being silently dropped.
function coerceBullets(value) {
  const arr = coerceArray(value);
  if (arr.length) return arr;
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

async function executeTool(name, args, context = {}) {
  // Some local models occasionally re-wrap their tool call in a full function-call envelope
  // (e.g. {type:"function", function:"web_search", parameters:{query:"..."}}) instead of just
  // the arguments object the schema asked for. Unwrap that one level rather than failing the
  // call outright — this is model inconsistency, not something callers can prevent.
  if (args && typeof args === 'object' && args.parameters && typeof args.parameters === 'object') {
    args = args.parameters;
  }

  if (name === 'save_memory') {
    if (!context.user) return { text: 'Error: no user to save a memory for.' };
    const result = addMemory(context.user.id, args.fact);
    if (result.error) return { text: `Error: ${result.error}` };
    context.savedMemory = true;
    return {
      text: result.duplicate
        ? 'This was already in memory. Tell the user briefly that you already remember it.'
        : 'Saved to memory. Confirm briefly to the user that you will remember it.',
    };
  }

  if (name === 'run_code') {
    const result = await runCode(String(args.code || ''));
    // For a bank, a made-up figure is worse than no figure — after a failed calculation small
    // models tend to "estimate" the answer anyway, so spell out that they must retry or say so.
    return {
      text: result.ok
        ? result.output
        : `Error: ${result.error}\nThe calculation did not run, so you do not have a result. Fix the expression ` +
          '(use ^ for powers) and call run_code again, or tell the user the calculation failed. Never state a ' +
          'figure you did not get from a successful run_code result.',
    };
  }

  if (name === 'fetch_url') {
    try {
      const result = await fetchUrl(String(args.url || ''), context.unlockedDomains);
      if (result.kind === 'image') {
        const department = context.user?.department || 'General';
        const extFromType = (result.contentType.split('/')[1] || 'jpg').split(';')[0].replace('svg+xml', 'svg');
        let filename = `image.${extFromType}`;
        try {
          const base = decodeURIComponent(new URL(result.sourceUrl).pathname.split('/').pop() || '');
          filename = /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base || 'image'}.${extFromType}`;
        } catch {
          /* keep default */
        }
        const insertResult = db
          .prepare(
            'INSERT INTO documents (user_id, department, is_personal, filename, mime_type, kind, image_data, char_count) VALUES (?, ?, 1, ?, ?, ?, ?, ?)'
          )
          .run(context.user.id, department, filename, result.contentType, 'image', result.buffer.toString('base64'), 0);
        return {
          text: 'Image fetched successfully and shown to the user. Do not describe it further unless asked; just acknowledge briefly, and do not fabricate any markdown image links yourself.',
          meta: { documentId: insertResult.lastInsertRowid, filename, kind: 'image' },
        };
      }
      // Save the fetched page so the user can revisit and preview it later, the same way
      // generated documents work — without this, a fetched site was only ever text fed to the
      // model, with nothing for the user to look at themselves.
      if (result.text && context.user) {
        try {
          const { chunkText } = require('./documentExtract');
          const chunks = chunkText(result.text);
          if (chunks.length) {
            const department = context.user.department || 'General';
            const hostname = new URL(result.sourceUrl).hostname;
            const insertResult = db
              .prepare(
                'INSERT INTO documents (user_id, department, is_personal, filename, mime_type, kind, char_count) VALUES (?, ?, 1, ?, ?, ?, ?)'
              )
              .run(context.user.id, department, hostname, 'text/html', 'webpage', result.text.length);
            const insertChunk = db.prepare(
              'INSERT INTO document_chunks (document_id, chunk_index, content, heading) VALUES (?, ?, ?, ?)'
            );
            chunks.forEach((chunk, idx) => insertChunk.run(insertResult.lastInsertRowid, idx, chunk.text, chunk.heading));
            return {
              text: result.text,
              meta: { documentId: insertResult.lastInsertRowid, filename: hostname, kind: 'webpage' },
            };
          }
        } catch {
          /* saving the page for preview is a bonus, not essential — fall through to plain text */
        }
      }
      return { text: result.text };
    } catch (err) {
      return { text: `Error: ${err.message}` };
    }
  }

  if (name === 'web_search') {
    const { isWebSearchEnabled } = require('./settings');
    if (!isWebSearchEnabled()) {
      return { text: 'Error: Web search is disabled. Ask an admin to enable it in the admin portal\'s Tools tab.' };
    }
    const query = String(args.query || '').trim();
    if (!query) return { text: 'Error: no query provided' };
    // Small local models treat "no results" or a search error as proof the answer doesn't exist
    // and flatly refuse, instead of falling back to what they already know — so both empty and
    // failed searches carry an explicit nudge not to do that (same reasoning as the forced-search
    // path above, which needs its own copy of this since that path never reaches this function).
    const NO_REFUSAL_HINT =
      'This does not necessarily mean the topic doesn\'t exist — the search provider may be ' +
      'temporarily unavailable or rate-limited. If you have relevant general knowledge, answer ' +
      "with it instead of telling the user no information exists.";
    try {
      const results = await webSearch(query);
      if (!results.length) return { text: `No results found. ${NO_REFUSAL_HINT}` };
      if (context.unlockedDomains) {
        for (const r of results) {
          try {
            context.unlockedDomains.add(new URL(r.url).hostname);
          } catch {
            /* skip malformed URL */
          }
        }
      }
      const text = results
        .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`.trim())
        .join('\n\n');
      return { text };
    } catch (err) {
      return { text: `Error: ${err.message}. ${NO_REFUSAL_HINT}` };
    }
  }

  if (name === 'generate_image') {
    const { generateImage } = require('./imagegen');
    try {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) return { text: 'Error: no prompt provided' };
      const result = await generateImage(prompt, context.user);
      return {
        text: `Image generated successfully and shown to the user (took ${result.seconds}s). Do not describe it further; just acknowledge it briefly.`,
        meta: { documentId: result.documentId, filename: result.filename, kind: 'image' },
      };
    } catch (err) {
      return { text: `Error: ${err.message}` };
    }
  }

  if (name === 'create_word_document' || name === 'create_pdf_document') {
    const kind = name === 'create_word_document' ? 'docx' : 'pdf';
    try {
      const { generateDocx, generatePdf } = require('./documentGen');
      const { saveGeneratedFile } = require('./documentStore');
      const title = String(args.title || 'Untitled').trim() || 'Untitled';
      const content = String(args.content || '');
      const buffer = await (kind === 'docx' ? generateDocx(title, content) : generatePdf(title, content));
      const filename = `${sanitizeFilename(title)}.${kind}`;
      const saved = saveGeneratedFile(buffer, filename, kind, context.user, `${title}\n\n${content}`);
      return {
        text: `${kind === 'docx' ? 'Word document' : 'PDF'} "${filename}" created successfully and shown to the user for preview/download. Do not restate the document's contents; just acknowledge it briefly.`,
        meta: { documentId: saved.documentId, filename: saved.filename, kind },
      };
    } catch (err) {
      return { text: `Error: ${err.message}` };
    }
  }

  if (name === 'create_excel_document') {
    try {
      const { generateXlsx } = require('./documentGen');
      const { saveGeneratedFile } = require('./documentStore');
      const title = String(args.title || 'Untitled').trim() || 'Untitled';
      const rows = coerceArray(args.rows);
      const buffer = await generateXlsx(title, rows);
      const filename = `${sanitizeFilename(title)}.xlsx`;
      const rowsText = `${title}\n\n${rows.map((r) => (Array.isArray(r) ? r.join(', ') : String(r))).join('\n')}`;
      const saved = saveGeneratedFile(buffer, filename, 'xlsx', context.user, rowsText);
      return {
        text: `Excel spreadsheet "${filename}" created successfully and shown to the user for preview/download. Do not restate the data; just acknowledge it briefly.`,
        meta: { documentId: saved.documentId, filename: saved.filename, kind: 'xlsx' },
      };
    } catch (err) {
      return { text: `Error: ${err.message}` };
    }
  }

  if (name === 'create_powerpoint') {
    try {
      const { generatePptx } = require('./documentGen');
      const { saveGeneratedFile } = require('./documentStore');
      const title = String(args.title || 'Untitled').trim() || 'Untitled';
      const slides = coerceArray(args.slides);
      const buffer = await generatePptx(title, slides);
      const filename = `${sanitizeFilename(title)}.pptx`;
      const outline = `${title}\n\n${slides
        .map((s, i) => `Slide ${i + 1}: ${s.heading || ''}\n${coerceBullets(s.bullets).map((b) => `- ${b}`).join('\n')}`)
        .join('\n\n')}`;
      const saved = saveGeneratedFile(buffer, filename, 'pptx', context.user, outline);
      return {
        text: `Presentation "${filename}" created successfully and shown to the user for preview/download. Do not restate the slide contents; just acknowledge it briefly.`,
        meta: { documentId: saved.documentId, filename: saved.filename, kind: 'pptx' },
      };
    } catch (err) {
      return { text: `Error: ${err.message}` };
    }
  }

  if (name === 'analyze_excel') {
    try {
      const documentId = Number(args.documentId);
      if (!Number.isInteger(documentId)) return { text: 'Error: documentId must be an integer' };

      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
      if (!doc) return { text: `Error: no document with id ${documentId}` };

      const user = context.user;
      if (!canAccessDoc(doc, user)) return { text: 'Error: you do not have access to that document' };

      if (doc.kind !== 'xlsx') return { text: `Error: "${doc.filename}" is not an Excel spreadsheet` };
      if (!doc.file_data) {
        return { text: `Error: "${doc.filename}" is too large or wasn't stored for analysis. Try a smaller file.` };
      }

      const XLSX = require('xlsx');
      const buffer = Buffer.from(doc.file_data, 'base64');
      const workbook = XLSX.read(buffer, { type: 'buffer' });

      const reports = [];
      for (const sheetName of workbook.SheetNames.slice(0, MAX_ANALYZE_SHEETS)) {
        const sheet = workbook.Sheets[sheetName];
        const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
        if (!aoa.length) continue;

        const [header, ...dataRows] = aoa;
        const rows = dataRows.slice(0, MAX_ANALYZE_ROWS);
        const lines = [`Sheet "${sheetName}": ${rows.length} row(s), columns: ${header.map((h) => h ?? '(blank)').join(', ')}`];

        header.forEach((colName, idx) => {
          const values = rows.map((r) => r[idx]).filter((v) => v !== null && v !== undefined && v !== '');
          if (!values.length) return;
          const numericValues = values.filter((v) => typeof v === 'number');
          if (numericValues.length >= values.length * 0.8 && numericValues.length) {
            const sum = numericValues.reduce((a, b) => a + b, 0);
            const avg = sum / numericValues.length;
            const min = Math.min(...numericValues);
            const max = Math.max(...numericValues);
            lines.push(
              `  "${colName}" (numeric, ${numericValues.length} values): sum=${sum.toLocaleString()}, ` +
                `avg=${avg.toLocaleString(undefined, { maximumFractionDigits: 2 })}, min=${min.toLocaleString()}, max=${max.toLocaleString()}`
            );
          } else {
            lines.push(`  "${colName}" (text, ${values.length} non-empty values)`);
          }
        });

        reports.push(lines.join('\n'));
      }

      if (!reports.length) return { text: `"${doc.filename}" has no data to analyze.` };
      return { text: reports.join('\n\n') };
    } catch (err) {
      return { text: `Error: ${err.message}` };
    }
  }

  return { text: `Error: unknown tool "${name}"` };
}

function sanitizeFilename(title) {
  const clean = title.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return clean || 'document';
}

module.exports = { TOOL_DEFS, executeTool, webSearch };

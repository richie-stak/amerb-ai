// Spins up a real instance of the app as a child process, pointed at a disposable SQLite file
// instead of data/amerb-ai.sqlite — after an incident where manual testing deleted real
// production conversations, the test suite must be structurally incapable of touching real data,
// not just careful about it.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// The self-signed cert this app generates is never in the system trust store, so the test
// runner's own fetch() calls need this to talk to it — same tradeoff `curl -k` makes everywhere
// else in this project's manual QA process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// node --test runs each test *file* in its own process, so a simple incrementing counter doesn't
// prevent two files from picking the same port at the same time — pick from a wide random range
// instead, and check the port is actually usable before relying on it (see startTestServer).
function randomPort() {
  return 15000 + crypto.randomInt(0, 45000);
}

// Windows reserves whole ranges of ports for Hyper-V/WSL and will refuse (EACCES) a listener inside
// them, and another test's server may already hold the port. Ask the OS first: a port that can be
// bound to 127.0.0.1 right now is a port this test server can use.
function portIsUsable(port) {
  return new Promise((resolve) => {
    const probe = require('node:net').createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function waitForReady(baseUrl, child) {
  // Generous: on a busy machine (or while the bank's own AMERB AI is running with a model loaded)
  // starting the server and generating its certificate can take a while, and a slow start is not a
  // test failure.
  const deadline = Date.now() + 45000;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server process exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/session`);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not become ready in time: ${lastErr}`);
}

// Starts the app as a child process on a given database file and port, and waits until it answers.
async function spawnServer(dbPath, port, extraEnv = {}) {
  const stderrChunks = [];
  let expectedStop = false;
  const child = spawn('node', [path.join(__dirname, '..', '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      // Test runs write their logs next to the disposable database, not into the real logs/ folder.
      LOG_DIR: `${dbPath}.logs`,
      AMERB_DB_PATH: dbPath,
      PORT: String(port),
      SESSION_SECRET: 'test-secret-not-for-production',
      // Tests never talk to a model, so don't make every test server load one into memory.
      AMERB_SKIP_WARMUP: '1',
      AMERB_SECRET_KEY_PATH: `${dbPath}.key`,
      // Tests must never quietly reach this machine's real Ollama through the model-fallback path
      // (a test that expects a failure would then run a real model and take a minute).
      AMERB_DEFAULT_FALLBACK: 'off',
      // The suite creates far more accounts and sign-ins than a person would; the auth throttle is
      // tested on its own in security.test.js.
      AUTH_RATE_MAX: '100000',
      // Bind IPv4 loopback only, and talk to 127.0.0.1 rather than localhost: on Windows a
      // connection attempt to ::1 can occasionally hang instead of being refused, which made
      // tests fail with a 10-second connect timeout for no real reason.
      HOST: '127.0.0.1',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  // A server that dies mid-test would otherwise show up only as a confusing "fetch failed" in
  // whichever test happened to run next — surface its output instead, so the real cause is visible.
  child.on('exit', (code, signal) => {
    if (expectedStop) return;
    process.stderr.write(
      `\n--- test server on port ${port} exited unexpectedly (code ${code}, signal ${signal}) ---\n` +
        `${Buffer.concat(stderrChunks).toString('utf8')}\n--- end of server output ---\n`
    );
  });
  child.expectedStop = (value) => {
    expectedStop = value;
  };

  try {
    await waitForReady(`https://127.0.0.1:${port}`, child);
  } catch (err) {
    child.expectedStop?.(true); // it never got going; the error below already carries its output
    child.kill();
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    throw new Error(`${err.message}
--- server stderr ---
${stderr}`);
  }
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.expectedStop?.(true);
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

// `env` adds environment variables for the server process (e.g. OLLAMA_URL pointing at a mock).
async function startTestServer({ env = {} } = {}) {
  const dbPath = path.join(os.tmpdir(), `amerb-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  // Try a few ports: some are reserved by Windows, and another test file may be using another.
  let port;
  let child;
  let lastError;
  for (let attempt = 0; attempt < 12 && !child; attempt++) {
    port = randomPort();
    if (!(await portIsUsable(port))) continue;
    try {
      child = await spawnServer(dbPath, port, env);
    } catch (err) {
      lastError = err;
    }
  }
  if (!child) throw lastError || new Error('Could not find a usable port for the test server');

  return {
    baseUrl: `https://127.0.0.1:${port}`,
    dbPath,
    // Direct DB access for fixture setup the API can't do (e.g. backdating timestamps) — a
    // second connection to the same file is safe since better-sqlite/node:sqlite use WAL mode.
    openDb() {
      return new DatabaseSync(dbPath);
    },
    // Stops and starts the app again on the same database and port — like a real restart. The port
    // is waited for: Windows can hold a just-closed listening socket for a moment, and binding it
    // too eagerly would make the restart look like a crash.
    async restart() {
      await stopChild(child);
      for (let attempt = 0; attempt < 40 && !(await portIsUsable(port)); attempt++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      child = await spawnServer(dbPath, port, env);
    },
    async stop() {
      await stopChild(child);
      for (const suffix of ['', '-wal', '-shm', '.key']) {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      }
      fs.rmSync(`${dbPath}.logs`, { recursive: true, force: true });
    },
    // The server's structured log folder, for tests that check what was logged.
    logDir: `${dbPath}.logs`,
  };
}

// Minimal cookie-jar fetch wrapper — the app uses cookie-based sessions, and Node's fetch doesn't
// persist cookies across calls on its own.
//
// Connection attempts are retried: on this project's Windows machines, the FIRST connection to a
// node process that has just started listening is occasionally dropped (ETIMEDOUT / ECONNREFUSED)
// by the local firewall or antivirus, which used to fail a random test once in every few runs even
// though the server was healthy. A retry only happens when no response was received at all, so it
// can't paper over a real failure — a server that really isn't there still fails, just after a few
// hundred more milliseconds.
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']);

function isConnectionDrop(err) {
  if (!err || err.message !== 'fetch failed') return false;
  const cause = err.cause;
  if (!cause) return false;
  if (RETRYABLE_CODES.has(cause.code)) return true;
  return Array.isArray(cause.errors) && cause.errors.some((e) => RETRYABLE_CODES.has(e.code));
}

async function fetchWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt >= 3 || !isConnectionDrop(err) || options.signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 150 * 2 ** attempt));
    }
  }
}

function makeClient(baseUrl) {
  let cookie = null;
  async function request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetchWithRetry(`${baseUrl}${pathname}`, { ...options, headers, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return res;
  }
  return {
    // The session cookie, to carry a login over to another client (e.g. across a restart).
    getCookie: () => cookie,
    setCookie: (value) => {
      cookie = value;
    },
    get: (pathname) => request(pathname),
    post: (pathname, body) =>
      request(pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    patch: (pathname, body) =>
      request(pathname, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }),
    delete: (pathname) => request(pathname, { method: 'DELETE' }),
    // Multipart upload: `files` is [{ name, content }], `fields` extra form fields (e.g. scope).
    upload: (pathname, files, fields = {}) => {
      const form = new FormData();
      for (const f of files) form.append('files', new Blob([f.content], { type: 'text/plain' }), f.name);
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      return request(pathname, { method: 'POST', body: form });
    },
  };
}

module.exports = { startTestServer, makeClient };

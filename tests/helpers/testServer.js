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
// instead, with a retry loop below in case of a genuine collision.
function randomPort() {
  return 20000 + crypto.randomInt(0, 40000);
}

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 20000;
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
async function spawnServer(dbPath, port) {
  const stderrChunks = [];
  const child = spawn('node', [path.join(__dirname, '..', '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      AMERB_DB_PATH: dbPath,
      PORT: String(port),
      SESSION_SECRET: 'test-secret-not-for-production',
      // Tests never talk to a model, so don't make every test server load one into memory.
      AMERB_SKIP_WARMUP: '1',
      AMERB_SECRET_KEY_PATH: `${dbPath}.key`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  try {
    await waitForReady(`https://localhost:${port}`, child);
  } catch (err) {
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
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

async function startTestServer() {
  const dbPath = path.join(os.tmpdir(), `amerb-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  const port = randomPort();
  let child = await spawnServer(dbPath, port);

  return {
    baseUrl: `https://localhost:${port}`,
    dbPath,
    // Direct DB access for fixture setup the API can't do (e.g. backdating timestamps) — a
    // second connection to the same file is safe since better-sqlite/node:sqlite use WAL mode.
    openDb() {
      return new DatabaseSync(dbPath);
    },
    // Stops and starts the app again on the same database and port — like a real restart.
    async restart() {
      await stopChild(child);
      child = await spawnServer(dbPath, port);
    },
    async stop() {
      await stopChild(child);
      for (const suffix of ['', '-wal', '-shm', '.key']) {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      }
    },
  };
}

// Minimal cookie-jar fetch wrapper — the app uses cookie-based sessions, and Node's fetch doesn't
// persist cookies across calls on its own.
function makeClient(baseUrl) {
  let cookie = null;
  async function request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${baseUrl}${pathname}`, { ...options, headers, redirect: 'manual' });
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

// What's going on with this machine and the services AMERB AI depends on: the public /health
// probe (for Docker, uptime monitors and the Windows service check) and the richer status the
// admin Operations dashboard shows.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const db = require('./db');
const logger = require('./logger');
const { OLLAMA_URL } = require('./ollama');
const { checkHealth: checkImageService } = require('./imagegen');
const queue = require('./queue');
const rateLimit = require('./rateLimit');
const modelRouting = require('./modelRouting');

const startedAt = Date.now();

// ---------- CPU load ----------
// os.loadavg() doesn't exist on Windows, so CPU use is measured the same way everywhere: compare
// the CPU time counters between two samples a few seconds apart.

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  return { idle, total };
}

const SAMPLE_MS = 5000;
const HISTORY = 60; // five minutes
const cpuHistory = [];
let lastCpu = cpuTimes();

function sampleCpu() {
  const now = cpuTimes();
  const total = now.total - lastCpu.total;
  const idle = now.idle - lastCpu.idle;
  lastCpu = now;
  if (total <= 0) return;
  cpuHistory.push(Math.round((1 - idle / total) * 100));
  if (cpuHistory.length > HISTORY) cpuHistory.shift();
}

function startSampler() {
  sampleCpu();
  setInterval(sampleCpu, SAMPLE_MS).unref();
}

// ---------- GPU (NVIDIA only; absent on most office machines, and that's fine) ----------

let gpuCache = { at: 0, value: null };

function readGpu() {
  if (Date.now() - gpuCache.at < 5000) return Promise.resolve(gpuCache.value);
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 2500, windowsHide: true },
      (err, stdout) => {
        let value = null;
        if (!err && stdout.trim()) {
          value = stdout
            .trim()
            .split(/\r?\n/)
            .map((line) => {
              const [name, util, used, total, temp] = line.split(',').map((s) => s.trim());
              return { name, utilizationPercent: Number(util), memoryUsedMb: Number(used), memoryTotalMb: Number(total), temperatureC: Number(temp) };
            });
        }
        gpuCache = { at: Date.now(), value };
        resolve(value);
      }
    );
  });
}

// ---------- Ollama ----------

async function ollamaJson(pathname, timeoutMs) {
  const r = await fetch(`${OLLAMA_URL}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
  return r.json();
}

async function readOllama() {
  const started = Date.now();
  try {
    const [version, running, tags] = await Promise.all([
      ollamaJson('/api/version', 2500).catch(() => ({})),
      ollamaJson('/api/ps', 2500).catch(() => ({ models: [] })),
      ollamaJson('/api/tags', 2500),
    ]);
    return {
      reachable: true,
      url: OLLAMA_URL,
      version: version.version || null,
      latencyMs: Date.now() - started,
      installedModels: (tags.models || []).length,
      loadedModels: (running.models || []).map((m) => ({
        name: m.name,
        sizeMb: Math.round((m.size || 0) / 1048576),
        vramMb: Math.round((m.size_vram || 0) / 1048576),
        expiresAt: m.expires_at || null,
      })),
    };
  } catch (err) {
    return { reachable: false, url: OLLAMA_URL, error: err.message };
  }
}

// ---------- Storage ----------

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function dirSize(dir) {
  try {
    return fs.readdirSync(dir).reduce((sum, name) => sum + fileSize(path.join(dir, name)), 0);
  } catch {
    return 0;
  }
}

function readStorage() {
  const dataDir = path.dirname(db.DB_PATH);
  let freeBytes = null;
  let totalBytes = null;
  try {
    const s = fs.statfsSync(dataDir);
    freeBytes = s.bavail * s.bsize;
    totalBytes = s.blocks * s.bsize;
  } catch {
    /* statfs unavailable */
  }
  return {
    databaseBytes: fileSize(db.DB_PATH) + fileSize(`${db.DB_PATH}-wal`),
    logsBytes: dirSize(logger.LOG_DIR),
    diskFreeBytes: freeBytes,
    diskTotalBytes: totalBytes,
  };
}

// ---------- Public health probe ----------

function databaseOk() {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

// `deep` also checks Ollama. A missing Ollama only marks the app "degraded" (still HTTP 200) —
// restarting the app wouldn't fix it, so a container or service supervisor shouldn't try. Pass
// strict to get a 503 for degraded as well, for monitors that want to alert on it.
async function healthCheck({ deep = false, strict = false } = {}) {
  const dbOk = databaseOk();
  const body = {
    status: dbOk ? 'ok' : 'down',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    database: dbOk ? 'ok' : 'error',
  };
  if (deep && dbOk) {
    const ollama = await readOllama();
    body.ollama = ollama.reachable ? 'ok' : 'unreachable';
    if (!ollama.reachable) body.status = 'degraded';
  }
  const httpStatus = !dbOk || (strict && body.status !== 'ok') ? 503 : 200;
  return { httpStatus, body };
}

// ---------- Admin dashboard ----------

async function collectStatus() {
  const [ollama, gpu, imageService] = await Promise.all([readOllama(), readGpu(), checkImageService()]);
  const mem = process.memoryUsage();
  const cpuNow = cpuHistory.length ? cpuHistory[cpuHistory.length - 1] : null;
  return {
    at: new Date().toISOString(),
    app: {
      version: require('../package.json').version,
      node: process.versions.node,
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      memoryMb: Math.round(mem.rss / 1048576),
      service: process.env.AMERB_SERVICE === '1',
    },
    machine: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      cpuCount: os.cpus().length,
      cpuPercent: cpuNow,
      cpuHistory: [...cpuHistory],
      memoryTotalMb: Math.round(os.totalmem() / 1048576),
      memoryUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
      gpus: gpu,
    },
    ollama,
    imageService: {
      ready: Boolean(imageService.ready),
      loading: Boolean(imageService.loading),
      error: imageService.error || null,
    },
    database: { ok: databaseOk() },
    storage: readStorage(),
    queue: queue.stats(),
    rateLimit: rateLimit.stats(),
    modelHealth: modelRouting.healthSnapshot(),
  };
}

module.exports = { startSampler, healthCheck, collectStatus };

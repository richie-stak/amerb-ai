// Structured logging: one JSON object per line in logs/amerb-ai.log, rotated by size so the file
// can never fill the disk. The existing console.* calls throughout the app are captured too
// (captureConsole), so everything the server prints also lands in the file with a timestamp and
// level — and admins can read recent warnings and errors in the admin portal without touching a
// terminal.
//
//   LOG_DIR        where the logs go (default: <project>/logs)
//   LOG_LEVEL      debug | info | warn | error (default: info)
//   LOG_MAX_MB     rotate when the file reaches this size (default: 10)
//   LOG_KEEP       how many rotated files to keep (default: 5)
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'amerb-ai.log');
const MAX_BYTES = (Number(process.env.LOG_MAX_MB) || 10) * 1024 * 1024;
const KEEP = Math.max(1, Number(process.env.LOG_KEEP) || 5);
const minLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

let currentSize = null;
let fileFailed = false;

// Shifts amerb-ai.log -> .1 -> .2 ... and drops the oldest, so disk use is bounded to
// roughly MAX_BYTES * (KEEP + 1).
function rotate() {
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${LOG_FILE}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i + 1}`);
  }
  if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  fs.rmSync(`${LOG_FILE}.${KEEP + 1}`, { force: true });
  currentSize = 0;
}

function writeLine(line) {
  if (fileFailed) return;
  try {
    if (currentSize === null) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      currentSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    }
    const bytes = Buffer.byteLength(line);
    if (currentSize + bytes > MAX_BYTES) rotate();
    fs.appendFileSync(LOG_FILE, line);
    currentSize += bytes;
  } catch (err) {
    // A full disk or a read-only folder must never take the app down — fall back to console only.
    fileFailed = true;
    process.stderr.write(`Logging to ${LOG_FILE} is disabled: ${err.message}\n`);
  }
}

// The console methods as they were before captureConsole replaced them.
const rawConsole = {
  debug: console.debug.bind(console),
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function errorFields(err) {
  return { error: err.message, ...(err.code ? { code: err.code } : {}), stack: String(err.stack || '').split('\n').slice(0, 6).join('\n') };
}

function emit(level, msg, fields = {}, { toConsole = true } = {}) {
  if (LEVELS[level] < minLevel) return;
  const entry = { t: new Date().toISOString(), level, msg: String(msg), ...fields };
  writeLine(`${JSON.stringify(entry)}\n`);
  if (toConsole) {
    const extra = Object.keys(fields).length ? ` ${util.inspect(fields, { breakLength: Infinity, depth: 2 })}` : '';
    (level === 'error' ? rawConsole.error : level === 'warn' ? rawConsole.warn : rawConsole.log)(`${msg}${extra}`);
  }
}

const logger = {
  LOG_DIR,
  LOG_FILE,
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  errorFields,

  // Sends everything the app prints with console.log/warn/error to the log file too, keeping the
  // normal console output exactly as it was.
  captureConsole() {
    const wrap = (level, original) => (...args) => {
      original(...args);
      emit(level, util.format(...args), {}, { toConsole: false });
    };
    console.log = wrap('info', rawConsole.log);
    console.info = wrap('info', rawConsole.info);
    console.warn = wrap('warn', rawConsole.warn);
    console.error = wrap('error', rawConsole.error);
  },

  // Express middleware: one line per API request with its status and duration. Static files and
  // the health probe are skipped, and slow or failed requests are logged at a higher level so
  // they stand out.
  requestLogger(req, res, next) {
    if (!req.originalUrl.startsWith('/api/')) return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 || ms > 30_000 ? 'warn' : 'debug';
      // A streamed chat reply legitimately takes a long time; only flag it when it also failed.
      emit(level === 'warn' && res.statusCode < 400 ? 'info' : level, 'request', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms,
        user: req.session?.userId ?? null,
        ip: String(req.ip || '').replace(/^::ffff:/, ''),
      }, { toConsole: false });
    });
    next();
  },

  // The most recent entries at or above `level` from the current log file (newest first), for the
  // admin portal. Reads only the tail of the file, so it stays fast however large the log is.
  recent({ level = 'warn', limit = 100, contains = '' } = {}) {
    const min = LEVELS[level] || LEVELS.warn;
    let text = '';
    try {
      const size = fs.statSync(LOG_FILE).size;
      const length = Math.min(size, 1024 * 1024);
      const fd = fs.openSync(LOG_FILE, 'r');
      try {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, size - length);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
    const needle = String(contains || '').toLowerCase();
    const entries = [];
    for (const line of text.split('\n').reverse()) {
      if (!line.startsWith('{')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // the first line of a tail read can be cut in half
      }
      if ((LEVELS[entry.level] || 0) < min) continue;
      if (needle && !line.toLowerCase().includes(needle)) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return entries;
  },
};

module.exports = logger;

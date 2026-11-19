const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const logger = require('./logger');
logger.captureConsole();

const express = require('express');
const session = require('express-session');
const db = require('./db');
const { ensureCert, localIPv4Addresses } = require('./certs');
const { runRetentionSweep } = require('./retention');
const { warmUpDefaultModel } = require('./ollama');
const { SqliteSessionStore } = require('./sessionStore');
const { startBackgroundIndexing } = require('./embeddings');
const knowledgeFolders = require('./knowledgeFolders');
const monitor = require('./monitor');
const security = require('./security');
const speech = require('./speech');

const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const chatRoutes = require('./routes/chat');
const modelRoutes = require('./routes/models');
const documentRoutes = require('./routes/documents');
const adminRoutes = require('./routes/admin');
const adminLanguageRoutes = require('./routes/adminLanguage');
const imagegenRoutes = require('./routes/imagegen');
const settingsRoutes = require('./routes/settings');
const speechRoutes = require('./routes/speech');
const promptRoutes = require('./routes/prompts');
const memoryRoutes = require('./routes/memories');
const providerRoutes = require('./routes/providers');
const languageRoutes = require('./routes/languages');

// Last-resort safety net: every route handler is already wrapped (see middleware/asyncHandler),
// but this catches anything that still slips through — without it, an unhandled rejection
// anywhere would silently crash the whole process (and every user's session with it).
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled promise rejection', logger.errorFields(err instanceof Error ? err : new Error(String(err))));
});
// Fail fast: after an uncaught exception the process state is unknown, and continuing risks wrong
// answers or a damaged database. The service (Windows service or systemd) restarts it in seconds.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down so the supervisor restarts a clean process', logger.errorFields(err));
  shutdown(1);
});

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// No version banner, and — when the app sits behind nginx/Caddy/a load balancer — the real client
// address comes from the proxy header, so audit entries and rate limits are not all the proxy's IP.
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
}

// Health probe for Docker, uptime monitors and the Windows service. Public (no login, no session)
// and cheap: ?deep=1 also checks Ollama, ?strict=1 turns "degraded" into an HTTP 503.
app.get('/health', async (req, res) => {
  const { httpStatus, body } = await monitor.healthCheck({ deep: req.query.deep === '1', strict: req.query.strict === '1' });
  res.status(httpStatus).set('Cache-Control', 'no-store').json(body);
});

app.use(logger.requestLogger);
app.use(security.securityHeaders({ publicDir: path.join(__dirname, '..', 'public') }));
app.use(security.crossSiteRequestGuard());
app.use(express.json({ limit: '1mb' }));

app.use(
  session({
    name: 'amerb.sid',
    // Stored in the database, so a server restart doesn't sign everyone out.
    store: new SqliteSessionStore(),
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: true, // the app is HTTPS-only now — never send the session cookie over plain HTTP
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// Sign-in, sign-up and password changes get a per-address throttle on top of the per-account lockout.
app.use(['/api/auth/login', '/api/auth/signup', '/api/auth/me/password'], security.addressRateLimit());
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/models', modelRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/admin/providers', providerRoutes);
app.use('/api/admin/language', adminLanguageRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/imagegen', imagegenRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/speech', speechRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/memories', memoryRoutes);
app.use('/api/languages', languageRoutes);

// Session check used by the frontend to gate the chat page
app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session && req.session.userId) });
});

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Code highlighting and maths rendering are served from node_modules rather than a public CDN,
// so the chat page keeps working on a bank network with no internet access.
const nodeModules = path.join(__dirname, '..', 'node_modules');
app.use('/vendor/katex', express.static(path.join(nodeModules, 'katex', 'dist'), { maxAge: '7d' }));
app.use('/vendor/hljs', express.static(path.join(nodeModules, '@highlightjs', 'cdn-assets'), { maxAge: '7d' }));

// An unknown /api path is a bug or a probe, never a page: answer in JSON.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Any unknown non-API route falls back to the chat app (client-side handles auth redirect)
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Keep API error responses as JSON (e.g. multer file-upload errors) instead of Express's default HTML
// page. Client errors keep their message; server errors never leak internals to the browser — the
// details go to the log, where an administrator can read them.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Upload problems are the user's, not the server's: answer with the reason and the right status
  // instead of an opaque 500.
  if (err && (err.code === 'LIMIT_FILE_SIZE' || /^LIMIT_/.test(String(err.code || '')))) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large. The limit is 20 MB per file, 5 files per message.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Too many files at once. Attach up to 5 files per message.'
          : 'That upload was rejected: ' + (err.message || err.code);
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
  }
  if (err && /Unsupported file type|Unsupported PDF/i.test(String(err.message || ''))) {
    return res.status(400).json({ error: err.message });
  }
  const isClientError = err.status >= 400 && err.status < 500;
  if (!isClientError) {
    logger.error('Request failed', {
      path: req.originalUrl,
      method: req.method,
      ...logger.errorFields(err instanceof Error ? err : new Error(String(err))),
    });
    return res.status(500).json({ error: 'Something went wrong. The administrator can find the details in the server log.' });
  }
  return res.status(err.status).json({ error: err.message || 'Request failed' });
});

const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Graceful shutdown: stop accepting new connections, let in-flight requests finish, close the
// database, then exit. Without this a restart (service update, reboot, Ctrl+C) can cut off a streamed
// answer mid-sentence, or leave a SQLite write half-done. A second signal, or 10 seconds of a stuck
// connection, forces the exit — a supervisor should never be left waiting.
let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { exitCode });
  const force = setTimeout(() => {
    logger.warn('Forced exit after 10 s of shutdown');
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(exitCode || 1);
  }, 10_000);
  force.unref();

  const finish = () => {
    clearTimeout(force);
    try {
      db.close();
      logger.info('Database closed');
    } catch {
      /* already closed */
    }
    process.exit(exitCode);
  };

  if (!activeServer) return finish();
  activeServer.close(finish);
  // Idle keep-alive sockets would otherwise hold the server open for their whole idle timeout. Sockets
  // that are mid-answer are left alone so a streamed reply can finish; whatever is still open when the
  // grace period ends is destroyed by the force timer at the top of this function.
  if (typeof activeServer.closeIdleConnections === 'function') activeServer.closeIdleConnections();
  return undefined;
}

let activeServer = null;
const sockets = new Set();
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

ensureCert()
  .then(({ cert, key }) => {
    const server = https.createServer({ cert, key }, app);
    activeServer = server;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use — is AMERB AI already running? Set PORT in .env to use another.`);
      } else if (err.code === 'EACCES') {
        console.error(`Not allowed to listen on port ${PORT} — on Linux, ports below 1024 need root. Use e.g. PORT=3000.`);
      } else {
        console.error('Could not start the server:', err);
      }
      process.exit(1);
    });
    // HOST=0.0.0.0 (the default) listens on every network interface, so other PCs on the network
    // can reach it by this machine's IP. Set HOST=127.0.0.1 in .env to allow this PC only.
    server.listen(PORT, HOST, () => {
      console.log(`AMERB AI running at:`);
      console.log(`  This computer:  https://localhost:${PORT}`);
      if (HOST === '0.0.0.0' || HOST === '::') {
        // 169.254.x.x addresses are self-assigned when a network adapter has no real connection —
        // nobody can reach the server through them, so listing them would only confuse.
        for (const ip of localIPv4Addresses().filter((a) => !a.startsWith("169.254."))) {
          console.log(`  On the network: https://${ip}:${PORT}`);
        }
      } else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
        console.log(`  On the network: https://${HOST}:${PORT}`);
      }
      logger.info('AMERB AI started', { port: PORT, host: HOST, pid: process.pid, node: process.versions.node, logFile: logger.LOG_FILE });
      monitor.startSampler();
      // Keeps data/knowledge/<base>/ folders in step with the database (one copy per knowledge base).
      knowledgeFolders.startBackgroundSync();
      runRetentionSweep();
      setInterval(runRetentionSweep, RETENTION_SWEEP_INTERVAL_MS).unref();
      if (!process.env.AMERB_SKIP_WARMUP) {
        warmUpDefaultModel();
        // Builds meaning-based search for any documents not indexed yet, then keeps up with new ones.
        startBackgroundIndexing();
      }
    });
  })
  .catch((err) => {
    console.error('Could not start HTTPS server — failed to load/generate a TLS certificate:', err);
    process.exit(1);
  });

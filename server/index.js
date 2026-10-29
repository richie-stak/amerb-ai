const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const express = require('express');
const session = require('express-session');
const { ensureCert, localIPv4Addresses } = require('./certs');
const { runRetentionSweep } = require('./retention');
const { warmUpDefaultModel } = require('./ollama');

const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const chatRoutes = require('./routes/chat');
const modelRoutes = require('./routes/models');
const documentRoutes = require('./routes/documents');
const adminRoutes = require('./routes/admin');
const imagegenRoutes = require('./routes/imagegen');
const settingsRoutes = require('./routes/settings');
const speechRoutes = require('./routes/speech');
const promptRoutes = require('./routes/prompts');
const memoryRoutes = require('./routes/memories');
const providerRoutes = require('./routes/providers');

// Last-resort safety net: every route handler is already wrapped (see middleware/asyncHandler),
// but this catches anything that still slips through — without it, an unhandled rejection
// anywhere would silently crash the whole process (and every user's session with it).
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '1mb' }));

app.use(
  session({
    name: 'amerb.sid',
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

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/models', modelRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/admin/providers', providerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/imagegen', imagegenRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/speech', speechRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/memories', memoryRoutes);

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

// Any unknown non-API route falls back to the chat app (client-side handles auth redirect)
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Keep API error responses as JSON (e.g. multer file-upload errors) instead of Express's default HTML page.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ error: err.message || 'Request failed' });
});

const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

ensureCert()
  .then(({ cert, key }) => {
    const server = https.createServer({ cert, key }, app);
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
      runRetentionSweep();
      setInterval(runRetentionSweep, RETENTION_SWEEP_INTERVAL_MS).unref();
      if (!process.env.AMERB_SKIP_WARMUP) warmUpDefaultModel();
    });
  })
  .catch((err) => {
    console.error('Could not start HTTPS server — failed to load/generate a TLS certificate:', err);
    process.exit(1);
  });

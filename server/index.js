const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const express = require('express');
const session = require('express-session');
const { ensureCert } = require('./certs');
const { runRetentionSweep } = require('./retention');

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
app.use('/api/admin', adminRoutes);
app.use('/api/imagegen', imagegenRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/speech', speechRoutes);
app.use('/api/prompts', promptRoutes);

// Session check used by the frontend to gate the chat page
app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session && req.session.userId) });
});

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

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
    https.createServer({ cert, key }, app).listen(PORT, () => {
      console.log(`AMERB AI running at https://localhost:${PORT}`);
      runRetentionSweep();
      setInterval(runRetentionSweep, RETENTION_SWEEP_INTERVAL_MS).unref();
    });
  })
  .catch((err) => {
    console.error('Could not start HTTPS server — failed to load/generate a TLS certificate:', err);
    process.exit(1);
  });

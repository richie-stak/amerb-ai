// Production hardening that applies to every request: security headers, a cross-site request guard,
// and a per-address throttle for the authentication endpoints.
//
// Written by hand rather than adding helmet: the app has exactly one page per route, no CDN, and a
// handful of inline theme scripts — so the Content Security Policy can be genuinely strict (hashes,
// not 'unsafe-inline' for scripts) and there is no third-party dependency to keep patched.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('./logger');

// The policy for the app itself. `connect-src 'self'` means even if a script were somehow injected it
// could not exfiltrate data anywhere; `frame-ancestors 'none'` stops the bank's app being framed for
// clickjacking; object-src/base-uri/form-action close the classic bypasses.
function contentSecurityPolicy(publicDir) {
  const hashes = inlineScriptHashes(publicDir);
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.map((h) => ` 'sha256-${h}'`).join('')}`,
    // Inline *style attributes* are used throughout the UI (and KaTeX emits them), so styles stay
    // permissive; scripts — the part that matters — do not.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Every inline <script> in the served pages, hashed so the browser will run exactly those and nothing
// else. They are static files, so this is computed once at startup.
function inlineScriptHashes(publicDir) {
  const hashes = [];
  let files = [];
  try {
    files = fs.readdirSync(publicDir).filter((name) => name.endsWith('.html'));
  } catch {
    return hashes;
  }
  for (const file of files) {
    let html = '';
    try {
      html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const body = match[1];
      if (!body.trim()) continue;
      hashes.push(crypto.createHash('sha256').update(body, 'utf8').digest('base64'));
    }
  }
  return [...new Set(hashes)];
}

function securityHeaders({ publicDir, httpsOnly = true }) {
  const csp = contentSecurityPolicy(publicDir);
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The microphone is used by the voice-input button; nothing else is.
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (httpsOnly) {
      // No includeSubDomains: this app is one host, and coercing its siblings would be somebody
      // else's decision.
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    // API responses carry people's conversations and settings; they must never sit in a shared cache.
    if (req.path.startsWith('/api/') || req.path === '/health') {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}

// Defence in depth behind the SameSite=Lax session cookie: any state-changing request that a browser
// says came from another site is refused. Requests without an Origin header (curl, the launcher's own
// health probe, the test suite) are allowed — the cookie is what authenticates them anyway.
function crossSiteRequestGuard() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin) return next();
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: 'Request blocked: invalid origin' });
    }
    const expected = req.get('host');
    if (host !== expected) {
      logger.warn('Blocked a cross-site request', { origin, host: expected, path: req.path, method: req.method });
      return res.status(403).json({ error: 'Request blocked: cross-site requests are not allowed' });
    }
    return next();
  };
}

// Per-address limiter for the endpoints an attacker would hammer: sign-in, sign-up and password
// changes. The per-account lockout already exists; this stops one machine from spraying many accounts
// (or filling the audit log) at speed.
function addressRateLimit({ windowMs = Number(process.env.AUTH_RATE_WINDOW_MS) || 15 * 60 * 1000, max = Number(process.env.AUTH_RATE_MAX) || 30 } = {}) {
  const hits = new Map(); // ip -> [timestamps]
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, list] of hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => t > now - windowMs);
    if (list.length >= max) {
      const retryAfter = Math.ceil((list[0] + windowMs - now) / 1000);
      logger.warn('Authentication rate limit hit', { ip, path: req.path, retryAfter });
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Too many attempts from this computer. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` });
    }
    list.push(now);
    hits.set(ip, list);
    return next();
  };
}

// A limiter keyed by whatever identifies the caller best for the endpoint in question (a user id for
// uploads, an address for sign-in). Same sliding-window idea as addressRateLimit.
function keyedRateLimit({ key, windowMs = 15 * 60 * 1000, max = 60, message }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, list] of hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const k = typeof key === 'function' ? key(req) : key;
    if (!k) return next();
    const now = Date.now();
    const list = (hits.get(k) || []).filter((t) => t > now - windowMs);
    if (list.length >= max) {
      const retryAfter = Math.ceil((list[0] + windowMs - now) / 1000);
      logger.warn('Rate limit hit', { key: String(k).slice(0, 40), path: req.path, retryAfter });
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message || `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` });
    }
    list.push(now);
    hits.set(k, list);
    return next();
  };
}

module.exports = {
  securityHeaders,
  crossSiteRequestGuard,
  addressRateLimit,
  keyedRateLimit,
  inlineScriptHashes,
  contentSecurityPolicy,
};

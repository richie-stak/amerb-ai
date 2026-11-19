'use strict';
// Container health probe: GET https://127.0.0.1:$PORT/health must answer 200 with {"status":"ok"}.
// The server's HTTPS certificate is self-signed, so verification is skipped for this single
// loopback request only. (Slim images have no curl; node is always there.) Exit 0 = healthy.
const https = require('node:https');

const req = https.get(
  { host: '127.0.0.1', port: Number(process.env.PORT) || 3000, path: '/health', rejectUnauthorized: false, timeout: 4000 },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy(new Error('response too large'));
    });
    res.on('end', () => {
      let ok = false;
      try {
        ok = res.statusCode === 200 && JSON.parse(body).status === 'ok';
      } catch {
        /* not JSON -> unhealthy */
      }
      process.exit(ok ? 0 : 1);
    });
  }
);
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));

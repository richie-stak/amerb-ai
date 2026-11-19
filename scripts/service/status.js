// Shows whether the "AMERB AI" Windows service is installed/running. Works without Administrator.
//
//   npm run service:status
//
// Exit code: 0 = installed and running, 1 = installed but not running, 2 = not installed.
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { ROOT, SERVICE_NAME, SERVICE_ID, requireWindows, sc, queryService, parseArgs } = require('./common');

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp(__filename);
  process.exit(0);
}

requireWindows('Service status');

// PORT from the environment, else from .env, else 3000.
function configuredPort() {
  if (process.env.PORT) return process.env.PORT;
  try {
    return (/^\s*PORT\s*=\s*(\d+)/m.exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')) || [])[1] || '3000';
  } catch {
    return '3000';
  }
}

function probe(port) {
  return new Promise((resolve) => {
    // Self-signed certificate: this single probe to our own server on 127.0.0.1 skips verification.
    const req = https.get(`https://127.0.0.1:${port}/health`, { rejectUnauthorized: false, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ error: err.code || err.message }));
  });
}

(async () => {
  const s = queryService();
  const logFile = path.join(ROOT, 'logs', 'service.log');
  console.log(`Service : ${SERVICE_NAME}  (Windows service name "${SERVICE_ID}")`);

  if (!s.installed) {
    console.log('Installed: no');
    console.log('\nInstall it from an Administrator terminal:  npm run service:install   (or double-click install-service.bat)');
    process.exit(2);
  }

  console.log('Installed: yes');
  console.log(`State    : ${s.state}`);
  const qc = sc(['qc', SERVICE_ID]).out;
  const start = /START_TYPE\s*:\s*\d+\s+(.+)/.exec(qc)?.[1]?.trim();
  const account = /SERVICE_START_NAME\s*:\s*(.+)/.exec(qc)?.[1]?.trim();
  if (start) console.log(`Start    : ${start}`);
  if (account) console.log(`Account  : ${account}`);
  const failure = sc(['qfailure', SERVICE_ID]).out;
  const actions = [...failure.matchAll(/RESTART -- Delay = (\d+) milliseconds/g)].map((m) => `${Number(m[1]) / 1000}s`);
  if (actions.length) console.log(`Recovery : restart after ${actions.join(', ')}`);

  if (s.state === 'RUNNING') {
    const port = configuredPort();
    const h = await probe(port);
    if (h.status) console.log(`Health   : https://localhost:${port}/health -> HTTP ${h.status} ${h.body.replace(/\s+/g, ' ')}`);
    else console.log(`Health   : https://localhost:${port}/health not reachable yet (${h.error}) — it can take 30-60 s after start`);
  }
  console.log(`Logs     : ${fs.existsSync(logFile) ? logFile : `${logFile} (not created yet)`}  and  ${path.join(ROOT, 'daemon')}`);
  process.exit(s.state === 'RUNNING' ? 0 : 1);
})();

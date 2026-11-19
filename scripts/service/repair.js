// Repairs an "AMERB AI" Windows service that was installed but never finished installing: applies
// the start type and crash-restart policy that install.js sets after registration, starts the
// service, and checks that the app actually answers. Safe to run more than once.
//
//   repair-service.bat                       (self-elevates)
//   npm run service:repair                   (from an Administrator terminal)
//   npm run service:repair -- --no-start     only fix the settings, don't start it
//   npm run service:repair -- --refresh-certificate   also re-issue the HTTPS certificate for this
//                             machine's current addresses (staff PCs then need to trust the new one)
//   npm run service:repair -- --help
//
// Why this exists: node-windows reports "installed" through a console line from winsw.exe. If that
// line is missed (slow disk, antivirus, an elevated window that closed early) the service is
// registered but left with the default Automatic start type and no recovery actions — exactly the
// half-finished state this repairs.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { ROOT, SERVICE_NAME, SERVICE_ID, requireWindows, requireAdmin, isAdmin, sc, queryService, parseArgs, printHelp } = require('./common');
const networking = require('../networking');

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp(__filename);
  process.exit(0);
}

requireWindows('The service repair tool');

function configuredPort() {
  if (process.env.PORT) return process.env.PORT;
  try {
    return (/^\s*PORT\s*=\s*(\d+)/m.exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')) || [])[1] || '3000';
  } catch {
    return '3000';
  }
}

// Which process holds a TCP port (from netstat -ano), so a conflict gets a precise message instead
// of "the service keeps restarting".
function portOwner(port) {
  const netstat = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true });
  return new Promise((resolve) => {
    let text = '';
    netstat.stdout.on('data', (c) => (text += c));
    netstat.on('close', () => {
      const line = text
        .split(/\r?\n/)
        .find((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l));
      const pid = line ? Number(line.trim().split(/\s+/).pop()) : null;
      if (!pid) return resolve(null);
      const info = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      let detail = '';
      info.stdout.on('data', (c) => (detail += c));
      info.on('close', () => resolve({ pid, detail: detail.replace(/["\r\n]/g, ' ').trim() }));
      return undefined;
    });
    netstat.on('error', () => resolve(null));
  });
}

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = https.get(`https://127.0.0.1:${port}/health`, { rejectUnauthorized: false, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: body.trim().slice(0, 200) }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ error: err.code || err.message }));
  });
}

function step(ok, text) {
  console.log(`  ${ok ? '[ok]' : '[!!]'} ${text}`);
  return ok;
}

function runSc(label, scArgs) {
  const r = sc(scArgs);
  return step(r.status === 0, `${label}${r.status === 0 ? '' : ` — failed: ${r.out.split('\n').pop()}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const before = queryService();
  console.log(`Repairing Windows service "${SERVICE_NAME}" (${SERVICE_ID})…`);
  if (!before.installed) {
    console.error(`\n[!] The service is not installed, so there is nothing to repair.`);
    console.error('    Install it first:  install-service.bat   (or npm run service:install)');
    process.exit(2);
  }
  if (!isAdmin()) {
    requireAdmin('repair'); // prints the elevation help and exits
  }

  step(true, `service is registered (state: ${before.state})`);

  // 1. Start type: Automatic (Delayed Start), so it comes up after the network is ready — Ollama
  //    often needs a few seconds after boot, and a delayed start avoids racing it.
  runSc('start type: Automatic (Delayed Start)', ['config', SERVICE_ID, 'start=', 'delayed-auto']);

  // 2. Restart the wrapper if it dies: 5 s, then 15 s, then every 60 s; counter resets daily.
  runSc('recovery: restart after 5 s / 15 s / 60 s', [
    'failure',
    SERVICE_ID,
    'reset=',
    '86400',
    'actions=',
    'restart/5000/restart/15000/restart/60000',
  ]);

  // 3. Treat a stop with a non-zero exit code as a failure too, not only a process crash.
  runSc('recovery also on non-zero exit codes', ['failureflag', SERVICE_ID, '1']);

  const port = configuredPort();
  if (args['no-start']) {
    console.log(`\nSettings repaired, not started (--no-start). Start it with:  net start "${SERVICE_ID}"`);
    process.exit(0);
  }

  // 4. The port has to be free: a copy started by start.bat (or a leftover node process) holding
  //    3000 makes the service fail with EADDRINUSE and restart forever, which looks like a broken
  //    install rather than a port conflict.
  if (before.state !== 'RUNNING') {
    const owner = await portOwner(port);
    if (owner) {
      const isOurService = /amerbai/i.test(owner.detail);
      if (!isOurService) {
        console.error(
          `\n[!] Port ${port} is already in use by another process (pid ${owner.pid}: ${owner.detail || 'unknown'}).\n` +
            '    That is almost always a copy of AMERB AI started by start.bat, or a node server left running.\n' +
            '    Close it (Ctrl+C in its window, or: taskkill /pid ' +
            owner.pid +
            ' /T /F), then run this again.'
        );
        process.exit(3);
      }
    }
  }

  // 5. Let other computers connect: a firewall rule for the port, so staff on the network are not
  //    blocked by Windows asking (or silently dropping) the connection.
  networking.allowThroughWindowsFirewall(port);

  // 6. The certificate is issued for the addresses this machine had when it was generated. If an
  //    address changed, browsers warn on it; --refresh-certificate re-issues it for the current ones.
  if (args['refresh-certificate'] || args.refreshCertificate) {
    const backup = path.join(ROOT, `certs.backup-${new Date().toISOString().slice(0, 10)}`);
    const certs = path.join(ROOT, 'certs');
    if (fs.existsSync(certs)) {
      fs.rmSync(backup, { recursive: true, force: true });
      fs.cpSync(certs, backup, { recursive: true });
      fs.rmSync(certs, { recursive: true, force: true });
      step(true, `old certificate backed up to ${path.basename(backup)} and removed — a new one is generated on start`);
      step(true, 'staff PCs that trusted the old certificate will need to trust the new certs\\server.cert');
    }
  }

  // 7. Start it and wait for the real state, not just for the request to be accepted.
  if (before.state === 'RUNNING') {
    step(true, 'service is already running');
  } else {
    console.log('Starting the service…');
    const started = sc(['start', SERVICE_ID]);
    if (started.status !== 0 && !/already running/i.test(started.out)) {
      step(false, `could not start it: ${started.out.split('\n').pop()}`);
    }
    let state = before.state;
    for (let i = 0; i < 30 && state !== 'RUNNING'; i++) {
      await sleep(1000);
      state = queryService().state;
    }
    step(state === 'RUNNING', `service state: ${state}`);
    if (state !== 'RUNNING') {
      console.error(`\n    The service is not running. Check the wrapper log: ${path.join(ROOT, 'daemon')}`);
      process.exit(1);
    }
  }

  // 6. The service being "running" only means the wrapper started; the app itself needs 20-60 s
  //    (loads the model, generates the certificate, starts the image service).
  let health = { error: 'not checked' };
  for (let i = 0; i < 12; i++) {
    health = await probeHealth(port);
    if (health.status === 200) break;
    await sleep(5000);
  }
  if (health.status === 200) {
    step(true, `health: https://localhost:${port}/health -> HTTP 200 ${health.body}`);
  } else {
    step(false, `the service is running but the app is not answering yet at https://localhost:${port}/health (${health.error || `HTTP ${health.status}`})`);
    console.log(`\n    Check ${path.join(ROOT, 'logs', 'service.log')} — the most common cause is Ollama not being`);
    console.log('    reachable from the service account (see docs/WINDOWS-SERVICE.md, "Which account should it run as?").');
  }

  networking.printAccessInfo({ port });

  console.log(`Logs: ${path.join(ROOT, 'logs', 'service.log')}  and  ${path.join(ROOT, 'daemon')}`);
  console.log('Status any time:  npm run service:status');
  process.exit(health.status === 200 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[!] ${err.stack || err.message}`);
  process.exit(1);
});

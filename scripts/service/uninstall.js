// Stops and removes the "AMERB AI" Windows service (the app files, data/ and logs/ are left alone).
//
//   npm run service:uninstall          (from an Administrator terminal)
//   uninstall-service.bat              (self-elevates)
//
// Options: --help
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, SERVICE_NAME, SERVICE_ID, requireWindows, requireAdmin, sc, queryService, createService, parseArgs, printHelp } = require('./common');

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp(__filename);
  process.exit(0);
}

requireWindows('The Windows service uninstaller');
requireAdmin('remove');

const svc = createService();
const before = queryService();

if (!before.installed && !svc.exists) {
  console.log(`The service "${SERVICE_NAME}" (${SERVICE_ID}) is not installed — nothing to do.`);
  process.exit(0);
}

console.log(`Removing Windows service "${SERVICE_NAME}" (currently ${before.installed ? before.state : 'not registered, only files left'})...`);

function finish(ok, message) {
  clearTimeout(timeout);
  (ok ? console.log : console.error)(message);
  process.exit(ok ? 0 : 1);
}

function verifyGone() {
  // Windows may keep the entry "marked for deletion" for a moment; give it a few seconds.
  let tries = 0;
  const check = setInterval(() => {
    tries += 1;
    const now = queryService();
    if (!now.installed) {
      clearInterval(check);
      finish(true, `Done. The service "${SERVICE_NAME}" has been removed. Logs in ${path.join(ROOT, 'logs')} were kept.`);
    } else if (tries >= 15) {
      clearInterval(check);
      finish(false, `[!] The service still shows as ${now.state}. If it is "marked for deletion", close services.msc / Task Manager and it disappears; otherwise run: sc delete "${SERVICE_ID}"`);
    }
  }, 1000);
}

const timeout = setTimeout(() => finish(false, '[!] Timed out waiting for the service to be removed. Check `npm run service:status`.'), 120000);

if (svc.exists) {
  svc.on('uninstall', verifyGone);
  svc.on('alreadyuninstalled', verifyGone);
  svc.on('error', (err) => console.error(`[!] ${err && err.message ? err.message : err}`));
  svc.uninstall(); // stops the service first, then removes it and the daemon\ files
} else {
  // Registered in Windows but the daemon\ files are gone (folder moved/cleaned): remove it directly.
  console.log('daemon\\ files are missing — removing the registration with sc.exe.');
  sc(['stop', SERVICE_ID]);
  setTimeout(() => {
    const r = sc(['delete', SERVICE_ID]);
    if (r.status !== 0) finish(false, `[!] sc delete failed: ${r.out}`);
    verifyGone();
  }, 3000);
}

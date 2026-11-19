// Shared helpers for install.js / uninstall.js / status.js (Windows service via node-windows).
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVICE_NAME = 'AMERB AI'; // display name in services.msc
const SERVICE_DESCRIPTION = 'AMERB AI - locally hosted chat assistant (Node.js server + Ollama + optional image service). Starts at boot and restarts on failure.';
// node-windows derives the Windows service name from the display name: letters/digits only,
// lower-cased, plus ".exe" ("AMERB AI" -> "amerbai.exe"). `sc`/`net` commands use this name.
const SERVICE_ID = `${SERVICE_NAME.replace(/[^\w]/gi, '').toLowerCase()}.exe`;

function requireWindows(what) {
  if (process.platform !== 'win32') {
    console.error(`${what} is for Windows only. On Linux use the systemd unit: sudo deploy/install-systemd.sh  (see docs/WINDOWS-SERVICE.md).`);
    process.exit(1);
  }
}

// Administrator check that never pops up a UAC prompt. (node-windows' own isAdminUser() falls back
// to an *elevation request* when it isn't admin, which is not what we want for a plain check.)
// `fltmc` only succeeds in an elevated process; `net session` is the fallback.
function isAdmin() {
  const probe = (cmd, args) => {
    try {
      return spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true }).status === 0;
    } catch {
      return false;
    }
  };
  return probe('fltmc', []) || probe('net', ['session']);
}

function requireAdmin(action) {
  if (isAdmin()) return;
  const wrapper = { install: 'install-service.bat', remove: 'uninstall-service.bat', repair: 'repair-service.bat' }[action] || 'install-service.bat';
  console.error(
    [
      '',
      `[!] Administrator rights are required to ${action} a Windows service.`,
      '',
      '    Re-run from an elevated terminal (right-click Command Prompt / PowerShell -> "Run as administrator"),',
      `    in ${ROOT}`,
      '    or just double-click the wrapper, which asks for elevation by itself:',
      `      ${wrapper}`,
      '',
    ].join('\n')
  );
  process.exit(1);
}

// Runs sc.exe (works without admin for "query"/"qc", needs admin for config/failure).
function sc(args) {
  const result = spawnSync('sc.exe', args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

// Returns { installed, state: 'RUNNING'|'STOPPED'|'START_PENDING'|..., raw } for our service.
function queryService() {
  const result = sc(['query', SERVICE_ID]);
  if (result.status !== 0) {
    // 1060 = "The specified service does not exist as an installed service"
    return { installed: false, state: null, raw: result.out };
  }
  const state = /STATE\s*:\s*\d+\s+(\w+)/.exec(result.out)?.[1] || 'UNKNOWN';
  return { installed: true, state, raw: result.out };
}

// Build the node-windows Service for this project. `opts.user` / `opts.password` set the logon account.
function createService(opts = {}) {
  const { Service } = require('node-windows');
  const svc = new Service({
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    script: path.join(ROOT, 'scripts', 'launch.js'),
    scriptOptions: '--service',
    workingDirectory: ROOT,
    env: [{ name: 'AMERB_SERVICE', value: '1' }],
    // Crash-restart policy of node-windows' wrapper (it re-forks launch.js whenever it exits):
    //  - first restart after 5 s; each further restart waits 5% longer than the last. The wrapper never
    //    resets this growth, so keep it small: 5 s -> ~57 s after 50 crashes, ~11 min after 100.
    //  - maxRestarts: give up only if the script starts more than 20 times within 60 s. With the wait above
    //    that can't happen, so in practice the wrapper keeps trying forever (which is what we want).
    //  - abortOnError false: a non-zero exit never makes the wrapper stop.
    wait: 5,
    grow: 0.05,
    maxRestarts: 20,
    abortOnError: false,
    // Lets the service stop cleanly: the wrapper sends launch.js a "shutdown" message (which kills the
    // whole server/image-service tree) instead of a hard kill that would leave node/python orphans.
    stopparentfirst: true,
    stoptimeout: 30,
    logging: { mode: 'roll-by-size', sizeThreshold: 10240, keepFiles: 5 },
    allowServiceLogon: Boolean(opts.user),
  });
  // Put the daemon\ folder (winsw exe, xml, wrapper logs) in the project root rather than next to launch.js.
  svc.directory(ROOT);
  if (opts.user) {
    const { domain, account } = splitUser(opts.user);
    svc.logOnAs.domain = domain;
    svc.logOnAs.account = account;
    svc.logOnAs.password = opts.password;
  }
  return svc;
}

// "DOMAIN\name" -> {domain:'DOMAIN', account:'name'}; ".\name" or "name" -> this computer.
function splitUser(user) {
  user = String(user).trim().replace(/\\{2,}/g, '\\'); // tolerate "DOMAIN\\name" copied from JSON/docs
  const m = /^(.*)\\(.+)$/.exec(user);
  if (m) return { domain: m[1] || '.', account: m[2] };
  const upn = /^(.+)@(.+)$/.exec(user); // user@domain.local
  if (upn) return { domain: upn[2], account: upn[1] };
  return { domain: '.', account: user };
}

// Minimal "--flag", "--key value" and "--key=value" parser (no dependencies).
function parseArgs(argv, valueFlags = []) {  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    if (eq !== -1) out[key] = arg.slice(eq + 1);
    else if (valueFlags.includes(key)) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

module.exports = { ROOT, SERVICE_NAME, SERVICE_ID, requireWindows, requireAdmin, isAdmin, sc, queryService, createService, splitUser, parseArgs, printHelp };

// Prints the comment block at the top of a script (everything before the first line of code) as its
// --help text, so each script documents itself in one place.
function printHelp(file) {
  const fs = require('node:fs');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const block = [];
  for (const line of lines) {
    if (!line.startsWith('//')) break;
    block.push(line.slice(2).replace(/^ /, ''));
  }
  console.log(block.join('\n').trimEnd());
}

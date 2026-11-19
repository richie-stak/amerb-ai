// Installs AMERB AI as a Windows service ("AMERB AI") that starts at boot and restarts on failure.
//
//   npm run service:install                     (from an Administrator terminal)
//   npm run service:install -- --user "DOMAIN\name" --password "..."
//   npm run service:install -- --no-start
//   install-service.bat                         (self-elevates)
//
// Options:
//   --user "DOMAIN\name"   run the service as this account instead of LocalSystem (".\name" = local user).
//                          Use the account that installed Ollama if Ollama is a per-user install.
//   --password "..."       the account's password (or set AMERB_SERVICE_PASSWORD; if neither is given and
//                          this is an interactive terminal you are asked for it).
//   --no-start             install only; don't start the service now.
//   --dry-run              print what would be installed and exit (works without Administrator).
//   --help
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, SERVICE_NAME, SERVICE_ID, requireWindows, requireAdmin, sc, queryService, createService, parseArgs, printHelp } = require('./common');
const networking = require('../networking');

const args = parseArgs(process.argv.slice(2), ['user', 'password']);

if (args.help || args.h) {
  printHelp(__filename);
  process.exit(0);
}

requireWindows('The Windows service installer');

function prompt(question, hidden) {
  return new Promise((resolve) => {
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// node-windows' winsw.js has a leftover debug console.log that dumps the whole config — including the
// service-account password — while the XML is generated. Drop just that call.
const realLog = console.log;
console.log = (...a) => {
  if (a[0] && typeof a[0] === 'object' && String(a[0].loc || '').startsWith('winsw.js')) return;
  realLog(...a);
};

function step(ok, text) {
  console.log(`  ${ok ? '[ok]' : '[!!]'} ${text}`);
}

function runSc(label, scArgs) {
  const r = sc(scArgs);
  step(r.status === 0, `${label}${r.status === 0 ? '' : ` — failed: ${r.out.split('\n').pop()}`}`);
  return r.status === 0;
}

async function main() {
  let user = args.user === true ? '' : args.user;
  let password = args.password === true ? '' : args.password || process.env.AMERB_SERVICE_PASSWORD;
  if (user && !password) {
    if (!process.stdin.isTTY) {
      console.error('[!] --user needs --password (or the AMERB_SERVICE_PASSWORD environment variable).');
      process.exit(1);
    }
    password = await prompt(`Password for ${user}: `, true);
  }
  if (args.user === true || (args.password && !user)) {
    console.error('[!] Use --user "DOMAIN\\name" together with --password "...".');
    process.exit(1);
  }

  const svc = createService({ user, password });

  if (args['dry-run']) {
    console.log(`Would install Windows service "${SERVICE_NAME}" (service name ${SERVICE_ID}):`);
    console.log(`  node         : ${process.execPath}`);
    console.log(`  script       : ${svc.script} --service  (via node-windows wrapper)`);
    console.log(`  working dir  : ${ROOT}`);
    console.log(`  daemon files : ${svc.root}`);
    console.log(`  account      : ${user || 'LocalSystem (default)'}`);
    console.log(`  start now    : ${args['no-start'] ? 'no' : 'yes'}`);
    console.log('\n--- winsw XML ---\n' + svc._xml.replace(/<password>.*?<\/password>/g, '<password>********</password>'));
    console.log('\nThen: sc config start= delayed-auto, sc failure (restart after 5 s / 15 s / 60 s), sc failureflag 1.');
    process.exit(0);
  }

  requireAdmin('install');

  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'node-windows', 'bin', 'winsw', 'winsw.exe'))) {
    console.error('[!] node-windows is not fully installed. Run "npm install" in the project folder first.');
    process.exit(1);
  }
  const existing = queryService();
  if (existing.installed || svc.exists) {
    console.error(`[!] The service "${SERVICE_NAME}" (${SERVICE_ID}) is already installed${existing.installed ? ` (state: ${existing.state})` : ' (files in daemon\\ exist)'}.`);
    console.error('    To reinstall (e.g. after moving the folder, updating Node.js or changing the account) run: npm run service:uninstall   and then install again.');
    process.exit(1);
  }

  console.log(`Installing Windows service "${SERVICE_NAME}"...`);
  console.log(`  node: ${process.execPath}`);
  console.log(`  app : ${ROOT}`);
  console.log(`  as  : ${user || 'LocalSystem (default)'}`);

  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    process.exit(code);
  };

  const timeout = setTimeout(() => {
    // Registration may well have happened even though node-windows never reported it (it relies on
    // matching a console line from winsw.exe). Say so, and point at the repair tool, rather than
    // leaving a registered-but-unconfigured service behind without explanation.
    const state = queryService();
    if (state.installed) {
      console.error(
        `\n[!] node-windows did not confirm the installation, but the service IS registered (state: ${state.state}).\n` +
          '    Its start type and crash-restart policy may not have been applied. Finish it with:\n' +
          '      repair-service.bat        (or: npm run service:repair)\n'
      );
    } else {
      console.error('[!] Timed out waiting for the installation to finish. Check daemon\\ for logs and `npm run service:status`.');
    }
    finish(1);
  }, 120000);

  svc.on('alreadyinstalled', () => {
    console.error('[!] Already installed.');
    finish(1);
  });
  svc.on('invalidinstallation', () => {
    console.error('[!] A broken installation exists in daemon\\ — run `npm run service:uninstall` first.');
    finish(1);
  });
  svc.on('error', (err) => {
    console.error(`[!] ${err && err.message ? err.message : err}`);
  });

  // The steps below are what makes the service come back by itself: start at boot (delayed), and
  // restart after a crash. They run once registration is seen — from node-windows' event, or from
  // the poller at the bottom if that event never arrives.
  let configured = false;
  const configure = () => {
    if (configured) return false;
    configured = true;

    // Start type: Automatic (Delayed Start) — comes up after the network and other boot services are ready.
    runSc('start type: Automatic (Delayed Start)', ['config', SERVICE_ID, 'start=', 'delayed-auto']);
    // If the winsw wrapper itself dies, Windows restarts it: after 5 s, 15 s, then every 60 s; counter resets after a day.
    runSc('recovery: restart after 5 s / 15 s / 60 s', ['failure', SERVICE_ID, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000']);
    // Also treat "stopped with a non-zero exit code" as a failure, not only a crash of the process.
    runSc('recovery also on non-zero exit codes', ['failureflag', SERVICE_ID, '1']);

    // Let the other computers on the network reach it, so nobody has to open the port by hand.
    const port = Number(process.env.PORT || 3000);
    networking.allowThroughWindowsFirewall(port);
    return true;
  };

  svc.on('install', () => {
    const state = queryService();
    if (!state.installed) {
      console.error(`[!] winsw did not register the service. See ${path.join(svc.root, SERVICE_ID.replace(/\.exe$/, '') + '.wrapper.log')} and the output above.`);
      finish(1);
      return;
    }
    step(true, `service registered as "${SERVICE_ID}" (display name "${SERVICE_NAME}")`);
    configure();

    // winsw keeps the account password in plain text in daemon\<id>.xml; it is only needed by `install`.
    if (user) {
      try {
        const xmlFile = path.join(svc.root, `${SERVICE_ID.replace(/\.exe$/, '')}.xml`);
        fs.writeFileSync(xmlFile, fs.readFileSync(xmlFile, 'utf8').replace(/<password>.*?<\/password>/gs, '<password></password>'));
        step(true, 'service-account password removed from the daemon XML file');
      } catch (err) {
        step(false, `could not remove the password from the daemon XML (${err.message}) — delete the <password> line yourself`);
      }
    }

    if (args['no-start']) {
      clearTimeout(timeout);
      console.log('\nInstalled, not started (--no-start). Start it with:  net start "' + SERVICE_ID + '"  (or services.msc).');
      finish(0);
      return;
    }

    svc.on('start', () => step(true, 'start requested'));
    svc.start();
    // net start is asynchronous in node-windows; poll for the real state.
    let polls = 0;
    const poll = setInterval(() => {
      const s = queryService();
      polls += 1;
      if (s.state === 'RUNNING' || polls >= 30) {
        clearInterval(poll);
        clearTimeout(timeout);
        step(s.state === 'RUNNING', `service state: ${s.state}`);
        console.log('\nDone. Give the server ~30-60 s to come up, then check:  https://localhost:3000/health   (npm run service:status)');
        networking.printAccessInfo({ port: Number(process.env.PORT || 3000) });
        console.log(`Logs: ${path.join(ROOT, 'logs', 'service.log')}  and  ${svc.root}`);
        if (user) console.log(`Make sure ${user} can read/write ${ROOT} and can run Ollama (see docs/WINDOWS-SERVICE.md).`);
        else console.log('Running as LocalSystem: a per-user Ollama install is usually NOT visible to it — see docs/WINDOWS-SERVICE.md ("Ollama at boot").');
        finish(s.state === 'RUNNING' ? 0 : 1);
      }
    }, 1000);
  });

  try {
    svc.install();
  } catch (err) {
    console.error(`[!] ${err.message || err}`);
    finish(1);
  }

  // Fallback for the half-installed state: if the service shows up in the service manager but
  // node-windows never emits "install", still apply the settings and (unless --no-start) start it.
  // Without this, an install that loses that one console line leaves a service that never starts at
  // boot and never restarts after a crash — silently not doing the job it was installed for.
  let fallbackPolls = 0;
  const fallback = setInterval(() => {
    if (finished) return clearInterval(fallback);
    fallbackPolls += 1;
    if (fallbackPolls > 60) return clearInterval(fallback);
    if (!queryService().installed) return undefined;
    clearInterval(fallback);
    if (configured) return undefined; // the normal path already handled it
    console.log('\n(The installer did not report success, but the service is registered — finishing the setup.)');
    step(true, `service registered as "${SERVICE_ID}" (display name "${SERVICE_NAME}")`);
    configure();
    if (args['no-start']) {
      clearTimeout(timeout);
      console.log('\nInstalled, not started (--no-start). Start it with:  net start "' + SERVICE_ID + '"');
      return finish(0);
    }
    svc.start();
    const poll = setInterval(() => {
      const s = queryService();
      if (s.state === 'RUNNING') {
        clearInterval(poll);
        clearTimeout(timeout);
        step(true, 'service state: RUNNING');
        console.log('\nDone. Give the server ~30-60 s to come up, then check:  https://localhost:3000/health   (npm run service:status)');
        finish(0);
      }
    }, 1000);
    return undefined;
  }, 1000);
}

main().catch((err) => {
  console.error(`[!] ${err.stack || err.message}`);
  process.exit(1);
});


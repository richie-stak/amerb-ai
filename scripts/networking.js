// Shared by the launcher and the service installers: which address staff actually open, whether the
// HTTPS certificate covers it, and how to let other PCs through the firewall.
//
// The app listens on every interface (HOST=0.0.0.0 by default), so "bonding to the host IP" is really
// two questions answered here: which URL to hand out, and whether that URL is one the browser will
// accept without a warning.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');

const IS_WINDOWS = process.platform === 'win32';

// IPv4 addresses another machine could actually reach. 169.254.x.x is what Windows/link-local assigns
// when an adapter has no real network, and nothing can be reached through it.
function lanAddresses() {
  const out = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) continue;
      out.push({ address: address.address, interface: name });
    }
  }
  return out;
}

// Virtual adapters (Hyper-V, WSL, VirtualBox, Docker) are listed too, because on a laptop the bank's
// LAN may well be one of them — but they are marked, so the advice printed is not misleading.
function looksVirtual(name) {
  return /vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback|docker|br-|veth/i.test(name);
}

function accessUrls(port) {
  return lanAddresses().map((entry) => ({ ...entry, url: `https://${entry.address}:${port}`, virtual: looksVirtual(entry.interface) }));
}

// The DNS names and IPs an existing certificate was issued for.
function certificateNames(certPath) {
  try {
    const cert = new X509Certificate(fs.readFileSync(certPath));
    const san = cert.subjectAltName || '';
    return san
      .split(',')
      .map((entry) => entry.trim().replace(/^(DNS|IP Address):/, '').toLowerCase())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function certificateReport({ certPath, port }) {
  const names = certificateNames(certPath);
  const urls = accessUrls(port);
  if (!names) return { hasCertificate: fs.existsSync(certPath), missing: urls.map((u) => u.address), urls };
  const missing = urls.filter((u) => !names.includes(u.address.toLowerCase()));
  return { hasCertificate: true, missing: missing.map((u) => u.address), urls };
}

function printAccessInfo({ port, certPath, log = console.log }) {
  const report = certificateReport({ certPath: certPath || path.join(__dirname, '..', 'certs', 'server.cert'), port });
  log('');
  log('  Staff can open AMERB AI at:');
  log(`    This computer : https://localhost:${port}`);
  for (const entry of report.urls) {
    const covered = report.missing.includes(entry.address) ? '' : '  (certificate covers this address)';
    log(`    On the network: ${entry.url}${covered}${entry.virtual ? '  [virtual adapter]' : ''}`);
  }
  if (report.missing.length) {
    log('');
    log('  [!] The HTTPS certificate does not cover: ' + report.missing.join(', '));
    log('      Browsers will warn on those addresses. To fix it: delete the certs folder and restart the');
    log('      service (a new certificate is generated for the current addresses), or run:');
    log('        repair-service.bat --refresh-certificate      (Windows, as administrator)');
    log('      Staff PCs that trusted the old certificate will need to trust the new one.');
  }
  log('');
  if (IS_WINDOWS) {
    log('  Other PCs cannot connect? Allow the port through the firewall (as administrator):');
    log(`    netsh advfirewall firewall add rule name="AMERB AI (TCP ${port})" dir=in action=allow protocol=TCP localport=${port}`);
  } else {
    log('  Other PCs cannot connect? Allow the port through the firewall:');
    log(`    sudo ufw allow ${port}/tcp        (or: sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload)`);
  }
}

// Adds (or refreshes) the Windows Firewall rule for the port. Idempotent: the rule is deleted first if
// it exists, so a changed port does not leave a stale hole open. Returns true on success.
function allowThroughWindowsFirewall(port, { log = console.log } = {}) {
  if (!IS_WINDOWS) return false;
  const name = `AMERB AI (TCP ${port})`;
  spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`], { stdio: 'ignore', windowsHide: true });
  const result = spawnSync(
    'netsh',
    ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`, 'profile=domain,private,public'],
    { encoding: 'utf8', windowsHide: true }
  );
  const ok = result.status === 0;
  log(ok ? `  [ok] Windows Firewall: TCP ${port} allowed for other computers` : `  [!!] Could not add the firewall rule (run as administrator): ${String(result.stdout || result.stderr || '').trim().split('\n')[0]}`);
  return ok;
}

module.exports = { lanAddresses, accessUrls, certificateNames, certificateReport, printAccessInfo, allowThroughWindowsFirewall, IS_WINDOWS };

// `node scripts/networking.js [port]` prints the same information for an installer or an operator:
// which addresses staff can use, whether the certificate covers them, and the firewall command.
if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 3000;
  printAccessInfo({ port });
}

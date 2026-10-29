const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const selfsigned = require('selfsigned');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const CERT_PATH = path.join(CERT_DIR, 'server.cert');
const KEY_PATH = path.join(CERT_DIR, 'server.key');

// Every LAN IPv4 address this machine currently has, so staff on other PCs can reach this server
// by IP without the certificate rejecting that address as one it wasn't issued for.
function localIPv4Addresses() {
  const addresses = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface || []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses;
}

// Extra names/addresses from PUBLIC_HOSTNAMES in .env (comma-separated), for a fixed IP or a DNS
// name like amerb.bank.local that staff will use but this machine can't discover on its own.
function extraHostnames() {
  return (process.env.PUBLIC_HOSTNAMES || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

// The DNS names and IPs an existing certificate was issued for, or null if it can't be read.
function certNames(certPem) {
  try {
    const san = new crypto.X509Certificate(certPem).subjectAltName || '';
    return san.split(',').map((entry) => entry.trim().replace(/^(DNS|IP Address):/, '').toLowerCase());
  } catch {
    return null;
  }
}

// Generates a self-signed HTTPS certificate covering this machine's hostname and every address it
// could plausibly be reached at (localhost, its LAN IPs), so browsers only have to trust one
// exception regardless of whether staff open it as localhost or over the bank's network.
//
// An existing certificate is reused as long as it was made for *this* machine — network IPs can
// change across reboots, and forcing every staff PC to re-trust the certificate each time would be
// worse than an occasional stale IP. But when the folder has been moved to a different computer
// (the hostname isn't in the certificate) or new PUBLIC_HOSTNAMES were added, it's regenerated,
// since a certificate for the old machine would fail on every browser.
async function ensureCert() {
  const hostname = os.hostname();
  const ips = localIPv4Addresses();
  const extras = extraHostnames();

  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    const cert = fs.readFileSync(CERT_PATH);
    const names = certNames(cert);
    const missing = names ? [hostname, ...extras].filter((n) => !names.includes(n.toLowerCase())) : [];
    if (!missing.length) {
      const staleIps = names ? ips.filter((ip) => !names.includes(ip)) : [];
      if (staleIps.length) {
        console.warn(
          `Note: the HTTPS certificate doesn't cover this machine's current IP (${staleIps.join(', ')}), so ` +
            `browsers will warn about it when opened by IP. Opening it by hostname (https://${hostname}:PORT) ` +
            'still works. To cover the new IP, delete the certs folder and restart.'
        );
      }
      return { cert, key: fs.readFileSync(KEY_PATH) };
    }
    console.log(`The HTTPS certificate was made for a different machine or name (missing: ${missing.join(', ')}) — creating a new one.`);
  }

  const isIp = (value) => net.isIP(value) !== 0;
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: hostname },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...ips.map((ip) => ({ type: 7, ip })),
    ...extras.map((h) => (isIp(h) ? { type: 7, ip: h } : { type: 2, value: h })),
  ];

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);

  const attrs = [{ name: 'commonName', value: hostname }];
  const pems = await selfsigned.generate(attrs, {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(KEY_PATH, pems.private);

  console.log(`Generated a new self-signed HTTPS certificate at ${CERT_DIR}`);
  console.log(`Covers: localhost, 127.0.0.1, ${[hostname, ...ips, ...extras].join(', ')}`);
  console.log('Staff on other PCs will see a browser security warning the first time — see README for how to trust it.');

  return { cert: pems.cert, key: pems.private };
}

module.exports = { ensureCert, localIPv4Addresses, CERT_DIR };

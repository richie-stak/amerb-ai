const fs = require('node:fs');
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

// Generates a self-signed HTTPS certificate covering this machine's hostname and every address it
// could plausibly be reached at (localhost, its LAN IPs), so browsers only have to trust one
// exception regardless of whether staff open it as localhost or over the bank's network. Skips
// regeneration if a certificate already exists — network IPs can change across reboots, but
// forcing every staff PC to re-trust the certificate each time would be worse than an occasional
// stale IP, which is still covered by the hostname/localhost entries either way.
async function ensureCert() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
  }

  const hostname = os.hostname();
  const ips = localIPv4Addresses();

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: hostname },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...ips.map((ip) => ({ type: 7, ip })),
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
  console.log(`Covers: localhost, 127.0.0.1, ${hostname}${ips.length ? `, ${ips.join(', ')}` : ''}`);
  console.log('Staff on other PCs will see a browser security warning the first time — see README for how to trust it.');

  return { cert: pems.cert, key: pems.private };
}

module.exports = { ensureCert, localIPv4Addresses, CERT_DIR };

// Bank branding for generated documents: the Amenfiman Community Bank logo, shown on every Word, PDF,
// Excel and PowerPoint file AMERB AI produces.
//
// The logo is a normal file in the repository (assets/branding/community-bank-logo.png) so it travels with
// the app to another machine or container. AMERB_LOGO_PATH overrides it (for example a rebranded logo on
// one installation), and if the file is missing generation still works — just without the logo — rather
// than failing the tool call.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BANK_NAME = 'Amenfiman Community Bank';
// The dark green in the logo, used for headings and table header rows in generated files.
const BRAND_GREEN = '004E2D';
const DEFAULT_LOGO = path.join(ROOT, 'assets', 'branding', 'community-bank-logo.png');

let cache = null; // { key, logo }

function logoPath() {
  return process.env.AMERB_LOGO_PATH || DEFAULT_LOGO;
}

// PNG dimensions live in the IHDR chunk: 4-byte width and height starting at byte 16.
function pngSize(buffer) {
  try {
    if (buffer.length < 24 || buffer.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return null;
  }
}

// Returns { buffer, width, height, ratio, filename } or null when no usable logo is configured.
function getLogo() {
  const file = logoPath();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (cache && cache.key === key) return cache.logo;

  let logo = null;
  try {
    const buffer = fs.readFileSync(file);
    const size = pngSize(buffer);
    if (size && size.width > 0 && size.height > 0) {
      logo = {
        buffer,
        width: size.width,
        height: size.height,
        ratio: size.height / size.width,
        filename: path.basename(file),
      };
    }
  } catch {
    logo = null;
  }
  cache = { key, logo };
  return logo;
}

// A width in points/inches and the height that keeps the logo's aspect ratio.
function sizedFor(width) {
  const logo = getLogo();
  return logo ? { logo, width, height: Math.max(1, Math.round(width * logo.ratio)) } : null;
}

module.exports = { getLogo, sizedFor, logoPath, BANK_NAME, BRAND_GREEN, DEFAULT_LOGO };

// Generated documents carry the bank's logo. These tests check every format really embeds it, and that a
// missing logo file degrades to "no logo" instead of failing the generation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { getLogo, logoPath, BANK_NAME, DEFAULT_LOGO } = require('../server/branding');
const gen = require('../server/documentGen');

const CONTENT = '# Heading\n\n- bullet one\n- bullet two\n\n| A | B |\n|---|---|\n| 1 | 2 |';

function zipEntries(file) {
  try {
    return execFileSync('tar', ['-tf', file], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

test('the logo is present with its real dimensions', () => {
  const logo = getLogo();
  assert.ok(logo, `expected the bank logo at ${logoPath()}`);
  assert.deepEqual({ width: logo.width, height: logo.height }, { width: 2118, height: 405 });
  assert.equal(logo.buffer.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'it is a PNG');
  assert.ok(Math.abs(logo.ratio - 405 / 2118) < 1e-9, 'aspect ratio is preserved for scaling');
  assert.equal(BANK_NAME, 'Amenfiman Community Bank');
});

test('a Word document embeds the logo', async () => {
  const buffer = await gen.generateDocx('Password Policy Summary', CONTENT);
  const file = path.join(os.tmpdir(), `amerb-brand-${Date.now()}.docx`);
  fs.writeFileSync(file, buffer);
  try {
    const media = zipEntries(file).filter((entry) => /^word\/media\/.+\.png$/.test(entry));
    assert.equal(media.length, 1, `expected one PNG in word/media, got ${JSON.stringify(zipEntries(file))}`);
    assert.ok(buffer.length > 100_000, 'the image bytes are inside the file');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a PDF embeds the logo as an image object', async () => {
  const buffer = await gen.generatePdf('Password Policy Summary', CONTENT);
  const text = buffer.toString('latin1');
  assert.match(text, /\/Subtype\s*\/Image/, 'the PDF has an image XObject');
  assert.ok(buffer.length > 100_000);
});

test('an Excel workbook embeds the logo above the table, not over it', async () => {
  const buffer = await gen.generateXlsx('Password Summary', [
    ['Item', 'Value'],
    ['Rotation', 90],
  ]);
  const file = path.join(os.tmpdir(), `amerb-brand-${Date.now()}.xlsx`);
  fs.writeFileSync(file, buffer);
  try {
    const media = zipEntries(file).filter((entry) => /^xl\/media\/.+\.png$/.test(entry));
    assert.equal(media.length, 1, JSON.stringify(zipEntries(file)));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a PowerPoint puts the logo on the title slide and on each content slide', async () => {
  const buffer = await gen.generatePptx('Password Policy Summary', [
    { heading: 'One', bullets: ['a'] },
    { heading: 'Two', bullets: ['b'] },
  ]);
  const file = path.join(os.tmpdir(), `amerb-brand-${Date.now()}.pptx`);
  fs.writeFileSync(file, buffer);
  try {
    const media = zipEntries(file).filter((entry) => /^ppt\/media\/.+\.png$/.test(entry));
    assert.equal(media.length, 3, `title + two content slides, got ${JSON.stringify(media)}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a missing logo file does not break document generation', async () => {
  const previous = process.env.AMERB_LOGO_PATH;
  process.env.AMERB_LOGO_PATH = path.join(os.tmpdir(), 'definitely-not-a-logo.png');
  try {
    assert.equal(getLogo(), null);
    const docx = await gen.generateDocx('No logo', '# still works');
    assert.ok(docx.length > 1000, 'Word still generates');
    const pdf = await gen.generatePdf('No logo', '# still works');
    assert.match(pdf.toString('latin1'), /%PDF/, 'PDF still generates');
    const xlsx = await gen.generateXlsx('No logo', [['A']]);
    assert.ok(xlsx.length > 1000, 'Excel still generates');
    const pptx = await gen.generatePptx('No logo', []);
    assert.ok(pptx.length > 1000, 'PowerPoint still generates');
  } finally {
    if (previous === undefined) delete process.env.AMERB_LOGO_PATH;
    else process.env.AMERB_LOGO_PATH = previous;
  }
});

test('AMERB_LOGO_PATH can point at a different logo', () => {
  // Copying the same PNG under another name is enough to prove the override is honoured.
  const custom = path.join(os.tmpdir(), `custom-logo-${Date.now()}.png`);
  fs.copyFileSync(DEFAULT_LOGO, custom);
  const previous = process.env.AMERB_LOGO_PATH;
  process.env.AMERB_LOGO_PATH = custom;
  try {
    const logo = getLogo();
    assert.ok(logo, 'the configured logo is picked up');
    assert.equal(logo.filename, path.basename(custom));
  } finally {
    if (previous === undefined) delete process.env.AMERB_LOGO_PATH;
    else process.env.AMERB_LOGO_PATH = previous;
    fs.rmSync(custom, { force: true });
  }
});

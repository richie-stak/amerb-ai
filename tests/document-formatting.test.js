// Reports must look like documents, not like raw markdown, and the in-app preview must show the logo that
// is embedded in the file. (The user's report was a valid .docx with the logo inside; the preview stripped
// the image, and the text showed literal **bold** markers.)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTestServer, makeClient } = require('./helpers/testServer');
const gen = require('../server/documentGen');

let server;
let admin;

function unzipText(buffer, member) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amerb-unzip-'));
  const file = path.join(dir, 'doc.docx');
  fs.writeFileSync(file, buffer);
  try {
    execFileSync('tar', ['-xf', file, '-C', dir]);
    return fs.readFileSync(path.join(dir, member), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdfPageCount(buffer) {
  const count = /\/Count (\d+)/.exec(buffer.toString('latin1'));
  return count ? Number(count[1]) : null;
}

before(async () => {
  server = await startTestServer();
  admin = makeClient(server.baseUrl);
  const signup = await admin.post('/api/auth/signup', {
    username: 'docfmtadmin',
    email: 'docfmtadmin@amenfimanbank.com',
    password: 'password12345',
    department: 'IT',
  });
  assert.equal(signup.status, 200);
  const db = server.openDb();
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'docfmtadmin'").run();
  db.close();
});

after(async () => {
  await server.stop();
});

test('a Word report turns markdown bold and rules into formatting, not literal characters', async () => {
  const buffer = await gen.generateDocx('Report', '**To:** All Staff\n\n**From:** IT\n\n---\n\n## Purpose\n\nSome **important** text.');
  const xml = unzipText(buffer, 'word/document.xml');
  const runs = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  const text = runs.join('|');
  assert.ok(!text.includes('**'), `no literal bold markers should remain: ${text}`);
  assert.ok(!text.includes('---'), `the rule must not print as text: ${text}`);
  assert.match(xml, /<w:b\/>|<w:b >/, 'bold runs are marked');
  assert.match(text, /To:/);
  assert.match(text, /important/);
});

test('a PDF report is not padded with blank pages (the footer used to force a page break per line)', async () => {
  const short = await gen.generatePdf('Report', '**To:** All staff\n\nOne paragraph only.');
  assert.equal(pdfPageCount(short), 1, 'a one-paragraph report is one page');
  assert.match(short.toString('latin1'), /\/Subtype\s*\/Image/, 'and still carries the logo');

  const long = await gen.generatePdf(
    'Report',
    Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: ${'The bank requires staff to follow its information security policy. '.repeat(3)}`).join('\n\n')
  );
  assert.ok(pdfPageCount(long) > 1, 'a long report still paginates');
});

test('the in-app preview of a generated Word report shows the embedded logo', async () => {
  const buffer = await gen.generateDocx('Logo check', '# Heading\n\nBody text.');
  const upload = await admin.upload('/api/documents', [{ name: 'branded-report.docx', content: buffer }], { scope: 'personal' });
  const body = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(body));
  const id = body.results[0].id;

  const preview = await admin.get(`/api/documents/${id}/preview`);
  assert.equal(preview.status, 200);
  const data = await preview.json();
  assert.equal(data.type, 'html');
  assert.match(data.html, /<img[^>]+src="data:image\/png;base64,/, 'the logo is kept as an image, not replaced with "#"');
  assert.ok(data.html.length > 10_000, 'the image data is included');
});

test('the in-app preview of a generated Excel report shows the logo above the table', async () => {
  const buffer = await gen.generateXlsx('Logo check', [
    ['Item', 'Value'],
    ['One', 1],
  ]);
  const upload = await admin.upload('/api/documents', [{ name: 'branded-sheet.xlsx', content: buffer }], { scope: 'personal' });
  const body = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(body));
  const id = body.results[0].id;

  const preview = await admin.get(`/api/documents/${id}/preview`);
  assert.equal(preview.status, 200);
  const data = await preview.json();
  assert.match(data.html, /preview-logo/, 'the logo block is added to the Excel preview');
  assert.match(data.html, /data:image\/png;base64,/);
  assert.match(data.html, /<table/, 'the table is still there');
});

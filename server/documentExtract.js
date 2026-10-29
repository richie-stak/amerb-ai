const path = require('node:path');

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const MAX_CHARS = 400_000; // guard against pathological files blowing up memory/DB

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ',
};

function decodeEntities(str) {
  return str.replace(/&(#39|#x27|amp|lt|gt|quot|apos|nbsp);/g, (_, name) => HTML_ENTITIES[name] || ' ');
}

// Mammoth's convertToHtml preserves the Word doc's heading styles as <h1>-<h6>, which
// extractRawText throws away — converting those to "# "/"## " markdown lines lets the chunker
// below track section titles for docx the same way it already does for .md files and the
// "# Sheet: ..." headers this app's own xlsx/AI-generated-doc output already uses.
function htmlToMarkdownish(html) {
  return decodeEntities(
    html
      .replace(/<h[1-2][^>]*>(.*?)<\/h[1-2]>/gi, '\n\n# $1\n\n')
      .replace(/<h[3-6][^>]*>(.*?)<\/h[3-6]>/gi, '\n\n## $1\n\n')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n- $1')
      .replace(/<\/p>|<br\s*\/?>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  ).trim();
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
};

function isImageFile(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || (mimeType || '').startsWith('image/');
}

function imageMimeType(filename, mimeType) {
  if (mimeType && mimeType.startsWith('image/')) return mimeType;
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || 'image/png';
}

// Runs local OCR (Tesseract) over an image buffer. Slow-ish (seconds per image) but fully offline
// after the English language data has been downloaded once.
async function ocrImage(buffer) {
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(buffer);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

async function extractText(buffer, filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();

  if (isImageFile(filename, mimeType)) {
    return ocrImage(buffer);
  }

  if (ext === '.pdf' || mimeType === 'application/pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy();
    }
  }

  if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = require('mammoth');
    const result = await mammoth.convertToHtml({ buffer });
    return htmlToMarkdownish(result.value || '');
  }

  if (['.xlsx', '.xls', '.xlsm'].includes(ext)) {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) parts.push(`# Sheet: ${sheetName}\n${csv}`);
    }
    return parts.join('\n\n');
  }

  // Plain text formats: .txt, .md, .csv, and anything else we don't have a parser for
  return buffer.toString('utf8');
}

function headingText(paragraph) {
  const m = paragraph.trim().match(/^#{1,6}\s+(.*)$/);
  return m ? m[1].trim() : null;
}

// Splits into ~1200-char chunks along paragraph boundaries. Each chunk carries the tail of the
// previous one (CHUNK_OVERLAP chars) so a sentence cut off at a chunk boundary isn't lost from
// both sides, and is tagged with the most recent "# "/"## " heading seen so citations and the
// context injected into chat can say which section of the document it came from.
function chunkText(text) {
  const clean = text.replace(/\r\n/g, '\n').trim().slice(0, MAX_CHARS);
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = '';
  let currentHeading = null;
  let activeHeading = null;

  function finalizeChunk() {
    if (current.trim()) chunks.push({ heading: currentHeading, text: current.trim() });
  }

  for (const para of paragraphs) {
    const heading = headingText(para);
    if (heading) activeHeading = heading;
    if (!current) currentHeading = activeHeading;

    if (current && current.length + para.length + 2 > CHUNK_SIZE) {
      const tail = current.slice(-CHUNK_OVERLAP).trim();
      finalizeChunk();
      current = tail ? `${tail}\n\n${para}` : para;
      currentHeading = activeHeading;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }

    // A single paragraph longer than CHUNK_SIZE needs hard splitting.
    while (current.length > CHUNK_SIZE * 1.5) {
      chunks.push({ heading: currentHeading, text: current.slice(0, CHUNK_SIZE).trim() });
      current = current.slice(CHUNK_SIZE - CHUNK_OVERLAP);
    }
  }
  finalizeChunk();

  return chunks;
}

module.exports = { extractText, chunkText, CHUNK_SIZE, isImageFile, imageMimeType };

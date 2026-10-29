const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');

const HEADING_LEVELS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
const BRAND_GREEN = '004E2D';

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

// A tiny markdown-ish parser shared by the Word and PDF generators: "# " headings (1-3 levels),
// "- " bullets, "| a | b |" tables (with a "|---|---|" separator row, standard markdown table
// syntax), everything else a plain paragraph. Deliberately simple so a small local LLM can
// reliably produce it — this is the same convention the chat UI's own markdown renderer uses.
function parseBlocks(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push({ type: 'bullet', text: bullet[1] });
      continue;
    }

    // A markdown table: a "| ... |" row followed by a "|---|---|"-style separator row.
    if (line.startsWith('|') && lines[i + 1] && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(lines[i + 1].trim())) {
      const headers = splitTableRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i].trim()));
        i++;
      }
      i--; // the outer for-loop's i++ will advance past the last consumed row
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    blocks.push({ type: 'paragraph', text: line });
  }
  return blocks;
}

function buildDocxTable(headers, rows) {
  const borders = {
    top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
    left: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
    right: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  };
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (h) =>
        new TableCell({
          shading: { fill: BRAND_GREEN },
          borders,
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF' })] })],
        })
    ),
  });
  const bodyRows = rows.map(
    (r) =>
      new TableRow({
        children: headers.map(
          (_, idx) =>
            new TableCell({
              borders,
              children: [new Paragraph({ children: [new TextRun(String(r[idx] ?? ''))] })],
            })
        ),
      })
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] });
}

async function generateDocx(title, content) {
  const blocks = parseBlocks(content);
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 240 } }),
    ...blocks.flatMap((b) => {
      if (b.type === 'heading') {
        return [
          new Paragraph({
            text: b.text,
            heading: HEADING_LEVELS[b.level - 1] || HeadingLevel.HEADING_3,
            spacing: { before: 200, after: 120 },
          }),
        ];
      }
      if (b.type === 'bullet') {
        return [new Paragraph({ children: [new TextRun(b.text)], bullet: { level: 0 }, spacing: { after: 80 } })];
      }
      if (b.type === 'table') {
        return [buildDocxTable(b.headers, b.rows), new Paragraph({ text: '', spacing: { after: 160 } })];
      }
      return [new Paragraph({ children: [new TextRun(b.text)], spacing: { after: 120 } })];
    }),
  ];
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// Draws a bordered, bank-green-headed table directly onto the PDF, since pdfkit has no native
// table support — pagination-aware, starting a new page if a row would overflow.
function drawPdfTable(doc, headers, rows) {
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / Math.max(headers.length, 1);
  const rowHeight = 22;

  function drawRow(cells, isHeader) {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    if (isHeader) doc.rect(startX, y, usableWidth, rowHeight).fill(`#${BRAND_GREEN}`);
    doc.fillColor(isHeader ? 'white' : 'black').fontSize(10);
    cells.forEach((cellText, idx) => {
      doc.text(String(cellText ?? ''), startX + idx * colWidth + 4, y + 6, {
        width: colWidth - 8,
        height: rowHeight,
        ellipsis: true,
      });
    });
    doc.fillColor('black').strokeColor('#cccccc').lineWidth(0.5);
    doc.rect(startX, y, usableWidth, rowHeight).stroke();
    for (let c = 1; c < cells.length; c++) {
      doc.moveTo(startX + c * colWidth, y).lineTo(startX + c * colWidth, y + rowHeight).stroke();
    }
    doc.y = y + rowHeight;
  }

  drawRow(headers, true);
  for (const row of rows) drawRow(row, false);
  doc.moveDown(0.5);
}

function generatePdf(title, content) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(22).fillColor(`#${BRAND_GREEN}`).text(title);
    doc.fillColor('black');
    doc.moveDown();

    for (const b of parseBlocks(content)) {
      if (b.type === 'heading') {
        doc.moveDown(0.4);
        doc.fontSize(18 - (b.level - 1) * 3).fillColor(`#${BRAND_GREEN}`).text(b.text);
        doc.fillColor('black');
        doc.moveDown(0.2);
      } else if (b.type === 'bullet') {
        doc.fontSize(12).text(`•  ${b.text}`, { indent: 18 });
      } else if (b.type === 'table') {
        drawPdfTable(doc, b.headers, b.rows);
      } else {
        doc.fontSize(12).text(b.text);
        doc.moveDown(0.3);
      }
    }

    // A footer with page numbers needs the final page count, so it's added in a pass over every
    // already-laid-out page rather than as content is written (bufferPages keeps them addressable).
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - doc.page.margins.bottom + 18;
      doc.fontSize(8).fillColor('#888888');
      doc.text('Amenfiman Community Bank — AMERB AI', doc.page.margins.left, bottom, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 80,
      });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - doc.page.margins.right - 80, bottom, {
        width: 80,
        align: 'right',
      });
    }

    doc.end();
  });
}

// Bold white-on-green header row (frozen), borders, auto-sized columns, and thousands-separator
// formatting on columns that are entirely numeric — the free/community xlsx (SheetJS) writer used
// elsewhere in this app for *reading* spreadsheets can't produce any of this styling, which is why
// generation specifically goes through exceljs instead.
async function generateXlsx(title, rows) {
  const normalized = Array.isArray(rows) ? rows.map((r) => (Array.isArray(r) ? r : [r])) : [];
  const safeRows = normalized.length ? normalized : [['(no data)']];
  const [header, ...dataRows] = safeRows;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AMERB AI';
  workbook.created = new Date();
  const sheetName = String(title || 'Sheet1').slice(0, 31) || 'Sheet1';
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.addRow(header);
  dataRows.forEach((r) => sheet.addRow(r));

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BRAND_GREEN}` } };
    cell.alignment = { vertical: 'middle' };
  });

  for (let c = 0; c < header.length; c++) {
    let maxLen = String(header[c] ?? '').length;
    let allNumeric = dataRows.length > 0;
    for (const r of dataRows) {
      const v = r[c];
      maxLen = Math.max(maxLen, String(v ?? '').length);
      if (typeof v !== 'number') allNumeric = false;
    }
    const col = sheet.getColumn(c + 1);
    col.width = Math.min(Math.max(maxLen + 2, 10), 40);
    if (allNumeric) col.numFmt = '#,##0.00';
  }

  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
    });
  });

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

async function generatePptx(title, slides) {
  const pres = new PptxGenJS();

  const titleSlide = pres.addSlide();
  titleSlide.addText(title, { x: 0.5, y: 2.2, w: 9, h: 1.5, fontSize: 36, bold: true, align: 'center' });

  for (const s of Array.isArray(slides) ? slides : []) {
    const slide = pres.addSlide();
    slide.addText(String(s.heading || ''), { x: 0.5, y: 0.35, w: 9, h: 1, fontSize: 28, bold: true });
    const bullets = Array.isArray(s.bullets) ? s.bullets : typeof s.bullets === 'string' ? [s.bullets] : [];
    if (bullets.length) {
      slide.addText(
        bullets.map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })),
        { x: 0.6, y: 1.5, w: 8.8, h: 5, fontSize: 18 }
      );
    }
  }

  return pres.write({ outputType: 'nodebuffer' });
}

module.exports = { generateDocx, generatePdf, generateXlsx, generatePptx, parseBlocks };

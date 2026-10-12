const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');

class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; this.userFacing = true; }
}

// Decide the real file type from its bytes, not just its name or declared MIME type.
function detectType(buf, originalName = '') {
  if (buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    if (/\.docx$/i.test(originalName)) return 'docx';
  }
  return null;
}

async function extractText(buf, originalName) {
  const type = detectType(buf, originalName);
  if (!type) throw new UserError('This file type is not supported. Please upload a PDF or a Word (.docx) file.');
  let text = '';
  try {
    if (type === 'pdf') {
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try { text = (await parser.getText()).text || ''; } finally { await parser.destroy().catch(() => {}); }
    } else {
      text = (await mammoth.extractRawText({ buffer: buf })).value || '';
    }
  } catch (e) {
    throw new UserError('We could not read this file. It may be damaged or password-protected. Try saving it again as a new PDF or DOCX, or paste your details manually.');
  }
  text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/-- \d+ of \d+ --/g, '').trim();
  if (text.length < 80) {
    throw new UserError('We could not find readable text in this file. It may be a scanned image. Please upload a text-based PDF or DOCX, or type your details in manually.');
  }
  return { text: text.slice(0, 40000), type };
}

// Used only when the AI service is unavailable: pull out what plain patterns can find.
function basicFields(text) {
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [''])[0];
  const phone = (text.match(/(\+?\d[\d\s().-]{8,16}\d)/) || [''])[0].trim();
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const name = firstLine.length <= 60 && !/[@\d]/.test(firstLine) ? firstLine : '';
  return { name, email, phone };
}

module.exports = { extractText, basicFields, UserError };

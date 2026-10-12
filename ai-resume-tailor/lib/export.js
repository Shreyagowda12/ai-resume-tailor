const PDFDocument = require('pdfkit');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, TabStopType, BorderStyle, LevelFormat,
} = require('docx');

const TEMPLATES = {
  classic: { label: 'Classic', pdfFont: 'Times', docFont: 'Times New Roman', accent: '000000', size: 10.5, nameSize: 20, center: true },
  modern:  { label: 'Modern',  pdfFont: 'Helvetica', docFont: 'Calibri', accent: '3B4CCA', size: 10, nameSize: 22, center: false },
  compact: { label: 'Compact', pdfFont: 'Helvetica', docFont: 'Arial', accent: '333333', size: 9.5, nameSize: 18, center: false },
};
const tpl = (k) => TEMPLATES[k] || TEMPLATES.classic;

// Standard PDF fonts only cover Latin text; replace anything else so the PDF never shows broken glyphs.
const pdfSafe = (s) => String(s || '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/[   ]/g, ' ').replace(/[^\x09\x0A\x20-\x7E¡-ÿ•]/g, '?');

function contactLine(r) {
  return [r.contact.email, r.contact.phone, r.contact.location, ...r.contact.links].filter(Boolean).join('  |  ');
}

// Single list of blocks that both the PDF and DOCX writers render (keeps the two identical in content).
function buildBlocks(r) {
  const sections = [];
  if (r.summary) sections.push({ heading: 'Professional Summary', items: [{ type: 'text', text: r.summary }] });
  if (r.skills.length) sections.push({ heading: 'Skills', items: [{ type: 'text', text: r.skills.join(', ') }] });
  if (r.experience.length) sections.push({
    heading: 'Work Experience',
    items: r.experience.map((e) => ({ type: 'entry', title: e.title, sub: [e.company, e.location].filter(Boolean).join(', '), dates: e.dates, bullets: e.bullets })),
  });
  if (r.projects.length) sections.push({
    heading: 'Projects',
    items: r.projects.map((p) => ({ type: 'entry', title: p.name, sub: p.tech, dates: p.dates, bullets: p.bullets })),
  });
  if (r.education.length) sections.push({
    heading: 'Education',
    items: r.education.map((e) => ({ type: 'entry', title: e.degree, sub: [e.school, e.location].filter(Boolean).join(', '), dates: e.dates, bullets: e.details })),
  });
  if (r.certifications.length) sections.push({ heading: 'Certifications', items: [{ type: 'bullets', bullets: r.certifications }] });
  if (r.achievements.length) sections.push({ heading: 'Achievements', items: [{ type: 'bullets', bullets: r.achievements }] });
  return sections;
}

function toPdf(resume, templateKey) {
  const t = tpl(templateKey);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 46, bottom: 46, left: 52, right: 52 },
      info: { Title: `${resume.name} - Resume`, Author: resume.name },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const reg = t.pdfFont === 'Times' ? 'Times-Roman' : t.pdfFont, bold = `${t.pdfFont}-Bold`, ital = t.pdfFont === 'Times' ? 'Times-Italic' : `${t.pdfFont}-Oblique`;
    const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
    const accent = '#' + t.accent;
    const need = (h) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); };

    doc.font(bold).fontSize(t.nameSize).fillColor(accent).text(pdfSafe(resume.name), L, doc.y, { width: W, align: t.center ? 'center' : 'left' });
    const cl = contactLine(resume);
    if (cl) doc.font(reg).fontSize(t.size).fillColor('#222222').text(pdfSafe(cl), { width: W, align: t.center ? 'center' : 'left' });
    doc.moveDown(0.6);

    for (const sec of buildBlocks(resume)) {
      need(60);
      doc.font(bold).fontSize(t.size + 1).fillColor(accent).text(pdfSafe(sec.heading.toUpperCase()), L, doc.y, { width: W, characterSpacing: 0.6 });
      const ly = doc.y + 1;
      doc.moveTo(L, ly).lineTo(L + W, ly).lineWidth(0.7).strokeColor(accent).stroke();
      doc.moveDown(0.45);
      for (const it of sec.items) {
        if (it.type === 'text') {
          doc.font(reg).fontSize(t.size).fillColor('#111111').text(pdfSafe(it.text), L, doc.y, { width: W, lineGap: 1.5 });
          doc.moveDown(0.4);
        } else if (it.type === 'bullets') {
          it.bullets.forEach((b) => bullet(pdfSafe(b)));
          doc.moveDown(0.4);
        } else {
          need(44);
          const y = doc.y;
          doc.font(bold).fontSize(t.size + 0.5).fillColor('#000000');
          const dateW = it.dates ? doc.font(reg).fontSize(t.size).widthOfString(pdfSafe(it.dates)) + 8 : 0;
          doc.font(bold).fontSize(t.size + 0.5).text(pdfSafe(it.title), L, y, { width: W - dateW, lineBreak: true });
          const endY = doc.y;
          if (it.dates) doc.font(reg).fontSize(t.size).fillColor('#222222').text(pdfSafe(it.dates), L, y, { width: W, align: 'right', lineBreak: false });
          doc.y = endY;
          if (it.sub) doc.font(ital).fontSize(t.size).fillColor('#222222').text(pdfSafe(it.sub), L, doc.y, { width: W });
          doc.moveDown(0.15);
          it.bullets.forEach((b) => bullet(pdfSafe(b)));
          doc.moveDown(0.5);
        }
      }
    }
    function bullet(text) {
      need(16);
      const y = doc.y;
      doc.font(reg).fontSize(t.size).fillColor('#111111').text('•', L + 4, y, { width: 10, lineBreak: false });
      doc.text(text, L + 16, y, { width: W - 16, lineGap: 1.5 });
      doc.moveDown(0.1);
    }
    doc.end();
  });
}

async function toDocx(resume, templateKey) {
  const t = tpl(templateKey);
  const font = t.docFont, sz = Math.round(t.size * 2), accent = t.accent;
  const RIGHT = 10466; // right tab stop at the text width of an A4 page with 0.75in margins (twips)
  const run = (text, o = {}) => new TextRun({ text: String(text || ''), font, size: sz, ...o });
  const kids = [];

  kids.push(new Paragraph({
    alignment: t.center ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { after: 40 },
    children: [run(resume.name, { bold: true, size: t.nameSize * 2, color: accent })],
  }));
  const cl = contactLine(resume);
  if (cl) kids.push(new Paragraph({ alignment: t.center ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { after: 120 }, children: [run(cl)] }));

  const bulletPara = (text) => new Paragraph({ numbering: { reference: 'bul', level: 0 }, spacing: { after: 30 }, children: [run(text)] });

  for (const sec of buildBlocks(resume)) {
    kids.push(new Paragraph({
      keepNext: true, spacing: { before: 200, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 1 } },
      children: [run(sec.heading.toUpperCase(), { bold: true, color: accent, size: sz + 2 })],
    }));
    for (const it of sec.items) {
      if (it.type === 'text') kids.push(new Paragraph({ spacing: { after: 80 }, children: [run(it.text)] }));
      else if (it.type === 'bullets') it.bullets.forEach((b) => kids.push(bulletPara(b)));
      else {
        kids.push(new Paragraph({
          keepNext: true, spacing: { before: 80 }, tabStops: [{ type: TabStopType.RIGHT, position: RIGHT }],
          children: [run(it.title, { bold: true }), ...(it.dates ? [run('\t' + it.dates)] : [])],
        }));
        if (it.sub) kids.push(new Paragraph({ keepNext: it.bullets.length > 0, spacing: { after: 30 }, children: [run(it.sub, { italics: true })] }));
        it.bullets.forEach((b) => kids.push(bulletPara(b)));
      }
    }
  }

  const doc = new Document({
    creator: resume.name, title: `${resume.name} - Resume`,
    numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 220 } } } }] }] },
    styles: { default: { document: { run: { font, size: sz } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 900, bottom: 900, left: 1080, right: 1080 } } }, children: kids }],
  });
  return Packer.toBuffer(doc);
}

// "Shreya Gowda" + "Product Analyst" -> "Shreya_Product_Analyst_Resume"
function suggestFilename(name, jobTitle) {
  const first = (name || '').trim().split(/\s+/)[0] || 'My';
  return cleanFilename(`${first}_${jobTitle || ''}_Resume`);
}
function cleanFilename(s) {
  const out = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _.-]/g, '').trim().replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '')
    .replace(/\.(pdf|docx)$/i, '').slice(0, 100);
  return out || 'Resume';
}

module.exports = { toPdf, toDocx, TEMPLATES, suggestFilename, cleanFilename };

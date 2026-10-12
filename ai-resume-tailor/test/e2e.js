const fs = require('fs'); const assert = require('assert'); const { PDFParse } = require('pdf-parse'); const mammoth = require('mammoth');
const B = 'http://localhost:3300';
class Client { constructor() { this.c = ''; }
  async req(path, { json, method, form, raw } = {}) {
    const h = { 'X-Requested-With': 'resume-tailor', cookie: this.c }; let body;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const r = await fetch(B + path, { method: method || (body ? 'POST' : 'GET'), headers: h, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) this.c = sc.split(';')[0].startsWith('sid=') && !/^sid=;/.test(sc) ? sc.split(';')[0] : '';
    if (raw) return r; const d = await r.json().catch(() => ({})); return { s: r.status, d };
  } }
const ok = (n) => console.log('  ✓', n);
(async () => {
  const a = new Client(), b = new Client();
  // auth
  let r = await a.req('/api/resumes'); assert.equal(r.s, 401); ok('unauthenticated access blocked');
  r = await fetch(B + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 403); ok('CSRF header required');
  r = await a.req('/api/auth/signup', { json: { name: 'Shreya Gowda', email: 'shreya@example.com', password: 'short' } }); assert.equal(r.s, 400); ok('weak password rejected');
  r = await a.req('/api/auth/signup', { json: { name: 'Shreya Gowda', email: 'Shreya@Example.com', password: 'Secret123' } }); assert.equal(r.s, 200); ok('signup');
  r = await a.req('/api/auth/signup', { json: { name: 'x', email: 'shreya@example.com', password: 'Secret123' } }); assert.equal(r.s, 409); ok('duplicate email rejected');
  const db = require('better-sqlite3')(process.env.DATA_DIR + '/app.db'); const row = db.prepare('select password_hash from users').get(); assert(row.password_hash.startsWith('$2')); ok('password stored hashed (bcrypt)');
  // parse
  let fd = new FormData(); fd.append('file', new Blob([fs.readFileSync('test/resume.pdf')]), 'resume.pdf');
  r = await a.req('/api/parse', { form: fd }); assert.equal(r.s, 200, JSON.stringify(r.d)); assert.equal(r.d.resume.name, 'Shreya Gowda'); ok('PDF parsed + structured');
  fd = new FormData(); fd.append('file', new Blob([fs.readFileSync('test/resume.docx')]), 'resume.docx');
  r = await a.req('/api/parse', { form: fd }); assert.equal(r.s, 200); assert(r.d.rawText.includes('Acme Analytics')); ok('DOCX parsed');
  fd = new FormData(); fd.append('file', new Blob(['MZ not a pdf']), 'evil.pdf'); r = await a.req('/api/parse', { form: fd }); assert.equal(r.s, 400); ok('fake PDF rejected:', r.d.error);
  fd = new FormData(); fd.append('file', new Blob([Buffer.alloc(6 * 1024 * 1024, 1)]), 'big.pdf'); r = await a.req('/api/parse', { form: fd }); assert.equal(r.s, 413); ok('oversize file rejected');
  fd = new FormData(); fd.append('file', new Blob(['%PDF-1.4 garbage garbage']), 'broken.pdf'); r = await a.req('/api/parse', { form: fd }); assert.equal(r.s, 400); ok('corrupt PDF gives friendly error: ' + r.d.error.slice(0, 50));
  const original = (await a.req('/api/parse', { form: (() => { const f = new FormData(); f.append('file', new Blob([fs.readFileSync('test/resume.pdf')]), 'resume.pdf'); return f; })() })).d.resume;
  // tailor
  const jd = 'We are hiring a Product Analyst. You will use Python, SQL and Excel for data visualization with Tableau and stakeholder management across teams. Strong communication required.';
  r = await a.req('/api/tailor', { json: { resume: original, jobDescription: 'short' } }); assert.equal(r.s, 400); ok('short JD rejected');
  r = await a.req('/api/tailor', { json: { resume: original, jobDescription: jd, jobTitle: 'Product Analyst', company: 'Acme' } }); assert.equal(r.s, 200, JSON.stringify(r.d));
  const t = r.d; assert(t.analysis.score > 0 && t.analysis.score <= 100); assert(t.analysis.found.includes('Python')); assert(t.analysis.missing.includes('stakeholder management'));
  assert(t.warnings.some((w) => /99%/.test(w))); assert(t.warnings.some((w) => /Tableau/.test(w))); ok(`tailored; score ${t.scoreBefore} → ${t.analysis.score}; fabricated "99%" and "Tableau" were flagged`);
  r = await a.req('/api/regenerate', { json: { section: 'summary', resume: t.resume, original, jobDescription: jd } }); assert.equal(r.s, 200); assert(/Regenerated/.test(r.d.value)); ok('regenerate section');
  // save
  const save = { title: 'Product Analyst - Acme', jobTitle: 'Product Analyst', company: 'Acme', jobDescription: jd, keywords: t.keywords, content: t.resume, original, template: 'modern' };
  r = await a.req('/api/resumes', { json: save }); assert.equal(r.s, 200); const id1 = r.d.resume.id; assert.equal(r.d.resume.version, 1); ok('saved resume #' + id1);
  r = await a.req('/api/resumes', { json: { ...save, groupId: r.d.resume.groupId, content: { ...t.resume, summary: 'Version two' } } }); const id2 = r.d.resume.id; assert.equal(r.d.resume.version, 2); ok('saved as new version (v2); v1 kept');
  r = await a.req('/api/resumes'); assert.equal(r.d.resumes.length, 2); assert(r.d.resumes.every((x) => x.atsScore != null)); ok('list shows 2 with ATS scores');
  r = await a.req('/api/resumes?q=acme'); assert.equal(r.d.resumes.length, 2); r = await a.req('/api/resumes?q=zzz'); assert.equal(r.d.resumes.length, 0); ok('search');
  r = await a.req('/api/resumes/' + id1); assert.equal(r.d.resume.content.summary, t.resume.summary); ok('v1 unchanged after v2 saved');
  // downloads
  let dr = await a.req(`/api/resumes/${id1}/download?format=pdf&filename=${encodeURIComponent('Shreya_Product_Analyst_Resume')}`, { raw: true });
  assert.equal(dr.status, 200); assert(/filename="Shreya_Product_Analyst_Resume.pdf"/.test(dr.headers.get('content-disposition')));
  const pdf = Buffer.from(await dr.arrayBuffer()); fs.writeFileSync('/tmp/out.pdf', pdf); assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  const pt = (await (async () => { const p = new PDFParse({ data: new Uint8Array(pdf) }); const x = await p.getText(); await p.destroy(); return x.text; })());
  for (const s of ['Shreya Gowda', 'PROFESSIONAL SUMMARY', 'WORK EXPERIENCE', 'Acme Analytics', 'Cleaned sales data using Python', 'Bangalore University']) assert(pt.includes(s), 'PDF missing ' + s); ok('PDF downloaded, text is selectable and complete');
  dr = await a.req(`/api/resumes/${id1}/download?format=docx`, { raw: true }); const dx = Buffer.from(await dr.arrayBuffer()); fs.writeFileSync('/tmp/out.docx', dx);
  assert(/Shreya_Product_Analyst_Resume\.docx/.test(dr.headers.get('content-disposition'))); const dt = (await mammoth.extractRawText({ buffer: dx })).value;
  for (const s of ['Shreya Gowda', 'Professional Summary'.toUpperCase(), 'Acme Analytics', 'Cleaned sales data using Python']) assert(dt.includes(s), 'DOCX missing ' + s); ok('DOCX downloaded (default personalised filename), content complete');
  for (const tpl of ['classic', 'compact']) { await a.req('/api/resumes/' + id1, { method: 'PUT', json: { ...save, template: tpl } }); const x = await a.req(`/api/resumes/${id1}/download?format=pdf`, { raw: true }); assert.equal(x.status, 200); fs.writeFileSync(`/tmp/out-${tpl}.pdf`, Buffer.from(await x.arrayBuffer())); } ok('all templates export');
  // rename / duplicate / replace / delete
  r = await a.req('/api/resumes/' + id1, { method: 'PATCH', json: { title: 'Renamed' } }); assert.equal(r.d.resume.title, 'Renamed'); ok('rename');
  r = await a.req(`/api/resumes/${id1}/duplicate`, { method: 'POST', json: {} }); assert.equal(r.s, 200); const id3 = r.d.resume.id; ok('duplicate');
  r = await a.req('/api/resumes/' + id3, { method: 'DELETE' }); assert.equal(r.s, 200); r = await a.req('/api/resumes/' + id3); assert.equal(r.s, 404); ok('delete');
  // persistence across sign out / in
  await a.req('/api/auth/signout', { json: {} }); r = await a.req('/api/resumes'); assert.equal(r.s, 401); ok('signed out');
  r = await a.req('/api/auth/signin', { json: { email: 'shreya@example.com', password: 'wrong' } }); assert.equal(r.s, 401);
  r = await a.req('/api/auth/signin', { json: { email: 'shreya@example.com', password: 'Secret123' } }); assert.equal(r.s, 200);
  r = await a.req('/api/resumes'); assert.equal(r.d.resumes.length, 2); ok('resumes persist after sign out / sign in');
  // isolation
  await b.req('/api/auth/signup', { json: { name: 'Other', email: 'other@example.com', password: 'Other1234' } });
  r = await b.req('/api/resumes'); assert.equal(r.d.resumes.length, 0);
  for (const [m, p] of [['GET', '/api/resumes/' + id1], ['GET', `/api/resumes/${id1}/download?format=pdf`], ['PATCH', '/api/resumes/' + id1], ['PUT', '/api/resumes/' + id1], ['DELETE', '/api/resumes/' + id1], ['POST', `/api/resumes/${id1}/duplicate`]]) {
    r = await b.req(p, { method: m, json: m === 'GET' ? undefined : save }); assert.equal(r.s, 404, m + ' ' + p); }
  r = await b.req('/api/resumes', { json: { ...save, groupId: id1 } }); const x = await a.req('/api/resumes'); assert(x.d.resumes.every((q) => q.id !== r.d.resume.id)); ok("user B cannot read/modify/delete/download/chain onto user A's resumes");
  // password reset
  r = await a.req('/api/auth/forgot', { json: { email: 'shreya@example.com' } }); assert.equal(r.s, 200); ok('forgot-password responds (link logged to server console as SMTP is unset)');
  console.log('\nALL API CHECKS PASSED');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });

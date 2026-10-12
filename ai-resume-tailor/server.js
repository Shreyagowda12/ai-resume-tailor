require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { extractText, basicFields, UserError } = require('./lib/parse');
const ai = require('./lib/ai');
const { analyze, truthCheck } = require('./lib/ats');
const { normalizeResume, emptyResume, SECTIONS } = require('./lib/schema');
const exporter = require('./lib/export');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"] } },
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(auth.csrfGuard);
app.use(auth.loadUser);

const limiter = (windowMs, max, msg) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: msg } });
const authLimiter = limiter(15 * 60 * 1000, 30, 'Too many attempts. Please wait a few minutes and try again.');
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: Number(process.env.AI_REQUESTS_PER_HOUR || 40), standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `u${req.user ? req.user.id : 'anon'}`, validate: false,
  message: { error: 'You have used a lot of AI requests this hour. Please try again a little later.' },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

// ---------- Config ----------
app.get('/api/config', (req, res) => {
  res.json({
    aiConfigured: ai.aiConfigured(),
    templates: Object.entries(exporter.TEMPLATES).map(([key, t]) => ({ key, label: t.label })),
  });
});

// ---------- Auth ----------
app.post('/api/auth/signup', authLimiter, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = req.body.password;
  if (!name) throw new UserError('Please enter your name.');
  if (!auth.validEmail(email)) throw new UserError('Please enter a valid email address.');
  const pwErr = auth.validatePassword(password);
  if (pwErr) throw new UserError(pwErr);
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new UserError('An account with this email already exists. Try signing in instead.', 409);
  const hash = await auth.bcrypt.hash(password, 12);
  const info = db.prepare('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)').run(name, email, hash);
  auth.startSession(res, info.lastInsertRowid);
  res.json({ user: { id: info.lastInsertRowid, name, email } });
}));

const DUMMY_HASH = auth.bcrypt.hashSync('not-a-real-password', 12); // keeps timing the same for unknown emails
app.post('/api/auth/signin', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const ok = await auth.bcrypt.compare(String(req.body.password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new UserError('Incorrect email or password.', 401);
  auth.startSession(res, user.id);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/signout', (req, res) => { auth.endSession(req, res); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

app.post('/api/auth/forgot', authLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  let emailed = false;
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(user.id);
    db.prepare('INSERT INTO password_resets (token_hash,user_id,expires_at) VALUES (?,?,?)').run(auth.sha(token), user.id, Date.now() + 3600e3);
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    try { emailed = await auth.sendResetEmail(user.email, `${base}/#/reset?token=${token}`); } catch (e) { console.error('reset email failed:', e.message); }
  }
  const smtp = !!process.env.SMTP_HOST;
  res.json({ ok: true, message: smtp
    ? 'If an account exists for that email, we have sent a link to reset the password.'
    : 'Email sending is not set up on this server yet, so no email was sent. The site owner can find your reset link in the server log (see README).' });
}));

app.post('/api/auth/reset', authLimiter, wrap(async (req, res) => {
  const pwErr = auth.validatePassword(req.body.password);
  if (pwErr) throw new UserError(pwErr);
  const row = db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND expires_at>?').get(auth.sha(String(req.body.token || '')), Date.now());
  if (!row) throw new UserError('This reset link is invalid or has expired. Please request a new one.');
  const hash = await auth.bcrypt.hash(req.body.password, 12);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, row.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id=?').run(row.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
  res.json({ ok: true });
}));

// ---------- Everything below needs a signed-in user ----------
app.use('/api', auth.requireUser);

// ---------- Upload + parse ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
app.post('/api/parse', aiLimiter, (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return next(new UserError('That file is too large. Please upload a file smaller than 5 MB.', 413));
  if (err) return next(new UserError('The upload failed. Please try again.'));
  next();
}), wrap(async (req, res) => {
  if (!req.file) throw new UserError('Please choose a PDF or DOCX file to upload.');
  const { text } = await extractText(req.file.buffer, req.file.originalname);
  let resume, warning = null;
  try {
    resume = await ai.structureResume(text);
  } catch (e) {
    if (!e.userFacing) throw e;
    // Could not use AI: still hand back the raw text so nothing is lost.
    const b = basicFields(text);
    resume = emptyResume(); resume.name = b.name; resume.contact.email = b.email; resume.contact.phone = b.phone;
    warning = `${e.message} We extracted your text below, but could not sort it into sections automatically. Please fill in the sections yourself.`;
  }
  res.json({ resume, rawText: text, warning });
}));

// ---------- AI tailoring ----------
const jdOk = (jd) => typeof jd === 'string' && jd.trim().length >= 80;

app.post('/api/tailor', aiLimiter, wrap(async (req, res) => {
  const original = normalizeResume(req.body.resume);
  const jobDescription = String(req.body.jobDescription || '').trim().slice(0, 20000);
  if (!original.name || (!original.experience.length && !original.projects.length && !original.skills.length)) {
    throw new UserError('Your resume looks empty. Please add your name and some experience, projects, or skills first.');
  }
  if (!jdOk(jobDescription)) throw new UserError('Please paste the full job description (at least a few sentences).');
  const out = await ai.tailorResume({
    resume: original, jobDescription,
    jobTitle: String(req.body.jobTitle || '').slice(0, 120), company: String(req.body.company || '').slice(0, 120),
  });
  // The AI is not allowed to change who the person is.
  out.resume.name = original.name;
  out.resume.contact = original.contact;
  const analysis = analyze(out.resume, jobDescription, out.keywords);
  const before = analyze(original, jobDescription, out.keywords);
  res.json({ ...out, analysis, scoreBefore: before.score, warnings: truthCheck(original, out.resume) });
}));

app.post('/api/regenerate', aiLimiter, wrap(async (req, res) => {
  const section = String(req.body.section || '');
  if (!SECTIONS.includes(section)) throw new UserError('Unknown section.');
  const jobDescription = String(req.body.jobDescription || '').trim().slice(0, 20000);
  if (!jdOk(jobDescription)) throw new UserError('A job description is needed to regenerate a section.');
  const original = normalizeResume(req.body.original);
  const resume = normalizeResume(req.body.resume);
  const value = await ai.regenerateSection({
    section, resume, original, jobDescription,
    jobTitle: String(req.body.jobTitle || '').slice(0, 120), company: String(req.body.company || '').slice(0, 120),
    instruction: String(req.body.instruction || '').slice(0, 300),
  });
  const next = { ...resume, [section]: value };
  res.json({ value, warnings: truthCheck(original, normalizeResume(next)) });
}));

// Pure calculation (no AI): re-score after the user edits.
app.post('/api/analyze', wrap(async (req, res) => {
  const resume = normalizeResume(req.body.resume);
  const original = req.body.original ? normalizeResume(req.body.original) : null;
  const keywords = Array.isArray(req.body.keywords) ? req.body.keywords.filter((k) => typeof k === 'string').slice(0, 40) : [];
  res.json({
    analysis: analyze(resume, String(req.body.jobDescription || '').slice(0, 20000), keywords),
    warnings: original ? truthCheck(original, resume) : [],
  });
}));

// ---------- Saved resumes ----------
const summary = (r) => ({
  id: r.id, groupId: r.group_id, version: r.version, title: r.title, jobTitle: r.job_title, company: r.company,
  atsScore: r.ats_score, template: r.template, createdAt: r.created_at, updatedAt: r.updated_at,
});
const full = (r) => ({
  ...summary(r), jobDescription: r.job_description, content: JSON.parse(r.content),
  original: r.original ? JSON.parse(r.original) : null, keywords: r.keywords ? JSON.parse(r.keywords) : [],
});
const mine = (req) => db.prepare('SELECT * FROM resumes WHERE id=? AND user_id=?').get(Number(req.params.id) || 0, req.user.id);
const notFound = () => new UserError('We could not find that resume.', 404);
const TEMPLATE_KEYS = Object.keys(exporter.TEMPLATES);

function readBody(req) {
  const b = req.body;
  const content = normalizeResume(b.content);
  if (!content.name) throw new UserError('Please add your name to the resume before saving.');
  const jobDescription = String(b.jobDescription || '').slice(0, 20000);
  const keywords = Array.isArray(b.keywords) ? b.keywords.filter((k) => typeof k === 'string').slice(0, 40) : [];
  const jobTitle = String(b.jobTitle || '').trim().slice(0, 120);
  const company = String(b.company || '').trim().slice(0, 120);
  const title = String(b.title || '').trim().slice(0, 150) || [jobTitle, company].filter(Boolean).join(' - ') || `${content.name} Resume`;
  const score = (jobDescription || keywords.length) ? analyze(content, jobDescription, keywords).score : null;
  return {
    title, jobTitle, company, jobDescription, keywords, content, score,
    original: b.original ? normalizeResume(b.original) : null,
    template: TEMPLATE_KEYS.includes(b.template) ? b.template : 'classic',
  };
}

app.get('/api/resumes', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = db.prepare('SELECT * FROM resumes WHERE user_id=? ORDER BY updated_at DESC, id DESC').all(req.user.id);
  if (q) rows = rows.filter((r) => `${r.title} ${r.job_title} ${r.company}`.toLowerCase().includes(q));
  res.json({ resumes: rows.map(summary) });
});

app.get('/api/resumes/:id', (req, res) => { const r = mine(req); if (!r) throw notFound(); res.json({ resume: full(r) }); });

// Create a NEW saved resume (never overwrites). groupId links it as a new version of an earlier one.
app.post('/api/resumes', (req, res) => {
  const d = readBody(req);
  let groupId = null, version = 1;
  if (req.body.groupId) {
    const g = db.prepare('SELECT MAX(version) v, MIN(id) first FROM resumes WHERE user_id=? AND (group_id=? OR id=?)').get(req.user.id, req.body.groupId, req.body.groupId);
    if (g && g.v) { groupId = Number(req.body.groupId); version = g.v + 1; }
  }
  const info = db.prepare(`INSERT INTO resumes (user_id,group_id,version,title,job_title,company,job_description,template,content,original,keywords,ats_score)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, groupId, version, d.title, d.jobTitle, d.company, d.jobDescription, d.template,
    JSON.stringify(d.content), d.original ? JSON.stringify(d.original) : null, JSON.stringify(d.keywords), d.score);
  const id = info.lastInsertRowid;
  if (!groupId) db.prepare('UPDATE resumes SET group_id=? WHERE id=?').run(id, id);
  res.json({ resume: full(db.prepare('SELECT * FROM resumes WHERE id=?').get(id)) });
});

// Explicitly replace an existing saved resume.
app.put('/api/resumes/:id', (req, res) => {
  const r = mine(req); if (!r) throw notFound();
  const d = readBody(req);
  db.prepare(`UPDATE resumes SET title=?,job_title=?,company=?,job_description=?,template=?,content=?,original=?,keywords=?,ats_score=?,updated_at=datetime('now') WHERE id=?`)
    .run(d.title, d.jobTitle, d.company, d.jobDescription, d.template, JSON.stringify(d.content),
      d.original ? JSON.stringify(d.original) : r.original, JSON.stringify(d.keywords), d.score, r.id);
  res.json({ resume: full(db.prepare('SELECT * FROM resumes WHERE id=?').get(r.id)) });
});

app.patch('/api/resumes/:id', (req, res) => {
  const r = mine(req); if (!r) throw notFound();
  const title = String(req.body.title || '').trim().slice(0, 150);
  if (!title) throw new UserError('Please type a name for the resume.');
  db.prepare(`UPDATE resumes SET title=?, updated_at=datetime('now') WHERE id=?`).run(title, r.id);
  res.json({ resume: summary(db.prepare('SELECT * FROM resumes WHERE id=?').get(r.id)) });
});

app.post('/api/resumes/:id/duplicate', (req, res) => {
  const r = mine(req); if (!r) throw notFound();
  const info = db.prepare(`INSERT INTO resumes (user_id,group_id,version,title,job_title,company,job_description,template,content,original,keywords,ats_score)
    VALUES (?,NULL,1,?,?,?,?,?,?,?,?,?)`).run(r.user_id, `${r.title} (copy)`.slice(0, 150), r.job_title, r.company, r.job_description, r.template, r.content, r.original, r.keywords, r.ats_score);
  db.prepare('UPDATE resumes SET group_id=id WHERE id=?').run(info.lastInsertRowid);
  res.json({ resume: summary(db.prepare('SELECT * FROM resumes WHERE id=?').get(info.lastInsertRowid)) });
});

app.delete('/api/resumes/:id', (req, res) => {
  const r = mine(req); if (!r) throw notFound();
  db.prepare('DELETE FROM resumes WHERE id=?').run(r.id);
  res.json({ ok: true });
});

app.get('/api/resumes/:id/download', wrap(async (req, res) => {
  const r = mine(req); if (!r) throw notFound();
  const format = req.query.format === 'docx' ? 'docx' : 'pdf';
  const content = JSON.parse(r.content);
  const asked = String(req.query.filename || '').trim();
  const base = asked ? exporter.cleanFilename(asked) : exporter.suggestFilename(content.name, r.job_title);
  const name = `${base}.${format}`;
  let buf;
  try { buf = format === 'pdf' ? await exporter.toPdf(content, r.template) : await exporter.toDocx(content, r.template); }
  catch (e) { console.error('export failed:', e); throw new UserError('We could not create the download. Please try again.', 500); }
  res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buf);
}));

app.get('/api/suggest-filename', (req, res) => {
  res.json({ filename: exporter.suggestFilename(String(req.query.name || req.user.name), String(req.query.jobTitle || '')) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// ---------- Errors ----------
app.use((err, req, res, _next) => {
  if (err && err.userFacing) return res.status(err.status || 400).json({ error: err.message });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much text to process at once.' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI Resume Tailor running at http://localhost:${PORT}`);
    if (!ai.aiConfigured()) console.log('WARNING: ANTHROPIC_API_KEY is not set. AI features will show a setup message.');
  });
}
module.exports = app;

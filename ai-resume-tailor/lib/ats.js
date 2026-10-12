const { resumeToText, SECTIONS } = require('./schema');

const STOP = new Set(('a an the and or of to in for with on at by from as is are be been being this that these those it its your you we our their they will can may must should would could ' +
  'have has had do does did not no nor so such than then there here who whom which what when where why how all any each both few more most other some own same too very just also into over under again further once about above ' +
  'across after before between during through up down out off per via etc including include includes work working ability able strong good great experience years year role position job team company candidate required preferred plus ' +
  'responsibilities requirements qualifications skills knowledge looking join us new using use used').split(/\s+/));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Does `kw` appear in `text`? Case-insensitive, whole-word, tolerant of simple plurals.
function countKeyword(text, kw) {
  const k = kw.trim();
  if (!k) return 0;
  const pat = esc(k).replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?<![A-Za-z0-9])${pat}(?:s|es)?(?![A-Za-z0-9])`, 'gi');
  return (text.match(re) || []).length;
}

// Fallback keyword extraction (used only if the AI did not return keywords): most frequent meaningful words.
function fallbackKeywords(jd) {
  const freq = new Map();
  (jd.toLowerCase().match(/[a-z][a-z0-9+#.\-/]{1,}/g) || []).forEach((w) => {
    w = w.replace(/[.\-/]+$/, '');
    if (w.length < 3 || STOP.has(w)) return;
    freq.set(w, (freq.get(w) || 0) + 1);
  });
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);
}

function analyze(resume, jobDescription, keywords) {
  const text = resumeToText(resume);
  const kws = (keywords && keywords.length ? keywords : fallbackKeywords(jobDescription || '')).slice(0, 40);
  const found = [], missing = [], stuffed = [];
  kws.forEach((k) => {
    const n = countKeyword(text, k);
    if (n > 0) found.push(k); else missing.push(k);
    if (n > 6) stuffed.push(k);
  });

  const breakdown = [];
  const add = (label, got, max, note) => breakdown.push({ label, got: Math.round(got * 10) / 10, max, note });
  const formatting = [];

  // 1. Keyword coverage (50)
  const cov = kws.length ? found.length / kws.length : 0;
  add('Keyword match', cov * 50, 50, kws.length ? `${found.length} of ${kws.length} job keywords appear in your resume.` : 'No job keywords to compare yet.');

  // 2. Sections and contact details (20)
  let sec = 0;
  const hasContact = !!(resume.contact.email && resume.contact.phone);
  if (hasContact) sec += 5; else formatting.push('Add both an email address and a phone number so recruiters can reach you.');
  if (resume.summary) sec += 3; else formatting.push('Add a short Professional Summary at the top.');
  if (resume.skills.length) sec += 4; else formatting.push('Add a Skills section with a plain list of your skills.');
  if (resume.experience.length || resume.projects.length) sec += 4; else formatting.push('Add Work Experience or Projects.');
  if (resume.education.length) sec += 4; else formatting.push('Add an Education section.');
  add('Standard sections & contact info', sec, 20, 'ATS software looks for familiar headings and contact details.');

  // 3. Bullet quality (15)
  const bullets = [...resume.experience.flatMap((e) => e.bullets), ...resume.projects.flatMap((p) => p.bullets)];
  let bq = 0;
  if (bullets.length) {
    const lenOk = bullets.filter((b) => { const w = b.split(/\s+/).length; return w >= 6 && w <= 35; }).length / bullets.length;
    const startOk = bullets.filter((b) => /^[A-Z]/.test(b) && !/^(I|We|My|Responsible for|Duties|Worked on)\b/i.test(b)).length / bullets.length;
    bq = (lenOk * 0.6 + startOk * 0.4) * 15;
    if (lenOk < 0.8) formatting.push('Keep each bullet point between about 6 and 30 words.');
    if (startOk < 0.8) formatting.push('Start bullet points with an action verb (for example "Built", "Led", "Analysed") rather than "Responsible for".');
  } else formatting.push('Describe your work with bullet points under each job or project.');
  add('Bullet point quality', bq, 15, 'Short bullets that start with action verbs are easier to read and scan.');

  // 4. Length (10)
  const words = text.split(/\s+/).filter(Boolean).length;
  let len = 10;
  if (words < 150) len = 3; else if (words < 250) len = 7; else if (words > 1100) len = 4; else if (words > 850) len = 7;
  if (words < 250) formatting.push(`Your resume is short (${words} words). Add more detail about your real skills and experience.`);
  if (words > 850) formatting.push(`Your resume is long (${words} words). Aim for 1-2 pages by trimming less relevant details.`);
  add('Length & readability', len, 10, `${words} words.`);

  // 5. Dates (5)
  const datedEntries = [...resume.experience, ...resume.education].filter((e) => e.dates).length;
  const totalEntries = resume.experience.length + resume.education.length;
  add('Dates on entries', totalEntries ? (datedEntries / totalEntries) * 5 : 0, 5, 'Dates help ATS build your work timeline.');
  if (totalEntries && datedEntries < totalEntries) formatting.push('Add dates to every job and education entry.');

  // Penalty for keyword stuffing
  let penalty = 0;
  if (stuffed.length) {
    penalty = Math.min(10, stuffed.length * 3);
    formatting.push(`These keywords appear very often and may look like stuffing: ${stuffed.join(', ')}. Use each naturally, not repeatedly.`);
  }
  breakdown.push({ label: 'Keyword stuffing penalty', got: -penalty, max: 0, note: 'Overusing a keyword can hurt readability.' });

  const score = Math.max(0, Math.min(100, Math.round(breakdown.reduce((s, b) => s + b.got, 0))));
  return { score, found, missing, stuffed, breakdown, formatting, wordCount: words };
}

// Compare tailored output with the original and flag anything that may not be true.
function truthCheck(original, tailored) {
  const orig = resumeToText(original).toLowerCase();
  const warnings = [];
  const numRe = /\d[\d,.]*\s?(?:%|\+|k|m|x)?/gi;
  const origNums = new Set((orig.match(numRe) || []).map((n) => n.replace(/[\s,]/g, '').toLowerCase()));
  const seen = new Set();
  const checkNums = (txt, where) => {
    (txt.match(numRe) || []).forEach((n) => {
      const key = n.replace(/[\s,]/g, '').toLowerCase().replace(/[.,]+$/, '');
      if (key && !origNums.has(key) && !seen.has(key + where)) {
        seen.add(key + where);
        warnings.push(`A number "${n.trim()}" in ${where} was not in your original resume. Please check it is accurate or remove it.`);
      }
    });
  };
  tailored.experience.forEach((e) => e.bullets.forEach((b) => checkNums(b, `${e.company || 'Work Experience'}`)));
  tailored.projects.forEach((p) => p.bullets.forEach((b) => checkNums(b, `project "${p.name}"`)));
  checkNums(tailored.summary, 'the summary');

  tailored.skills.forEach((s) => {
    if (!orig.includes(s.toLowerCase())) warnings.push(`The skill "${s}" was not found in your original resume. Keep it only if it is true.`);
  });
  tailored.experience.forEach((e) => {
    if (e.company && !orig.includes(e.company.toLowerCase())) warnings.push(`The employer "${e.company}" was not in your original resume.`);
  });
  tailored.education.forEach((e) => {
    if (e.school && !orig.includes(e.school.toLowerCase())) warnings.push(`The school "${e.school}" was not in your original resume.`);
  });
  tailored.certifications.forEach((c) => {
    if (!orig.includes(c.toLowerCase().slice(0, 25))) warnings.push(`The certification "${c}" was not found in your original resume.`);
  });
  return warnings.slice(0, 30);
}

module.exports = { analyze, truthCheck, countKeyword, SECTIONS };

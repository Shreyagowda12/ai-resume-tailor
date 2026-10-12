// Canonical resume shape + helpers shared by parsing, AI, analysis and export.

const SECTIONS = ['summary', 'skills', 'experience', 'education', 'projects', 'certifications', 'achievements'];

const str = (v, max = 2000) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const strList = (v, maxItems = 60, maxLen = 600) =>
  (Array.isArray(v) ? v : []).map((x) => str(typeof x === 'string' ? x : '', maxLen)).filter(Boolean).slice(0, maxItems);
const objList = (v, maxItems, fn) => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === 'object').slice(0, maxItems).map(fn);

function emptyResume() {
  return {
    name: '',
    contact: { email: '', phone: '', location: '', links: [] },
    summary: '',
    skills: [],
    experience: [],
    education: [],
    projects: [],
    certifications: [],
    achievements: [],
  };
}

// Force any input (user-edited or AI-generated) into the canonical shape.
function normalizeResume(r) {
  r = r && typeof r === 'object' ? r : {};
  const c = r.contact && typeof r.contact === 'object' ? r.contact : {};
  return {
    name: str(r.name, 120),
    contact: {
      email: str(c.email, 254),
      phone: str(c.phone, 40),
      location: str(c.location, 120),
      links: strList(c.links, 6, 200),
    },
    summary: str(r.summary, 2000),
    skills: strList(r.skills, 80, 80),
    experience: objList(r.experience, 20, (e) => ({
      title: str(e.title, 150), company: str(e.company, 150), location: str(e.location, 120),
      dates: str(e.dates, 60), bullets: strList(e.bullets, 15, 500),
    })),
    education: objList(r.education, 10, (e) => ({
      degree: str(e.degree, 200), school: str(e.school, 200), location: str(e.location, 120),
      dates: str(e.dates, 60), details: strList(e.details, 8, 300),
    })),
    projects: objList(r.projects, 15, (p) => ({
      name: str(p.name, 150), tech: str(p.tech, 200), dates: str(p.dates, 60), bullets: strList(p.bullets, 10, 500),
    })),
    certifications: strList(r.certifications, 25, 200),
    achievements: strList(r.achievements, 25, 400),
  };
}

function resumeToText(r) {
  const L = [];
  L.push(r.name, [r.contact.email, r.contact.phone, r.contact.location, ...r.contact.links].filter(Boolean).join(' | '));
  if (r.summary) L.push('PROFESSIONAL SUMMARY', r.summary);
  if (r.skills.length) L.push('SKILLS', r.skills.join(', '));
  if (r.experience.length) {
    L.push('WORK EXPERIENCE');
    r.experience.forEach((e) => L.push([e.title, e.company, e.location, e.dates].filter(Boolean).join(' | '), ...e.bullets));
  }
  if (r.projects.length) {
    L.push('PROJECTS');
    r.projects.forEach((p) => L.push([p.name, p.tech, p.dates].filter(Boolean).join(' | '), ...p.bullets));
  }
  if (r.education.length) {
    L.push('EDUCATION');
    r.education.forEach((e) => L.push([e.degree, e.school, e.location, e.dates].filter(Boolean).join(' | '), ...e.details));
  }
  if (r.certifications.length) L.push('CERTIFICATIONS', ...r.certifications);
  if (r.achievements.length) L.push('ACHIEVEMENTS', ...r.achievements);
  return L.filter(Boolean).join('\n');
}

// Text of a single section (used for original-vs-modified comparison and truthfulness checks).
function sectionText(r, key) {
  const only = emptyResume();
  if (key === 'summary') return r.summary || '';
  only[key] = r[key];
  return resumeToText(only).replace(/^[A-Z ]+\n/, '');
}

module.exports = { SECTIONS, emptyResume, normalizeResume, resumeToText, sectionText, str, strList };

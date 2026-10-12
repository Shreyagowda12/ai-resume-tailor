const Anthropic = require('@anthropic-ai/sdk');
const { normalizeResume, SECTIONS, strList } = require('./schema');
const { UserError } = require('./parse');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
let client = null;

function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
function getClient() {
  if (!aiConfigured()) {
    throw new UserError('The AI service is not set up yet. The site owner needs to add an ANTHROPIC_API_KEY (see README).', 503);
  }
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120000, maxRetries: 2 });
  return client;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no json');
  return JSON.parse(text.slice(start, end + 1));
}

async function callJson(system, user, maxTokens = 8000) {
  const c = getClient();
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let msg;
    try {
      msg = await c.messages.create({
        model: MODEL, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: user }],
      });
    } catch (e) {
      const s = e && e.status;
      if (s === 401 || s === 403) throw new UserError('The AI service rejected our API key. The site owner should check ANTHROPIC_API_KEY.', 502);
      if (s === 429) throw new UserError('The AI service is busy right now. Please wait a minute and try again.', 429);
      throw new UserError('The AI request failed. Please try again in a moment.', 502);
    }
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try { return extractJson(text); } catch (e) { lastErr = e; }
  }
  throw new UserError('The AI returned an unreadable answer. Please try again.', 502);
}

const SCHEMA_DOC = `Resume JSON schema (use exactly these keys):
{
 "name": string,
 "contact": {"email": string, "phone": string, "location": string, "links": [string]},
 "summary": string,
 "skills": [string],
 "experience": [{"title": string, "company": string, "location": string, "dates": string, "bullets": [string]}],
 "education": [{"degree": string, "school": string, "location": string, "dates": string, "details": [string]}],
 "projects": [{"name": string, "tech": string, "dates": string, "bullets": [string]}],
 "certifications": [string],
 "achievements": [string]
}`;

const TRUTH_RULES = `STRICT TRUTHFULNESS RULES:
- Use ONLY facts present in the candidate's resume. Never invent or imply employers, job titles, dates, degrees, certifications, skills, tools, projects, achievements, or numbers/metrics.
- Do not add a skill or tool unless it appears (or is clearly a synonym of something that appears) in the candidate's resume.
- You may reword, reorder, merge, and emphasise real content, and use the job description's terminology ONLY where it truthfully describes what the candidate already did.
- Never add numbers, percentages, or amounts that are not in the original text.
- Keep all companies, schools, titles, and dates exactly as given.`;

async function structureResume(text) {
  const system = `You convert raw resume text into structured JSON. Copy information faithfully; do not invent, embellish, or infer anything. Put missing fields as empty strings/arrays. Keep the original wording of bullet points. Put items that don't fit a section (e.g. awards, publications, achievements) in "achievements". Respond with JSON only.\n${SCHEMA_DOC}`;
  const out = await callJson(system, `Resume text:\n"""\n${text}\n"""`);
  return normalizeResume(out);
}

async function tailorResume({ resume, jobDescription, jobTitle, company }) {
  const system = `You are an expert resume writer who optimises resumes for Applicant Tracking Systems (ATS) and human recruiters.
Tailor the candidate's resume to the job description.
Do all of the following:
- Identify the important keywords/skills/tools in the job description.
- Improve wording, grammar, clarity and professional tone. Start bullets with strong action verbs. Keep bullets concise (under ~30 words).
- Rewrite bullets to highlight the most job-relevant real achievements; order sections' items by relevance to the job.
- Write a 2-3 sentence "summary" (Professional Summary) based only on the candidate's real background and aimed at this role.
- Use plain, ATS-standard content. Place keywords naturally; never stuff or repeat them unnaturally.
${TRUTH_RULES}
Respond with JSON only, in this shape:
{"resume": <resume JSON>, "keywords": [string, ... up to 30 important keywords/phrases from the job description, most important first], "changes": [string, ... a checklist of the specific improvements you made], "suggestions": [string, ... advice for the candidate for improving further, e.g. real experience they could add if they have it — never claim they have it]}
${SCHEMA_DOC}`;
  const user = `Job title: ${jobTitle || '(not given)'}\nCompany: ${company || '(not given)'}\n\nJOB DESCRIPTION:\n"""\n${jobDescription}\n"""\n\nCANDIDATE RESUME (JSON):\n${JSON.stringify(resume)}`;
  const out = await callJson(system, user, 10000);
  return {
    resume: normalizeResume(out.resume),
    keywords: strList(out.keywords, 40, 60),
    changes: strList(out.changes, 25, 300),
    suggestions: strList(out.suggestions, 15, 300),
  };
}

async function regenerateSection({ section, resume, original, jobDescription, jobTitle, company, instruction }) {
  if (!SECTIONS.includes(section)) throw new UserError('Unknown section.');
  const system = `You are an expert ATS resume writer. Rewrite ONLY the "${section}" section of the candidate's resume so it better fits the job description, with a fresh take on the wording.
${TRUTH_RULES}
Use the ORIGINAL resume as the source of truth for facts. Respond with JSON only: {"${section}": <value in the same format as in the schema>}.
${SCHEMA_DOC}`;
  const user = `Job title: ${jobTitle || '(not given)'}\nCompany: ${company || '(not given)'}\n\nJOB DESCRIPTION:\n"""\n${jobDescription}\n"""\n\nORIGINAL RESUME (JSON, source of truth):\n${JSON.stringify(original)}\n\nCURRENT VERSION OF THE SECTION:\n${JSON.stringify(resume[section])}\n${instruction ? `\nExtra instruction from the candidate: ${instruction}\n` : ''}`;
  const out = await callJson(system, user, 4000);
  const merged = normalizeResume({ ...resume, [section]: out[section] });
  return merged[section];
}

module.exports = { aiConfigured, structureResume, tailorResume, regenerateSection, MODEL };

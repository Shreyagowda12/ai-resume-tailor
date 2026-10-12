# AI Resume Tailor – ATS Resume Builder

A full-stack web app: sign up, upload a PDF/DOCX resume, paste a job description, get an AI-tailored and ATS-friendly version, edit it, save it, and download it as PDF or DOCX.

## Quick start (about 5 minutes)

1. Install **Node.js 20 or newer** from https://nodejs.org
2. In this folder run: `npm install`
3. Copy `.env.example` to `.env` and paste your Anthropic API key after `ANTHROPIC_API_KEY=`
   (create one at https://console.anthropic.com/ → API Keys. The key stays on the server and is never sent to the browser.)
4. Run: `npm start`
5. Open http://localhost:3000, create an account and click **Create New Resume**.

Without an API key the site still runs (sign-in, saved resumes, manual entry, editing, scoring, downloads all work), but reading uploads into sections, tailoring and "Regenerate section" show a clear "AI is not set up" message.

## How it works

Sign Up/In → Homepage → Create New Resume → Upload (PDF/DOCX) → check extracted details → paste job description → **Tailor** → ATS analysis → Editor (live preview, original-vs-current comparison, regenerate a section, undo, templates) → **Save Final Resume** → Download PDF/DOCX → it appears under **My Saved Resumes**.

- Nothing is saved to your account until you click **Save Final Resume**. Unsaved work in progress is kept in your browser so a refresh does not lose it.
- Saving an already-saved resume asks whether to **save as a new version** (default; older version kept) or **replace** it.
- Downloads are named like `Shreya_Product_Analyst_Resume.pdf` (first name + job title), and you can rename before downloading. PDFs use real text (selectable), single column, no tables/icons/images. DOCX is fully editable.

## Truthfulness safeguards
- The AI prompt forbids inventing employers, titles, dates, degrees, certifications, skills, projects or numbers.
- Your name and contact details are copied from your reviewed original, never from the AI.
- After tailoring (and after each edit/regeneration) the server compares the result with your original and **warns about new numbers, skills, employers, schools or certifications** that were not in it. You decide what to keep.

## ATS score
The score is an **estimate** calculated by this app's own transparent rules (not by AI and not from any employer's system): keyword match with the job description (50), standard sections and contact info (20), bullet-point quality (15), length (10), dates (5), minus a keyword-stuffing penalty. It is not a guarantee of passing any ATS. Job keywords are extracted by the AI from the job description; if that ever fails, a simple word-frequency fallback is used.

## Security
Passwords are hashed with bcrypt; sessions are random tokens in HttpOnly cookies (stored hashed); every resume query is filtered by the signed-in user's id (other users get "not found"); uploads are limited to 5 MB and checked by file contents, not just the name; state-changing requests need a CSRF header; sign-in and AI endpoints are rate-limited; security headers via Helmet.

## Limitations (honest list)
- **Forgot password**: email only works if you configure SMTP (see `.env.example`). Otherwise the reset link is printed in the server console, and the page tells the user no email was sent.
- **Scanned/image PDFs** have no text and cannot be read (no OCR); the app says so and lets users type their details.
- **PDF export uses standard Latin fonts**: characters outside Western European scripts (e.g. Devanagari, Chinese) show as `?` in the PDF. DOCX keeps all characters.
- **Parsing accuracy** depends on the AI; users review and correct the extracted details before continuing.
- Data is stored in a local SQLite file (`data/app.db`). Back it up; for many users or multiple servers, move to a hosted database.
- Deploy behind HTTPS (set `NODE_ENV=production`, `BASE_URL`, and `TRUST_PROXY=1` behind a proxy).
- Password change from inside the account and account deletion screens are not included.

## Running the tests
The tests use a small stand-in for the AI API (`test/stub-anthropic.js`, test-only) so they run offline:
```
node test/make-fixtures.js
node test/stub-anthropic.js &
DATA_DIR=/tmp/rt-data PORT=3300 ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://localhost:4010 node server.js &
DATA_DIR=/tmp/rt-data node test/e2e.js
```
These were run against this build: sign-up, hashing, upload validation, parsing, tailoring, truth warnings, save/versioning, search, PDF/DOCX content, rename/duplicate/delete, persistence after sign-out, and user-to-user isolation. The real AI model has **not** been exercised here (no key available), so tailoring quality with your key is the one thing to try first.

(() => {
'use strict';

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
let user = null, config = { aiConfigured: false, templates: [] }, draft = null;

async function api(url, opts = {}) {
  const o = { method: 'GET', headers: { 'X-Requested-With': 'resume-tailor' }, credentials: 'same-origin', ...opts };
  if (opts.json !== undefined) { o.method = opts.method || 'POST'; o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.json); }
  let res;
  try { res = await fetch(url, o); } catch (e) { throw new Error('Could not reach the server. Please check your internet connection and try again.'); }
  if (opts.blob && res.ok) return res.blob();
  let data = {};
  try { data = await res.json(); } catch (e) { /* not json */ }
  if (res.status === 401 && user && !url.includes('/auth/')) { user = null; renderTop(); location.hash = '#/login'; throw new Error('Your session ended. Please sign in again.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}
function busy(text, sub = '') { $('#overlay-text').textContent = text; $('#overlay-sub').textContent = sub; $('#overlay').classList.remove('hidden'); }
function idle() { $('#overlay').classList.add('hidden'); }
async function withBusy(text, sub, fn) { busy(text, sub); try { return await fn(); } finally { idle(); } }

function modal({ title, body = '', buttons = [{ label: 'OK', value: true, primary: true }], onOpen }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2><div class="mbody">${body}</div><div class="actions">${buttons.map((b, i) =>
      `<button class="btn ${b.primary ? '' : b.danger ? 'danger' : 'secondary'}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    root.appendChild(bg);
    const close = (v) => { bg.remove(); resolve(v); };
    bg.addEventListener('click', (e) => {
      if (e.target === bg) return close(null);
      const b = e.target.closest('button[data-i]'); if (!b) return;
      const btn = buttons[+b.dataset.i];
      close(typeof btn.value === 'function' ? btn.value(bg) : btn.value);
    });
    bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    const first = bg.querySelector('input,textarea') || bg.querySelector('button'); first && first.focus();
    onOpen && onOpen(bg, close);
  });
}
const confirmBox = (title, text, label = 'Delete') => modal({ title, body: `<p>${esc(text)}</p>`, buttons: [{ label: 'Cancel', value: false }, { label, value: true, danger: true }] });

const fmtDate = (s) => { const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
const scoreClass = (n) => (n >= 75 ? 'good' : n >= 55 ? 'mid' : 'low');
const scoreColor = (n) => (n >= 75 ? '#15803d' : n >= 55 ? '#c2790b' : '#b42318');
const clone = (o) => JSON.parse(JSON.stringify(o));
const emptyResume = () => ({ name: '', contact: { email: '', phone: '', location: '', links: [] }, summary: '', skills: [], experience: [], education: [], projects: [], certifications: [], achievements: [] });

function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => a[k], o); t[last] = v; }

// ---------- draft persistence (unfinished work survives a refresh) ----------
const draftKey = () => `rt_draft_${user ? user.id : 0}`;
function saveDraftLocal() { try { if (draft) localStorage.setItem(draftKey(), JSON.stringify({ ...draft, history: [] })); } catch (e) { /* ignore */ } }
function loadDraftLocal() { try { const s = localStorage.getItem(draftKey()); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function clearDraftLocal() { try { localStorage.removeItem(draftKey()); } catch (e) { /* ignore */ } }
function newDraft() {
  return { savedId: null, groupId: null, version: 1, stage: 'upload', original: null, resume: emptyResume(), aiResume: null, jobDescription: '', jobTitle: '', company: '', keywords: [], analysis: null, scoreBefore: null, changes: [], suggestions: [], warnings: [], template: 'classic', title: '', history: [], rawText: '' };
}

// ---------- top bar ----------
function renderTop() {
  $('#topbar').innerHTML = `<a class="brand" href="#/${user ? 'home' : ''}"><span class="logo"></span>AI Resume Tailor</a>` +
    (user ? `<div class="who"><span>Signed in as <b>${esc(user.name)}</b></span><button class="btn secondary sm" id="signout">Sign Out</button></div>`
      : `<div class="who"><a class="btn secondary sm" href="#/login">Sign In</a><a class="btn sm" href="#/signup">Sign Up</a></div>`);
  const so = $('#signout');
  if (so) so.onclick = async () => { await api('/api/auth/signout', { method: 'POST', json: {} }).catch(() => {}); user = null; draft = null; renderTop(); location.hash = '#/'; toast('You have been signed out.', 'ok'); };
}

// ---------- router ----------
const routes = {};
async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [pathPart, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const publicRoutes = ['/', '/login', '/signup', '/forgot', '/reset'];
  if (!user && !publicRoutes.includes(pathPart)) { location.hash = '#/login'; return; }
  if (user && ['/', '/login', '/signup'].includes(pathPart)) { location.hash = '#/home'; return; }
  const m = pathPart.match(/^\/resume\/(\d+)$/);
  const key = m ? '/resume' : pathPart;
  const fn = routes[key];
  window.scrollTo(0, 0);
  if (!fn) { location.hash = user ? '#/home' : '#/'; return; }
  try { await fn(params, m && m[1]); } catch (e) { app.innerHTML = `<div class="container narrow"><div class="alert error">${esc(e.message)}</div><a class="btn" href="#/home">Back to my resumes</a></div>`; }
  app.focus({ preventScroll: true });
}

// ---------- landing + auth pages ----------
routes['/'] = () => {
  app.innerHTML = `<div class="container"><section class="hero">
    <h1>Get your resume ready for every job</h1>
    <p>Upload your resume, paste a job description, and get an honest, ATS-friendly version in minutes. We never invent experience: you review every change before you save.</p>
    <a class="btn big" href="#/signup">Create a free account</a> <a class="btn big secondary" href="#/login">Sign In</a></section>
    <div class="steps-list">
      <div class="card"><b>1. Upload</b><p class="muted">Add your current resume (PDF or Word).</p></div>
      <div class="card"><b>2. Paste the job</b><p class="muted">Copy the job description into the box.</p></div>
      <div class="card"><b>3. Review</b><p class="muted">See your estimated ATS score and edit anything.</p></div>
      <div class="card"><b>4. Download</b><p class="muted">Save it and download as PDF or Word.</p></div>
    </div></div>`;
};

function authCard(title, inner) { app.innerHTML = `<div class="container narrow"><div class="card"><h1>${title}</h1>${inner}</div></div>`; }
const errBox = (id = 'err') => `<div id="${id}" class="alert error hidden" role="alert"></div>`;
const showErr = (m, id = 'err') => { const e = $('#' + id); e.textContent = m; e.classList.remove('hidden'); e.scrollIntoView({ block: 'nearest' }); };

routes['/signup'] = () => {
  authCard('Create your account', `${errBox()}<form id="f" novalidate>
    <label for="name">Your name</label><input id="name" type="text" autocomplete="name" required>
    <label for="email">Email address</label><input id="email" type="email" autocomplete="email" required>
    <label for="pw">Password</label><input id="pw" type="password" autocomplete="new-password" required>
    <p class="hint">At least 8 characters, with a letter and a number.</p>
    <div class="actions"><button class="btn big" type="submit">Sign Up</button><a href="#/login">I already have an account</a></div></form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault(); const b = e.target.querySelector('button'); b.disabled = true;
    try { const r = await api('/api/auth/signup', { json: { name: $('#name').value, email: $('#email').value, password: $('#pw').value } }); user = r.user; renderTop(); location.hash = '#/home'; }
    catch (er) { showErr(er.message); b.disabled = false; }
  };
};
routes['/login'] = () => {
  authCard('Sign in', `${errBox()}<form id="f" novalidate>
    <label for="email">Email address</label><input id="email" type="email" autocomplete="email" required>
    <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
    <div class="actions"><button class="btn big" type="submit">Sign In</button><a href="#/forgot">Forgot password?</a></div>
    <p class="muted">New here? <a href="#/signup">Create an account</a></p></form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault(); const b = e.target.querySelector('button'); b.disabled = true;
    try { const r = await api('/api/auth/signin', { json: { email: $('#email').value, password: $('#pw').value } }); user = r.user; renderTop(); location.hash = '#/home'; }
    catch (er) { showErr(er.message); b.disabled = false; }
  };
};
routes['/forgot'] = () => {
  authCard('Forgot your password?', `<p class="muted">Enter your email address and we will send you a link to choose a new password.</p><div id="ok" class="alert info hidden"></div>${errBox()}<form id="f" novalidate>
    <label for="email">Email address</label><input id="email" type="email" autocomplete="email" required>
    <div class="actions"><button class="btn big" type="submit">Send Reset Link</button><a href="#/login">Back to sign in</a></div></form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('/api/auth/forgot', { json: { email: $('#email').value } }); const ok = $('#ok'); ok.textContent = r.message; ok.classList.remove('hidden'); $('#err').classList.add('hidden'); }
    catch (er) { showErr(er.message); }
  };
};
routes['/reset'] = (params) => {
  const token = params.get('token') || '';
  authCard('Choose a new password', `${errBox()}<form id="f" novalidate>
    <label for="pw">New password</label><input id="pw" type="password" autocomplete="new-password" required>
    <p class="hint">At least 8 characters, with a letter and a number.</p>
    <div class="actions"><button class="btn big" type="submit">Save New Password</button></div></form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/auth/reset', { json: { token, password: $('#pw').value } }); toast('Password updated. Please sign in.', 'ok'); location.hash = '#/login'; }
    catch (er) { showErr(er.message); }
  };
};

// ---------- dashboard ----------
let searchTimer, reloadList = null;
routes['/home'] = async () => {
  const unfinished = loadDraftLocal();
  app.innerHTML = `<div class="container">
    <div class="dash-head"><div><h1>Welcome, ${esc(user.name.split(' ')[0])}!</h1><p class="muted">Create a resume for a new job, or open one you saved before.</p></div>
    <a class="btn big" href="#/new" id="newbtn">+ Create New Resume</a></div>
    ${unfinished && unfinished.resume && unfinished.resume.name && !unfinished.savedId ? `<div class="alert info" id="unfinished">You have an unsaved resume in progress${unfinished.jobTitle ? ` for <b>${esc(unfinished.jobTitle)}</b>` : ''}.
      <div class="actions" style="margin-top:.5rem"><button class="btn sm" id="resume-draft">Continue</button><button class="btn sm secondary" id="drop-draft">Discard it</button></div></div>` : ''}
    <h2>My Saved Resumes</h2>
    <input class="search" type="search" id="q" placeholder="Search by job title, company or name..." aria-label="Search saved resumes">
    <div id="list" aria-live="polite"><p class="muted">Loading your resumes...</p></div></div>`;
  $('#newbtn').onclick = () => { draft = newDraft(); };
  const rd = $('#resume-draft');
  if (rd) { rd.onclick = () => { draft = unfinished; draft.history = []; location.hash = draft.stage === 'editor' ? '#/editor' : draft.stage === 'analysis' ? '#/analysis' : draft.stage === 'job' ? '#/new/job' : '#/new'; }; $('#drop-draft').onclick = () => { clearDraftLocal(); $('#unfinished').remove(); }; }
  const load = async () => {
    const q = $('#q').value.trim();
    try {
      const { resumes } = await api('/api/resumes' + (q ? `?q=${encodeURIComponent(q)}` : ''));
      $('#list').innerHTML = resumes.length ? `<div class="grid">${resumes.map(cardHtml).join('')}</div>`
        : q ? `<div class="empty"><p>No saved resumes match "${esc(q)}".</p></div>`
          : `<div class="empty"><h3>No saved resumes yet</h3><p>Click <b>Create New Resume</b> to make your first one. It will appear here once you save it.</p></div>`;
    } catch (e) { $('#list').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  };
  reloadList = load;
  $('#q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); };
  $('#list').onclick = onCardClick;
  await load();
};

function cardHtml(r) {
  return `<div class="card rcard" data-id="${r.id}">
    <h3>${esc(r.title)}</h3>
    <div><span class="badge">Version ${r.version}</span>${r.atsScore != null ? `<span class="badge ${scoreClass(r.atsScore)}" title="Estimated ATS score">ATS ~${r.atsScore}/100</span>` : ''}</div>
    <div class="meta">${r.jobTitle ? `<b>${esc(r.jobTitle)}</b>` : '<i>No job title</i>'}${r.company ? ` at ${esc(r.company)}` : ''}<br>Last modified ${esc(fmtDate(r.updatedAt))}</div>
    <div class="btns">
      <button class="btn sm" data-a="open">Open</button><button class="btn sm secondary" data-a="open">Edit</button>
      <button class="btn sm secondary" data-a="download">Download</button>
      <button class="btn sm ghost" data-a="rename">Rename</button><button class="btn sm ghost" data-a="dup">Duplicate</button><button class="btn sm ghost" data-a="del">Delete</button>
    </div></div>`;
}

async function onCardClick(e) {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const card = b.closest('.rcard'); const id = card.dataset.id; const title = card.querySelector('h3').textContent;
  const a = b.dataset.a;
  try {
    if (a === 'open') { location.hash = `#/resume/${id}`; }
    else if (a === 'download') { const { resume } = await api(`/api/resumes/${id}`); await downloadDialog(resume); }
    else if (a === 'rename') {
      const v = await modal({ title: 'Rename resume', body: `<label for="nn">New name</label><input id="nn" type="text" maxlength="150" value="${esc(title)}">`, buttons: [{ label: 'Cancel', value: null }, { label: 'Save name', primary: true, value: (m) => m.querySelector('#nn').value }] });
      if (v && v.trim()) { await api(`/api/resumes/${id}`, { method: 'PATCH', json: { title: v } }); toast('Renamed.', 'ok'); reloadList && reloadList(); }
    } else if (a === 'dup') { await api(`/api/resumes/${id}/duplicate`, { json: {} }); toast('A copy was added to your list.', 'ok'); reloadList && reloadList(); }
    else if (a === 'del') {
      if (await confirmBox('Delete this resume?', `"${title}" will be permanently deleted. This cannot be undone.`)) { await api(`/api/resumes/${id}`, { method: 'DELETE' }); toast('Deleted.', 'ok'); reloadList && reloadList(); }
    }
  } catch (er) { toast(er.message, 'error'); }
}

// ---------- download dialog ----------
async function downloadDialog(saved, headline) {
  let suggested = '';
  try { suggested = (await api(`/api/suggest-filename?name=${encodeURIComponent(saved.content.name)}&jobTitle=${encodeURIComponent(saved.jobTitle || '')}`)).filename; } catch (e) { suggested = 'Resume'; }
  await modal({
    title: 'Download your resume',
    body: `${headline ? `<div class="alert ok">${esc(headline)}</div>` : ''}<label for="fn">File name</label><input id="fn" type="text" maxlength="100" value="${esc(suggested)}"><p class="hint">You can change the name. The correct ending (.pdf or .docx) is added for you.</p>
      <div class="actions"><button class="btn" id="dl-pdf">Download PDF</button><button class="btn secondary" id="dl-docx">Download Word (DOCX)</button></div><div id="dl-err" class="alert error hidden"></div>`,
    buttons: [{ label: 'Close', value: true }],
    onOpen: (m) => {
      const go = async (fmt) => {
        const btn = m.querySelector(fmt === 'pdf' ? '#dl-pdf' : '#dl-docx'); btn.disabled = true;
        try {
          const blob = await api(`/api/resumes/${saved.id}/download?format=${fmt}&filename=${encodeURIComponent(m.querySelector('#fn').value)}`, { blob: true });
          const name = (m.querySelector('#fn').value || suggested).replace(/[^\w .-]/g, '').trim().replace(/\s+/g, '_').replace(/\.(pdf|docx)$/i, '') || 'Resume';
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.${fmt}`; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast('Download started.', 'ok');
        } catch (er) { const x = m.querySelector('#dl-err'); x.textContent = er.message; x.classList.remove('hidden'); }
        btn.disabled = false;
      };
      m.querySelector('#dl-pdf').onclick = () => go('pdf'); m.querySelector('#dl-docx').onclick = () => go('docx');
    },
  });
}

// ---------- wizard ----------
function progress(step) {
  const names = ['Upload resume', 'Add job', 'Check ATS score', 'Edit & save'];
  return `<ol class="progress" aria-label="Progress">${names.map((n, i) => `<li class="${i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''}" ${i + 1 === step ? 'aria-current="step"' : ''}>${i + 1}. ${n}</li>`).join('')}</ol>`;
}
const aiBanner = () => (config.aiConfigured ? '' : `<div class="alert warn"><b>AI is not set up on this server yet.</b> Reading resumes into sections and tailoring need an AI key. Ask the site owner to add <code>ANTHROPIC_API_KEY</code> (the README explains how). You can still type your details in by hand.</div>`);

routes['/new'] = () => {
  if (!draft) draft = newDraft();
  draft.stage = 'upload';
  const hasData = !!(draft.resume.name || draft.rawText);
  app.innerHTML = `<div class="container">${progress(1)}<h1>Upload your current resume</h1>
    <p class="muted">We read your PDF or Word file and fill in the details below. Nothing is invented: you can check and fix everything before going on.</p>${aiBanner()}
    <div class="card"><label class="drop" id="drop" for="file"><b>Click to choose a file</b> or drag it here<br><span class="muted small">PDF or DOCX, up to 5 MB</span><input id="file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></label>
    <div id="up-msg"></div>
    <p class="muted small" style="margin-top:.8rem">No file or it will not read? <button class="btn ghost sm" id="manual">Type my details in myself</button></p></div>
    <div id="review" class="${hasData ? '' : 'hidden'}"><h2 style="margin-top:1.5rem">Check your details</h2>
      <p class="muted">Fix anything that was read wrongly, add anything missing, and remove anything you do not want. Only information you keep here will be used.</p>
      <div class="card" id="form-host"></div>
      <div class="actions"><button class="btn big" id="next1">Next: Add the job →</button><a class="btn ghost" href="#/home">Cancel</a></div></div></div>`;
  const input = $('#file'), drop = $('#drop');
  const doUpload = async (file) => {
    $('#up-msg').innerHTML = '';
    if (!file) return;
    if (!/\.(pdf|docx)$/i.test(file.name)) { $('#up-msg').innerHTML = `<div class="alert error" style="margin-top:1rem">That file type is not supported. Please upload a PDF or a Word (.docx) file.</div>`; return; }
    if (file.size > 5 * 1024 * 1024) { $('#up-msg').innerHTML = `<div class="alert error" style="margin-top:1rem">That file is larger than 5 MB. Please upload a smaller file.</div>`; return; }
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await withBusy('Reading your resume...', 'This can take up to a minute.', () => api('/api/parse', { method: 'POST', body: fd }));
      draft.resume = r.resume; draft.rawText = r.rawText || '';
      if (r.warning) $('#up-msg').innerHTML = `<div class="alert warn" style="margin-top:1rem">${esc(r.warning)}</div>`;
      else $('#up-msg').innerHTML = `<div class="alert ok" style="margin-top:1rem">Done! Please check the details below.</div>`;
      showReview();
    } catch (er) { $('#up-msg').innerHTML = `<div class="alert error" style="margin-top:1rem">${esc(er.message)}</div>`; }
  };
  input.onchange = () => doUpload(input.files[0]);
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => doUpload(e.dataTransfer.files[0]));
  const showReview = () => {
    $('#review').classList.remove('hidden');
    const raw = draft.rawText ? `<details style="margin-bottom:1rem"><summary>Show the text we read from your file</summary><pre style="white-space:pre-wrap;font-size:.85rem;max-height:300px;overflow:auto">${esc(draft.rawText)}</pre></details>` : '';
    $('#form-host').innerHTML = raw + formHtml(draft.resume, { regen: false });
    bindForm($('#form-host'), { onChange: saveDraftLocal });
    $('#review').scrollIntoView({ behavior: 'smooth' });
  };
  $('#manual').onclick = () => { showReview(); };
  if (hasData) showReview();
  $('#next1').onclick = () => {
    const r = draft.resume;
    if (!r.name.trim()) return toast('Please enter your name.', 'error');
    if (!r.experience.length && !r.projects.length && !r.skills.length) return toast('Please add at least some experience, projects or skills.', 'error');
    draft.original = clone(r); draft.stage = 'job'; saveDraftLocal(); location.hash = '#/new/job';
  };
};

routes['/new/job'] = () => {
  if (!draft || !draft.original) { location.hash = '#/new'; return; }
  draft.stage = 'job';
  app.innerHTML = `<div class="container narrow" style="max-width:820px">${progress(2)}<h1>Which job are you applying for?</h1>
    <p class="muted">Paste the job description below. We will customise your resume for this job: highlighting your real, relevant experience and using the job's own keywords <b>where they truthfully apply</b>. We will never add skills or experience you do not have.</p>${aiBanner()}
    <div class="card"><div class="row"><div><label for="jt">Job title (optional)</label><input id="jt" type="text" maxlength="120" placeholder="e.g. Product Analyst" value="${esc(draft.jobTitle)}"></div>
      <div><label for="co">Company name (optional)</label><input id="co" type="text" maxlength="120" placeholder="e.g. Acme Ltd" value="${esc(draft.company)}"></div></div>
      <label for="jd">Job description</label><textarea id="jd" rows="14" placeholder="Paste the full job description here...">${esc(draft.jobDescription)}</textarea>
      <p class="hint" id="jdcount"></p></div>
    <div class="actions"><button class="btn big" id="go">✨ Tailor My Resume</button><a class="btn ghost" href="#/new">← Back</a></div></div>`;
  const upd = () => { const n = $('#jd').value.trim().length; $('#jdcount').textContent = n < 80 ? `Please paste at least a few sentences (${n} characters so far).` : `${n.toLocaleString()} characters. Looks good.`; };
  $('#jd').oninput = upd; upd();
  $('#go').onclick = async () => {
    draft.jobTitle = $('#jt').value.trim(); draft.company = $('#co').value.trim(); draft.jobDescription = $('#jd').value.trim();
    saveDraftLocal();
    if (draft.jobDescription.length < 80) return toast('Please paste the full job description first.', 'error');
    try {
      const r = await withBusy('Tailoring your resume...', 'The AI is reading the job and rewriting your resume. This usually takes 20 to 60 seconds.',
        () => api('/api/tailor', { json: { resume: draft.original, jobDescription: draft.jobDescription, jobTitle: draft.jobTitle, company: draft.company } }));
      Object.assign(draft, { resume: r.resume, aiResume: clone(r.resume), keywords: r.keywords, analysis: r.analysis, scoreBefore: r.scoreBefore, changes: r.changes, suggestions: r.suggestions, warnings: r.warnings, stage: 'analysis', history: [] });
      saveDraftLocal(); location.hash = '#/analysis';
    } catch (er) { toast(er.message, 'error'); }
  };
};

function analysisHtml(a, opts = {}) {
  return `<div class="score"><div class="ring" style="--p:${a.score};--col:${scoreColor(a.score)}"><div>${a.score}</div></div>
    <div><h3 style="margin:0">Estimated ATS score: ${a.score} / 100</h3>
    ${opts.before != null ? `<p class="muted" style="margin:.2rem 0">Your original resume scored about <b>${opts.before}</b> for this job.</p>` : ''}
    <p class="muted small" style="margin:0;max-width:520px"><b>This is an estimate only.</b> It is not a guarantee of passing any employer's ATS, and it does not copy any particular company's scoring. It checks keyword match, standard sections, bullet style and length.</p></div></div>`;
}

routes['/analysis'] = () => {
  if (!draft || !draft.analysis) { location.hash = '#/new'; return; }
  const a = draft.analysis;
  app.innerHTML = `<div class="container">${progress(3)}<h1>Your tailored resume is ready</h1>
    <div class="card">${analysisHtml(a, { before: draft.scoreBefore })}</div>
    ${draft.warnings.length ? `<div class="alert warn" style="margin-top:1rem"><b>Please double-check these items.</b> They were not clearly in your original resume. Remove or fix anything that is not true:<ul>${draft.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : `<div class="alert ok" style="margin-top:1rem">Nothing new was added that we could not find in your original resume.</div>`}
    <div class="cols2" style="margin-top:1rem">
      <div class="card"><h3>Keywords from the job</h3><p class="muted small">Found in your resume:</p><div class="chips">${a.found.length ? a.found.map((k) => `<span class="chip found">${esc(k)}</span>`).join('') : '<span class="muted">None yet</span>'}</div>
        <p class="muted small" style="margin-top:1rem">Missing or not mentioned (add them only if they are true for you):</p><div class="chips">${a.missing.length ? a.missing.map((k) => `<span class="chip miss">${esc(k)}</span>`).join('') : '<span class="muted">None. Great coverage!</span>'}</div></div>
      <div class="card"><h3>How the score is made</h3>${a.breakdown.filter((b) => b.max > 0 || b.got < 0).map((b) => `<div class="brk"><div class="top"><span>${esc(b.label)}</span><span>${b.got}${b.max ? ` / ${b.max}` : ''}</span></div>${b.max ? `<div class="bar"><i style="width:${Math.max(0, b.got / b.max * 100)}%"></i></div>` : ''}<div class="hint">${esc(b.note)}</div></div>`).join('')}</div></div>
    <div class="cols2" style="margin-top:1rem">
      <div class="card"><h3>Improvements we made</h3>${draft.changes.length ? `<ul class="checklist">${draft.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="muted">No change list was returned.</p>'}</div>
      <div class="card"><h3>Formatting &amp; readability tips</h3>${a.formatting.length ? `<ul class="bullets-list">${a.formatting.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="muted">No formatting problems found.</p>'}
        <h3 style="margin-top:1rem">Ways to improve further</h3>${draft.suggestions.length ? `<ul class="bullets-list">${draft.suggestions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="muted">No extra suggestions.</p>'}</div></div>
    <div class="actions"><button class="btn big" id="toed">Review &amp; edit my resume →</button><a class="btn ghost" href="#/new/job">← Change job description</a></div></div>`;
  $('#toed').onclick = () => { draft.stage = 'editor'; saveDraftLocal(); location.hash = '#/editor'; };
};

// ---------- form builder (used in step 1 and in the editor) ----------
const SEC_LABEL = { summary: 'Professional Summary', skills: 'Skills', experience: 'Work Experience', education: 'Education', projects: 'Projects', certifications: 'Certifications', achievements: 'Achievements' };
function inp(path, label, val, ph = '') { return `<div><label>${label}<input type="text" data-path="${path}" value="${esc(val)}" placeholder="${esc(ph)}"></label></div>`; }
function ta(path, label, val, kind, hint = '') { const rows = Math.max(3, String(val).split('\n').length + 1); return `<label>${label}<textarea data-path="${path}" data-kind="${kind}" rows="${rows}">${esc(val)}</textarea></label>${hint ? `<div class="hint">${hint}</div>` : ''}`; }
function secHead(key, opts) { return `<div class="sec-head"><h3>${SEC_LABEL[key]}</h3>${opts.regen && key !== 'contact' ? `<button class="btn sm secondary" data-act="regen" data-sec="${key}" title="Rewrite only this section with AI">↻ Regenerate section</button>` : ''}</div>`; }
function entryTools(key, i, n) { return `<span><button class="btn ghost sm" data-act="up" data-key="${key}" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="btn ghost sm" data-act="down" data-key="${key}" data-i="${i}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button class="btn danger sm" data-act="rm" data-key="${key}" data-i="${i}">Remove</button></span>`; }

function formHtml(r, opts = {}) {
  const c = r.contact;
  let h = `<div class="sec" style="border:0;padding-top:0"><h3>Contact details</h3><div class="row">${inp('name', 'Full name', r.name)}${inp('contact.email', 'Email', c.email)}${inp('contact.phone', 'Phone', c.phone)}${inp('contact.location', 'Location', c.location, 'City, Country')}</div>
    ${ta('contact.links', 'Links (one per line)', c.links.join('\n'), 'lines', 'For example your LinkedIn or portfolio address.')}</div>`;
  h += `<div class="sec">${secHead('summary', opts)}${ta('summary', 'Summary', r.summary, 'text')}</div>`;
  h += `<div class="sec">${secHead('skills', opts)}${ta('skills', 'Skills (separate with commas)', r.skills.join(', '), 'csv')}</div>`;
  h += `<div class="sec">${secHead('experience', opts)}${r.experience.map((e, i) => `<div class="entry"><div class="entry-head"><b>Job ${i + 1}</b>${entryTools('experience', i, r.experience.length)}</div>
      <div class="row">${inp(`experience.${i}.title`, 'Job title', e.title)}${inp(`experience.${i}.company`, 'Company', e.company)}${inp(`experience.${i}.location`, 'Location', e.location)}${inp(`experience.${i}.dates`, 'Dates', e.dates, 'Jan 2022 - Present')}</div>
      ${ta(`experience.${i}.bullets`, 'What you did (one bullet point per line)', e.bullets.join('\n'), 'lines')}</div>`).join('')}<button class="btn secondary sm" data-act="add" data-key="experience">+ Add a job</button></div>`;
  h += `<div class="sec">${secHead('projects', opts)}${r.projects.map((p, i) => `<div class="entry"><div class="entry-head"><b>Project ${i + 1}</b>${entryTools('projects', i, r.projects.length)}</div>
      <div class="row">${inp(`projects.${i}.name`, 'Project name', p.name)}${inp(`projects.${i}.tech`, 'Tools / technologies', p.tech)}${inp(`projects.${i}.dates`, 'Dates', p.dates)}</div>
      ${ta(`projects.${i}.bullets`, 'Details (one bullet point per line)', p.bullets.join('\n'), 'lines')}</div>`).join('')}<button class="btn secondary sm" data-act="add" data-key="projects">+ Add a project</button></div>`;
  h += `<div class="sec">${secHead('education', opts)}${r.education.map((e, i) => `<div class="entry"><div class="entry-head"><b>Education ${i + 1}</b>${entryTools('education', i, r.education.length)}</div>
      <div class="row">${inp(`education.${i}.degree`, 'Degree / course', e.degree)}${inp(`education.${i}.school`, 'School / university', e.school)}${inp(`education.${i}.location`, 'Location', e.location)}${inp(`education.${i}.dates`, 'Dates', e.dates)}</div>
      ${ta(`education.${i}.details`, 'Extra details (one per line, optional)', e.details.join('\n'), 'lines')}</div>`).join('')}<button class="btn secondary sm" data-act="add" data-key="education">+ Add education</button></div>`;
  h += `<div class="sec">${secHead('certifications', opts)}${ta('certifications', 'Certifications (one per line)', r.certifications.join('\n'), 'lines')}</div>`;
  h += `<div class="sec">${secHead('achievements', opts)}${ta('achievements', 'Achievements (one per line)', r.achievements.join('\n'), 'lines')}</div>`;
  return h;
}

const NEW_ENTRY = { experience: () => ({ title: '', company: '', location: '', dates: '', bullets: [] }), education: () => ({ degree: '', school: '', location: '', dates: '', details: [] }), projects: () => ({ name: '', tech: '', dates: '', bullets: [] }) };
function parseVal(el) {
  const v = el.value;
  if (el.dataset.kind === 'lines') return v.split('\n').map((s) => s.trim()).filter(Boolean);
  if (el.dataset.kind === 'csv') return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return v;
}

// host: element containing the form. hooks: { onChange, beforeChange, onStructure, regen(section) }
function bindForm(host, hooks = {}) {
  host.oninput = (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.path) return;
    hooks.beforeChange && hooks.beforeChange();
    setPath(draft.resume, el.dataset.path, parseVal(el));
    hooks.onChange && hooks.onChange();
  };
  host.onclick = async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const act = b.dataset.act, key = b.dataset.key, i = +b.dataset.i;
    if (act === 'regen') { hooks.regen && hooks.regen(b.dataset.sec); return; }
    hooks.beforeChange && hooks.beforeChange(true);
    const arr = draft.resume[key];
    if (act === 'add') arr.push(NEW_ENTRY[key]());
    if (act === 'rm') { if (!(await confirmBox('Remove this entry?', 'It will be removed from this resume. You can use Undo to bring it back.', 'Remove'))) return; arr.splice(i, 1); }
    if (act === 'up' && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    if (act === 'down' && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
    host.innerHTML = formHtml(draft.resume, { regen: !!hooks.regen });
    hooks.onChange && hooks.onChange(true);
  };
}

// ---------- resume preview + comparison ----------
function previewHtml(r, tpl) {
  const c = [r.contact.email, r.contact.phone, r.contact.location, ...r.contact.links].filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ');
  const ul = (a) => (a.length ? `<ul>${a.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '');
  const entry = (t, sub, d, bl) => `<div class="ent-top"><b>${esc(t)}</b><span>${esc(d)}</span></div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${ul(bl)}`;
  let h = `<div class="paper ${esc(tpl)}"><h1>${esc(r.name) || 'Your Name'}</h1><div class="contact">${c}</div>`;
  if (r.summary) h += `<h2>Professional Summary</h2><p>${esc(r.summary)}</p>`;
  if (r.skills.length) h += `<h2>Skills</h2><p>${esc(r.skills.join(', '))}</p>`;
  if (r.experience.length) h += `<h2>Work Experience</h2>${r.experience.map((e) => entry(e.title, [e.company, e.location].filter(Boolean).join(', '), e.dates, e.bullets)).join('')}`;
  if (r.projects.length) h += `<h2>Projects</h2>${r.projects.map((p) => entry(p.name, p.tech, p.dates, p.bullets)).join('')}`;
  if (r.education.length) h += `<h2>Education</h2>${r.education.map((e) => entry(e.degree, [e.school, e.location].filter(Boolean).join(', '), e.dates, e.details)).join('')}`;
  if (r.certifications.length) h += `<h2>Certifications</h2>${ul(r.certifications)}`;
  if (r.achievements.length) h += `<h2>Achievements</h2>${ul(r.achievements)}`;
  return h + '</div>';
}

function secText(r, k) {
  if (k === 'summary') return r.summary || '';
  if (k === 'skills') return r.skills.join(', ');
  const L = (a) => a.map((b) => `• ${b}`);
  if (k === 'experience') return r.experience.map((e) => [[e.title, e.company, e.dates].filter(Boolean).join(' | '), ...L(e.bullets)].join('\n')).join('\n\n');
  if (k === 'projects') return r.projects.map((p) => [[p.name, p.tech, p.dates].filter(Boolean).join(' | '), ...L(p.bullets)].join('\n')).join('\n\n');
  if (k === 'education') return r.education.map((e) => [[e.degree, e.school, e.dates].filter(Boolean).join(' | '), ...L(e.details)].join('\n')).join('\n\n');
  return L(r[k]).join('\n');
}
function markNew(text, base) {
  const known = new Set((base.toLowerCase().match(/[\p{L}\p{N}+#.]+/gu) || []));
  return esc(text).replace(/[\p{L}\p{N}+#.]+/gu, (w) => (known.has(w.toLowerCase()) ? w : `<mark>${w}</mark>`));
}
function compareHtml(orig, cur) {
  if (!orig) return '<p class="muted">No original version is stored for this resume.</p>';
  const keys = ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'achievements'];
  return `<p class="muted small">Left: your original. Right: the current version. <mark>Green</mark> words are new compared with your original.</p><div class="cmp">${keys.map((k) => {
    const a = secText(orig, k), b = secText(cur, k); if (!a && !b) return '';
    return `<h4>${SEC_LABEL[k]}</h4><div><div class="cap">Original</div>${esc(a) || '<i class="muted">(empty)</i>'}</div><div><div class="cap">Current</div>${b ? markNew(b, a) : '<i class="muted">(empty)</i>'}</div>`;
  }).join('')}</div>`;
}

// ---------- editor ----------
routes['/resume'] = async (_p, id) => {
  const { resume } = await api(`/api/resumes/${id}`);
  draft = { ...newDraft(), savedId: resume.id, groupId: resume.groupId, version: resume.version, stage: 'editor', original: resume.original || null, resume: resume.content, aiResume: clone(resume.content), jobDescription: resume.jobDescription, jobTitle: resume.jobTitle, company: resume.company, keywords: resume.keywords, template: resume.template, title: resume.title };
  location.hash = '#/editor';
};

routes['/editor'] = () => {
  if (!draft || !draft.resume.name) { location.hash = '#/home'; return; }
  draft.stage = 'editor';
  const canAI = config.aiConfigured && draft.jobDescription && draft.jobDescription.length >= 80 && draft.original;
  let lastJson = JSON.stringify(draft.resume), snapTimer = null, analyzeTimer = null, view = 'preview', mobile = 'edit';
  app.innerHTML = `<div class="container wide">${draft.savedId ? '' : progress(4)}
    <div class="sticky-bar"><div class="ring mini" id="ring"><div>–</div></div>
      <div class="grow"><b id="ed-title">${esc(draft.title || draft.jobTitle || 'Your resume')}</b><div class="small muted" id="ed-sub">${draft.savedId ? `Saved resume, version ${draft.version}` : 'Not saved yet'}</div></div>
      <button class="btn secondary sm" id="undo" disabled>↶ Undo</button><button class="btn secondary sm" id="discard">Discard my edits</button>
      <button class="btn" id="save">💾 Save Final Resume</button></div>
    <div class="tabs mobile-tabs"><button class="tab on" data-m="edit">Edit</button><button class="tab" data-m="view">Preview</button></div>
    <div class="editor"><div class="pane" id="p-edit"><div class="card" id="form-host"></div></div>
      <div class="pane hide-m" id="p-view"><div class="tabs"><button class="tab on" data-v="preview">Preview</button><button class="tab" data-v="compare">Original vs current</button><button class="tab" data-v="ats">ATS check</button>
        <select id="tpl" aria-label="Template" style="width:auto;margin-left:auto">${config.templates.map((t) => `<option value="${t.key}" ${t.key === draft.template ? 'selected' : ''}>${esc(t.label)} template</option>`).join('')}</select></div>
        <div id="view-host"></div></div></div></div>`;
  const host = $('#form-host');
  host.innerHTML = formHtml(draft.resume, { regen: canAI });

  const renderView = () => {
    const vh = $('#view-host'); if (!vh) return;
    if (view === 'preview') vh.innerHTML = previewHtml(draft.resume, draft.template);
    else if (view === 'compare') vh.innerHTML = compareHtml(draft.original, draft.resume);
    else vh.innerHTML = draft.analysis ? `<div class="card">${analysisHtml(draft.analysis)}<h3 style="margin-top:1rem">Missing keywords</h3><div class="chips">${draft.analysis.missing.length ? draft.analysis.missing.map((k) => `<span class="chip miss">${esc(k)}</span>`).join('') : 'None'}</div>
      <h3 style="margin-top:1rem">Found keywords</h3><div class="chips">${draft.analysis.found.map((k) => `<span class="chip found">${esc(k)}</span>`).join('') || 'None'}</div>
      ${draft.analysis.formatting.length ? `<h3 style="margin-top:1rem">Tips</h3><ul class="bullets-list">${draft.analysis.formatting.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${draft.warnings.length ? `<div class="alert warn" style="margin-top:1rem"><b>Please verify:</b><ul>${draft.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}</div>`
      : '<div class="card"><p class="muted">Add a job description to see an ATS check. Open this resume from the "Create New Resume" flow to tailor it for a job.</p></div>';
  };
  const renderRing = () => {
    const a = draft.analysis; const r = $('#ring'); if (!r) return;
    if (a) { r.style.setProperty('--p', a.score); r.style.setProperty('--col', scoreColor(a.score)); r.firstElementChild.textContent = a.score; r.title = 'Estimated ATS score (not a guarantee)'; } else r.classList.add('hidden');
  };
  const reanalyze = async () => {
    if (!draft.keywords.length && !draft.jobDescription) return;
    try {
      const r = await api('/api/analyze', { json: { resume: draft.resume, original: draft.original, keywords: draft.keywords, jobDescription: draft.jobDescription } });
      draft.analysis = r.analysis; draft.warnings = r.warnings; renderRing(); if (view === 'ats') renderView();
    } catch (e) { /* silent: score will refresh on next edit */ }
  };
  const afterChange = (structural) => {
    $('#undo').disabled = !draft.history.length;
    if (view !== 'ats' || structural) renderView();
    clearTimeout(analyzeTimer); analyzeTimer = setTimeout(reanalyze, 700);
    saveDraftLocal();
  };
  const hooks = {
    beforeChange: (force) => { if (force || !snapTimer) { draft.history.push(lastJson); if (draft.history.length > 100) draft.history.shift(); } clearTimeout(snapTimer); snapTimer = setTimeout(() => { snapTimer = null; }, 900); },
    onChange: (structural) => { lastJson = JSON.stringify(draft.resume); afterChange(structural); },
    regen: canAI ? async (section) => {
      const note = await modal({ title: `Regenerate "${SEC_LABEL[section]}"`, body: `<p>The AI will rewrite only this section, using your original resume for the facts. Your other sections stay as they are.</p><label for="ins">Anything specific to focus on? (optional)</label><input id="ins" type="text" maxlength="300" placeholder="e.g. make it shorter">`, buttons: [{ label: 'Cancel', value: null }, { label: 'Regenerate', primary: true, value: (m) => m.querySelector('#ins').value || '' }] });
      if (note === null) return;
      try {
        const r = await withBusy('Rewriting this section...', 'This usually takes 10 to 30 seconds.', () => api('/api/regenerate', { json: { section, resume: draft.resume, original: draft.original, jobDescription: draft.jobDescription, jobTitle: draft.jobTitle, company: draft.company, instruction: note } }));
        hooks.beforeChange(true); draft.resume[section] = r.value; host.innerHTML = formHtml(draft.resume, { regen: true });
        hooks.onChange(true); toast('Section rewritten. Use Undo if you prefer the previous version.', 'ok');
        if (r.warnings.length) toast('Please check the new text against your real experience.', '');
      } catch (er) { toast(er.message, 'error'); }
    } : null,
  };
  bindForm(host, hooks);
  $('#undo').onclick = () => { const prev = draft.history.pop(); if (!prev) return; draft.resume = JSON.parse(prev); lastJson = prev; host.innerHTML = formHtml(draft.resume, { regen: canAI }); afterChange(true); };
  $('#discard').onclick = async () => {
    if (!draft.aiResume) return;
    if (!(await confirmBox('Discard your edits?', draft.savedId ? 'Your edits since you opened this resume will be thrown away.' : 'Your edits will be thrown away and the AI-generated version will come back.', 'Discard edits'))) return;
    draft.history.push(lastJson); draft.resume = clone(draft.aiResume); lastJson = JSON.stringify(draft.resume); host.innerHTML = formHtml(draft.resume, { regen: canAI }); afterChange(true);
  };
  document.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { view = b.dataset.v; document.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', x === b)); renderView(); }));
  document.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { mobile = b.dataset.m; document.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b)); $('#p-edit').classList.toggle('hide-m', mobile !== 'edit'); $('#p-view').classList.toggle('hide-m', mobile !== 'view'); }));
  $('#tpl').onchange = (e) => { draft.template = e.target.value; renderView(); saveDraftLocal(); };
  $('#save').onclick = () => saveFlow();
  renderRing(); renderView();
  if (draft.analysis == null) reanalyze();
};

async function saveFlow() {
  const r = draft.resume;
  if (!r.name.trim()) return toast('Please add your name before saving.', 'error');
  const defTitle = draft.title || [draft.jobTitle, draft.company].filter(Boolean).join(' - ') || `${r.name} Resume`;
  const wasSaved = !!draft.savedId;
  const choice = await modal({
    title: 'Save your final resume',
    body: `<p class="muted">Happy with your resume? Saving puts it in <b>My Saved Resumes</b>.</p>
      <label for="rt">Resume name</label><input id="rt" type="text" maxlength="150" value="${esc(defTitle)}">
      <div class="row"><div><label for="sjt">Job title</label><input id="sjt" type="text" maxlength="120" value="${esc(draft.jobTitle)}"></div><div><label for="sco">Company</label><input id="sco" type="text" maxlength="120" value="${esc(draft.company)}"></div></div>
      ${wasSaved ? `<label class="radio"><input type="radio" name="mode" value="new" checked><span><b>Save as a new version</b><br><span class="muted small">Keeps your older version untouched.</span></span></label>
      <label class="radio"><input type="radio" name="mode" value="replace"><span><b>Replace the current version</b><br><span class="muted small">Overwrites version ${draft.version}.</span></span></label>` : ''}`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save Final Resume', primary: true, value: (m) => ({ title: m.querySelector('#rt').value, jobTitle: m.querySelector('#sjt').value, company: m.querySelector('#sco').value, mode: (m.querySelector('input[name=mode]:checked') || {}).value || 'new' }) }],
  });
  if (!choice) return;
  const payload = { title: choice.title, jobTitle: choice.jobTitle, company: choice.company, jobDescription: draft.jobDescription, keywords: draft.keywords, content: draft.resume, original: draft.original, template: draft.template };
  try {
    let res;
    if (wasSaved && choice.mode === 'replace') res = await api(`/api/resumes/${draft.savedId}`, { method: 'PUT', json: payload });
    else res = await api('/api/resumes', { json: { ...payload, groupId: wasSaved ? draft.groupId : null } });
    const s = res.resume;
    Object.assign(draft, { savedId: s.id, groupId: s.groupId, version: s.version, title: s.title, jobTitle: s.jobTitle, company: s.company });
    clearDraftLocal();
    const sub = $('#ed-sub'); if (sub) sub.textContent = `Saved resume, version ${s.version}`;
    const et = $('#ed-title'); if (et) et.textContent = s.title;
    toast('Saved to My Saved Resumes.', 'ok');
    await downloadDialog(s, 'Your resume is saved! Download it now, or find it any time on your homepage.');
    const go = await modal({ title: 'What next?', body: '<p>Your resume is saved.</p>', buttons: [{ label: 'Keep editing', value: false }, { label: 'Go to My Saved Resumes', primary: true, value: true }] });
    if (go) location.hash = '#/home';
  } catch (er) { toast(er.message, 'error'); }
}

// ---------- boot ----------
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { /* drafts are autosaved locally; nothing to block */ });
(async function boot() {
  try { config = await api('/api/config'); } catch (e) { /* offline */ }
  try { user = (await api('/api/auth/me')).user; } catch (e) { user = null; }
  renderTop(); route();
})();
})();

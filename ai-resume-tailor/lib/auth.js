const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('./db');

const SESSION_DAYS = 14;
const COOKIE = 'sid';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isProd = process.env.NODE_ENV === 'production';

function cookieOpts() {
  return { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: SESSION_DAYS * 864e5, path: '/' };
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  res.cookie(COOKIE, token, cookieOpts());
}

function endSession(req, res) {
  const t = req.cookies && req.cookies[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t));
  res.clearCookie(COOKIE, { path: '/' });
}

// Attach req.user if a valid session exists.
function loadUser(req, _res, next) {
  const t = req.cookies && req.cookies[COOKIE];
  if (t) {
    const row = db.prepare(
      `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash=? AND s.expires_at > ?`).get(sha(t), Date.now());
    if (row) req.user = row;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
}

// Basic CSRF defence: state-changing requests must carry a custom header
// (browsers will not add it cross-site without a CORS preflight, which we never allow).
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'resume-tailor') {
    return res.status(403).json({ error: 'Request blocked for your safety. Please refresh the page and try again.' });
  }
  next();
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters long.';
  if (p.length > 128) return 'Password is too long (max 128 characters).';
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain at least one letter and one number.';
  return null;
}

async function sendResetEmail(to, link) {
  if (!process.env.SMTP_HOST) {
    console.log(`\n[password reset] SMTP is not configured. Reset link for ${to}:\n  ${link}\n`);
    return false;
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Reset your AI Resume Tailor password',
    text: `Click this link to choose a new password (valid for 1 hour):\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
  });
  return true;
}

module.exports = {
  sha, bcrypt, startSession, endSession, loadUser, requireUser, csrfGuard,
  validEmail, validatePassword, sendResetEmail,
};

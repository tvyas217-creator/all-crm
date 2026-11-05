'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb, audit, seedStatuses } = require('../db');
const { esc, nowISO, cleanMobile, validMobile } = require('../lib/util');
const { page } = require('../lib/layout');
const { workspaceAccess } = require('../lib/plans');

const r = express.Router();

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  const body = `<div class="loginwrap"><div class="card">
  <h1 style="text-align:center">📞 All CRM</h1>
  <p class="mut center">Every lead, every call, every follow-up — in one place.</p>
  <form method="post" action="/login">
    <label>Email</label><input type="email" name="email" required autocomplete="username" placeholder="you@company.com">
    <label>Password</label><input type="password" name="password" required autocomplete="current-password" placeholder="••••••••">
    <p style="margin-top:16px"><button class="btn block" type="submit">Log In</button></p>
  </form>
  <details class="fold"><summary>Demo Accounts (for testing)</summary>
  <p class="small">Admin: admin@allcrm.local / Admin@123<br>
  Manager: manager@allcrm.local / Manager@123<br>
  Employee: emp1@allcrm.local / Emp@123 · emp2@allcrm.local / Emp@123</p></details>
  <p class="small mut">Forgot your password? Ask your admin to reset it (Settings → Users).</p>
  <p class="small center" style="margin-top:10px">New company? <a href="/register">Register here →</a></p>
  </div></div>`;
  res.send(page(req, { title: 'Login', body }));
});

r.post('/login', (req, res) => {
  const d = getDb();
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = d.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    req.session.flash = { type: 'err', msg: 'Incorrect email or password.' };
    return res.redirect('/login');
  }
  if (!u.active) {
    req.session.flash = { type: 'err', msg: 'This account has been deactivated. Please contact your admin.' };
    return res.redirect('/login');
  }
  const acc = workspaceAccess(d, u.workspace_id);
  if (!acc.ok) {
    req.session.flash = { type: 'err', msg: acc.msg };
    return res.redirect('/login');
  }
  req.session.userId = u.id;
  d.prepare('UPDATE users SET last_login_at=?, last_active_at=? WHERE id=?').run(nowISO(), nowISO(), u.id);
  audit(d, u.workspace_id, u.id, 'login', u.email);
  res.redirect('/');
});

r.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- Public company registration ("New Company") ----------

// Light abuse guard: max 10 register attempts per IP per 15 minutes (in-memory).
const regHits = new Map(); // ip -> [timestamps]
function regRateLimited(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const arr = (regHits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  regHits.set(ip, arr);
  return arr.length > 10;
}

function registerForm(vals, err) {
  vals = vals || {};
  const body = `<div class="loginwrap"><div class="card">
  <h1 style="text-align:center">📞 All CRM</h1>
  <p class="mut center">Create an account for your new company — your leads and team data stay completely separate.</p>
  ${err ? `<div class="flash err">${esc(err)}</div>` : ''}
  <p class="small center">Note: A new company account becomes active <b>after approval</b> — once approved, you get a <b>3-day FREE trial</b>.</p>
  <form method="post" action="/register">
    <label>Company Name</label><input type="text" name="company" required value="${esc(vals.company || '')}" placeholder="e.g. Sharma Traders">
    <label>Your Name</label><input type="text" name="name" required value="${esc(vals.name || '')}" placeholder="Your name">
    <label>Mobile Number (optional)</label><input type="tel" name="phone" value="${esc(vals.phone || '')}" placeholder="98XXXXXXXX">
    <label>Email</label><input type="email" name="email" required autocomplete="username" value="${esc(vals.email || '')}" placeholder="you@company.com">
    <label>Password</label><input type="password" name="password" required autocomplete="new-password" placeholder="At least 6 characters">
    <label>Confirm Password</label><input type="password" name="confirm" required autocomplete="new-password" placeholder="Re-enter your password">
    <p style="margin-top:16px"><button class="btn block" type="submit">Create Company →</button></p>
  </form>
  <p class="small center" style="margin-top:10px">Already have an account? <a href="/login">Log in →</a></p>
  </div></div>`;
  return body;
}

r.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.send(page(req, { title: 'Register', body: registerForm() }));
});

r.post('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  if (regRateLimited(req.ip || 'unknown')) {
    return res.status(429).send(page(req, {
      title: 'Register',
      body: registerForm(req.body, 'Too many attempts — please try again after 15 minutes.'),
    }));
  }
  const company = String(req.body.company || '').trim();
  const name = String(req.body.name || '').trim();
  const phoneRaw = cleanMobile(req.body.phone || '');
  const phone = phoneRaw && validMobile(phoneRaw) ? phoneRaw : null;
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const vals = { company, name, email, phone: req.body.phone || '' };
  const fail = (msg) => res.status(400).send(page(req, { title: 'Register', body: registerForm(vals, msg) }));

  if (!company || !name || !email || !password || !confirm) return fail('All fields are required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email address (e.g. you@company.com).');
  if (password.length < 6) return fail('Password must be at least 6 characters.');
  if (password !== confirm) return fail('Password and Confirm Password do not match.');

  const d = getDb();
  if (d.prepare('SELECT id FROM users WHERE email=?').get(email)) {
    return fail('This email is already registered — please log in.');
  }

  const now = nowISO();
  let wsId = null; let userId = null;
  const create = d.transaction(() => {
    wsId = d.prepare("INSERT INTO workspaces (name, timezone, api_token, created_at, status) VALUES (?,?,?,?, 'pending')")
      .run(company, 'Asia/Kolkata', crypto.randomBytes(20).toString('hex'), now).lastInsertRowid;
    seedStatuses(d, wsId); // standard 10 statuses, clean slate — no demo data
    userId = d.prepare('INSERT INTO users (workspace_id, name, email, password_hash, role, phone, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(wsId, name, email, bcrypt.hashSync(password, 10), 'admin', phone, now).lastInsertRowid;
  });
  try {
    create();
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE constraint failed: users.email')) {
      return fail('This email is already registered — please log in.');
    }
    throw e;
  }

  audit(d, wsId, userId, 'register-pending', company);
  // No login yet: the workspace stays "pending" until the Super Admin
  // approves it (approval starts the 3-day Trial).
  const body = `<div class="loginwrap"><div class="card">
  <h1 style="text-align:center">✅ Request Received!</h1>
  <p>Hello <b>${esc(name)}</b>, your request for company <b>"${esc(company)}"</b> has been received and is now <b>pending approval</b>.</p>
  <p>Once approved, you can log in with <b>${esc(email)}</b> and your <b>3-day FREE trial</b> will start. Please bear with us — we will approve it shortly.</p>
  <p class="small center" style="margin-top:12px"><a href="/login">Go to the login page →</a></p>
  </div></div>`;
  res.send(page(req, { title: 'Request Received', body }));
});

module.exports = r;

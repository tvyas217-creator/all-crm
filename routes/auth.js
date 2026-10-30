'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb, audit, seedStatuses } = require('../db');
const { esc, nowISO } = require('../lib/util');
const { page } = require('../lib/layout');

const r = express.Router();

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  const body = `<div class="loginwrap"><div class="card">
  <h1 style="text-align:center">📞 All CRM</h1>
  <p class="mut center">Har lead, har call, har follow-up — ek hi jagah.</p>
  <form method="post" action="/login">
    <label>Email</label><input type="email" name="email" required autocomplete="username" placeholder="you@company.com">
    <label>Password</label><input type="password" name="password" required autocomplete="current-password" placeholder="••••••••">
    <p style="margin-top:16px"><button class="btn block" type="submit">Login Karein</button></p>
  </form>
  <details class="fold"><summary>Demo accounts (test ke liye)</summary>
  <p class="small">Admin: admin@allcrm.local / Admin@123<br>
  Manager: manager@allcrm.local / Manager@123<br>
  Employee: emp1@allcrm.local / Emp@123 · emp2@allcrm.local / Emp@123</p></details>
  <p class="small mut">Password bhool gaye? Apne admin se reset karwayein (Settings → Users).</p>
  <p class="small center" style="margin-top:10px">Nayi company banani hai? <a href="/register">Register karein →</a></p>
  </div></div>`;
  res.send(page(req, { title: 'Login', body }));
});

r.post('/login', (req, res) => {
  const d = getDb();
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = d.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    req.session.flash = { type: 'err', msg: 'Email ya password galat hai.' };
    return res.redirect('/login');
  }
  if (!u.active) {
    req.session.flash = { type: 'err', msg: 'Ye account band hai. Admin se sampark karein.' };
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

// ---------- Public company registration ("Nayi Company") ----------

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
  <p class="mut center">Nayi company ke liye apna account banayein — saari leads aur team ka data bilkul alag rahega.</p>
  ${err ? `<div class="flash err">${esc(err)}</div>` : ''}
  <form method="post" action="/register">
    <label>Company Name</label><input type="text" name="company" required value="${esc(vals.company || '')}" placeholder="e.g. Sharma Traders">
    <label>Your Name</label><input type="text" name="name" required value="${esc(vals.name || '')}" placeholder="Aapka naam">
    <label>Email</label><input type="email" name="email" required autocomplete="username" value="${esc(vals.email || '')}" placeholder="you@company.com">
    <label>Password</label><input type="password" name="password" required autocomplete="new-password" placeholder="Kam se kam 6 characters">
    <label>Confirm Password</label><input type="password" name="confirm" required autocomplete="new-password" placeholder="Password dobara likhein">
    <p style="margin-top:16px"><button class="btn block" type="submit">Company Banayein →</button></p>
  </form>
  <p class="small center" style="margin-top:10px">Pehle se account hai? <a href="/login">Login karein →</a></p>
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
      body: registerForm(req.body, 'Bahut zyada koshishein ho gayi hain — kripya 15 minute baad dobara try karein.'),
    }));
  }
  const company = String(req.body.company || '').trim();
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const vals = { company, name, email };
  const fail = (msg) => res.status(400).send(page(req, { title: 'Register', body: registerForm(vals, msg) }));

  if (!company || !name || !email || !password || !confirm) return fail('Saare fields bharna zaroori hai.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Email sahi format me likhein (e.g. you@company.com).');
  if (password.length < 6) return fail('Password kam se kam 6 characters ka hona chahiye.');
  if (password !== confirm) return fail('Password aur Confirm Password ek jaise nahi hain.');

  const d = getDb();
  if (d.prepare('SELECT id FROM users WHERE email=?').get(email)) {
    return fail('Ye email pehle se registered hai — login karein');
  }

  const now = nowISO();
  let wsId = null; let userId = null;
  const create = d.transaction(() => {
    wsId = d.prepare('INSERT INTO workspaces (name, timezone, api_token, created_at) VALUES (?,?,?,?)')
      .run(company, 'Asia/Kolkata', crypto.randomBytes(20).toString('hex'), now).lastInsertRowid;
    seedStatuses(d, wsId); // standard 10 statuses, clean slate — no demo data
    userId = d.prepare('INSERT INTO users (workspace_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)')
      .run(wsId, name, email, bcrypt.hashSync(password, 10), 'admin', now).lastInsertRowid;
  });
  try {
    create();
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE constraint failed: users.email')) {
      return fail('Ye email pehle se registered hai — login karein');
    }
    throw e;
  }

  req.session.userId = userId;
  d.prepare('UPDATE users SET last_login_at=?, last_active_at=? WHERE id=?').run(nowISO(), nowISO(), userId);
  audit(d, wsId, userId, 'register', company);
  req.session.flash = { type: 'ok', msg: `Swagat hai! Aapki company "${company}" ban gayi hai — ab apni team aur leads add karein.` };
  res.redirect('/');
});

module.exports = r;

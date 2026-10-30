'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, audit } = require('../db');
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

module.exports = r;

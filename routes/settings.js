'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb, closeDb, openDb, DB_PATH, audit } = require('../db');
const { esc, nowISO, fmtDT } = require('../lib/util');
const { page } = require('../lib/layout');
const { requireAuth, requireRole } = require('../lib/auth');

const r = express.Router();
const admin = requireRole('admin');

r.get('/settings', requireAuth, admin, (req, res) => {
  const d = getDb(); const u = req.user;
  const ws = d.prepare('SELECT * FROM workspaces WHERE id=?').get(u.workspace_id);
  const body = `<h1>⚙️ Settings</h1>
  <div class="card"><h3 style="margin-top:0">🏢 Company</h3>
  <form method="post" action="/settings">
    <label>Company / Workspace Naam</label><input name="name" value="${esc(ws.name)}">
    <div class="grid2"><div><label>Lost Lead Din (itne din activity na ho to "thandi" lead)</label><input type="number" name="lost_lead_days" min="1" max="90" value="${ws.lost_lead_days}"></div>
    <div><label>Auto-Dialer Redial Attempts (per session)</label><input type="number" name="redial_attempts" min="0" max="5" value="${ws.redial_attempts}"></div></div>
    <p style="margin-top:12px"><button class="btn" type="submit">Save Karein</button></p></form></div>
  <div class="card"><h3 style="margin-top:0">🔗 Lead Auto-Import API (Phase 3 ready)</h3>
  <p class="small">Dusre tools (website form, ads) is token se seedha lead bhej sakte hain:<br>
  <code style="word-break:break-all">POST /api/webhook/leads · Header: x-api-token: ${esc(ws.api_token || '')}</code><br>
  Body (JSON): {"name":"...","mobile":"98XXXXXXXX","city":"...","source":"Website"}</p>
  <form method="post" action="/settings/regen-token" onsubmit="return confirm('Purana token band ho jayega. Pakka?')"><button class="btn sm ghost" type="submit">🔄 Naya Token Banayein</button></form></div>
  <div class="card"><h3 style="margin-top:0">🧭 Admin Sections</h3>
  <div class="rowflex">
    <a class="btn ghost" href="/settings/statuses">🔄 Lead Statuses</a>
    <a class="btn ghost" href="/settings/fields">🧩 Custom Fields</a>
    <a class="btn ghost" href="/templates">💬 WA Templates</a>
    <a class="btn ghost" href="/settings/users">👥 Users (Team)</a>
  </div></div>
  <div class="card"><h3 style="margin-top:0">💾 Data Backup</h3>
  <p class="small">Poora database ek file me download karein. Restore karne par maujooda data us backup se badal jayega.</p>
  <div class="rowflex"><a class="btn blue" href="/settings/backup">⬇ Backup Download</a></div>
  <label style="margin-top:14px">Backup Restore (.db file)</label>
  <input type="file" id="rst_file" accept=".db">
  <p><button class="btn red" type="button" onclick="doRestore()">♻️ Restore Karein (dhyaan se!)</button></p>
  <script>function doRestore(){var f=document.getElementById('rst_file').files[0];if(!f){alert('Pehle .db file chunein');return}if(!confirm('Pakka restore karein? Abhi ka data backup se badal jayega.'))return;var rd=new FileReader();rd.onload=function(){fetch('/settings/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data_base64:String(rd.result).split(',')[1]})}).then(function(r){return r.json()}).then(function(j){alert(j.msg||j.error);if(j.ok)location.href='/login'})};rd.readAsDataURL(f)}</script></div>`;
  res.send(page(req, { title: 'Settings', body, active: 'settings' }));
});

r.post('/settings', requireAuth, admin, (req, res) => {
  const d = getDb();
  d.prepare('UPDATE workspaces SET name=?, lost_lead_days=?, redial_attempts=? WHERE id=?')
    .run(String(req.body.name || 'All CRM').trim(), Math.min(90, Math.max(1, parseInt(req.body.lost_lead_days, 10) || 7)), Math.min(5, Math.max(0, parseInt(req.body.redial_attempts, 10) || 0)), req.user.workspace_id);
  req.session.flash = { type: 'ok', msg: 'Settings save ho gayi ✅' };
  res.redirect('/settings');
});

r.post('/settings/regen-token', requireAuth, admin, (req, res) => {
  getDb().prepare('UPDATE workspaces SET api_token=? WHERE id=?').run(crypto.randomBytes(20).toString('hex'), req.user.workspace_id);
  req.session.flash = { type: 'ok', msg: 'Naya API token ban gaya.' };
  res.redirect('/settings');
});

// ---------- Statuses ----------
r.get('/settings/statuses', requireAuth, admin, (req, res) => {
  const d = getDb(); const u = req.user;
  const rows = d.prepare('SELECT s.*, (SELECT COUNT(*) FROM leads l WHERE l.status_id=s.id) used FROM statuses s WHERE s.workspace_id=? ORDER BY s.sort').all(u.workspace_id);
  const body = `<h1>🔄 Lead Statuses</h1><p><a href="/settings">← Settings</a></p>
  ${rows.map((s) => `<div class="card"><form method="post" action="/settings/statuses/${s.id}" class="rowflex">
    <input type="color" name="color" value="${esc(s.color)}" style="width:56px;min-height:44px;padding:2px">
    <input name="name" value="${esc(s.name)}" style="flex:1;min-width:140px" required>
    <label style="margin:0"><input type="checkbox" name="counts_connected" ${s.counts_connected ? 'checked' : ''}> Connected ginein</label>
    <input type="number" name="sort" value="${s.sort}" style="width:76px" title="Order">
    <button class="btn sm" type="submit">Save</button>
    ${s.used ? `<span class="small mut">${s.used} leads use kar rahi hain</span>` : `<button class="btn sm red" formaction="/settings/statuses/${s.id}/delete" type="submit" onclick="return confirm('Delete karein?')">Delete</button>`}
  </form></div>`).join('')}
  <div class="card"><h3 style="margin-top:0">➕ Naya Status</h3>
  <form method="post" action="/settings/statuses" class="rowflex"><input name="name" required placeholder="Status naam" style="flex:1;min-width:140px">
  <input type="color" name="color" value="#0e9f6e" style="width:56px;min-height:44px;padding:2px">
  <label style="margin:0"><input type="checkbox" name="counts_connected"> Connected</label>
  <button class="btn" type="submit">Jodein</button></form></div>`;
  res.send(page(req, { title: 'Statuses', body, active: 'settings' }));
});

r.post('/settings/statuses', requireAuth, admin, (req, res) => {
  const d = getDb(); const u = req.user;
  const mx = d.prepare('SELECT COALESCE(MAX(sort),0) m FROM statuses WHERE workspace_id=?').get(u.workspace_id).m;
  d.prepare('INSERT INTO statuses (workspace_id, name, color, counts_connected, sort) VALUES (?,?,?,?,?)')
    .run(u.workspace_id, String(req.body.name || '').trim(), req.body.color || '#64748b', req.body.counts_connected ? 1 : 0, mx + 1);
  res.redirect('/settings/statuses');
});
r.post('/settings/statuses/:id', requireAuth, admin, (req, res) => {
  getDb().prepare('UPDATE statuses SET name=?, color=?, counts_connected=?, sort=? WHERE id=? AND workspace_id=?')
    .run(String(req.body.name || '').trim(), req.body.color || '#64748b', req.body.counts_connected ? 1 : 0, parseInt(req.body.sort, 10) || 0, req.params.id, req.user.workspace_id);
  res.redirect('/settings/statuses');
});
r.post('/settings/statuses/:id/delete', requireAuth, admin, (req, res) => {
  const d = getDb();
  const used = d.prepare('SELECT COUNT(*) c FROM leads WHERE status_id=?').get(req.params.id).c;
  if (!used) d.prepare('DELETE FROM statuses WHERE id=? AND workspace_id=?').run(req.params.id, req.user.workspace_id);
  res.redirect('/settings/statuses');
});

// ---------- Custom fields ----------
r.get('/settings/fields', requireAuth, admin, (req, res) => {
  const d = getDb(); const u = req.user;
  const rows = d.prepare('SELECT * FROM custom_fields WHERE workspace_id=? ORDER BY sort, id').all(u.workspace_id);
  const body = `<h1>🧩 Custom Fields</h1><p><a href="/settings">← Settings</a></p>
  ${rows.map((f) => `<div class="card rowflex" style="justify-content:space-between"><span><b>${esc(f.name)}</b> <span class="mut">(${esc(f.type)}${f.type === 'dropdown' ? ': ' + esc(f.options || '') : ''})</span></span>
  <form method="post" action="/settings/fields/${f.id}/delete" onsubmit="return confirm('Field delete karein? Uska data bhi jayega.')"><button class="btn sm red" type="submit">Delete</button></form></div>`).join('') || '<div class="card mut">Koi custom field nahi hai.</div>'}
  <div class="card"><h3 style="margin-top:0">➕ Naya Field</h3>
  <form method="post" action="/settings/fields">
  <label>Field Naam</label><input name="name" required placeholder="jaise Area / Requirement">
  <label>Type</label><select name="type"><option value="text">Text</option><option value="number">Number</option><option value="dropdown">Dropdown</option><option value="date">Date</option></select>
  <label>Dropdown Options (comma se alag — sirf dropdown ke liye)</label><input name="options" placeholder="Option 1, Option 2, Option 3">
  <p><button class="btn" type="submit">Field Jodein</button></p></form></div>`;
  res.send(page(req, { title: 'Custom Fields', body, active: 'settings' }));
});
r.post('/settings/fields', requireAuth, admin, (req, res) => {
  const d = getDb(); const u = req.user;
  const t = ['text', 'number', 'dropdown', 'date'].includes(req.body.type) ? req.body.type : 'text';
  const mx = d.prepare('SELECT COALESCE(MAX(sort),0) m FROM custom_fields WHERE workspace_id=?').get(u.workspace_id).m;
  d.prepare('INSERT INTO custom_fields (workspace_id, name, type, options, sort) VALUES (?,?,?,?,?)')
    .run(u.workspace_id, String(req.body.name || '').trim(), t, t === 'dropdown' ? String(req.body.options || '') : null, mx + 1);
  res.redirect('/settings/fields');
});
r.post('/settings/fields/:id/delete', requireAuth, admin, (req, res) => {
  getDb().prepare('DELETE FROM custom_fields WHERE id=? AND workspace_id=?').run(req.params.id, req.user.workspace_id);
  res.redirect('/settings/fields');
});

// ---------- Users ----------
r.get('/settings/users', requireAuth, admin, (req, res) => {
  const d = getDb(); const u = req.user;
  const rows = d.prepare('SELECT * FROM users WHERE workspace_id=? ORDER BY role, name').all(u.workspace_id);
  const body = `<h1>👥 Users (Team)</h1><p><a href="/settings">← Settings</a></p>
  <div class="card"><div class="tblwrap"><table><tr><th>Naam</th><th>Email</th><th>Role</th><th>Haal</th><th>Last Login</th><th>Actions</th></tr>
  ${rows.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.email)}</td><td>${esc(x.role)}</td><td>${x.active ? '✅ Active' : '⛔ Band'}</td><td>${fmtDT(x.last_login_at)}</td>
  <td><div class="rowflex">
    ${x.id !== u.id ? `<form method="post" action="/settings/users/${x.id}/toggle"><button class="btn sm ghost" type="submit">${x.active ? 'Band Karein' : 'Chalu Karein'}</button></form>` : '<span class="mut small">aap khud</span>'}
    <form method="post" action="/settings/users/${x.id}/reset" class="rowflex"><input type="password" name="password" placeholder="Naya password" required style="min-height:38px;max-width:150px"><button class="btn sm blue" type="submit">Reset</button></form>
  </div></td></tr>`).join('')}</table></div></div>
  <div class="card"><h3 style="margin-top:0">➕ Naya User</h3>
  <form method="post" action="/settings/users"><div class="grid2">
  <div><label>Naam</label><input name="name" required></div>
  <div><label>Email</label><input type="email" name="email" required></div>
  <div><label>Password</label><input name="password" required minlength="6"></div>
  <div><label>Role</label><select name="role"><option value="employee">Employee</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div></div>
  <p><button class="btn" type="submit">User Jodein</button></p></form></div>`;
  res.send(page(req, { title: 'Users', body, active: 'settings' }));
});
r.post('/settings/users', requireAuth, admin, (req, res) => {
  const d = getDb(); const u = req.user;
  const email = String(req.body.email || '').trim().toLowerCase();
  if (d.prepare('SELECT id FROM users WHERE email=?').get(email)) { req.session.flash = { type: 'err', msg: 'Ye email pehle se hai.' }; return res.redirect('/settings/users'); }
  const role = ['admin', 'manager', 'employee'].includes(req.body.role) ? req.body.role : 'employee';
  d.prepare('INSERT INTO users (workspace_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)')
    .run(u.workspace_id, String(req.body.name || '').trim(), email, bcrypt.hashSync(String(req.body.password || '123456'), 10), role, nowISO());
  req.session.flash = { type: 'ok', msg: 'User jud gaya ✅' };
  res.redirect('/settings/users');
});
r.post('/settings/users/:id/toggle', requireAuth, admin, (req, res) => {
  const d = getDb();
  const x = d.prepare('SELECT * FROM users WHERE id=? AND workspace_id=?').get(req.params.id, req.user.workspace_id);
  if (x && x.id !== req.user.id) d.prepare('UPDATE users SET active=? WHERE id=?').run(x.active ? 0 : 1, x.id);
  res.redirect('/settings/users');
});
r.post('/settings/users/:id/reset', requireAuth, admin, (req, res) => {
  const d = getDb();
  d.prepare('UPDATE users SET password_hash=? WHERE id=? AND workspace_id=?')
    .run(bcrypt.hashSync(String(req.body.password || '123456'), 10), req.params.id, req.user.workspace_id);
  req.session.flash = { type: 'ok', msg: 'Password reset ho gaya ✅' };
  res.redirect('/settings/users');
});

// ---------- Backup / restore ----------
r.get('/settings/backup', requireAuth, admin, (req, res) => {
  const d = getDb();
  const tmp = path.join(path.dirname(DB_PATH), 'backup-tmp.db');
  try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (e) {}
  d.prepare('VACUUM INTO ?').run(tmp);
  res.download(tmp, 'allcrm-backup-' + new Date().toISOString().slice(0, 10) + '.db', () => { try { fs.unlinkSync(tmp); } catch (e) {} });
});

r.post('/settings/restore', requireAuth, admin, (req, res) => {
  const buf = Buffer.from(String(req.body.data_base64 || ''), 'base64');
  if (!buf.length) return res.json({ ok: false, error: 'File khaali hai' });
  const tmp = path.join(path.dirname(DB_PATH), 'restore-tmp.db');
  fs.writeFileSync(tmp, buf);
  try {
    const Test = require('better-sqlite3');
    const t = new Test(tmp, { readonly: true });
    t.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    t.close();
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (err) {}
    return res.json({ ok: false, error: 'Ye sahi All CRM backup file nahi lagti: ' + e.message });
  }
  closeDb();
  fs.copyFileSync(tmp, DB_PATH);
  try { fs.unlinkSync(tmp + '-wal'); } catch (e) {}
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch (e) {}
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch (e) {}
  openDb();
  try { fs.unlinkSync(tmp); } catch (e) {}
  audit(getDb(), req.user.workspace_id, req.user.id, 'restore', 'Database restored from backup');
  req.session.destroy(() => {});
  res.json({ ok: true, msg: 'Restore ho gaya ✅ Ab naye (backup wale) accounts se login karein.' });
});

module.exports = r;

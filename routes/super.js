'use strict';
// Super Admin panel (/super) — for the product owner (Tarun) only.
// Auth is completely separate from workspace users: super_admins table +
// session.superId. From here: all companies (clients), plans,
// subscriptions, approve / suspend / activate / renew / plan-change /
// admin-password-reset / delete.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb, audit } = require('../db');
const { esc, nowISO, fmtD, fmtDT, timeAgo } = require('../lib/util');
const { CSS, info, INFO_JS } = require('../lib/layout');
const { currentSub, subExpired, daysLeft, assignPlan, userCount, leadCount } = require('../lib/plans');

const r = express.Router();

// ---------- auth ----------
function loadSuper(req, res, next) {
  req.super = null;
  if (req.session && req.session.superId) {
    const sa = getDb().prepare('SELECT * FROM super_admins WHERE id=?').get(req.session.superId);
    if (sa) req.super = sa;
  }
  next();
}
r.use(loadSuper);

function requireSuper(req, res, next) {
  if (!req.super) return res.redirect('/super/login');
  next();
}

function superPage(req, { title, body, active = '' }) {
  const flash = req.session ? req.session.flash : null;
  if (req.session) req.session.flash = null;
  const sa = req.super;
  const nav = sa ? `<div class="rowflex" style="margin-bottom:14px">
    <a class="btn sm ${active === 'dash' ? '' : 'ghost'}" href="/super">🏠 Dashboard</a>
    <a class="btn sm ${active === 'clients' ? '' : 'ghost'}" href="/super/clients">🏢 Clients</a>
    <a class="btn sm ${active === 'plans' ? '' : 'ghost'}" href="/super/plans">💳 Plans</a>
    <a class="btn sm ${active === 'pwd' ? '' : 'ghost'}" href="/super/password">🔑 My Password</a>
  </div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · All CRM Super Admin</title>
<meta name="theme-color" content="#0b7a56">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>${CSS}</style></head><body>
<div class="topbar"><a class="logo" href="/super"><span class="dot">👑</span>All CRM · Super Admin</a><div class="sp"></div>
${sa ? `<div class="who">${esc(sa.name)}<small>${esc(sa.email)}</small></div>
<form method="post" action="/super/logout" style="margin:0"><button class="btn sm ghost" type="submit">Logout</button></form>` : ''}
</div>
<main class="main" style="margin-left:auto">
${flash ? `<div class="flash ${flash.type === 'err' ? 'err' : 'ok'}">${esc(flash.msg)}</div>` : ''}
${nav}
${body}
</main><script>${INFO_JS}</script></body></html>`;
}

function flash(req, type, msg) { req.session.flash = { type, msg }; }
function saudit(req, wsId, action, detail) {
  audit(getDb(), wsId || null, null, 'super:' + action, `${detail || ''} [by ${req.super ? req.super.email : '?'}]`.trim());
}

// ---------- login / logout ----------
r.get('/super/login', (req, res) => {
  if (req.super) return res.redirect('/super');
  const body = `<div class="loginwrap"><div class="card">
  <h1 style="text-align:center">👑 Super Admin</h1>
  <p class="mut center">Owner only — control of all companies, plans and subscriptions.</p>
  <form method="post" action="/super/login">
    <label>Email</label><input type="email" name="email" required autocomplete="username" placeholder="owner@allcrm.local">
    <label>Password</label><input type="password" name="password" required autocomplete="current-password" placeholder="••••••••">
    <p style="margin-top:16px"><button class="btn block" type="submit">Log In</button></p>
  </form>
  <p class="small center" style="margin-top:10px"><a href="/login">← Company user login</a></p>
  </div></div>`;
  res.send(superPage(req, { title: 'Super Admin Login', body }));
});

r.post('/super/login', (req, res) => {
  const d = getDb();
  const email = String(req.body.email || '').trim().toLowerCase();
  const sa = d.prepare('SELECT * FROM super_admins WHERE email=?').get(email);
  if (!sa || !bcrypt.compareSync(String(req.body.password || ''), sa.password_hash)) {
    flash(req, 'err', 'Incorrect email or password.');
    return res.redirect('/super/login');
  }
  req.session.superId = sa.id;
  audit(d, null, null, 'super:login', sa.email);
  res.redirect('/super');
});

r.post('/super/logout', (req, res) => {
  if (req.session) delete req.session.superId;
  res.redirect('/super/login');
});

// ---------- shared client-row shaping ----------
function derivedStatus(ws, sub) {
  if (ws.status === 'pending') return { key: 'pending', label: '⏳ Pending Approval' };
  if (ws.status === 'rejected') return { key: 'rejected', label: '❌ Rejected' };
  if (ws.status === 'suspended') return { key: 'suspended', label: '⛔ Suspended' };
  if (subExpired(sub)) return { key: 'expired', label: '⌛ Plan Expired' };
  if (sub && sub.plan_name === 'Trial') return { key: 'trial', label: '🧪 Trial' };
  return { key: 'active', label: '✅ Active' };
}

function clientRow(d, ws) {
  const owner = d.prepare("SELECT * FROM users WHERE workspace_id=? AND role='admin' ORDER BY id LIMIT 1").get(ws.id);
  const sub = currentSub(d, ws.id);
  const lastAct = d.prepare('SELECT MAX(last_active_at) m FROM users WHERE workspace_id=?').get(ws.id).m;
  return {
    ws, owner, sub,
    status: derivedStatus(ws, sub),
    employees: userCount(d, ws.id),
    leads: leadCount(d, ws.id),
    lastAct,
    dl: daysLeft(sub),
  };
}

// ---------- dashboard ----------
r.get('/super', requireSuper, (req, res) => {
  const d = getDb();
  const wss = d.prepare('SELECT * FROM workspaces ORDER BY id').all();
  const rows = wss.map((ws) => clientRow(d, ws));
  const count = (k) => rows.filter((x) => x.status.key === k).length;
  const totalUsers = d.prepare('SELECT COUNT(*) c FROM users').get().c;
  const totalLeads = d.prepare('SELECT COUNT(*) c FROM leads').get().c;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const weekSignups = wss.filter((w) => w.created_at >= weekAgo).length;
  const expiring = rows.filter((x) => x.ws.status === 'active' && x.dl !== null && x.dl >= 0 && x.dl <= 3 && !subExpired(x.sub));
  const pending = rows.filter((x) => x.status.key === 'pending');
  const recentAudit = d.prepare("SELECT * FROM audit_log WHERE action LIKE 'super:%' ORDER BY id DESC LIMIT 10").all();

  const body = `<h1>👑 Dashboard</h1>
  <div class="stats">
    <div class="stat"><div class="n">${rows.length}</div><div class="l">Total Companies</div></div>
    <div class="stat green"><div class="n">${count('active')}</div><div class="l">Active</div></div>
    <div class="stat"><div class="n">${count('trial')}</div><div class="l">On Trial</div></div>
    <div class="stat amber"><div class="n">${count('pending')}</div><div class="l">Pending Approval</div></div>
    <div class="stat red"><div class="n">${count('expired')}</div><div class="l">Plan Expired</div></div>
    <div class="stat red"><div class="n">${count('suspended')}</div><div class="l">Suspended</div></div>
    <div class="stat"><div class="n">${totalUsers}</div><div class="l">Total Users (all companies)</div></div>
    <div class="stat"><div class="n">${totalLeads}</div><div class="l">Total Leads (all companies)</div></div>
    <div class="stat"><div class="n">${weekSignups}</div><div class="l">Signups This Week</div></div>
  </div>

  ${pending.length ? `<div class="card"><h3 style="margin-top:0">⏳ Waiting for Approval (${pending.length})</h3>
  ${pending.map((x) => `<div class="leadrow"><div class="info"><div class="nm"><a href="/super/clients/${x.ws.id}">${esc(x.ws.name)}</a></div>
    <div class="sub">${esc(x.owner ? x.owner.name : '')} · ${esc(x.owner ? x.owner.email : '')}${x.owner && x.owner.phone ? ' · ' + esc(x.owner.phone) : ''} · ${fmtDT(x.ws.created_at)}</div></div>
    <form method="post" action="/super/clients/${x.ws.id}/approve"><button class="btn sm" type="submit">✅ Approve (Trial)</button></form>
    <form method="post" action="/super/clients/${x.ws.id}/reject" onsubmit="return confirm('Reject this request?')"><button class="btn sm red" type="submit">Reject</button></form></div>`).join('')}</div>` : ''}

  <div class="card"><h3 style="margin-top:0">⚠️ Expiring Within 3 Days (Trial/Plan)</h3>
  ${expiring.length ? `<div class="tblwrap"><table><tr><th>Company</th><th>Plan</th><th>Expiry</th><th>Left</th><th></th></tr>
  ${expiring.map((x) => `<tr><td><a href="/super/clients/${x.ws.id}"><b>${esc(x.ws.name)}</b></a></td><td>${esc(x.sub.plan_name)}</td><td>${fmtD(x.sub.expires_at)}</td><td>${x.dl} days</td><td><a class="btn sm blue" href="/super/clients/${x.ws.id}">Renew →</a></td></tr>`).join('')}</table></div>`
    : '<p class="mut">No company is expiring within the next 3 days. 👍</p>'}</div>

  <div class="card"><h3 style="margin-top:0">🕒 Recent Super-Admin Actions</h3>
  ${recentAudit.length ? recentAudit.map((a) => `<p class="small" style="margin:4px 0">${esc(a.action)} — ${esc(a.detail || '')} <span class="mut">(${timeAgo(a.created_at)})</span></p>`).join('') : '<p class="mut">No actions yet.</p>'}</div>`;
  res.send(superPage(req, { title: 'Dashboard', body, active: 'dash' }));
});

// ---------- clients list ----------
r.get('/super/clients', requireSuper, (req, res) => {
  const d = getDb();
  const q = String(req.query.q || '').trim().toLowerCase();
  const f = String(req.query.status || 'all');
  let wss = d.prepare('SELECT * FROM workspaces ORDER BY id DESC').all();
  let rows = wss.map((ws) => clientRow(d, ws));
  if (q) rows = rows.filter((x) => x.ws.name.toLowerCase().includes(q)
    || (x.owner && (x.owner.email.toLowerCase().includes(q) || x.owner.name.toLowerCase().includes(q))));
  if (f !== 'all') rows = rows.filter((x) => x.status.key === f);
  const opts = [['all', 'All'], ['pending', 'Pending'], ['active', 'Active'], ['trial', 'Trial'], ['expired', 'Expired'], ['suspended', 'Suspended'], ['rejected', 'Rejected']];
  const body = `<h1>🏢 Clients (Companies) ${info('Every company that registers appears here. A new signup starts as Pending and cannot log in until you approve it — approval starts their free 3-day Trial automatically. Open a company to manage its plan, renew or extend it, suspend it, or delete it.')}</h1>
  <form method="get" action="/super/clients" class="rowflex" style="margin-bottom:14px">
    <input name="q" value="${esc(req.query.q || '')}" placeholder="Search company, owner or email…" style="flex:1;min-width:200px">
    <select name="status" style="max-width:190px">${opts.map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button class="btn sm" type="submit">Search</button>
  </form>
  <div class="card"><div class="tblwrap"><table>
  <tr><th>Company</th><th>Owner</th><th>Contact</th><th>Team</th><th>Leads</th><th>Plan</th><th>Expiry</th><th>Status</th><th>Last Active</th><th></th></tr>
  ${rows.map((x) => `<tr>
    <td><a href="/super/clients/${x.ws.id}"><b>${esc(x.ws.name)}</b></a><br><span class="small mut">since ${fmtD(x.ws.created_at)}</span></td>
    <td>${esc(x.owner ? x.owner.name : '—')}</td>
    <td class="small">${esc(x.owner ? x.owner.email : '—')}${x.owner && x.owner.phone ? '<br>📱 ' + esc(x.owner.phone) : ''}</td>
    <td>${x.employees}</td><td>${x.leads}</td>
    <td>${x.sub ? esc(x.sub.plan_name) : '—'}</td>
    <td>${x.sub ? (x.sub.expires_at ? fmtD(x.sub.expires_at) + (x.dl !== null ? `<br><span class="small ${x.dl < 0 ? 'overdue' : 'mut'}">${x.dl < 0 ? 'expired ' + Math.abs(x.dl) + ' days ago' : x.dl + ' days left'}</span>` : '') : 'Never') : '—'}</td>
    <td>${x.status.label}</td>
    <td class="small">${x.lastAct ? timeAgo(x.lastAct) : '—'}</td>
    <td><a class="btn sm ghost" href="/super/clients/${x.ws.id}">Open →</a></td></tr>`).join('') || '<tr><td colspan="10" class="mut">No companies found.</td></tr>'}
  </table></div></div>`;
  res.send(superPage(req, { title: 'Clients', body, active: 'clients' }));
});

// ---------- client detail + actions ----------
function getClient(req, res) {
  const d = getDb();
  const ws = d.prepare('SELECT * FROM workspaces WHERE id=?').get(req.params.id);
  if (!ws) { flash(req, 'err', 'Company not found.'); res.redirect('/super/clients'); return null; }
  return { d, ws, x: clientRow(d, ws) };
}

r.get('/super/clients/:id', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws, x } = c;
  const plans = d.prepare('SELECT * FROM plans ORDER BY sort, id').all();
  const users = d.prepare('SELECT * FROM users WHERE workspace_id=? ORDER BY role, name').all(ws.id);
  const history = d.prepare(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.workspace_id=? ORDER BY s.id DESC`).all(ws.id);
  const planOpts = (sel) => plans.map((p) => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)} — ₹${p.price}${p.validity_days ? ' / ' + p.validity_days + ' days' : ' / never expires'}${p.is_active ? '' : ' (inactive)'}</option>`).join('');
  const body = `<h1>🏢 ${esc(ws.name)}</h1>
  <p><a href="/super/clients">← All Companies</a></p>
  <div class="card"><dl class="kv">
    <dt>Status</dt><dd>${x.status.label}</dd>
    <dt>Owner</dt><dd>${esc(x.owner ? x.owner.name : '—')}</dd>
    <dt>Email</dt><dd>${esc(x.owner ? x.owner.email : '—')}</dd>
    <dt>Mobile</dt><dd>${x.owner && x.owner.phone ? esc(x.owner.phone) : '— (not captured in older signups)'}</dd>
    <dt>Signup</dt><dd>${fmtDT(ws.created_at)}</dd>
    <dt>Team / Leads</dt><dd>${x.employees} users · ${x.leads} leads</dd>
    <dt>Current Plan</dt><dd>${x.sub ? `<b>${esc(x.sub.plan_name)}</b> (₹${x.sub.plan_price})` : '—'}</dd>
    <dt>Plan Started</dt><dd>${x.sub ? fmtD(x.sub.starts_at) : '—'}</dd>
    <dt>Plan Expiry</dt><dd>${x.sub ? (x.sub.expires_at ? fmtD(x.sub.expires_at) + (x.dl !== null ? ` (${x.dl < 0 ? 'expired ' + Math.abs(x.dl) + ' days ago' : x.dl + ' days left'})` : '') : 'Never (unlimited)') : '—'}</dd>
    <dt>Last Activity</dt><dd>${x.lastAct ? timeAgo(x.lastAct) : '—'}</dd>
  </dl></div>

  <div class="card"><h3 style="margin-top:0">⚡ Actions ${info('Suspend blocks the company\'s logins immediately but keeps all their data safe — use it for non-payment, and Reactivate to restore access. Delete (in the Danger Zone below) is permanent and removes everything. Approve starts a pending company\'s free 3-day Trial.')}</h3>
  <div class="rowflex">
    ${ws.status === 'pending' ? `<form method="post" action="/super/clients/${ws.id}/approve"><button class="btn" type="submit">✅ Approve + Start Trial</button></form>
    <form method="post" action="/super/clients/${ws.id}/reject" onsubmit="return confirm('Reject this request?')"><button class="btn red" type="submit">❌ Reject</button></form>` : ''}
    ${ws.status === 'suspended' ? `<form method="post" action="/super/clients/${ws.id}/activate"><button class="btn" type="submit">▶️ Reactivate</button></form>`
      : (ws.status !== 'pending' && ws.status !== 'rejected' ? `<form method="post" action="/super/clients/${ws.id}/suspend" onsubmit="return confirm('Suspend this company? Its users will not be able to log in (their data stays safe).')"><button class="btn red" type="submit">⛔ Suspend</button></form>` : '')}
    ${ws.status === 'rejected' ? `<form method="post" action="/super/clients/${ws.id}/activate"><button class="btn" type="submit">▶️ Activate</button></form>` : ''}
  </div>
  <div class="grid2" style="margin-top:14px">
    <form method="post" action="/super/clients/${ws.id}/plan" class="card" style="margin:0">
      <h3 style="margin-top:0">💳 Change / Assign Plan</h3>
      <label>Plan</label><select name="plan_id">${planOpts(x.sub ? x.sub.plan_id : null)}</select>
      <p><button class="btn blue" type="submit">Apply Plan (from today)</button></p>
      <p class="small mut">The new period starts today.</p>
    </form>
    <form method="post" action="/super/clients/${ws.id}/renew" class="card" style="margin:0">
      <h3 style="margin-top:0">🔄 Renew / Extend ${info('Renew adds the plan\'s validity starting from the current expiry — if days are still left, the new period begins after them, so paid days are never lost. If the plan has already expired, the new period starts today. "Just add days" below adds extra days without changing the plan.')}</h3>
      <label>Plan</label><select name="plan_id">${planOpts(x.sub ? x.sub.plan_id : null)}</select>
      <p><button class="btn" type="submit">Renew</button></p>
      <p class="small mut">If the current plan still has days left, the new period is added after its expiry — no days are wasted.</p>
    </form>
  </div>
  <form method="post" action="/super/clients/${ws.id}/extend" class="rowflex" style="margin-top:14px">
    <span><b>⏩ Just add days:</b></span>
    <input type="number" name="days" min="1" max="3650" value="30" style="max-width:110px">
    <button class="btn sm ghost" type="submit">Add Days</button>
  </form></div>

  <div class="card"><h3 style="margin-top:0">👥 Team (${users.length})</h3>
  <div class="tblwrap"><table><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Role</th><th>Status</th><th>Last Login</th></tr>
  ${users.map((u2) => `<tr><td><b>${esc(u2.name)}</b></td><td>${esc(u2.email)}</td><td>${esc(u2.phone || '—')}</td><td>${esc(u2.role)}</td><td>${u2.active ? '✅ Active' : '⛔ Disabled'}</td><td>${fmtDT(u2.last_login_at)}</td></tr>`).join('')}</table></div>
  <form method="post" action="/super/clients/${ws.id}/reset-admin" onsubmit="return confirm('Reset the company admin\'s password? A temporary password will be shown once.')" style="margin-top:10px">
  <button class="btn sm blue" type="submit">🔑 Reset Admin Password (temporary)</button></form></div>

  <div class="card"><h3 style="margin-top:0">🧾 Subscription History</h3>
  <div class="tblwrap"><table><tr><th>Plan</th><th>Start</th><th>Expiry</th><th>By</th><th>Note</th><th>When</th></tr>
  ${history.map((s) => `<tr><td>${esc(s.plan_name)}</td><td>${fmtD(s.starts_at)}</td><td>${s.expires_at ? fmtD(s.expires_at) : 'Never'}</td><td>${esc(s.created_by || '—')}</td><td class="small">${esc(s.note || '')}</td><td class="small">${fmtDT(s.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">No subscriptions.</td></tr>'}
  </table></div></div>

  <div class="card" style="border-color:#fecaca"><h3 style="margin-top:0;color:var(--red)">🗑️ Danger Zone — Delete Company</h3>
  <p class="small">All data (users, leads, calls — everything) will be permanently deleted. To prevent accidents, you must type the company name to confirm.</p>
  <form method="post" action="/super/clients/${ws.id}/delete" class="rowflex" onsubmit="return confirm('Delete permanently? This cannot be undone!')">
    <input name="confirm_name" placeholder="${esc(ws.name)} — type the name here" style="flex:1;min-width:220px">
    <button class="btn red" type="submit">Delete</button></form></div>`;
  res.send(superPage(req, { title: ws.name, body, active: 'clients' }));
});

r.post('/super/clients/:id/approve', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws } = c;
  d.prepare("UPDATE workspaces SET status='active' WHERE id=?").run(ws.id);
  const trial = d.prepare("SELECT * FROM plans WHERE name='Trial'").get();
  if (trial) assignPlan(d, ws.id, trial.id, 'super', 'Signup approved — 3-day Trial started', false);
  saudit(req, ws.id, 'approve', `${ws.name} approved, Trial started`);
  flash(req, 'ok', `✅ "${ws.name}" approved — 3-day Trial started.`);
  res.redirect('/super/clients/' + ws.id);
});

r.post('/super/clients/:id/reject', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws } = c;
  d.prepare("UPDATE workspaces SET status='rejected' WHERE id=?").run(ws.id);
  saudit(req, ws.id, 'reject', `${ws.name} request rejected`);
  flash(req, 'ok', `"${ws.name}" request rejected.`);
  res.redirect('/super/clients');
});

r.post('/super/clients/:id/suspend', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws } = c;
  d.prepare("UPDATE workspaces SET status='suspended' WHERE id=?").run(ws.id);
  saudit(req, ws.id, 'suspend', `${ws.name} suspended — logins blocked, data safe`);
  flash(req, 'ok', `⛔ "${ws.name}" suspended. Its users can no longer log in.`);
  res.redirect('/super/clients/' + ws.id);
});

r.post('/super/clients/:id/activate', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws } = c;
  d.prepare("UPDATE workspaces SET status='active' WHERE id=?").run(ws.id);
  saudit(req, ws.id, 'activate', `${ws.name} reactivated`);
  flash(req, 'ok', `✅ "${ws.name}" is active again.`);
  res.redirect('/super/clients/' + ws.id);
});

r.post('/super/clients/:id/plan', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws } = c;
  const plan = d.prepare('SELECT * FROM plans WHERE id=?').get(Number(req.body.plan_id));
  if (!plan) { flash(req, 'err', 'Plan not found.'); return res.redirect('/super/clients/' + ws.id); }
  assignPlan(d, ws.id, plan.id, 'super', 'Plan assigned by Super Admin', false);
  if (ws.status === 'pending') d.prepare("UPDATE workspaces SET status='active' WHERE id=?").run(ws.id);
  saudit(req, ws.id, 'plan', `${ws.name} assigned the ${plan.name} plan`);
  flash(req, 'ok', `💳 ${plan.name} plan applied to "${ws.name}".`);
  res.redirect('/super/clients/' + ws.id);
});

r.post('/super/clients/:id/renew', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws } = c;
  const plan = d.prepare('SELECT * FROM plans WHERE id=?').get(Number(req.body.plan_id));
  if (!plan) { flash(req, 'err', 'Plan not found.'); return res.redirect('/super/clients/' + ws.id); }
  const sub = assignPlan(d, ws.id, plan.id, 'super', 'Renewed — Super Admin', true);
  saudit(req, ws.id, 'renew', `${ws.name} renewed on ${plan.name}, new expiry ${sub.expires_at ? fmtD(sub.expires_at) : 'never'}`);
  flash(req, 'ok', `🔄 "${ws.name}" renewed — ${plan.name}${sub.expires_at ? ', expiry ' + fmtD(sub.expires_at) : ' (never expires)'}.`);
  res.redirect('/super/clients/' + ws.id);
});

r.post('/super/clients/:id/extend', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws, x } = c;
  const days = Math.min(3650, Math.max(1, parseInt(req.body.days, 10) || 0));
  const cur = x.sub;
  if (!cur) { flash(req, 'err', 'Assign a plan first, then add days.'); return res.redirect('/super/clients/' + ws.id); }
  if (!cur.expires_at) { flash(req, 'err', 'This plan has no expiry (unlimited) — there is no need to add days.'); return res.redirect('/super/clients/' + ws.id); }
  const base = new Date(cur.expires_at).getTime() > Date.now() ? new Date(cur.expires_at) : new Date();
  const expires = new Date(base.getTime() + days * 86400000).toISOString();
  d.prepare('INSERT INTO subscriptions (workspace_id, plan_id, starts_at, expires_at, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(ws.id, cur.plan_id, base.toISOString(), expires, `+${days} days extended — Super Admin`, 'super', nowISO());
  saudit(req, ws.id, 'extend', `${ws.name} extended by +${days} days, new expiry ${fmtD(expires)}`);
  flash(req, 'ok', `⏩ "${ws.name}" extended by ${days} days — new expiry ${fmtD(expires)}.`);
  res.redirect('/super/clients/' + ws.id);
});

r.post('/super/clients/:id/reset-admin', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws } = c;
  const admin = d.prepare("SELECT * FROM users WHERE workspace_id=? AND role='admin' ORDER BY id LIMIT 1").get(ws.id);
  if (!admin) { flash(req, 'err', 'No admin user found for this company.'); return res.redirect('/super/clients/' + ws.id); }
  const temp = 'Tmp@' + crypto.randomBytes(4).toString('hex');
  d.prepare('UPDATE users SET password_hash=?, active=1 WHERE id=?').run(bcrypt.hashSync(temp, 10), admin.id);
  saudit(req, ws.id, 'reset-admin', `${ws.name} admin (${admin.email}) password reset`);
  flash(req, 'ok', `🔑 ${admin.email} temporary password: ${temp} — note it down, it is shown only once. Ask the admin to log in and change it.`);
  res.redirect('/super/clients/' + ws.id);
});

r.post('/super/clients/:id/delete', requireSuper, (req, res) => {
  const c = getClient(req, res); if (!c) return;
  const { d, ws } = c;
  if (String(req.body.confirm_name || '').trim() !== ws.name) {
    flash(req, 'err', 'Not deleted — type the company name exactly as shown above.');
    return res.redirect('/super/clients/' + ws.id);
  }
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM lead_custom_values WHERE lead_id IN (SELECT id FROM leads WHERE workspace_id=?)').run(ws.id);
    d.prepare('DELETE FROM lead_tags WHERE lead_id IN (SELECT id FROM leads WHERE workspace_id=?)').run(ws.id);
    d.prepare('DELETE FROM whatsapp_logs WHERE lead_id IN (SELECT id FROM leads WHERE workspace_id=?)').run(ws.id);
    d.prepare('DELETE FROM timeline_events WHERE lead_id IN (SELECT id FROM leads WHERE workspace_id=?)').run(ws.id);
    d.prepare('DELETE FROM follow_ups WHERE lead_id IN (SELECT id FROM leads WHERE workspace_id=?) OR user_id IN (SELECT id FROM users WHERE workspace_id=?)').run(ws.id, ws.id);
    d.prepare('DELETE FROM calls WHERE lead_id IN (SELECT id FROM leads WHERE workspace_id=?)').run(ws.id);
    d.prepare('DELETE FROM dialer_sessions WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM imports WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM leads WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM statuses WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM custom_fields WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM tags WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM whatsapp_templates WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM subscriptions WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM audit_log WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM users WHERE workspace_id=?').run(ws.id);
    d.prepare('DELETE FROM workspaces WHERE id=?').run(ws.id);
  });
  tx();
  audit(d, null, null, 'super:delete', `Workspace #${ws.id} "${ws.name}" fully deleted [by ${req.super.email}]`);
  flash(req, 'ok', `🗑️ "${ws.name}" has been permanently deleted.`);
  res.redirect('/super/clients');
});

// ---------- plans CRUD ----------
function planFormValues(b) {
  const numOrNull = (v, min) => {
    const s = String(v ?? '').trim();
    if (s === '') return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? Math.max(min, n) : null;
  };
  return {
    name: String(b.name || '').trim(),
    price: Math.max(0, parseInt(b.price, 10) || 0),
    validity_days: numOrNull(b.validity_days, 1),
    max_employees: numOrNull(b.max_employees, 1),
    max_leads: numOrNull(b.max_leads, 1),
    is_active: b.is_active ? 1 : 0,
    sort: parseInt(b.sort, 10) || 0,
  };
}

r.get('/super/plans', requireSuper, (req, res) => {
  const d = getDb();
  const plans = d.prepare('SELECT p.*, (SELECT COUNT(DISTINCT s.workspace_id) FROM subscriptions s WHERE s.plan_id=p.id AND s.id=(SELECT MAX(s2.id) FROM subscriptions s2 WHERE s2.workspace_id=s.workspace_id)) AS in_use FROM plans p ORDER BY p.sort, p.id').all();
  const fld = (p, k) => (p && p[k] !== null && p[k] !== undefined ? p[k] : '');
  const planCard = (p) => `<div class="card"><form method="post" action="/super/plans/${p.id}">
    <div class="rowflex"><input name="name" value="${esc(p.name)}" required style="flex:1;min-width:130px;font-weight:700">
    <span class="small mut">currently active on ${p.in_use} compan${p.in_use === 1 ? 'y' : 'ies'}</span></div>
    <div class="grid2">
      <div><label>Price (₹)</label><input type="number" name="price" min="0" value="${p.price}"></div>
      <div><label>Validity in Days (blank = never expires)</label><input type="number" name="validity_days" min="1" value="${fld(p, 'validity_days')}"></div>
      <div><label>Max Team/Users (blank = unlimited)</label><input type="number" name="max_employees" min="1" value="${fld(p, 'max_employees')}"></div>
      <div><label>Max Leads (blank = unlimited)</label><input type="number" name="max_leads" min="1" value="${fld(p, 'max_leads')}"></div>
      <div><label>Order (sort)</label><input type="number" name="sort" value="${p.sort}"></div>
      <div><label style="margin-top:22px"><input type="checkbox" name="is_active" ${p.is_active ? 'checked' : ''}> Plan Active (off = cannot be newly assigned)</label></div>
    </div>
    <p><button class="btn sm" type="submit">Save</button></p></form></div>`;
  const body = `<h1>💳 Plans ${info('Plans decide price, validity and limits for every company. Leave Validity blank for a plan that never expires, and leave a limit blank for unlimited. The current prices are placeholders — set your real pricing here. A plan is never hard-deleted, because old subscriptions stay linked to it; uncheck "Plan Active" to retire a plan instead. Changing a plan\'s limits or validity also applies to companies currently on it.')}</h1>
  <p class="mut">The prices and limits on these plans are placeholders — adjust them to your pricing. A blank limit means unlimited, and a blank validity means the plan never expires. Plans are never hard-deleted (old subscriptions stay linked) — uncheck "Plan Active" to retire one.</p>
  ${plans.map(planCard).join('')}
  <div class="card"><h3 style="margin-top:0">➕ New Plan</h3>
  <form method="post" action="/super/plans">
    <div class="rowflex"><input name="name" required placeholder="Plan name (e.g. Starter)" style="flex:1;min-width:130px"></div>
    <div class="grid2">
      <div><label>Price (₹)</label><input type="number" name="price" min="0" value="0"></div>
      <div><label>Validity in Days (blank = never expires)</label><input type="number" name="validity_days" min="1" placeholder="30"></div>
      <div><label>Max Team/Users (blank = unlimited)</label><input type="number" name="max_employees" min="1" placeholder="10"></div>
      <div><label>Max Leads (blank = unlimited)</label><input type="number" name="max_leads" min="1" placeholder="2000"></div>
      <div><label>Order (sort)</label><input type="number" name="sort" value="10"></div>
      <div><label style="margin-top:22px"><input type="checkbox" name="is_active" checked> Plan Active</label></div>
    </div>
    <p><button class="btn" type="submit">Create Plan</button></p></form></div>`;
  res.send(superPage(req, { title: 'Plans', body, active: 'plans' }));
});

r.post('/super/plans', requireSuper, (req, res) => {
  const d = getDb();
  const v = planFormValues(req.body);
  if (!v.name) { flash(req, 'err', 'A plan name is required.'); return res.redirect('/super/plans'); }
  if (d.prepare('SELECT id FROM plans WHERE name=?').get(v.name)) { flash(req, 'err', 'A plan with this name already exists.'); return res.redirect('/super/plans'); }
  d.prepare('INSERT INTO plans (name, price, validity_days, max_employees, max_leads, is_active, sort, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(v.name, v.price, v.validity_days, v.max_employees, v.max_leads, v.is_active, v.sort, nowISO());
  saudit(req, null, 'plan-create', `Plan "${v.name}" created (₹${v.price})`);
  flash(req, 'ok', `💳 Plan "${v.name}" created.`);
  res.redirect('/super/plans');
});

r.post('/super/plans/:id', requireSuper, (req, res) => {
  const d = getDb();
  const plan = d.prepare('SELECT * FROM plans WHERE id=?').get(req.params.id);
  if (!plan) { flash(req, 'err', 'Plan not found.'); return res.redirect('/super/plans'); }
  const v = planFormValues(req.body);
  if (!v.name) { flash(req, 'err', 'A plan name is required.'); return res.redirect('/super/plans'); }
  const clash = d.prepare('SELECT id FROM plans WHERE name=? AND id<>?').get(v.name, plan.id);
  if (clash) { flash(req, 'err', 'Another plan with this name already exists.'); return res.redirect('/super/plans'); }
  d.prepare('UPDATE plans SET name=?, price=?, validity_days=?, max_employees=?, max_leads=?, is_active=?, sort=? WHERE id=?')
    .run(v.name, v.price, v.validity_days, v.max_employees, v.max_leads, v.is_active, v.sort, plan.id);
  saudit(req, null, 'plan-update', `Plan "${v.name}" (#${plan.id}) updated`);
  flash(req, 'ok', `💳 Plan "${v.name}" saved. (Note: limit/validity changes also apply to companies currently on this plan.)`);
  res.redirect('/super/plans');
});

// ---------- super admin: change own password ----------
r.get('/super/password', requireSuper, (req, res) => {
  const body = `<h1>🔑 Change My Password</h1>
  <div class="card"><form method="post" action="/super/password">
    <label>Current Password</label><input type="password" name="current" required autocomplete="current-password">
    <label>New Password (at least 6 characters)</label><input type="password" name="next" required autocomplete="new-password">
    <label>Confirm New Password</label><input type="password" name="confirm" required autocomplete="new-password">
    <p style="margin-top:14px"><button class="btn" type="submit">Change Password</button></p></form>
  <p class="small mut">Change the default password (Owner@123) right away, so this panel stays accessible only to you.</p></div>`;
  res.send(superPage(req, { title: 'Password', body, active: 'pwd' }));
});

r.post('/super/password', requireSuper, (req, res) => {
  const d = getDb();
  const sa = req.super;
  const next = String(req.body.next || '');
  if (!bcrypt.compareSync(String(req.body.current || ''), sa.password_hash)) {
    flash(req, 'err', 'Current password is incorrect.');
  } else if (next.length < 6) {
    flash(req, 'err', 'The new password must be at least 6 characters.');
  } else if (next !== String(req.body.confirm || '')) {
    flash(req, 'err', 'The new password and its confirmation do not match.');
  } else {
    d.prepare('UPDATE super_admins SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), sa.id);
    audit(d, null, null, 'super:password', sa.email + ' changed their password');
    flash(req, 'ok', '✅ Password changed.');
  }
  res.redirect('/super/password');
});

module.exports = r;

'use strict';
const express = require('express');
const { getDb } = require('../db');
const { esc, istDate, istDayRange, fmtDT, timeAgo } = require('../lib/util');
const { page, statusChip } = require('../lib/layout');
const { requireAuth, requireRole } = require('../lib/auth');

const r = express.Router();
const mgr = requireRole('admin', 'manager');

// ---- Live team board ----
r.get('/team', requireAuth, mgr, (req, res) => {
  const d = getDb(); const u = req.user;
  const [t0, t1] = istDayRange(istDate());
  const emps = d.prepare("SELECT * FROM users WHERE workspace_id=? AND role='employee' AND active=1 ORDER BY name").all(u.workspace_id);
  const rowFor = (e) => {
    const calls = d.prepare("SELECT COUNT(*) c FROM calls WHERE user_id=? AND state='completed' AND saved_at>=? AND saved_at<?").get(e.id, t0, t1).c;
    const conn = d.prepare(`SELECT COUNT(*) c FROM calls c JOIN statuses s ON s.id=c.status_id WHERE c.user_id=? AND c.state='completed' AND c.saved_at>=? AND c.saved_at<? AND s.counts_connected=1`).get(e.id, t0, t1).c;
    const open = d.prepare("SELECT COUNT(*) c FROM calls WHERE user_id=? AND state='started'").get(e.id).c;
    const fuDue = d.prepare('SELECT COUNT(*) c FROM follow_ups WHERE user_id=? AND done=0 AND due_at<?').get(e.id, t1).c;
    const last = d.prepare("SELECT MAX(saved_at) m FROM calls WHERE user_id=? AND state='completed'").get(e.id).m;
    return { e, calls, conn, open, fuDue, last };
  };
  const rows = emps.map(rowFor);
  const body = `<h1>📡 Live Team Board</h1>
  <p class="mut">Har 10 second me khud refresh hota hai. "Call par hai" ka matlab hai — employee ne call shuru ki hai, disposition abhi baaki hai (Phase 1 me browser asal call nahi dekh sakta).</p>
  <div class="card"><div class="tblwrap"><table><tr><th>Employee</th><th>Haal</th><th>Aaj Calls</th><th>Connected</th><th>Follow-up Due</th><th>Last Activity</th></tr>
  ${rows.map((x) => `<tr><td><b>${esc(x.e.name)}</b></td>
    <td>${x.open ? '<span class="chip" style="background:#f59e0b">📞 Call par hai</span>' : '<span class="chip" style="background:#94a3b8">Idle</span>'}</td>
    <td>${x.calls}</td><td>${x.conn}</td><td>${x.fuDue}</td><td>${timeAgo(x.last || x.e.last_active_at)}</td></tr>`).join('')}
  </table></div></div>
  <script>setTimeout(function(){location.reload()},30000)</script>`;
  res.send(page(req, { title: 'Live Team', body, active: 'team' }));
});

// ---- Reports ----
r.get('/reports', requireAuth, mgr, (req, res) => {
  const d = getDb(); const u = req.user;
  const today = istDate();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
  const [f0] = istDayRange(from); const [, t1] = istDayRange(to);
  const emps = d.prepare("SELECT * FROM users WHERE workspace_id=? AND role IN ('employee','manager','admin') ORDER BY role, name").all(u.workspace_id);
  const per = emps.map((e) => {
    const att = d.prepare("SELECT COUNT(*) c FROM calls WHERE user_id=? AND state='completed' AND saved_at>=? AND saved_at<?").get(e.id, f0, t1).c;
    const conn = d.prepare(`SELECT COUNT(*) c FROM calls c JOIN statuses s ON s.id=c.status_id WHERE c.user_id=? AND c.state='completed' AND c.saved_at>=? AND c.saved_at<? AND s.counts_connected=1`).get(e.id, f0, t1).c;
    const fus = d.prepare('SELECT COUNT(*) c FROM calls WHERE user_id=? AND state=\'completed\' AND saved_at>=? AND saved_at<? AND follow_up_at IS NOT NULL').get(e.id, f0, t1).c;
    const dur = d.prepare("SELECT COALESCE(SUM(duration_sec),0) s FROM calls WHERE user_id=? AND state='completed' AND saved_at>=? AND saved_at<?").get(e.id, f0, t1).s;
    return { e, att, conn, fus, dur, rate: att ? Math.round((conn / att) * 100) : 0 };
  }).filter((x) => x.att > 0 || x.e.role === 'employee');
  const perStatus = d.prepare(`SELECT s.name, s.color, COUNT(c.id) c FROM calls c JOIN leads l ON l.id=c.lead_id LEFT JOIN statuses s ON s.id=c.status_id
    WHERE l.workspace_id=? AND c.state='completed' AND c.saved_at>=? AND c.saved_at<? GROUP BY s.id ORDER BY c DESC`).all(u.workspace_id, f0, t1);
  const body = `<h1>📊 Reports</h1>
  <form method="get" class="card rowflex"><label style="margin:0">From</label><input type="date" name="from" value="${from}" style="max-width:180px">
  <label style="margin:0">To</label><input type="date" name="to" value="${to}" style="max-width:180px"><button class="btn sm" type="submit">Report Dekhein</button></form>
  <div class="card"><h3 style="margin-top:0">Employee Performance (${esc(from)} → ${esc(to)})</h3>
  <div class="tblwrap"><table><tr><th>Employee</th><th>Calls</th><th>Connected</th><th>Connect %</th><th>Follow-ups Set</th><th>Talk Time (min)</th><th>Recording</th></tr>
  ${per.map((x) => `<tr><td><b>${esc(x.e.name)}</b></td><td>${x.att}</td><td>${x.conn}</td><td>${x.rate}%</td><td>${x.fus}</td><td>${Math.round(x.dur / 60)}</td><td class="mut">Phase 2</td></tr>`).join('') || '<tr><td colspan="7" class="mut">Is period me koi call nahi hui.</td></tr>'}
  </table></div></div>
  <div class="card"><h3 style="margin-top:0">Status ke Hisab se Calls</h3>
  ${perStatus.length ? perStatus.map((s) => `<p style="margin:5px 0"><span class="chip" style="background:${esc(s.color || '#94a3b8')}">${esc(s.name || 'No Status')}</span> — <b>${s.c}</b> calls</p>`).join('') : '<p class="mut">Koi data nahi.</p>'}</div>`;
  res.send(page(req, { title: 'Reports', body, active: 'reports' }));
});

// ---- Lost / cold leads ----
r.get('/lost', requireAuth, mgr, (req, res) => {
  const d = getDb(); const u = req.user;
  const ws = d.prepare('SELECT lost_lead_days FROM workspaces WHERE id=?').get(u.workspace_id);
  const days = ws ? ws.lost_lead_days : 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = d.prepare(`SELECT l.*, s.name AS status_name, s.color AS status_color, au.name AS assignee
    FROM leads l LEFT JOIN statuses s ON s.id=l.status_id LEFT JOIN users au ON au.id=l.assigned_to
    WHERE l.workspace_id=? AND (s.name='Lost' OR (l.last_activity_at<? AND (s.name IS NULL OR s.name<>'Converted')))
    ORDER BY l.last_activity_at ASC LIMIT 200`).all(u.workspace_id, cutoff);
  const body = `<h1>🧊 Lost / Thande Leads (${rows.length})</h1>
  <p class="mut">Ye leads ya to "Lost" mark hain, ya pichle <b>${days} din</b> se in par koi activity nahi hui (Settings se din badal sakte hain). Inhe dobara try karna aksar kaam karta hai.</p>
  <div class="card" style="padding:6px 14px">${rows.length ? rows.map((l) => `<div class="leadrow"><div class="info">
    <a class="nm" href="/leads/${l.id}">${esc(l.name)}</a>
    <div class="sub">📱 ${esc(l.mobile)} · ${esc(l.city || '')} · 👤 ${esc(l.assignee || 'Unassigned')} · last activity: ${fmtDT(l.last_activity_at)} (${timeAgo(l.last_activity_at)})</div></div>
    ${statusChip({ name: l.status_name, color: l.status_color })}</div>`).join('') : '<p class="mut" style="padding:12px 4px">Koi lost/thandi lead nahi hai. 🎉</p>'}</div>`;
  res.send(page(req, { title: 'Lost Leads', body, active: 'lost' }));
});

module.exports = r;

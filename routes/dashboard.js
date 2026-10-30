'use strict';
const express = require('express');
const { getDb } = require('../db');
const { esc, istDate, istDayRange, addDaysIST, fmtT, timeAgo } = require('../lib/util');
const { page, statusChip } = require('../lib/layout');
const { requireAuth } = require('../lib/auth');

const r = express.Router();

function feedRows(d, wsId, limit = 12) {
  return d.prepare(`SELECT c.*, u.name AS user_name, l.name AS lead_name, l.id AS lid, s.name AS status_name, s.color AS status_color
    FROM calls c JOIN users u ON u.id=c.user_id JOIN leads l ON l.id=c.lead_id LEFT JOIN statuses s ON s.id=c.status_id
    WHERE l.workspace_id=? AND c.state='completed' ORDER BY c.saved_at DESC LIMIT ?`).all(wsId, limit);
}

function feedHtml(rows) {
  if (!rows.length) return '<p class="mut">Abhi koi call activity nahi hai.</p>';
  return rows.map((c) => `<div class="leadrow"><div class="info"><div class="nm" style="font-size:15px">${esc(c.user_name)} → <a href="/leads/${c.lid}">${esc(c.lead_name)}</a></div>
    <div class="sub">${c.status_name ? `<span class="chip" style="background:${esc(c.status_color)}">${esc(c.status_name)}</span>` : ''} ${esc(c.remark || '')} · ${timeAgo(c.saved_at)}</div></div></div>`).join('');
}

r.get('/', requireAuth, (req, res) => {
  const d = getDb();
  const u = req.user;
  const today = istDate();
  const [t0, t1] = istDayRange(today);
  const dow = (new Date(today + 'T12:00:00+05:30').getUTCDay() + 6) % 7; // 0=Mon
  const monday = addDaysIST(today, -dow);
  const [w0] = istDayRange(monday);

  let body = `<h1>Namaste, ${esc(u.name.split(' ')[0])} ji 🙏</h1>`;

  if (u.role === 'employee') {
    const myLeads = d.prepare('SELECT COUNT(*) c FROM leads WHERE assigned_to=?').get(u.id).c;
    const callsToday = d.prepare("SELECT COUNT(*) c FROM calls WHERE user_id=? AND state='completed' AND saved_at>=? AND saved_at<?").get(u.id, t0, t1).c;
    const connToday = d.prepare(`SELECT COUNT(*) c FROM calls c JOIN statuses s ON s.id=c.status_id WHERE c.user_id=? AND c.state='completed' AND c.saved_at>=? AND c.saved_at<? AND s.counts_connected=1`).get(u.id, t0, t1).c;
    const fuDue = d.prepare('SELECT COUNT(*) c FROM follow_ups WHERE user_id=? AND done=0 AND due_at<?').get(u.id, t1).c;
    const fuOver = d.prepare('SELECT COUNT(*) c FROM follow_ups WHERE user_id=? AND done=0 AND due_at<?').get(u.id, t0).c;
    const pending = d.prepare("SELECT COUNT(*) c FROM calls WHERE user_id=? AND state='started'").get(u.id).c;
    const weekCalls = d.prepare("SELECT COUNT(*) c FROM calls WHERE user_id=? AND state='completed' AND saved_at>=?").get(u.id, w0).c;
    const weekConv = d.prepare(`SELECT COUNT(*) c FROM calls c JOIN leads l ON l.id=c.lead_id JOIN statuses s ON s.id=l.status_id WHERE c.user_id=? AND c.state='completed' AND c.saved_at>=? AND s.name='Converted'`).get(u.id, w0).c;
    body += `<div class="stats">
      <div class="stat"><div class="n">${myLeads}</div><div class="l">Meri Leads</div></div>
      <div class="stat green"><div class="n">${callsToday}</div><div class="l">Aaj ki Calls (${connToday} connected)</div></div>
      <div class="stat amber"><div class="n">${fuDue}</div><div class="l">Follow-up Due (aaj tak)</div></div>
      <div class="stat ${pending ? 'red' : ''}"><div class="n">${pending}</div><div class="l">Disposition Baaki</div></div>
    </div>
    ${fuOver ? `<div class="flash err">⚠️ ${fuOver} follow-up overdue hain — pehle unhe niptayein. <a href="/followups?tab=overdue">Dekhein →</a></div>` : ''}
    ${pending ? `<div class="flash err">📝 ${pending} call ka status/remark bharna baaki hai. <a href="/pending">Abhi bharein →</a></div>` : ''}
    <div class="card"><h3 style="margin-top:0">Is hafte meri performance</h3>
    <p style="margin:6px 0">📞 Calls: <b>${weekCalls}</b> &nbsp;·&nbsp; 🎉 Converted calls: <b>${weekConv}</b></p>
    <div class="rowflex"><a class="btn" href="/dialer">📞 Calling Shuru Karein</a><a class="btn ghost" href="/followups">⏰ Follow-ups (${fuDue})</a><a class="btn ghost" href="/leads?assigned=me">👥 Meri Leads</a></div></div>
    <div class="card"><h3 style="margin-top:0">Meri recent activity</h3><div data-live-feed>${feedHtml(feedRows(d, u.workspace_id).filter((x) => x.user_id === u.id))}</div></div>`;
  } else {
    const totalLeads = d.prepare('SELECT COUNT(*) c FROM leads WHERE workspace_id=?').get(u.workspace_id).c;
    const unassigned = d.prepare('SELECT COUNT(*) c FROM leads WHERE workspace_id=? AND assigned_to IS NULL').get(u.workspace_id).c;
    const callsToday = d.prepare(`SELECT COUNT(*) c FROM calls c JOIN leads l ON l.id=c.lead_id WHERE l.workspace_id=? AND c.state='completed' AND c.saved_at>=? AND c.saved_at<?`).get(u.workspace_id, t0, t1).c;
    const connToday = d.prepare(`SELECT COUNT(*) c FROM calls c JOIN leads l ON l.id=c.lead_id JOIN statuses s ON s.id=c.status_id WHERE l.workspace_id=? AND c.state='completed' AND c.saved_at>=? AND c.saved_at<? AND s.counts_connected=1`).get(u.workspace_id, t0, t1).c;
    const fuOver = d.prepare(`SELECT COUNT(*) c FROM follow_ups f JOIN leads l ON l.id=f.lead_id WHERE l.workspace_id=? AND f.done=0 AND f.due_at<?`).get(u.workspace_id, t0).c;
    const funnel = d.prepare(`SELECT s.name, s.color, COUNT(l.id) c FROM statuses s LEFT JOIN leads l ON l.status_id=s.id AND l.workspace_id=? WHERE s.workspace_id=? GROUP BY s.id ORDER BY s.sort`).all(u.workspace_id, u.workspace_id);
    const team = d.prepare(`SELECT u2.id, u2.name,
      (SELECT COUNT(*) FROM calls c WHERE c.user_id=u2.id AND c.state='completed' AND c.saved_at>=? AND c.saved_at<?) AS calls_today,
      (SELECT COUNT(*) FROM leads l WHERE l.assigned_to=u2.id) AS leads_n
      FROM users u2 WHERE u2.workspace_id=? AND u2.role='employee' AND u2.active=1 ORDER BY calls_today DESC`).all(t0, t1, u.workspace_id);
    body += `<div class="stats">
      <div class="stat"><div class="n">${totalLeads}</div><div class="l">Total Leads (${unassigned} unassigned)</div></div>
      <div class="stat green"><div class="n">${callsToday}</div><div class="l">Aaj ki Calls</div></div>
      <div class="stat"><div class="n">${connToday}</div><div class="l">Connected Aaj</div></div>
      <div class="stat ${fuOver ? 'red' : ''}"><div class="n">${fuOver}</div><div class="l">Overdue Follow-ups</div></div>
    </div>
    <div class="card"><h3 style="margin-top:0">Lead Status Funnel</h3>
    <p>${funnel.map((f) => `<span class="chip" style="background:${esc(f.color)};margin:2px">${esc(f.name)}: ${f.c}</span>`).join(' ')}</p>
    <h3>Team — aaj ka score</h3><div class="tblwrap"><table><tr><th>Employee</th><th>Leads</th><th>Aaj Calls</th></tr>
    ${team.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${t.leads_n}</td><td>${t.calls_today}</td></tr>`).join('')}</table></div>
    <p><a href="/team">📡 Live Team Board →</a> · <a href="/reports">📊 Reports →</a></p></div>
    <div class="card"><h3 style="margin-top:0">Live Activity (auto-refresh)</h3><div data-live-feed>${feedHtml(feedRows(d, u.workspace_id))}</div></div>`;
  }
  body += `<script>setInterval(function(){fetch('/api/live').then(function(r){return r.json()}).then(function(j){document.querySelectorAll('[data-live-feed]').forEach(function(el){el.innerHTML=j.feedHtml})}).catch(function(){})},10000)</script>`;
  res.send(page(req, { title: 'Dashboard', body, active: 'home' }));
});

r.get('/more', requireAuth, (req, res) => {
  res.redirect('/');
});

module.exports = r;

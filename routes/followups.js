'use strict';
const express = require('express');
const { getDb, touchLead } = require('../db');
const { esc, nowISO, fmtDT, istDate, istDayRange, istToISO } = require('../lib/util');
const { page } = require('../lib/layout');
const { requireAuth } = require('../lib/auth');

const r = express.Router();

r.get('/followups', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const tab = ['today', 'overdue', 'upcoming'].includes(req.query.tab) ? req.query.tab : 'today';
  const today = istDate(); const [t0, t1] = istDayRange(today);
  const teamView = u.role !== 'employee' && req.query.scope === 'team';
  const conds = ['f.done=0'];
  const args = [];
  if (teamView) { conds.push('l.workspace_id=?'); args.push(u.workspace_id); }
  else { conds.push('f.user_id=?'); args.push(u.id); }
  if (tab === 'today') { conds.push('f.due_at>=? AND f.due_at<?'); args.push(t0, t1); }
  if (tab === 'overdue') { conds.push('f.due_at<?'); args.push(t0); }
  if (tab === 'upcoming') { conds.push('f.due_at>=?'); args.push(t1); }
  const rows = d.prepare(`SELECT f.*, l.name AS lead_name, l.mobile AS lead_mobile, un.name AS owner_name
    FROM follow_ups f JOIN leads l ON l.id=f.lead_id LEFT JOIN users un ON un.id=f.user_id
    WHERE ${conds.join(' AND ')} ORDER BY f.due_at ASC LIMIT 300`).all(...args);
  const counts = {
    today: d.prepare(`SELECT COUNT(*) c FROM follow_ups f JOIN leads l ON l.id=f.lead_id WHERE ${teamView ? 'l.workspace_id=?' : 'f.user_id=?'} AND f.done=0 AND f.due_at>=? AND f.due_at<?`).get(teamView ? u.workspace_id : u.id, t0, t1).c,
    overdue: d.prepare(`SELECT COUNT(*) c FROM follow_ups f JOIN leads l ON l.id=f.lead_id WHERE ${teamView ? 'l.workspace_id=?' : 'f.user_id=?'} AND f.done=0 AND f.due_at<?`).get(teamView ? u.workspace_id : u.id, t0).c,
    upcoming: d.prepare(`SELECT COUNT(*) c FROM follow_ups f JOIN leads l ON l.id=f.lead_id WHERE ${teamView ? 'l.workspace_id=?' : 'f.user_id=?'} AND f.done=0 AND f.due_at>=?`).get(teamView ? u.workspace_id : u.id, t1).c,
  };
  const body = `<h1>⏰ Follow-Ups</h1>
  <div class="rowflex" style="margin-bottom:12px">
    <a class="btn sm ${tab === 'today' ? '' : 'ghost'}" href="/followups?tab=today${teamView ? '&scope=team' : ''}">Aaj (${counts.today})</a>
    <a class="btn sm ${tab === 'overdue' ? 'red' : 'ghost'}" href="/followups?tab=overdue${teamView ? '&scope=team' : ''}">Overdue (${counts.overdue})</a>
    <a class="btn sm ${tab === 'upcoming' ? '' : 'ghost'}" href="/followups?tab=upcoming${teamView ? '&scope=team' : ''}">Upcoming (${counts.upcoming})</a>
    ${u.role !== 'employee' ? `<a class="btn sm ghost" href="/followups?tab=${tab}${teamView ? '' : '&scope=team'}">${teamView ? '👤 Sirf Mere' : '👥 Poori Team'}</a>` : ''}
  </div>
  <div class="card" style="padding:6px 14px">${rows.length ? rows.map((f) => `<div class="leadrow"><div class="info">
      <a class="nm" href="/leads/${f.lead_id}">${esc(f.lead_name)}</a>
      <div class="sub">📱 ${esc(f.lead_mobile)} · <span class="${tab === 'overdue' ? 'overdue' : tab === 'today' ? 'due-today' : ''}">⏰ ${fmtDT(f.due_at)}</span>${teamView ? ' · 👤 ' + esc(f.owner_name || '') : ''}${f.note ? '<br>' + esc(f.note) : ''}</div></div>
      <form method="post" action="/calls/start"><input type="hidden" name="lead_id" value="${f.lead_id}"><input type="hidden" name="return_to" value="/followups?tab=${tab}"><button class="callbtn" type="submit" title="Call">📞</button></form>
    </div>
    <div class="rowflex" style="padding:0 4px 11px">
      <form method="post" action="/followups/${f.id}/done"><button class="btn sm" type="submit">✅ Done</button></form>
      <form method="post" action="/followups/${f.id}/reschedule" class="rowflex"><input type="date" name="date" required style="min-height:38px;max-width:170px"><button class="btn sm ghost" type="submit">📅 Aage Badhayein</button></form>
    </div>`).join('') : '<p class="mut" style="padding:12px 4px">Is tab me koi follow-up nahi hai. 🎉</p>'}</div>`;
  res.send(page(req, { title: 'Follow-Ups', body, active: 'followups' }));
});

function ownFollowUp(d, u, id) {
  const f = d.prepare('SELECT f.*, l.workspace_id FROM follow_ups f JOIN leads l ON l.id=f.lead_id WHERE f.id=?').get(id);
  if (!f) return null;
  if (u.role === 'employee' && f.user_id !== u.id) return null;
  if (f.workspace_id !== u.workspace_id) return null;
  return f;
}

r.post('/followups/:id/done', requireAuth, (req, res) => {
  const d = getDb(); const f = ownFollowUp(d, req.user, req.params.id);
  if (f) { d.prepare('UPDATE follow_ups SET done=1, done_at=? WHERE id=?').run(nowISO(), f.id); touchLead(d, f.lead_id); }
  res.redirect(req.get('referer') || '/followups');
});

r.post('/followups/:id/reschedule', requireAuth, (req, res) => {
  const d = getDb(); const f = ownFollowUp(d, req.user, req.params.id);
  if (f && req.body.date) d.prepare('UPDATE follow_ups SET due_at=? WHERE id=?').run(istToISO(req.body.date, '10:00'), f.id);
  res.redirect(req.get('referer') || '/followups');
});

module.exports = r;

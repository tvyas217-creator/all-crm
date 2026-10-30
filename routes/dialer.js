'use strict';
const express = require('express');
const { getDb } = require('../db');
const { esc, nowISO, fmtDT } = require('../lib/util');
const { page, statusChip } = require('../lib/layout');
const { requireAuth } = require('../lib/auth');

const r = express.Router();

function activeSession(d, userId) {
  return d.prepare("SELECT * FROM dialer_sessions WHERE user_id=? AND state='active' ORDER BY id DESC").get(userId);
}

r.get('/dialer', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const s = activeSession(d, u.id);
  const sts = d.prepare('SELECT * FROM statuses WHERE workspace_id=? ORDER BY sort').all(u.workspace_id);
  const body = `<h1>📞 Auto Dialer</h1>
  ${s ? `<div class="card"><h3 style="margin-top:0">▶️ Ek session pehle se chal raha hai</h3>
    <p class="mut">Queue me ${JSON.parse(s.queue).length} leads baaki, redial queue: ${JSON.parse(s.redial).length}</p>
    <div class="rowflex"><a class="btn" href="/dialer/session">Session Jaari Rakhein →</a>
    <form method="post" action="/dialer/end"><button class="btn red" type="submit">⏹ Session Khatam Karein</button></form></div></div>` : ''}
  <div class="card"><h3 style="margin-top:0">Naya Calling Session</h3>
    <p class="mut">Filter chunein — session me ek-ek karke leads aayengi. Call button dabate hi phone ka dialer khulega (SIM se call), wapas aakar status bharte hi agli lead apne aap aa jayegi. Not Picked / Busy / Switched Off wali leads redial queue me jakar session ke aakhir me dobara aayengi.</p>
    <form method="post" action="/dialer/start">
      <label>Status Filter</label>
      <select name="status_id"><option value="">Saare status</option>${sts.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
      <label>Source Filter (optional)</label>
      <input name="source" placeholder="jaise IndiaMART">
      ${u.role !== 'employee' ? `<label>Kis ki leads?</label><select name="scope"><option value="mine">Sirf meri</option><option value="all">Poora workspace</option><option value="unassigned">Sirf unassigned</option></select>` : ''}
      <p style="margin-top:14px"><button class="btn block" type="submit" style="font-size:18px">▶️ Calling Session Shuru Karein</button></p>
    </form></div>`;
  res.send(page(req, { title: 'Auto Dialer', body, active: 'dialer' }));
});

r.post('/dialer/start', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const old = activeSession(d, u.id);
  if (old) d.prepare("UPDATE dialer_sessions SET state='ended', ended_at=? WHERE id=?").run(nowISO(), old.id);
  const conds = ['workspace_id=?']; const args = [u.workspace_id];
  if (u.role === 'employee' || req.body.scope === 'mine') { conds.push('assigned_to=?'); args.push(u.id); }
  else if (req.body.scope === 'unassigned') conds.push('assigned_to IS NULL');
  if (req.body.status_id) { conds.push('status_id=?'); args.push(Number(req.body.status_id)); }
  if (req.body.source) { conds.push('source=?'); args.push(String(req.body.source).trim()); }
  const ids = d.prepare(`SELECT id FROM leads WHERE ${conds.join(' AND ')} ORDER BY last_activity_at ASC, id ASC LIMIT 500`).all(...args).map((x) => x.id);
  if (!ids.length) { req.session.flash = { type: 'err', msg: 'Is filter me koi lead nahi mili.' }; return res.redirect('/dialer'); }
  d.prepare(`INSERT INTO dialer_sessions (user_id, workspace_id, filters, queue, redial, attempts, stats, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(u.id, u.workspace_id, JSON.stringify({ status_id: req.body.status_id || '', source: req.body.source || '' }),
      JSON.stringify(ids), '[]', '{}', JSON.stringify({ attempted: 0, connected: 0, followups: 0, skipped: 0 }), nowISO());
  res.redirect('/dialer/session');
});

function summaryHtml(s) {
  const st = JSON.parse(s.stats || '{}');
  return `<div class="card bigcall"><h2 style="margin-top:0">🎉 Session Poora Hua</h2>
  <div class="stats" style="text-align:left">
    <div class="stat"><div class="n">${st.attempted || 0}</div><div class="l">Calls Attempted</div></div>
    <div class="stat green"><div class="n">${st.connected || 0}</div><div class="l">Connected</div></div>
    <div class="stat amber"><div class="n">${st.followups || 0}</div><div class="l">Follow-ups Set</div></div>
    <div class="stat"><div class="n">${st.skipped || 0}</div><div class="l">Skipped</div></div>
  </div>
  <form method="post" action="/dialer/end"><button class="btn block" type="submit">⏹ Session Band Karein</button></form>
  <p><a href="/dialer">Naya session shuru karein →</a></p></div>`;
}

r.get('/dialer/session', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const s = activeSession(d, u.id);
  if (!s) { req.session.flash = { type: 'err', msg: 'Koi active session nahi hai.' }; return res.redirect('/dialer'); }
  let queue = JSON.parse(s.queue); const redial = JSON.parse(s.redial);
  let lead = null;
  if (s.current_lead_id) lead = d.prepare('SELECT * FROM leads WHERE id=?').get(s.current_lead_id);
  if (!lead) {
    while (queue.length && !lead) {
      const id = queue.shift();
      lead = d.prepare('SELECT * FROM leads WHERE id=?').get(id);
    }
    if (!lead && redial.length) {
      queue = redial.slice();
      d.prepare("UPDATE dialer_sessions SET queue=?, redial='[]' WHERE id=?").run(JSON.stringify(queue), s.id);
      return res.redirect('/dialer/session');
    }
    d.prepare('UPDATE dialer_sessions SET queue=?, current_lead_id=? WHERE id=?').run(JSON.stringify(queue), lead ? lead.id : null, s.id);
  }
  if (!lead) return res.send(page(req, { title: 'Session Summary', body: summaryHtml(s), active: 'dialer' }));

  const st = lead.status_id ? d.prepare('SELECT * FROM statuses WHERE id=?').get(lead.status_id) : null;
  const lastCall = d.prepare("SELECT c.*, s2.name AS status_name FROM calls c LEFT JOIN statuses s2 ON s2.id=c.status_id WHERE c.lead_id=? AND c.state='completed' ORDER BY c.saved_at DESC LIMIT 1").get(lead.id);
  const fus = d.prepare('SELECT * FROM follow_ups WHERE lead_id=? ORDER BY due_at DESC LIMIT 3').all(lead.id);
  const remaining = queue.length + redial.length + 1;
  const body = `<p class="mut">📋 Session · <b>${remaining}</b> leads baaki (redial: ${redial.length})</p>
  <div class="card bigcall">
    <div>${statusChip(st)} <span class="prio-${lead.priority}">${lead.priority}</span></div>
    <h1 style="font-size:27px;margin:10px 0 2px">${esc(lead.name)}</h1>
    <div class="num">+91 ${esc(lead.mobile)}</div>
    <p class="mut">${esc(lead.city || '')} · ${esc(lead.source || '')} · <a href="/leads/${lead.id}" target="_blank">Poora record →</a></p>
    ${lastCall ? `<p style="text-align:left"><b>Pichli call:</b> ${esc(lastCall.status_name || '')} — ${esc(lastCall.remark || 'koi remark nahi')} <span class="mut">(${fmtDT(lastCall.saved_at)})</span></p>` : '<p class="mut">Ye is lead ki pehli call hogi.</p>'}
    ${fus.length ? `<p style="text-align:left"><b>Follow-up history:</b><br>${fus.map((f) => `⏰ ${fmtDT(f.due_at)} ${f.done ? '✅ done' : '⏳ baaki'}`).join('<br>')}</p>` : ''}
    <form method="post" action="/calls/start"><input type="hidden" name="lead_id" value="${lead.id}"><input type="hidden" name="via" value="session"><input type="hidden" name="return_to" value="/dialer/session">
      <button class="btn block" type="submit" style="font-size:20px;min-height:60px">📞 Call Now</button></form>
    <div class="rowflex" style="margin-top:10px">
      <form method="post" action="/dialer/skip" style="flex:1"><button class="btn ghost block" type="submit">⏭ Skip — Agli Lead</button></form>
      <form method="post" action="/dialer/end" style="flex:1"><button class="btn red block" type="submit">⏹ Session Khatam</button></form>
    </div>
  </div>`;
  res.send(page(req, { title: 'Dialer — ' + lead.name, body, active: 'dialer' }));
});

r.post('/dialer/skip', requireAuth, (req, res) => {
  const d = getDb(); const s = activeSession(d, req.user.id);
  if (s) {
    const stats = JSON.parse(s.stats || '{}'); stats.skipped = (stats.skipped || 0) + 1;
    d.prepare('UPDATE dialer_sessions SET current_lead_id=NULL, stats=? WHERE id=?').run(JSON.stringify(stats), s.id);
  }
  res.redirect('/dialer/session');
});

r.post('/dialer/end', requireAuth, (req, res) => {
  const d = getDb(); const s = activeSession(d, req.user.id);
  if (!s) return res.redirect('/dialer');
  d.prepare("UPDATE dialer_sessions SET state='ended', ended_at=? WHERE id=?").run(nowISO(), s.id);
  res.send(page(req, { title: 'Session Summary', body: summaryHtml(s), active: 'dialer' }));
});

module.exports = r;

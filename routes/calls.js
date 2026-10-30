'use strict';
const express = require('express');
const { getDb, touchLead, logEvent } = require('../db');
const { esc, nowISO, fmtDT, istDate, addDaysIST, istToISO } = require('../lib/util');
const { page } = require('../lib/layout');
const { requireAuth, canAccessLead } = require('../lib/auth');

const r = express.Router();

function getLead(d, id) { return d.prepare('SELECT * FROM leads WHERE id=?').get(id); }

// ---- Step 1+2: log the attempt, then open the phone dialer ----
r.post('/calls/start', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const lead = getLead(d, Number(req.body.lead_id));
  if (!canAccessLead(u, lead)) { req.session.flash = { type: 'err', msg: 'Lead nahi mili.' }; return res.redirect('/leads'); }
  const via = req.body.via === 'session' ? 'session' : 'web';
  let sessionId = null;
  if (via === 'session') {
    const s = d.prepare("SELECT id FROM dialer_sessions WHERE user_id=? AND state='active' ORDER BY id DESC").get(u.id);
    if (s) sessionId = s.id;
  }
  const callId = d.prepare(`INSERT INTO calls (lead_id, user_id, direction, state, started_at, created_via, session_id) VALUES (?,?, 'outgoing', 'started', ?, ?, ?)`)
    .run(lead.id, u.id, nowISO(), via, sessionId).lastInsertRowid;
  const ret = req.body.return_to || ('/leads/' + lead.id);
  const body = `<div class="card bigcall">
    <p class="mut" style="margin:0">📞 Call lag raha hai — <b>${esc(lead.name)}</b></p>
    <div class="num">+91 ${esc(lead.mobile)}</div>
    <p class="mut">Aapke phone ka normal dialer khulega — call aapki apni SIM se lagegi.<br>PC par hain to apne phone se ye number dial karein.</p>
    <p><a class="btn block" href="tel:+91${esc(lead.mobile)}" style="font-size:19px">📞 Dialer Kholein — Call Karein</a></p>
    <p><a class="btn blue block" href="/calls/${callId}/disposition?return_to=${encodeURIComponent(ret)}">✅ Call Ho Gayi — Status / Remark Bharein</a></p>
    <form method="post" action="/calls/${callId}/cancel"><input type="hidden" name="return_to" value="${esc(ret)}"><button class="btn ghost block" type="submit">❌ Call Cancel (galti se dab gaya)</button></form>
    <p class="small mut">Note: Call attempt CRM me save ho gaya hai — manager ko live dikh raha hai ki call shuru hui.</p>
  </div>
  <script>setTimeout(function(){try{window.location.href='tel:+91${esc(lead.mobile)}'}catch(e){}},600)</script>`;
  res.send(page(req, { title: 'Calling ' + lead.name, body, active: 'dialer' }));
});

// ---- Pending dispositions ----
r.get('/pending', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const rows = d.prepare(`SELECT c.*, l.name AS lead_name, l.mobile FROM calls c JOIN leads l ON l.id=c.lead_id
    WHERE c.user_id=? AND c.state='started' ORDER BY c.started_at DESC`).all(u.id);
  const body = `<h1>📝 Disposition Baaki (${rows.length})</h1>
  <p class="mut">In calls ka status / remark bharna baaki hai. Call ke turant baad bharna sabse sahi rehta hai.</p>
  <div class="card" style="padding:6px 14px">${rows.length ? rows.map((c) => `<div class="leadrow"><div class="info">
    <a class="nm" href="/calls/${c.id}/disposition">${esc(c.lead_name)}</a>
    <div class="sub">📱 ${esc(c.mobile)} · call shuru: ${fmtDT(c.started_at)}</div></div>
    <a class="btn sm" href="/calls/${c.id}/disposition">Bhadein →</a></div>`).join('') : '<p class="mut" style="padding:12px 4px">Koi disposition baaki nahi hai. Badhiya kaam! 🎉</p>'}</div>`;
  res.send(page(req, { title: 'Pending Dispositions', body, active: 'pending' }));
});

// ---- After-call sheet ----
r.get('/calls/:id/disposition', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const call = d.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id);
  if (!call || call.user_id !== u.id || call.state !== 'started') { req.session.flash = { type: 'err', msg: 'Ye call disposition ke liye nahi mili.' }; return res.redirect('/pending'); }
  const lead = getLead(d, call.lead_id);
  const sts = d.prepare('SELECT * FROM statuses WHERE workspace_id=? ORDER BY sort').all(u.workspace_id);
  const ret = req.query.return_to || ('/leads/' + lead.id);
  const body = `<h1>✅ Call Ho Gayi — ${esc(lead.name)}</h1>
  <p class="mut">📱 ${esc(lead.mobile)} · Sirf 2-3 tap me save karein.</p>
  <form method="post" action="/calls/${call.id}/complete" class="card">
    <input type="hidden" name="return_to" value="${esc(ret)}">
    <label>1️⃣ Call ka Status chunein *</label>
    <div class="statuschips">${sts.map((s, i) => `<label><input type="radio" name="status_id" value="${s.id}" ${i === 0 ? 'required' : ''}><span>${esc(s.name)}</span></label>`).join('')}</div>
    <label>2️⃣ Remark (kya baat hui)</label>
    <textarea name="remark" id="remark" placeholder="Apne shabdon me likhein..."></textarea>
    <div class="quickchips">${['Call back later', 'WhatsApp bhej diya', 'Price bataya, soch rahe hain', 'Busy the', 'Family se pooch kar batayenge', 'Gatekeeper se baat hui'].map((q) => `<button type="button" onclick="var t=document.getElementById('remark');t.value=(t.value?t.value+' ':'')+'${q}'">${q}</button>`).join('')}</div>
    <label>3️⃣ Agla Follow-up kab?</label>
    <div class="statuschips">
      <label><input type="radio" name="fu" value="none" checked><span>❌ Nahi chahiye</span></label>
      <label><input type="radio" name="fu" value="tomorrow"><span>Kal</span></label>
      <label><input type="radio" name="fu" value="2days"><span>2 Din Baad</span></label>
      <label><input type="radio" name="fu" value="week"><span>1 Hafte Baad</span></label>
      <label><input type="radio" name="fu" value="custom"><span>📅 Date Chunein</span></label>
    </div>
    <div class="grid2"><div><label>Custom Follow-up Date/Time</label><input type="datetime-local" name="fu_custom"></div>
    <div><label>Call Duration (seconds, optional)</label><input type="number" name="duration_sec" min="0" placeholder="jaise 120"></div></div>
    <p class="small mut">Note (Phase 1 sach): Browser phone ki call duration khud nahi padh sakta — isiliye duration haath se bharna optional hai. Phase 2 ke Android app se ye apne aap sync hoga.</p>
    <p style="margin-top:14px"><button class="btn block" type="submit" style="font-size:18px">💾 Save Karein</button></p>
  </form>`;
  res.send(page(req, { title: 'After-Call Sheet', body, active: 'pending' }));
});

// ---- Save disposition ----
r.post('/calls/:id/complete', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const call = d.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id);
  if (!call || call.user_id !== u.id || call.state !== 'started') return res.redirect('/pending');
  const lead = getLead(d, call.lead_id);
  const st = d.prepare('SELECT * FROM statuses WHERE id=? AND workspace_id=?').get(req.body.status_id, u.workspace_id);
  if (!st) { req.session.flash = { type: 'err', msg: 'Status chunein.' }; return res.redirect('/calls/' + call.id + '/disposition'); }

  let fuAt = null;
  const today = istDate();
  if (req.body.fu === 'tomorrow') fuAt = istToISO(addDaysIST(today, 1), '10:00');
  else if (req.body.fu === '2days') fuAt = istToISO(addDaysIST(today, 2), '10:00');
  else if (req.body.fu === 'week') fuAt = istToISO(addDaysIST(today, 7), '10:00');
  else if (req.body.fu === 'custom' && req.body.fu_custom) fuAt = new Date(req.body.fu_custom).toISOString();

  const dur = req.body.duration_sec ? Math.max(0, parseInt(req.body.duration_sec, 10) || 0) : null;
  d.prepare("UPDATE calls SET state='completed', status_id=?, remark=?, duration_sec=?, saved_at=?, follow_up_at=? WHERE id=?")
    .run(st.id, String(req.body.remark || '').trim() || null, dur, nowISO(), fuAt, call.id);
  if (fuAt) d.prepare('INSERT INTO follow_ups (lead_id, user_id, call_id, due_at, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(lead.id, u.id, call.id, fuAt, String(req.body.remark || '').trim() || null, nowISO());
  const oldSt = lead.status_id ? d.prepare('SELECT name FROM statuses WHERE id=?').get(lead.status_id) : null;
  if (lead.status_id !== st.id) {
    d.prepare('UPDATE leads SET status_id=? WHERE id=?').run(st.id, lead.id);
    logEvent(d, lead.id, u.id, 'status', `Status: ${oldSt ? oldSt.name : '—'} → ${st.name} (call ke baad)`);
  }
  touchLead(d, lead.id);

  // Dialer session bookkeeping
  if (call.session_id) {
    const s = d.prepare('SELECT * FROM dialer_sessions WHERE id=?').get(call.session_id);
    if (s && s.state === 'active') {
      const stats = JSON.parse(s.stats || '{}');
      const attempts = JSON.parse(s.attempts || '{}');
      stats.attempted = (stats.attempted || 0) + 1;
      if (st.counts_connected) stats.connected = (stats.connected || 0) + 1;
      if (fuAt) stats.followups = (stats.followups || 0) + 1;
      attempts[lead.id] = (attempts[lead.id] || 0) + 1;
      let redial = JSON.parse(s.redial || '[]');
      const ws = d.prepare('SELECT redial_attempts FROM workspaces WHERE id=?').get(u.workspace_id);
      if (['Not Picked', 'Busy', 'Switched Off'].includes(st.name) && attempts[lead.id] <= (ws ? ws.redial_attempts : 2)) {
        if (!redial.includes(lead.id)) redial.push(lead.id);
      }
      d.prepare('UPDATE dialer_sessions SET stats=?, attempts=?, redial=?, current_lead_id=NULL WHERE id=?')
        .run(JSON.stringify(stats), JSON.stringify(attempts), JSON.stringify(redial), s.id);
    }
  }
  req.session.flash = { type: 'ok', msg: 'Disposition save ho gaya ✅' };
  res.redirect(req.body.return_to || ('/leads/' + lead.id));
});

r.post('/calls/:id/cancel', requireAuth, (req, res) => {
  const d = getDb();
  const call = d.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id);
  if (call && call.user_id === req.user.id && call.state === 'started') {
    d.prepare("UPDATE calls SET state='cancelled' WHERE id=?").run(call.id);
    if (call.session_id) d.prepare('UPDATE dialer_sessions SET current_lead_id=NULL WHERE id=? AND current_lead_id=?').run(call.session_id, call.lead_id);
  }
  res.redirect(req.body.return_to || '/pending');
});

// ---- Manual call log (incoming/outgoing) ----
r.post('/calls/log', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const lead = getLead(d, Number(req.body.lead_id));
  if (!canAccessLead(u, lead)) return res.redirect('/leads');
  const st = d.prepare('SELECT * FROM statuses WHERE id=? AND workspace_id=?').get(req.body.status_id, u.workspace_id);
  let fuAt = null;
  if (req.body.follow_up_date) fuAt = istToISO(req.body.follow_up_date, '10:00');
  const cid = d.prepare(`INSERT INTO calls (lead_id, user_id, direction, state, status_id, remark, duration_sec, started_at, saved_at, follow_up_at, created_via)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'manual')`).run(lead.id, u.id, req.body.direction === 'incoming' ? 'incoming' : 'outgoing', 'completed',
    st ? st.id : null, String(req.body.remark || '').trim() || null, req.body.duration_sec ? parseInt(req.body.duration_sec, 10) || null : null,
    nowISO(), nowISO(), fuAt).lastInsertRowid;
  if (fuAt) d.prepare('INSERT INTO follow_ups (lead_id, user_id, call_id, due_at, created_at) VALUES (?,?,?,?,?)').run(lead.id, u.id, cid, fuAt, nowISO());
  if (st && lead.status_id !== st.id) {
    const oldSt = lead.status_id ? d.prepare('SELECT name FROM statuses WHERE id=?').get(lead.status_id) : null;
    d.prepare('UPDATE leads SET status_id=? WHERE id=?').run(st.id, lead.id);
    logEvent(d, lead.id, u.id, 'status', `Status: ${oldSt ? oldSt.name : '—'} → ${st.name} (manual log)`);
  }
  touchLead(d, lead.id);
  req.session.flash = { type: 'ok', msg: 'Call log save ho gaya ✅' };
  res.redirect('/leads/' + lead.id);
});

module.exports = r;

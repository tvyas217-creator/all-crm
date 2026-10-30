'use strict';
const express = require('express');
const { getDb, touchLead, logEvent, audit } = require('../db');
const { esc, nowISO, cleanMobile, validMobile, paginate, qs, fmtDT, fmtD, istDate, istDayRange } = require('../lib/util');
const { page, statusChip } = require('../lib/layout');
const { requireAuth, requireRole, canAccessLead } = require('../lib/auth');

const r = express.Router();
const mgr = requireRole('admin', 'manager');

function getLead(d, id) { return d.prepare('SELECT * FROM leads WHERE id=?').get(id); }
function statuses(d, wsId) { return d.prepare('SELECT * FROM statuses WHERE workspace_id=? ORDER BY sort').all(wsId); }
function employees(d, wsId) { return d.prepare("SELECT * FROM users WHERE workspace_id=? AND role='employee' AND active=1 ORDER BY name").all(wsId); }
function userName(d, id) { if (!id) return '—'; const u = d.prepare('SELECT name FROM users WHERE id=?').get(id); return u ? u.name : '—'; }
function customFields(d, wsId) { return d.prepare('SELECT * FROM custom_fields WHERE workspace_id=? ORDER BY sort, id').all(wsId); }

function buildFilter(req, u) {
  const q = (req.query.q || '').trim();
  const conds = ['l.workspace_id=?'];
  const args = [u.workspace_id];
  if (u.role === 'employee') { conds.push('l.assigned_to=?'); args.push(u.id); }
  if (q) { conds.push('(l.name LIKE ? OR l.mobile LIKE ?)'); args.push('%' + q + '%', '%' + q + '%'); }
  if (req.query.status_id) { conds.push('l.status_id=?'); args.push(req.query.status_id); }
  if (req.query.source) { conds.push('l.source=?'); args.push(req.query.source); }
  if (req.query.priority) { conds.push('l.priority=?'); args.push(req.query.priority); }
  if (req.query.tag_id) { conds.push('EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id=l.id AND lt.tag_id=?)'); args.push(req.query.tag_id); }
  if (u.role !== 'employee') {
    if (req.query.assigned === 'unassigned') conds.push('l.assigned_to IS NULL');
    else if (req.query.assigned && req.query.assigned !== 'all') { conds.push('l.assigned_to=?'); args.push(req.query.assigned); }
  }
  if (req.query.due) {
    const today = istDate(); const [t0, t1] = istDayRange(today);
    if (req.query.due === 'today') { conds.push('EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id=l.id AND f.done=0 AND f.due_at>=? AND f.due_at<?)'); args.push(t0, t1); }
    if (req.query.due === 'overdue') { conds.push('EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id=l.id AND f.done=0 AND f.due_at<?)'); args.push(t0); }
    if (req.query.due === 'upcoming') { conds.push('EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id=l.id AND f.done=0 AND f.due_at>=?)'); args.push(t1); }
  }
  return { where: conds.join(' AND '), args };
}

// ---------------- LIST ----------------
r.get('/leads', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const { where, args } = buildFilter(req, u);
  const total = d.prepare(`SELECT COUNT(*) c FROM leads l WHERE ${where}`).get(...args).c;
  const pg = paginate(req, total, 20);
  const rows = d.prepare(`SELECT l.*, s.name AS status_name, s.color AS status_color, au.name AS assignee_name
    FROM leads l LEFT JOIN statuses s ON s.id=l.status_id LEFT JOIN users au ON au.id=l.assigned_to
    WHERE ${where} ORDER BY l.last_activity_at DESC LIMIT ? OFFSET ?`).all(...args, pg.perPage, pg.offset);
  const sources = d.prepare('SELECT DISTINCT source FROM leads WHERE workspace_id=? AND source IS NOT NULL ORDER BY source').all(u.workspace_id).map((x) => x.source);
  const tags = d.prepare('SELECT * FROM tags WHERE workspace_id=? ORDER BY name').all(u.workspace_id);
  const canAssign = u.role !== 'employee';
  const rowTags = {};
  if (rows.length) {
    const ph = rows.map(() => '?').join(',');
    d.prepare(`SELECT lt.lead_id, t.name FROM lead_tags lt JOIN tags t ON t.id=lt.tag_id WHERE lt.lead_id IN (${ph})`).all(...rows.map((x) => x.id))
      .forEach((t) => { (rowTags[t.lead_id] = rowTags[t.lead_id] || []).push(t.name); });
  }
  const f = req.query;
  const body = `<h1>👥 Leads <span class="mut" style="font-size:15px">(${total})</span></h1>
  <form method="get" class="card" style="padding:13px">
    <div class="rowflex">
      <input style="flex:2;min-width:170px" type="search" name="q" value="${esc(f.q || '')}" placeholder="🔍 Naam ya number khojein">
      <select name="status_id" style="flex:1;min-width:130px"><option value="">Saare Status</option>${statuses(d, u.workspace_id).map((s) => `<option value="${s.id}" ${String(f.status_id) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <select name="source" style="flex:1;min-width:120px"><option value="">Saare Source</option>${sources.map((s) => `<option ${f.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      ${u.role !== 'employee' ? `<select name="assigned" style="flex:1;min-width:130px"><option value="all">Sab Employees</option><option value="unassigned" ${f.assigned === 'unassigned' ? 'selected' : ''}>Unassigned</option>${employees(d, u.workspace_id).map((e) => `<option value="${e.id}" ${String(f.assigned) === String(e.id) ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>` : ''}
      <select name="due" style="flex:1;min-width:120px"><option value="">Follow-up: Sab</option><option value="today" ${f.due === 'today' ? 'selected' : ''}>Aaj Due</option><option value="overdue" ${f.due === 'overdue' ? 'selected' : ''}>Overdue</option><option value="upcoming" ${f.due === 'upcoming' ? 'selected' : ''}>Upcoming</option></select>
      <select name="tag_id" style="flex:1;min-width:110px"><option value="">Saare Tags</option>${tags.map((t) => `<option value="${t.id}" ${String(f.tag_id) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <button class="btn sm" type="submit">Filter</button>
      <a class="btn sm ghost" href="/leads/new">➕ Nayi Lead</a>
      <a class="btn sm ghost" href="/leads/export${qs(f)}">⬇ Export CSV</a>
    </div>
  </form>
  ${canAssign ? `<form method="post" action="/leads/bulk-assign" id="bulkform">` : ''}
  <div class="card" style="padding:6px 14px">
  ${rows.length ? rows.map((l) => `<div class="leadrow">
    ${canAssign ? `<span class="checkcell"><input type="checkbox" name="lead_ids" value="${l.id}" form="bulkform"></span>` : ''}
    <div class="info"><a class="nm" href="/leads/${l.id}">${esc(l.name)}</a>
      <div class="sub">📱 ${esc(l.mobile)} · ${esc(l.city || '')} · ${esc(l.source || '')} · <span class="prio-${l.priority}">${l.priority}</span></div>
      <div class="sub">${statusChip({ name: l.status_name, color: l.status_color })} <span class="mut">${l.assignee_name ? '👤 ' + esc(l.assignee_name) : '⚠️ Unassigned'}</span> ${(rowTags[l.id] || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </div>
    <form method="post" action="/calls/start"><input type="hidden" name="lead_id" value="${l.id}"><button class="callbtn" title="Call karein" type="submit">📞</button></form>
  </div>`).join('') : '<p class="mut" style="padding:14px 4px">Koi lead nahi mili. Filter badlein ya nayi lead jodein.</p>'}
  </div>
  ${canAssign ? `<div class="card rowflex"><span><b>Bulk Assign:</b> upar leads tick karein →</span>
    <select name="user_id" form="bulkform" style="max-width:220px">${employees(d, u.workspace_id).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
    <button class="btn sm blue" form="bulkform" type="submit">Assign Karein</button></form>
    <form method="post" action="/leads/round-robin" class="rowflex" style="display:inline-flex">
      <button class="btn sm ghost" type="submit">🔄 Round-Robin (saari unassigned)</button></form></div>` : ''}
  <div class="pager">${pg.page > 1 ? `<a href="/leads${qs({ ...f, page: pg.page - 1 })}">← Pichla</a>` : ''}<span class="cur">${pg.page} / ${pg.pages}</span>${pg.page < pg.pages ? `<a href="/leads${qs({ ...f, page: pg.page + 1 })}">Agla →</a>` : ''}</div>`;
  res.send(page(req, { title: 'Leads', body, active: 'leads' }));
});

r.post('/leads/bulk-assign', requireAuth, mgr, (req, res) => {
  const d = getDb(); const u = req.user;
  let ids = req.body.lead_ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(Boolean);
  const target = d.prepare("SELECT * FROM users WHERE id=? AND workspace_id=? AND role='employee' AND active=1").get(req.body.user_id, u.workspace_id);
  if (!ids.length || !target) { req.session.flash = { type: 'err', msg: 'Pehle leads chunein aur employee chunein.' }; return res.redirect('/leads'); }
  const upd = d.prepare('UPDATE leads SET assigned_to=?, updated_at=? WHERE id=? AND workspace_id=?');
  const ev = d.prepare('INSERT INTO timeline_events (lead_id, user_id, type, text, created_at) VALUES (?,?,?,?,?)');
  ids.forEach((id) => { upd.run(target.id, nowISO(), id, u.workspace_id); ev.run(id, u.id, 'assignment', `Lead ${target.name} ko assign hui (bulk)`, nowISO()); });
  audit(d, u.workspace_id, u.id, 'bulk_assign', ids.length + ' leads -> ' + target.name);
  req.session.flash = { type: 'ok', msg: ids.length + ' leads ' + target.name + ' ko assign ho gayi.' };
  res.redirect('/leads');
});

r.post('/leads/round-robin', requireAuth, mgr, (req, res) => {
  const d = getDb(); const u = req.user;
  let ids = req.body.lead_ids || [];
  if (!Array.isArray(ids)) ids = ids.length ? [ids] : [];
  ids = ids.map(Number).filter(Boolean);
  if (!ids.length) {
    ids = d.prepare('SELECT id FROM leads WHERE workspace_id=? AND assigned_to IS NULL ORDER BY created_at').all(u.workspace_id).map((x) => x.id);
  }
  const emps = employees(d, u.workspace_id);
  if (!ids.length || !emps.length) { req.session.flash = { type: 'err', msg: 'Round-robin ke liye unassigned leads aur employees chahiye.' }; return res.redirect('/leads'); }
  const upd = d.prepare('UPDATE leads SET assigned_to=?, updated_at=? WHERE id=?');
  const ev = d.prepare('INSERT INTO timeline_events (lead_id, user_id, type, text, created_at) VALUES (?,?,?,?,?)');
  ids.forEach((id, i) => { const e = emps[i % emps.length]; upd.run(e.id, nowISO(), id); ev.run(id, u.id, 'assignment', `Lead ${e.name} ko assign hui (round-robin)`, nowISO()); });
  req.session.flash = { type: 'ok', msg: ids.length + ' leads round-robin se ' + emps.length + ' employees me baant di gayi.' };
  res.redirect('/leads');
});

// ---------------- CREATE / EDIT ----------------
function leadForm(req, lead, errs) {
  const d = getDb(); const u = req.user;
  const fields = customFields(d, u.workspace_id);
  const vals = {};
  if (lead) d.prepare('SELECT * FROM lead_custom_values WHERE lead_id=?').all(lead.id).forEach((v) => { vals[v.field_id] = v.value; });
  const v = (k, fb = '') => esc(lead ? (lead[k] ?? fb) : fb);
  return `<h1>${lead ? '✏️ Lead Edit' : '➕ Nayi Lead'}</h1>
  ${errs ? `<div class="flash err">${esc(errs)}</div>` : ''}
  <form method="post" action="${lead ? '/leads/' + lead.id + '/update' : '/leads'}" class="card">
    <div class="grid2"><div><label>Naam *</label><input name="name" required value="${v('name')}"></div>
    <div><label>Mobile Number *</label><input name="mobile" required inputmode="numeric" value="${v('mobile')}" placeholder="10-digit mobile"></div>
    <div><label>Alternate Number</label><input name="alt_mobile" inputmode="numeric" value="${v('alt_mobile')}"></div>
    <div><label>Email</label><input name="email" type="email" value="${v('email')}"></div>
    <div><label>City</label><input name="city" value="${v('city')}"></div>
    <div><label>Source</label><input name="source" value="${v('source')}" placeholder="IndiaMART / Facebook / Walk-in..."></div>
    <div><label>Status</label><select name="status_id">${statuses(d, u.workspace_id).map((s) => `<option value="${s.id}" ${lead && lead.status_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div><label>Priority</label><select name="priority">${['Hot', 'Warm', 'Cold'].map((p) => `<option ${lead && lead.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    ${u.role !== 'employee' ? `<div><label>Assign To</label><select name="assigned_to"><option value="">— Unassigned —</option>${employees(d, u.workspace_id).map((e) => `<option value="${e.id}" ${lead && lead.assigned_to === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></div>` : ''}
    ${fields.map((fld) => `<div><label>${esc(fld.name)}</label>${fld.type === 'dropdown'
      ? `<select name="cf_${fld.id}"><option value="">—</option>${(fld.options || '').split(',').map((o) => `<option ${vals[fld.id] === o.trim() ? 'selected' : ''}>${esc(o.trim())}</option>`).join('')}</select>`
      : `<input name="cf_${fld.id}" type="${fld.type === 'number' ? 'number' : fld.type === 'date' ? 'date' : 'text'}" value="${esc(vals[fld.id] || '')}">`}</div>`).join('')}
    </div>
    <p style="margin-top:16px"><button class="btn" type="submit">${lead ? 'Save Karein' : 'Lead Jodein'}</button> <a class="btn ghost" href="/leads">Cancel</a></p>
  </form>`;
}

r.get('/leads/new', requireAuth, (req, res) => res.send(page(req, { title: 'Nayi Lead', body: leadForm(req, null), active: 'leads' })));

function saveCustom(d, leadId, body) {
  const fields = d.prepare('SELECT id FROM custom_fields WHERE workspace_id=(SELECT workspace_id FROM leads WHERE id=?)').all(leadId);
  const up = d.prepare('INSERT INTO lead_custom_values (lead_id, field_id, value) VALUES (?,?,?) ON CONFLICT(lead_id, field_id) DO UPDATE SET value=excluded.value');
  fields.forEach((f) => { const val = body['cf_' + f.id]; if (val !== undefined) up.run(leadId, f.id, String(val)); });
}

r.post('/leads', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const name = String(req.body.name || '').trim();
  const mobile = cleanMobile(req.body.mobile);
  if (!name || !validMobile(mobile)) {
    return res.send(page(req, { title: 'Nayi Lead', body: leadForm(req, req.body, 'Naam aur sahi 10-digit mobile number zaroori hai.'), active: 'leads' }));
  }
  const dup = d.prepare('SELECT id, name FROM leads WHERE workspace_id=? AND mobile=?').get(u.workspace_id, mobile);
  if (dup) {
    req.session.flash = { type: 'err', msg: `Ye number pehle se lead "${dup.name}" (#${dup.id}) me hai — duplicate nahi banega.` };
    return res.redirect('/leads/' + dup.id);
  }
  const assigned = u.role === 'employee' ? u.id : (req.body.assigned_to ? Number(req.body.assigned_to) : null);
  const id = d.prepare(`INSERT INTO leads (workspace_id, name, mobile, alt_mobile, email, city, source, status_id, assigned_to, priority, created_by, created_at, updated_at, last_activity_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(u.workspace_id, name, mobile, cleanMobile(req.body.alt_mobile) || null, req.body.email || null, req.body.city || null,
    req.body.source || null, req.body.status_id ? Number(req.body.status_id) : null, assigned, req.body.priority || 'Warm', u.id, nowISO(), nowISO(), nowISO()).lastInsertRowid;
  saveCustom(d, id, req.body);
  logEvent(d, id, u.id, 'created', `Lead bani — ${u.name} ne jodi`);
  req.session.flash = { type: 'ok', msg: 'Lead jud gayi ✅' };
  res.redirect('/leads/' + id);
});

r.get('/leads/:id/edit', requireAuth, (req, res) => {
  const d = getDb(); const lead = getLead(d, req.params.id);
  if (!canAccessLead(req.user, lead)) { req.session.flash = { type: 'err', msg: 'Lead nahi mili.' }; return res.redirect('/leads'); }
  res.send(page(req, { title: 'Lead Edit', body: leadForm(req, lead), active: 'leads' }));
});

r.post('/leads/:id/update', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user; const lead = getLead(d, req.params.id);
  if (!canAccessLead(u, lead)) return res.redirect('/leads');
  const mobile = cleanMobile(req.body.mobile);
  if (!String(req.body.name || '').trim() || !validMobile(mobile)) {
    return res.send(page(req, { title: 'Lead Edit', body: leadForm(req, { ...lead, ...req.body }, 'Naam aur sahi mobile zaroori hai.'), active: 'leads' }));
  }
  const dup = d.prepare('SELECT id FROM leads WHERE workspace_id=? AND mobile=? AND id<>?').get(u.workspace_id, mobile, lead.id);
  if (dup) { req.session.flash = { type: 'err', msg: 'Ye number kisi aur lead me pehle se hai.' }; return res.redirect('/leads/' + lead.id + '/edit'); }
  d.prepare('UPDATE leads SET name=?, mobile=?, alt_mobile=?, email=?, city=?, source=?, status_id=?, priority=?, updated_at=? WHERE id=?')
    .run(String(req.body.name).trim(), mobile, cleanMobile(req.body.alt_mobile) || null, req.body.email || null, req.body.city || null, req.body.source || null,
      req.body.status_id ? Number(req.body.status_id) : lead.status_id, req.body.priority || lead.priority, nowISO(), lead.id);
  saveCustom(d, lead.id, req.body); touchLead(d, lead.id);
  req.session.flash = { type: 'ok', msg: 'Lead update ho gayi ✅' };
  res.redirect('/leads/' + lead.id);
});

r.post('/leads/:id/delete', requireAuth, mgr, (req, res) => {
  const d = getDb(); const lead = getLead(d, req.params.id);
  if (lead && lead.workspace_id === req.user.workspace_id) {
    d.prepare('DELETE FROM leads WHERE id=?').run(lead.id);
    audit(d, req.user.workspace_id, req.user.id, 'lead_delete', lead.name + ' ' + lead.mobile);
    req.session.flash = { type: 'ok', msg: 'Lead delete ho gayi.' };
  }
  res.redirect('/leads');
});

// ---------------- EXPORT ----------------
r.get('/leads/export', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const { where, args } = buildFilter(req, u);
  const rows = d.prepare(`SELECT l.*, s.name AS status_name, au.name AS assignee FROM leads l LEFT JOIN statuses s ON s.id=l.status_id LEFT JOIN users au ON au.id=l.assigned_to WHERE ${where} ORDER BY l.id`).all(...args);
  const fields = customFields(d, u.workspace_id);
  const head = ['Name', 'Mobile', 'Alt Mobile', 'Email', 'City', 'Source', 'Status', 'Priority', 'Assigned To', 'Created', ...fields.map((f) => f.name)];
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [head.map(cell).join(',')];
  rows.forEach((l) => {
    const vals = {}; d.prepare('SELECT * FROM lead_custom_values WHERE lead_id=?').all(l.id).forEach((v) => { vals[v.field_id] = v.value; });
    lines.push([l.name, l.mobile, l.alt_mobile, l.email, l.city, l.source, l.status_name, l.priority, l.assignee, fmtD(l.created_at), ...fields.map((f) => vals[f.id] || '')].map(cell).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="allcrm-leads.csv"');
  res.send('﻿' + lines.join('\n'));
});

// ---------------- DETAIL + TIMELINE ----------------
r.get('/leads/:id', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user; const lead = getLead(d, req.params.id);
  if (!canAccessLead(u, lead)) { req.session.flash = { type: 'err', msg: 'Lead nahi mili ya permission nahi hai.' }; return res.redirect('/leads'); }
  const st = lead.status_id ? d.prepare('SELECT * FROM statuses WHERE id=?').get(lead.status_id) : null;
  const fields = customFields(d, u.workspace_id);
  const vals = {}; d.prepare('SELECT * FROM lead_custom_values WHERE lead_id=?').all(lead.id).forEach((v) => { vals[v.field_id] = v.value; });
  const leadTags = d.prepare('SELECT t.* FROM lead_tags lt JOIN tags t ON t.id=lt.tag_id WHERE lt.lead_id=?').all(lead.id);
  const allTags = d.prepare('SELECT * FROM tags WHERE workspace_id=? ORDER BY name').all(u.workspace_id);
  const templates = d.prepare('SELECT * FROM whatsapp_templates WHERE workspace_id=? AND active=1 ORDER BY name').all(u.workspace_id);

  // --- timeline merge ---
  const items = [];
  d.prepare('SELECT c.*, s.name AS status_name, s.color AS status_color, un.name AS user_name FROM calls c LEFT JOIN statuses s ON s.id=c.status_id LEFT JOIN users un ON un.id=c.user_id WHERE c.lead_id=?').all(lead.id)
    .forEach((c) => {
      if (c.state === 'completed') items.push({ ts: c.saved_at, html: `📞 <b>${esc(c.user_name || '')}</b> — ${c.direction === 'incoming' ? 'Incoming' : 'Outgoing'} call ${c.status_name ? `<span class="chip" style="background:${esc(c.status_color)}">${esc(c.status_name)}</span>` : ''}${c.duration_sec ? ` · ${c.duration_sec}s` : ''}${c.remark ? `<br>${esc(c.remark)}` : ''}${c.follow_up_at ? `<br><span class="mut">⏰ Follow-up: ${fmtDT(c.follow_up_at)}</span>` : ''}` });
      else if (c.state === 'started') items.push({ ts: c.started_at, html: `📞 <b>${esc(c.user_name || '')}</b> ne call shuru ki — disposition baaki hai` });
    });
  d.prepare('SELECT f.*, un.name AS user_name FROM follow_ups f LEFT JOIN users un ON un.id=f.user_id WHERE f.lead_id=?').all(lead.id)
    .forEach((f) => items.push({ ts: f.created_at, html: `⏰ Follow-up set — <b>${fmtDT(f.due_at)}</b> (${esc(f.user_name || '')}) ${f.done ? '· ✅ Done ' + fmtDT(f.done_at) : ''}` }));
  d.prepare('SELECT w.*, un.name AS user_name FROM whatsapp_logs w LEFT JOIN users un ON un.id=w.user_id WHERE w.lead_id=?').all(lead.id)
    .forEach((w) => items.push({ ts: w.created_at, html: `💬 WhatsApp bheja (${esc(w.user_name || '')})<br><span class="mut">${esc((w.message || '').slice(0, 120))}</span>` }));
  d.prepare('SELECT e.*, un.name AS user_name FROM timeline_events e LEFT JOIN users un ON un.id=e.user_id WHERE e.lead_id=?').all(lead.id)
    .forEach((e) => items.push({ ts: e.created_at, html: `${e.type === 'note' ? '📝' : e.type === 'status' ? '🔄' : e.type === 'transfer' || e.type === 'assignment' ? '👤' : '✨'} ${esc(e.text)}${e.type === 'note' && e.user_name ? ` — <span class="mut">${esc(e.user_name)}</span>` : ''}` }));
  items.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  const body = `<p><a href="/leads">← Saari Leads</a></p>
  <div class="card">
    <div class="rowflex" style="justify-content:space-between"><div>
      <h1 style="margin:0">${esc(lead.name)} <span class="prio-${lead.priority}" style="font-size:15px">${lead.priority}</span></h1>
      <p class="mut" style="margin:4px 0">📱 ${esc(lead.mobile)}${lead.alt_mobile ? ' · ' + esc(lead.alt_mobile) : ''} · ${esc(lead.city || '')} · Source: ${esc(lead.source || '—')}<br>
      👤 Owner: <b>${esc(userName(d, lead.assigned_to))}</b> · Lead #${lead.id} · Bani: ${fmtD(lead.created_at)}</p>
    </div><div>${statusChip(st)}</div></div>
    <div class="rowflex" style="margin-top:10px">
      <form method="post" action="/calls/start"><input type="hidden" name="lead_id" value="${lead.id}"><input type="hidden" name="return_to" value="/leads/${lead.id}"><button class="btn" type="submit">📞 Call Karein</button></form>
      ${templates.length ? `<span class="rowflex"><select id="wa_tpl" style="max-width:200px">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><button class="btn" style="background:#25d366" type="button" onclick="sendWA()">💬 WhatsApp</button></span>` : ''}
      <a class="btn ghost" href="/leads/${lead.id}/edit">✏️ Edit</a>
      ${u.role !== 'employee' ? `<form method="post" action="/leads/${lead.id}/delete" onsubmit="return confirm('Pakka delete karein?')"><button class="btn red sm" type="submit">Delete</button></form>` : ''}
    </div>
    <script>function sendWA(){var t=document.getElementById('wa_tpl').value;fetch('/leads/${lead.id}/whatsapp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({template_id:t})}).then(function(r){return r.json()}).then(function(j){if(j.ok){window.open(j.url,'_blank');location.reload()}else alert(j.error||'Error')})}</script>
    <dl class="kv" style="margin-top:14px">
      ${lead.email ? `<dt>Email</dt><dd>${esc(lead.email)}</dd>` : ''}
      ${fields.filter((f) => vals[f.id]).map((f) => `<dt>${esc(f.name)}</dt><dd>${esc(vals[f.id])}</dd>`).join('')}
    </dl>
    <div style="margin-top:8px">${leadTags.map((t) => `<span class="tag">${esc(t.name)} <a href="#" onclick="document.getElementById('untag_${t.id}').submit();return false" style="color:#991b1b">✕</a></span><form id="untag_${t.id}" method="post" action="/leads/${lead.id}/tags/remove" style="display:none"><input type="hidden" name="tag_id" value="${t.id}"></form>`).join('')}
    <form method="post" action="/leads/${lead.id}/tags/add" class="rowflex" style="margin-top:6px">
      <select name="tag_id" style="max-width:200px">${allTags.filter((t) => !leadTags.some((x) => x.id === t.id)).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <input name="new_tag" placeholder="ya naya tag likhein" style="max-width:180px">
      <button class="btn sm ghost" type="submit">+ Tag</button></form></div>
  </div>

  <div class="card"><h3 style="margin-top:0">🔄 Status Badlein</h3>
    <form method="post" action="/leads/${lead.id}/status" class="rowflex">
      <select name="status_id" style="max-width:240px">${statuses(d, u.workspace_id).map((s) => `<option value="${s.id}" ${lead.status_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <button class="btn sm" type="submit">Status Save</button></form>
    ${u.role !== 'employee' ? `<h3>👤 Transfer / Assign</h3>
    <form method="post" action="/leads/${lead.id}/transfer" class="rowflex">
      <select name="user_id" style="max-width:240px"><option value="">— Unassigned —</option>${employees(d, u.workspace_id).map((e) => `<option value="${e.id}" ${lead.assigned_to === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
      <button class="btn sm blue" type="submit">Assign Karein</button></form>` : ''}
  </div>

  <details class="fold"><summary>➕ Manual Call Log karein (incoming/outgoing)</summary>
    <form method="post" action="/calls/log">
      <input type="hidden" name="lead_id" value="${lead.id}">
      <div class="grid2">
      <div><label>Direction</label><select name="direction"><option value="outgoing">Outgoing (maine call kiya)</option><option value="incoming">Incoming (lead ne call kiya)</option></select></div>
      <div><label>Status</label><select name="status_id">${statuses(d, u.workspace_id).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div><label>Duration (sec, optional)</label><input type="number" name="duration_sec" min="0" placeholder="120"></div>
      <div><label>Follow-up Date (optional)</label><input type="date" name="follow_up_date"></div></div>
      <label>Remark</label><textarea name="remark" placeholder="Call par kya baat hui..."></textarea>
      <p><button class="btn sm" type="submit">Call Log Save</button></p>
    </form></details>

  <div class="card"><h3 style="margin-top:0">📝 Note Jodein</h3>
    <form method="post" action="/leads/${lead.id}/note"><textarea name="note" required placeholder="Is lead ke baare me note..."></textarea>
    <p><button class="btn sm" type="submit">Note Save</button></p></form></div>

  <div class="card"><h3 style="margin-top:0">🕒 Poora Record (Timeline)</h3>
    <div class="tl">${items.length ? items.map((i) => `<div class="ev"><div>${i.html}</div><div class="when">${fmtDT(i.ts)}</div></div>`).join('') : '<p class="mut">Abhi koi activity nahi hai.</p>'}</div>
  </div>`;
  res.send(page(req, { title: lead.name, body, active: 'leads' }));
});

r.post('/leads/:id/status', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user; const lead = getLead(d, req.params.id);
  if (!canAccessLead(u, lead)) return res.redirect('/leads');
  const ns = d.prepare('SELECT * FROM statuses WHERE id=? AND workspace_id=?').get(req.body.status_id, u.workspace_id);
  if (ns && ns.id !== lead.status_id) {
    const os = lead.status_id ? d.prepare('SELECT name FROM statuses WHERE id=?').get(lead.status_id) : null;
    d.prepare('UPDATE leads SET status_id=?, updated_at=? WHERE id=?').run(ns.id, nowISO(), lead.id);
    logEvent(d, lead.id, u.id, 'status', `Status: ${os ? os.name : '—'} → ${ns.name}`);
    touchLead(d, lead.id);
  }
  res.redirect('/leads/' + lead.id);
});

r.post('/leads/:id/transfer', requireAuth, mgr, (req, res) => {
  const d = getDb(); const u = req.user; const lead = getLead(d, req.params.id);
  if (!lead || lead.workspace_id !== u.workspace_id) return res.redirect('/leads');
  const targetId = req.body.user_id ? Number(req.body.user_id) : null;
  const oldName = userName(d, lead.assigned_to);
  d.prepare('UPDATE leads SET assigned_to=?, updated_at=? WHERE id=?').run(targetId, nowISO(), lead.id);
  logEvent(d, lead.id, u.id, 'transfer', `Lead transfer: ${oldName} → ${userName(d, targetId)}`);
  req.session.flash = { type: 'ok', msg: 'Lead assign/transfer ho gayi ✅' };
  res.redirect('/leads/' + lead.id);
});

r.post('/leads/:id/note', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user; const lead = getLead(d, req.params.id);
  if (!canAccessLead(u, lead)) return res.redirect('/leads');
  const note = String(req.body.note || '').trim();
  if (note) { logEvent(d, lead.id, u.id, 'note', note); touchLead(d, lead.id); }
  res.redirect('/leads/' + lead.id);
});

r.post('/leads/:id/tags/add', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user; const lead = getLead(d, req.params.id);
  if (!canAccessLead(u, lead)) return res.redirect('/leads');
  let tagId = req.body.tag_id ? Number(req.body.tag_id) : null;
  const newTag = String(req.body.new_tag || '').trim();
  if (newTag) {
    const ex = d.prepare('SELECT id FROM tags WHERE workspace_id=? AND name=?').get(u.workspace_id, newTag);
    tagId = ex ? ex.id : d.prepare('INSERT INTO tags (workspace_id, name) VALUES (?,?)').run(u.workspace_id, newTag).lastInsertRowid;
  }
  if (tagId) d.prepare('INSERT OR IGNORE INTO lead_tags (lead_id, tag_id) VALUES (?,?)').run(lead.id, tagId);
  res.redirect('/leads/' + lead.id);
});

r.post('/leads/:id/tags/remove', requireAuth, (req, res) => {
  const d = getDb(); const lead = getLead(d, req.params.id);
  if (!canAccessLead(req.user, lead)) return res.redirect('/leads');
  d.prepare('DELETE FROM lead_tags WHERE lead_id=? AND tag_id=?').run(lead.id, Number(req.body.tag_id));
  res.redirect('/leads/' + lead.id);
});

// WhatsApp: render template, log on timeline, return wa.me URL (JSON).
r.post('/leads/:id/whatsapp', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user; const lead = getLead(d, req.params.id);
  if (!canAccessLead(u, lead)) return res.status(403).json({ ok: false, error: 'Permission nahi hai' });
  const tpl = d.prepare('SELECT * FROM whatsapp_templates WHERE id=? AND workspace_id=?').get(req.body.template_id, u.workspace_id);
  if (!tpl) return res.status(400).json({ ok: false, error: 'Template nahi mila' });
  const msg = tpl.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => ({ name: lead.name, city: lead.city || '', source: lead.source || '', mobile: lead.mobile }[k] || m));
  d.prepare('INSERT INTO whatsapp_logs (lead_id, user_id, template_id, message, created_at) VALUES (?,?,?,?,?)').run(lead.id, u.id, tpl.id, msg, nowISO());
  touchLead(d, lead.id);
  res.json({ ok: true, url: 'https://wa.me/91' + lead.mobile + '?text=' + encodeURIComponent(msg), message: msg });
});

module.exports = r;

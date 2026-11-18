'use strict';
const express = require('express');
const { getDb } = require('../db');
const { esc, paginate, qs, fmtDT } = require('../lib/util');
const { page, info } = require('../lib/layout');
const { requireAuth, requireRole } = require('../lib/auth');
const { syncWorkspace, syncLeads } = require('../lib/rmdialer-sync');

const r = express.Router();

function fmtDur(sec) {
  if (sec == null) return '—';
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------------- LIST ----------------
// Admins & managers see every recording in the workspace. An employee sees
// only recordings matched to a lead assigned to them; recordings that could
// not be matched to any lead are visible to admins/managers only.
r.get('/recordings', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const isEmp = u.role === 'employee';
  const conds = ['cr.workspace_id=?'];
  const args = [u.workspace_id];
  if (isEmp) conds.push('l.assigned_to=?'), args.push(u.id);
  const q = (req.query.q || '').trim();
  if (q) { conds.push('(cr.phone LIKE ? OR cr.contact_name LIKE ? OR l.name LIKE ?)'); args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  if (req.query.from) { conds.push('substr(cr.recorded_at,1,10)>=?'); args.push(req.query.from); }
  if (req.query.to) { conds.push('substr(cr.recorded_at,1,10)<=?'); args.push(req.query.to); }
  const join = isEmp ? 'JOIN leads l ON l.id=cr.lead_id' : 'LEFT JOIN leads l ON l.id=cr.lead_id';
  const where = conds.join(' AND ');
  const total = d.prepare(`SELECT COUNT(*) c FROM call_recordings cr ${join} WHERE ${where}`).get(...args).c;
  const pg = paginate(req, total, 20);
  const rows = d.prepare(`SELECT cr.*, l.name AS lead_name FROM call_recordings cr ${join} WHERE ${where}
    ORDER BY cr.recorded_at DESC, cr.id DESC LIMIT ? OFFSET ?`).all(...args, pg.perPage, pg.offset);
  const f = req.query;
  const body = `<h1>🎙️ Call Recordings <span class="mut" style="font-size:15px">(${total})</span> ${info('These recordings are pulled automatically from RMDialer and matched to your leads by phone number. Press play to listen. A recording whose number does not match any lead is shown to admins and managers only, with the phone number instead of a lead name.')}</h1>
  <form method="get" class="card" style="padding:13px">
    <div class="rowflex">
      <input style="flex:2;min-width:170px" type="search" name="q" value="${esc(f.q || '')}" placeholder="🔍 Search by phone or name">
      <label style="margin:0">From <input type="date" name="from" value="${esc(f.from || '')}" style="min-height:44px"></label>
      <label style="margin:0">To <input type="date" name="to" value="${esc(f.to || '')}" style="min-height:44px"></label>
      <button class="btn sm" type="submit">Filter</button>
      ${u.role === 'admin' ? '<a class="btn sm ghost" href="/settings">⚙️ Sync Settings</a>' : ''}
    </div>
  </form>
  <div class="card" style="padding:6px 14px"><div class="tblwrap"><table>
  <tr><th>Lead / Number</th><th>Recording</th><th>Employee</th><th>Duration</th><th>Date</th></tr>
  ${rows.length ? rows.map((rec) => `<tr>
    <td>${rec.lead_id ? `<a href="/leads/${rec.lead_id}"><b>${esc(rec.lead_name || rec.contact_name || rec.phone || '')}</b></a>` : `<b>${esc(rec.contact_name || 'No matching lead')}</b>`}<br><span class="mut small">📱 ${esc(rec.phone || '')}</span></td>
    <td>${rec.recording_url ? `<audio controls preload="none" src="${esc(rec.recording_url)}" style="max-width:230px;height:38px;vertical-align:middle"></audio>` : '<span class="mut">—</span>'}</td>
    <td>${esc(rec.recorded_by_name || '—')}</td>
    <td>${fmtDur(rec.duration_seconds)}</td>
    <td>${fmtDT(rec.recorded_at)}</td>
  </tr>`).join('') : '<tr><td colspan="5" class="mut" style="padding:14px 4px">No recordings found yet. Recordings appear here automatically after a sync from RMDialer.</td></tr>'}
  </table></div></div>
  <div class="pager">${pg.page > 1 ? `<a href="/recordings${qs({ ...f, page: pg.page - 1 })}">← Previous</a>` : ''}<span class="cur">${pg.page} / ${pg.pages}</span>${pg.page < pg.pages ? `<a href="/recordings${qs({ ...f, page: pg.page + 1 })}">Next →</a>` : ''}</div>`;
  res.send(page(req, { title: 'Recordings', body, active: 'recordings' }));
});

// ---------------- SYNC NOW (admin) ----------------
r.post('/recordings/sync', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const out = await syncWorkspace(req.user.workspace_id, req.user.id);
    if (out.skipped) req.session.flash = { type: 'err', msg: out.reason || 'Sync skipped.' };
    else if (out.ok) req.session.flash = { type: 'ok', msg: 'RMDialer sync complete ✅ ' + out.result + '.' };
    else req.session.flash = { type: 'err', msg: out.error || 'Sync failed.' };
  } catch (e) {
    req.session.flash = { type: 'err', msg: 'Sync failed unexpectedly. Please try again.' };
  }
  res.redirect('/settings');
});

// ---------------- SYNC LEADS NOW (admin) ----------------
r.post('/recordings/sync-leads', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const out = await syncLeads(req.user.workspace_id, req.user.id);
    if (out.skipped) req.session.flash = { type: 'err', msg: out.reason || 'Lead sync skipped.' };
    else if (out.ok) req.session.flash = { type: 'ok', msg: 'RMDialer lead sync complete ✅ ' + out.result + '.' };
    else req.session.flash = { type: 'err', msg: out.error || 'Lead sync failed.' };
  } catch (e) {
    req.session.flash = { type: 'err', msg: 'Lead sync failed unexpectedly. Please try again.' };
  }
  res.redirect('/settings');
});

module.exports = r;

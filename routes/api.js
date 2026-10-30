'use strict';
const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { esc, nowISO, cleanMobile, validMobile, fmtT, timeAgo } = require('../lib/util');
const { requireAuth } = require('../lib/auth');

const r = express.Router();

// JSON feed for dashboard/team auto-refresh (10s polling).
r.get('/api/live', requireAuth, (req, res) => {
  const d = getDb();
  const u = req.user;
  const rows = d.prepare(`SELECT c.*, u.name AS user_name, l.name AS lead_name, l.id AS lid, s.name AS status_name, s.color AS status_color
    FROM calls c JOIN users u ON u.id=c.user_id JOIN leads l ON l.id=c.lead_id LEFT JOIN statuses s ON s.id=c.status_id
    WHERE l.workspace_id=? AND c.state='completed' ORDER BY c.saved_at DESC LIMIT 12`).all(u.workspace_id);
  const feedHtml = rows.length ? rows.map((c) => `<div class="leadrow"><div class="info"><div class="nm" style="font-size:15px">${esc(c.user_name)} → <a href="/leads/${c.lid}">${esc(c.lead_name)}</a></div>
    <div class="sub">${c.status_name ? `<span class="chip" style="background:${esc(c.status_color)}">${esc(c.status_name)}</span>` : ''} ${esc(c.remark || '')} · ${timeAgo(c.saved_at)}</div></div></div>`).join('')
    : '<p class="mut">Abhi koi call activity nahi hai.</p>';
  const team = (u.role !== 'employee') ? d.prepare(`SELECT u2.id, u2.name,
      EXISTS(SELECT 1 FROM calls c WHERE c.user_id=u2.id AND c.state='started') AS on_call,
      (SELECT MAX(c2.saved_at) FROM calls c2 WHERE c2.user_id=u2.id AND c2.state='completed') AS last_done,
      u2.last_active_at FROM users u2 WHERE u2.workspace_id=? AND u2.role='employee' AND u2.active=1`).all(u.workspace_id)
    .map((t) => ({ id: t.id, name: t.name, state: t.on_call ? 'call' : 'idle', last: t.last_done || t.last_active_at })) : [];
  res.json({ ok: true, feedHtml, team, serverTime: fmtT(nowISO()) });
});

// Phase-3-ready lead intake webhook: POST JSON {name, mobile, city?, email?, source?}
// Header: x-api-token: <workspace token from Settings>. Creates a lead and
// auto-assigns it to the active employee with the fewest leads (round-robin style).
r.post('/api/webhook/leads', (req, res) => {
  const d = getDb();
  const token = req.get('x-api-token') || req.query.token || '';
  const ws = d.prepare('SELECT * FROM workspaces WHERE api_token=?').get(token);
  if (!ws || !token) return res.status(401).json({ ok: false, error: 'Invalid API token' });
  const b = req.body || {};
  const mobile = cleanMobile(b.mobile || b.phone || b.number || '');
  const name = String(b.name || '').trim();
  if (!name || !validMobile(mobile)) return res.status(400).json({ ok: false, error: 'name aur sahi 10-digit mobile zaroori hai' });
  const dup = d.prepare('SELECT id FROM leads WHERE workspace_id=? AND mobile=?').get(ws.id, mobile);
  if (dup) return res.status(200).json({ ok: true, duplicate: true, lead_id: dup.id });
  const stNew = d.prepare("SELECT id FROM statuses WHERE workspace_id=? ORDER BY sort LIMIT 1").get(ws.id);
  const emps = d.prepare("SELECT u.id, (SELECT COUNT(*) FROM leads l WHERE l.assigned_to=u.id) n FROM users u WHERE u.workspace_id=? AND u.role='employee' AND u.active=1 ORDER BY n ASC, u.id ASC").all(ws.id);
  const assigned = emps.length ? emps[0].id : null;
  const id = d.prepare(`INSERT INTO leads (workspace_id, name, mobile, email, city, source, status_id, assigned_to, priority, created_at, updated_at, last_activity_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(ws.id, name, mobile, b.email || null, b.city || null, String(b.source || 'API'), stNew ? stNew.id : null, assigned, 'Warm', nowISO(), nowISO(), nowISO()).lastInsertRowid;
  res.json({ ok: true, lead_id: id, assigned_to: assigned });
});

// Tiny token generator used by settings (regenerate API token).
r.randomToken = () => crypto.randomBytes(20).toString('hex');

module.exports = r;

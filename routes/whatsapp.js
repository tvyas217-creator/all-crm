'use strict';
const express = require('express');
const { getDb } = require('../db');
const { esc, nowISO } = require('../lib/util');
const { page } = require('../lib/layout');
const { requireAuth, requireRole } = require('../lib/auth');

const r = express.Router();
const admin = requireRole('admin');

r.get('/templates', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const rows = d.prepare('SELECT * FROM whatsapp_templates WHERE workspace_id=? ORDER BY name').all(u.workspace_id);
  const body = `<h1>💬 WhatsApp Templates</h1>
  <p class="mut">Ye templates lead page par WhatsApp button se bheje jate hain (Phase 1 me wa.me se — employee ke apne WhatsApp se jata hai). Variables: <b>{{name}}</b>, <b>{{city}}</b>, <b>{{source}}</b>, <b>{{mobile}}</b>. Phase 3 me Official WhatsApp API se bulk campaigns bhi yahi templates use karengi — sirf opted-in contacts par.</p>
  ${rows.map((t) => `<div class="card"><div class="rowflex" style="justify-content:space-between"><b>${esc(t.name)}</b>${u.role === 'admin' ? `<form method="post" action="/templates/${t.id}/delete" onsubmit="return confirm('Delete karein?')"><button class="btn red sm" type="submit">Delete</button></form>` : ''}</div>
  <p style="white-space:pre-wrap;margin:8px 0 0">${esc(t.body)}</p></div>`).join('') || '<div class="card mut">Abhi koi template nahi hai.</div>'}
  ${u.role === 'admin' ? `<div class="card"><h3 style="margin-top:0">➕ Naya Template</h3>
  <form method="post" action="/templates"><label>Template Naam</label><input name="name" required placeholder="jaise Price List">
  <label>Message</label><textarea name="body" required placeholder="Namaste {{name}} ji, ..."></textarea>
  <p><button class="btn" type="submit">Template Jodein</button></p></form></div>` : ''}`;
  res.send(page(req, { title: 'WA Templates', body, active: 'templates' }));
});

r.post('/templates', requireAuth, admin, (req, res) => {
  const d = getDb();
  const name = String(req.body.name || '').trim(); const bodyTxt = String(req.body.body || '').trim();
  if (name && bodyTxt) d.prepare('INSERT INTO whatsapp_templates (workspace_id, name, body, created_at) VALUES (?,?,?,?)').run(req.user.workspace_id, name, bodyTxt, nowISO());
  res.redirect('/templates');
});

r.post('/templates/:id/delete', requireAuth, admin, (req, res) => {
  getDb().prepare('DELETE FROM whatsapp_templates WHERE id=? AND workspace_id=?').run(req.params.id, req.user.workspace_id);
  res.redirect('/templates');
});

module.exports = r;

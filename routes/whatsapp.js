'use strict';
const express = require('express');
const { getDb } = require('../db');
const { esc, nowISO } = require('../lib/util');
const { page, info } = require('../lib/layout');
const { requireAuth, requireRole } = require('../lib/auth');

const r = express.Router();
const admin = requireRole('admin');

r.get('/templates', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const rows = d.prepare('SELECT * FROM whatsapp_templates WHERE workspace_id=? ORDER BY name').all(u.workspace_id);
  const body = `<h1>💬 WhatsApp Templates${info('Templates are ready-made messages your team sends from a lead\'s page. Tapping WhatsApp opens the employee\'s own WhatsApp app (via wa.me) with the message filled in — the customer replies there as usual; nothing is sent automatically. Use {{name}}, {{city}}, {{source}} and {{mobile}} to personalize a message. Please message only customers who have agreed to be contacted.')}</h1>
  <p class="mut">These templates are sent from the lead page's WhatsApp button (in Phase 1 via wa.me — the message goes from the employee's own WhatsApp). Variables: <b>{{name}}</b>, <b>{{city}}</b>, <b>{{source}}</b>, <b>{{mobile}}</b>. In Phase 3, bulk campaigns via the Official WhatsApp API will use these same templates — for opted-in contacts only.</p>
  ${rows.map((t) => `<div class="card"><div class="rowflex" style="justify-content:space-between"><b>${esc(t.name)}</b>${u.role === 'admin' ? `<form method="post" action="/templates/${t.id}/delete" onsubmit="return confirm('Delete this template?')"><button class="btn red sm" type="submit">Delete</button></form>` : ''}</div>
  <p style="white-space:pre-wrap;margin:8px 0 0">${esc(t.body)}</p></div>`).join('') || '<div class="card mut">No templates yet.</div>'}
  ${u.role === 'admin' ? `<div class="card"><h3 style="margin-top:0">➕ New Template</h3>
  <form method="post" action="/templates"><label>Template Name</label><input name="name" required placeholder="e.g. Price List">
  <label>Message</label><textarea name="body" required placeholder="Hello {{name}}, ..."></textarea>
  <p><button class="btn" type="submit">Add Template</button></p></form></div>` : ''}`;
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

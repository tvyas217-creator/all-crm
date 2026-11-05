'use strict';
const express = require('express');
const XLSX = require('xlsx');
const { getDb, logEvent } = require('../db');
const { esc, nowISO, cleanMobile, validMobile, fmtDT } = require('../lib/util');
const { page, info } = require('../lib/layout');
const { requireAuth } = require('../lib/auth');
const { leadRoom } = require('../lib/plans');

const r = express.Router();

r.get('/import', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const past = d.prepare('SELECT i.*, un.name AS user_name FROM imports i LEFT JOIN users un ON un.id=i.user_id WHERE i.workspace_id=? ORDER BY i.id DESC LIMIT 10').all(u.workspace_id);
  const emps = d.prepare("SELECT * FROM users WHERE workspace_id=? AND role='employee' AND active=1 ORDER BY name").all(u.workspace_id);
  const body = `<h1>⬆️ Leads Import${info('Upload an Excel (.xlsx) or CSV file with a header row. Name and Mobile columns are required; City, Email, Source and your custom-field columns are matched by name automatically. A row whose mobile already exists — in the file or in the CRM — is skipped as a duplicate. If your plan\'s lead limit is reached, the import fills only the remaining space and reports the skipped rows.')}</h1>
  <div class="card">
    <p class="mut" style="margin-top:0">Choose an Excel (.xlsx) or CSV file. The first row must be a header — <b>Name</b> and <b>Mobile</b> are required; City, Email and Source are matched automatically. Columns named after your custom fields are matched too. Rows with a duplicate number are skipped.</p>
    <label>Choose a File (.xlsx / .csv)</label>
    <input type="file" id="imp_file" accept=".xlsx,.xls,.csv">
    <label>Assign imported leads to:${u.role !== 'employee' ? info('Round-Robin distributes new leads evenly among all active employees, one by one, so the work is shared fairly. You can also pick a single employee, or leave the leads unassigned and assign them later from the Leads page.') : ''}</label>
    <select id="imp_assign"><option value="">Leave unassigned</option>${u.role !== 'employee' ? '<option value="roundrobin">🔄 Round-Robin (all employees)</option>' : ''}${emps.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
    <p style="margin-top:14px"><button class="btn" type="button" id="imp_btn" onclick="doImport()">⬆️ Import</button></p>
    <div id="imp_out"></div>
    <script>
    function doImport(){
      var f=document.getElementById('imp_file').files[0];
      if(!f){alert('Please choose a file first');return}
      var btn=document.getElementById('imp_btn');btn.disabled=true;btn.textContent='Importing...';
      var rd=new FileReader();
      rd.onload=function(){
        var b64=String(rd.result).split(',')[1];
        fetch('/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:f.name,data_base64:b64,assign:document.getElementById('imp_assign').value})})
        .then(function(r){return r.text()}).then(function(html){document.getElementById('imp_out').innerHTML=html;btn.disabled=false;btn.textContent='⬆️ Import'})
        .catch(function(e){alert('Import failed: '+e);btn.disabled=false});
      };
      rd.readAsDataURL(f);
    }</script>
  </div>
  <div class="card"><h3 style="margin-top:0">Past Imports</h3>
  ${past.length ? `<div class="tblwrap"><table><tr><th>File</th><th>By</th><th>Added</th><th>Duplicates</th><th>Errors</th><th>Time</th></tr>${past.map((i) => `<tr><td>${esc(i.filename || '')}</td><td>${esc(i.user_name || '')}</td><td>${i.added}</td><td>${i.duplicates}</td><td>${i.errors}</td><td>${fmtDT(i.created_at)}</td></tr>`).join('')}</table></div>` : '<p class="mut">No imports yet.</p>'}
  </div>`;
  res.send(page(req, { title: 'Import', body, active: 'import' }));
});

r.post('/import', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  try {
    const buf = Buffer.from(String(req.body.data_base64 || ''), 'base64');
    if (!buf.length) return res.send('<div class="flash err">The file is empty or the upload failed.</div>');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.send('<div class="flash err">No rows found in the file.</div>');

    const keys = Object.keys(rows[0]).map((k) => [k, k.toLowerCase().replace(/[^a-z]/g, '')]);
    const find = (cands) => { const hit = keys.find(([, n]) => cands.includes(n)); return hit ? hit[0] : null; };
    const kName = find(['name', 'leadname', 'customername', 'fullname']);
    const kMobile = find(['mobile', 'mobilenumber', 'phone', 'phonenumber', 'number', 'contact', 'contactnumber']);
    const kCity = find(['city', 'location']);
    const kEmail = find(['email', 'emailid']);
    const kSource = find(['source', 'leadsource']);
    if (!kName || !kMobile) return res.send('<div class="flash err">The header must contain <b>Name</b> and <b>Mobile</b> columns — please check the file.</div>');

    const fields = d.prepare('SELECT * FROM custom_fields WHERE workspace_id=?').all(u.workspace_id);
    const fieldKey = {};
    fields.forEach((f) => { const hit = keys.find(([, n]) => n === f.name.toLowerCase().replace(/[^a-z]/g, '')); if (hit) fieldKey[f.id] = hit[0]; });

    const stNew = d.prepare('SELECT id FROM statuses WHERE workspace_id=? ORDER BY sort LIMIT 1').get(u.workspace_id);
    const assignSel = String(req.body.assign || '');
    const emps = d.prepare("SELECT id FROM users WHERE workspace_id=? AND role='employee' AND active=1 ORDER BY id").all(u.workspace_id);
    let rr = 0;
    const assignFor = () => {
      if (assignSel === 'roundrobin' && emps.length) return emps[(rr++) % emps.length].id;
      if (assignSel && assignSel !== 'roundrobin') { const n = Number(assignSel); if (emps.some((e) => e.id === n) || u.role !== 'employee') return n; }
      if (u.role === 'employee') return u.id;
      return null;
    };

    const insLead = d.prepare(`INSERT INTO leads (workspace_id, name, mobile, city, email, source, status_id, assigned_to, priority, created_by, created_at, updated_at, last_activity_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insVal = d.prepare('INSERT INTO lead_custom_values (lead_id, field_id, value) VALUES (?,?,?)');
    const seen = new Set();
    // Plan lead limit: the import takes only as many leads as there is
    // room for; the remaining rows are counted as "limit skipped"
    // (the whole import is not blocked).
    const room = leadRoom(d, u.workspace_id);
    let added = 0, duplicates = 0, errors = 0, limitSkipped = 0;
    const errSamples = [];
    const tx = d.transaction(() => {
      rows.forEach((row, idx) => {
        const name = String(row[kName] || '').trim();
        const mobile = cleanMobile(row[kMobile]);
        if (!name || !validMobile(mobile)) { errors++; if (errSamples.length < 5) errSamples.push('Row ' + (idx + 2) + ': name/mobile is invalid'); return; }
        if (seen.has(mobile)) { duplicates++; return; }
        seen.add(mobile);
        const dup = d.prepare('SELECT id FROM leads WHERE workspace_id=? AND mobile=?').get(u.workspace_id, mobile);
        if (dup) { duplicates++; return; }
        if (room.limited && added >= room.left) { limitSkipped++; return; }
        const id = insLead.run(u.workspace_id, name, mobile, kCity ? String(row[kCity] || '').trim() || null : null,
          kEmail ? String(row[kEmail] || '').trim() || null : null, kSource ? String(row[kSource] || '').trim() || null : 'Import',
          stNew ? stNew.id : null, assignFor(), 'Warm', u.id, nowISO(), nowISO(), nowISO()).lastInsertRowid;
        Object.entries(fieldKey).forEach(([fid, key]) => { const v = String(row[key] ?? '').trim(); if (v) insVal.run(id, Number(fid), v); });
        added++;
      });
    });
    tx();
    d.prepare('INSERT INTO imports (workspace_id, user_id, filename, added, duplicates, errors, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(u.workspace_id, u.id, String(req.body.filename || 'file'), added, duplicates, errors, nowISO());
    res.send(`<div class="flash ok">✅ Import complete — <b>${added}</b> leads added, <b>${duplicates}</b> duplicates skipped, <b>${errors}</b> error rows.</div>
      ${limitSkipped ? `<div class="flash err">⛔ Your plan's lead limit (${room.max}) has been reached — <b>${limitSkipped}</b> rows were not added because of the limit. To raise the limit, upgrade your plan (please contact support).</div>` : ''}
      ${errSamples.length ? '<p class="small">' + errSamples.map(esc).join('<br>') + '</p>' : ''}
      <p><a class="btn sm" href="/leads">View Leads →</a></p>`);
  } catch (e) {
    res.send('<div class="flash err">Import failed: ' + esc(e.message) + '</div>');
  }
});

module.exports = r;

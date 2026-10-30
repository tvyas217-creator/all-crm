'use strict';
const express = require('express');
const XLSX = require('xlsx');
const { getDb, logEvent } = require('../db');
const { esc, nowISO, cleanMobile, validMobile, fmtDT } = require('../lib/util');
const { page } = require('../lib/layout');
const { requireAuth } = require('../lib/auth');

const r = express.Router();

r.get('/import', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  const past = d.prepare('SELECT i.*, un.name AS user_name FROM imports i LEFT JOIN users un ON un.id=i.user_id WHERE i.workspace_id=? ORDER BY i.id DESC LIMIT 10').all(u.workspace_id);
  const emps = d.prepare("SELECT * FROM users WHERE workspace_id=? AND role='employee' AND active=1 ORDER BY name").all(u.workspace_id);
  const body = `<h1>⬆️ Leads Import</h1>
  <div class="card">
    <p class="mut" style="margin-top:0">Excel (.xlsx) ya CSV file chunein. Pehli row me header hona chahiye — <b>Name</b> aur <b>Mobile</b> zaroori hain; City, Email, Source apne aap mil jayenge. Jo custom fields aapne banaye hain, unke naam wale column bhi mil jayenge. Duplicate number wali rows skip ho jayengi.</p>
    <label>File Chunein (.xlsx / .csv)</label>
    <input type="file" id="imp_file" accept=".xlsx,.xls,.csv">
    <label>Import ke baad leads kis ko assign karein?</label>
    <select id="imp_assign"><option value="">Unassigned rakhein</option>${u.role !== 'employee' ? '<option value="roundrobin">🔄 Round-Robin (sab employees)</option>' : ''}${emps.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
    <p style="margin-top:14px"><button class="btn" type="button" id="imp_btn" onclick="doImport()">⬆️ Import Karein</button></p>
    <div id="imp_out"></div>
    <script>
    function doImport(){
      var f=document.getElementById('imp_file').files[0];
      if(!f){alert('Pehle file chunein');return}
      var btn=document.getElementById('imp_btn');btn.disabled=true;btn.textContent='Import ho raha hai...';
      var rd=new FileReader();
      rd.onload=function(){
        var b64=String(rd.result).split(',')[1];
        fetch('/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:f.name,data_base64:b64,assign:document.getElementById('imp_assign').value})})
        .then(function(r){return r.text()}).then(function(html){document.getElementById('imp_out').innerHTML=html;btn.disabled=false;btn.textContent='⬆️ Import Karein'})
        .catch(function(e){alert('Import fail: '+e);btn.disabled=false});
      };
      rd.readAsDataURL(f);
    }</script>
  </div>
  <div class="card"><h3 style="margin-top:0">Pichle Imports</h3>
  ${past.length ? `<div class="tblwrap"><table><tr><th>File</th><th>Kisne</th><th>Added</th><th>Duplicate</th><th>Error</th><th>Samay</th></tr>${past.map((i) => `<tr><td>${esc(i.filename || '')}</td><td>${esc(i.user_name || '')}</td><td>${i.added}</td><td>${i.duplicates}</td><td>${i.errors}</td><td>${fmtDT(i.created_at)}</td></tr>`).join('')}</table></div>` : '<p class="mut">Abhi koi import nahi hua.</p>'}
  </div>`;
  res.send(page(req, { title: 'Import', body, active: 'import' }));
});

r.post('/import', requireAuth, (req, res) => {
  const d = getDb(); const u = req.user;
  try {
    const buf = Buffer.from(String(req.body.data_base64 || ''), 'base64');
    if (!buf.length) return res.send('<div class="flash err">File khaali hai ya upload fail hua.</div>');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.send('<div class="flash err">File me koi row nahi mili.</div>');

    const keys = Object.keys(rows[0]).map((k) => [k, k.toLowerCase().replace(/[^a-z]/g, '')]);
    const find = (cands) => { const hit = keys.find(([, n]) => cands.includes(n)); return hit ? hit[0] : null; };
    const kName = find(['name', 'leadname', 'customername', 'fullname']);
    const kMobile = find(['mobile', 'mobilenumber', 'phone', 'phonenumber', 'number', 'contact', 'contactnumber']);
    const kCity = find(['city', 'location']);
    const kEmail = find(['email', 'emailid']);
    const kSource = find(['source', 'leadsource']);
    if (!kName || !kMobile) return res.send('<div class="flash err">Header me <b>Name</b> aur <b>Mobile</b> column zaroori hain — file check karein.</div>');

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
    let added = 0, duplicates = 0, errors = 0;
    const errSamples = [];
    const tx = d.transaction(() => {
      rows.forEach((row, idx) => {
        const name = String(row[kName] || '').trim();
        const mobile = cleanMobile(row[kMobile]);
        if (!name || !validMobile(mobile)) { errors++; if (errSamples.length < 5) errSamples.push('Row ' + (idx + 2) + ': naam/mobile sahi nahi'); return; }
        if (seen.has(mobile)) { duplicates++; return; }
        seen.add(mobile);
        const dup = d.prepare('SELECT id FROM leads WHERE workspace_id=? AND mobile=?').get(u.workspace_id, mobile);
        if (dup) { duplicates++; return; }
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
    res.send(`<div class="flash ok">✅ Import complete — <b>${added}</b> leads jud gayi, <b>${duplicates}</b> duplicate skip, <b>${errors}</b> error rows.</div>
      ${errSamples.length ? '<p class="small">' + errSamples.map(esc).join('<br>') + '</p>' : ''}
      <p><a class="btn sm" href="/leads">Leads Dekhein →</a></p>`);
  } catch (e) {
    res.send('<div class="flash err">Import fail ho gaya: ' + esc(e.message) + '</div>');
  }
});

module.exports = r;

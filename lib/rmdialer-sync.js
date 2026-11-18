'use strict';
// RMDialer Recording Sync — pulls call recordings from the RMDialer Outbound
// API (GET /recordings) into call_recordings, matched to leads by phone
// number. Per-workspace token lives in workspace_settings ('rmdialer_token').
// The token is a secret: it is never rendered in full and never logged.
const { getDb, audit, logEvent } = require('../db');
const { cleanMobile, validMobile } = require('./util');
const { leadRoom } = require('./plans');

const DEFAULT_BASE = 'https://secure.wappblaster.com/api/datalake/outbound';
const MAX_PAGES = 500;

function apiBase() { return process.env.RMDIALER_API_BASE || DEFAULT_BASE; }
function retryWaitMs() { const n = parseInt(process.env.RMDIALER_RETRY_WAIT_MS || '', 10); return Number.isFinite(n) && n >= 0 ? n : 60000; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ---------- workspace settings (key/value) ----------
function getSetting(d, wsId, key) {
  const row = d.prepare('SELECT value FROM workspace_settings WHERE workspace_id=? AND key=?').get(wsId, key);
  return row ? row.value : null;
}
function setSetting(d, wsId, key, value) {
  d.prepare(`INSERT INTO workspace_settings (workspace_id, key, value) VALUES (?,?,?)
             ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value`)
    .run(wsId, key, value);
}
function getToken(d, wsId) {
  const t = getSetting(d, wsId, 'rmdialer_token');
  return t && t.trim() ? t.trim() : null;
}
function maskToken(token) {
  if (!token) return '';
  return '••••••••' + String(token).slice(-4);
}

// '2026-09-11T11:42:05+05:30' — the exact format the RMDialer API returns and
// accepts for updated_since. IST is always UTC+05:30 (no DST).
function istIsoString(date) {
  const ist = new Date(date.getTime() + 19800000);
  return ist.toISOString().slice(0, 19) + '+05:30';
}

function phone10Of(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-10) : null;
}

// Match a lead in the same workspace by the last 10 digits of its mobile.
function matchLeadId(d, wsId, phone10) {
  if (!phone10) return null;
  const row = d.prepare('SELECT id FROM leads WHERE workspace_id=? AND substr(mobile,-10)=? ORDER BY id LIMIT 1').get(wsId, phone10);
  return row ? row.id : null;
}

class SyncError extends Error {}

async function fetchPage(url, token) {
  const doFetch = () => fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  let res = await doFetch();
  if (res.status === 429) { // rate limit: 60 req/min per token — wait, retry once
    await sleep(retryWaitMs());
    res = await doFetch();
    if (res.status === 429) throw new SyncError('RMDialer rate limit reached (429). Please wait a minute and try again.');
  }
  if (res.status === 401) throw new SyncError('RMDialer rejected the API token (401). The token may have been regenerated in RMDialer — please paste the current token in Settings.');
  if (res.status === 403) throw new SyncError('The RMDialer API token is turned off (403). Please switch it on in RMDialer under Setup → Outbound API.');
  if (!res.ok) throw new SyncError('RMDialer API error (HTTP ' + res.status + '). Please try again in a little while.');
  const json = await res.json().catch(() => null);
  if (!json || json.success === false) throw new SyncError('RMDialer API error: ' + ((json && json.message) || 'unexpected response'));
  return json;
}

const running = new Set(); // workspace ids with a sync in flight

async function syncWorkspace(workspaceId, userId = null) {
  if (running.has(workspaceId)) return { skipped: true, reason: 'A sync is already running for this workspace.' };
  const d = getDb();
  const token = getToken(d, workspaceId);
  if (!token) return { skipped: true, reason: 'No RMDialer token saved for this workspace.' };
  running.add(workspaceId);
  const runStart = new Date(); // last_sync_at advances to the run START (per the API guide)
  try {
    const lastSync = getSetting(d, workspaceId, 'rmdialer_last_sync_at');
    let url = apiBase() + '/recordings?per_page=500' + (lastSync ? '&updated_since=' + encodeURIComponent(lastSync) : '');
    let fetched = 0, added = 0, updated = 0;

    const upsert = d.prepare(`INSERT INTO call_recordings
      (workspace_id, rmdialer_id, lead_id, phone, phone10, contact_name, recording_url, file_name, duration_seconds, recorded_at, recorded_by_name, call_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id, rmdialer_id) DO UPDATE SET
        lead_id=excluded.lead_id, phone=excluded.phone, phone10=excluded.phone10,
        contact_name=excluded.contact_name, recording_url=excluded.recording_url,
        file_name=excluded.file_name, duration_seconds=excluded.duration_seconds,
        recorded_at=excluded.recorded_at, recorded_by_name=excluded.recorded_by_name,
        call_id=excluded.call_id`);
    const findExisting = d.prepare('SELECT id, lead_id FROM call_recordings WHERE workspace_id=? AND rmdialer_id=?');

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const json = await fetchPage(url, token);
      const rows = Array.isArray(json.data) ? json.data : [];
      const tx = d.transaction(() => {
        rows.forEach((row) => {
          if (row == null || row.id == null) return;
          const phoneRaw = row.phone_number || (row.lead && row.lead.phone_number) || '';
          const p10 = phone10Of(phoneRaw);
          const existing = findExisting.get(workspaceId, row.id);
          const leadId = matchLeadId(d, workspaceId, p10) || (existing ? existing.lead_id : null);
          upsert.run(workspaceId, row.id, leadId, phoneRaw || null, p10,
            (row.lead && row.lead.name) || null, row.recording_url || null, row.file_name || null,
            row.duration_seconds != null ? Number(row.duration_seconds) : null,
            row.recorded_at || null, (row.recorded_by && row.recorded_by.name) || null,
            row.call_id != null ? String(row.call_id) : null, new Date().toISOString());
          if (existing) updated++; else added++;
          fetched++;
        });
      });
      tx();
      url = json.meta && json.meta.next_page_url ? json.meta.next_page_url : null;
    }

    // Leads may have arrived after a recording did — retry matching stragglers.
    const unmatched = d.prepare('SELECT id, phone10 FROM call_recordings WHERE workspace_id=? AND lead_id IS NULL').all(workspaceId);
    const setLead = d.prepare('UPDATE call_recordings SET lead_id=? WHERE id=?');
    unmatched.forEach((rec) => {
      const lid = matchLeadId(d, workspaceId, rec.phone10);
      if (lid) setLead.run(lid, rec.id);
    });

    const result = added + ' new recordings' + (updated ? ', ' + updated + ' updated' : '') + ' (' + fetched + ' fetched)';
    setSetting(d, workspaceId, 'rmdialer_last_sync_at', istIsoString(runStart));
    setSetting(d, workspaceId, 'rmdialer_last_sync_result', result);
    setSetting(d, workspaceId, 'rmdialer_last_error', '');
    audit(d, workspaceId, userId, 'rmdialer_sync', result);
    return { ok: true, fetched, added, updated, result };
  } catch (e) {
    const msg = e instanceof SyncError ? e.message
      : 'Could not reach RMDialer (' + (e && e.message ? e.message : 'network error') + '). Please try again in a little while.';
    try {
      setSetting(d, workspaceId, 'rmdialer_last_error', msg);
      audit(d, workspaceId, userId, 'rmdialer_sync_failed', msg);
    } catch (err) { /* never let error-recording crash the sync path */ }
    return { ok: false, error: msg };
  } finally {
    running.delete(workspaceId);
  }
}

// ---------- Lead sync (GET /leads) ----------
// Mirrors the lead webhook in routes/api.js: dedupe by (workspace, mobile) —
// an existing lead is skipped, never overwritten; first status as default;
// least-loaded active employee as fallback assignee. RMDialer-only fields
// that have no column here (company) land on the lead timeline as a note.
const runningLeads = new Set(); // workspace ids with a lead sync in flight

function statusLabelOf(row) {
  const s = row.status;
  if (!s) return '';
  if (typeof s === 'string') return s.trim();
  return String(s.name || s.label || '').trim();
}

function resolveAssignee(d, wsId, assignedTo) {
  if (assignedTo) {
    if (assignedTo.email) {
      const byEmail = d.prepare("SELECT id FROM users WHERE workspace_id=? AND role='employee' AND active=1 AND LOWER(email)=LOWER(?) ORDER BY id LIMIT 1").get(wsId, String(assignedTo.email).trim());
      if (byEmail) return byEmail.id;
    }
    if (assignedTo.name) {
      const byName = d.prepare("SELECT id FROM users WHERE workspace_id=? AND role='employee' AND active=1 AND LOWER(name)=LOWER(?) ORDER BY id LIMIT 1").get(wsId, String(assignedTo.name).trim());
      if (byName) return byName.id;
    }
  }
  const emps = d.prepare("SELECT u.id, (SELECT COUNT(*) FROM leads l WHERE l.assigned_to=u.id) n FROM users u WHERE u.workspace_id=? AND u.role='employee' AND u.active=1 ORDER BY n ASC, u.id ASC").all(wsId);
  return emps.length ? emps[0].id : null;
}

async function syncLeads(workspaceId, userId = null) {
  if (runningLeads.has(workspaceId)) return { skipped: true, reason: 'A lead sync is already running for this workspace.' };
  const d = getDb();
  const token = getToken(d, workspaceId);
  if (!token) return { skipped: true, reason: 'No RMDialer token saved for this workspace.' };
  runningLeads.add(workspaceId);
  const runStart = new Date();
  try {
    const lastSync = getSetting(d, workspaceId, 'rmdialer_leads_last_sync_at');
    let url = apiBase() + '/leads?per_page=500' + (lastSync ? '&updated_since=' + encodeURIComponent(lastSync) : '');
    let fetched = 0, inserted = 0, skippedDuplicate = 0, skippedInvalid = 0, skippedLimit = 0;

    const statuses = d.prepare('SELECT id, name FROM statuses WHERE workspace_id=? ORDER BY sort, id').all(workspaceId);
    const firstStatusId = statuses.length ? statuses[0].id : null;
    const findDup = d.prepare('SELECT id FROM leads WHERE workspace_id=? AND mobile=?');
    const insLead = d.prepare(`INSERT INTO leads (workspace_id, name, mobile, email, city, source, status_id, assigned_to, priority, created_at, updated_at, last_activity_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const json = await fetchPage(url, token);
      const rows = Array.isArray(json.data) ? json.data : [];
      rows.forEach((row) => {
        if (row == null) return;
        fetched++;
        const mobile = cleanMobile(row.phone_number || '');
        if (!validMobile(mobile)) { skippedInvalid++; return; }
        if (findDup.get(workspaceId, mobile)) { skippedDuplicate++; return; }
        if (!leadRoom(d, workspaceId).ok) { skippedLimit++; return; }
        const label = statusLabelOf(row);
        const matchedStatus = label ? statuses.find((s) => s.name.toLowerCase() === label.toLowerCase()) : null;
        const createdRaw = row.created_at && !isNaN(new Date(row.created_at).getTime()) ? new Date(row.created_at).toISOString() : new Date().toISOString();
        const leadId = insLead.run(workspaceId, String(row.name || '').trim() || 'Unknown', mobile,
          row.email || null, row.city || null, String(row.source || '').trim() || 'RMDialer',
          matchedStatus ? matchedStatus.id : firstStatusId,
          resolveAssignee(d, workspaceId, row.assigned_to), 'Warm', createdRaw, createdRaw, createdRaw).lastInsertRowid;
        logEvent(d, leadId, userId, 'created', 'Lead synced from RMDialer');
        const company = String(row.company || row.company_name || '').trim();
        if (company) logEvent(d, leadId, userId, 'note', 'Company: ' + company + ' (from RMDialer)');
        inserted++;
      });
      url = json.meta && json.meta.next_page_url ? json.meta.next_page_url : null;
    }

    const result = inserted + ' new leads (' + skippedDuplicate + ' duplicates skipped, ' + skippedInvalid + ' invalid skipped'
      + (skippedLimit ? ', ' + skippedLimit + ' over plan limit' : '') + '; ' + fetched + ' fetched)';
    setSetting(d, workspaceId, 'rmdialer_leads_last_sync_at', istIsoString(runStart));
    setSetting(d, workspaceId, 'rmdialer_leads_last_result', result);
    setSetting(d, workspaceId, 'rmdialer_leads_last_error', '');
    audit(d, workspaceId, userId, 'rmdialer_leads_sync', result);
    return { ok: true, fetched, inserted, skipped_duplicate: skippedDuplicate, skipped_invalid: skippedInvalid, skipped_limit: skippedLimit, result };
  } catch (e) {
    const msg = e instanceof SyncError ? e.message
      : 'Could not reach RMDialer (' + (e && e.message ? e.message : 'network error') + '). Please try again in a little while.';
    try {
      setSetting(d, workspaceId, 'rmdialer_leads_last_error', msg);
      audit(d, workspaceId, userId, 'rmdialer_leads_sync_failed', msg);
    } catch (err) { /* never let error-recording crash the sync path */ }
    return { ok: false, error: msg };
  } finally {
    runningLeads.delete(workspaceId);
  }
}

// Every 15 minutes: sync every workspace that has a token saved — leads
// first, then recordings, so the recordings pass can match recordings to
// leads that have only just arrived.
function startScheduler() {
  const run = async () => {
    try {
      const d = getDb();
      const rows = d.prepare("SELECT workspace_id FROM workspace_settings WHERE key='rmdialer_token' AND value IS NOT NULL AND value<>''").all();
      for (const row of rows) {
        // Recordings sync automatically. Lead sync is MANUAL ONLY (Settings
        // button) — Tarun's explicit instruction, 18 Nov 2026: no automatic
        // lead pushes into a workspace.
        try { await syncWorkspace(row.workspace_id); } catch (e) { /* syncWorkspace records its own errors */ }
      }
    } catch (e) {
      console.error('[rmdialer-sync] scheduler error:', e.message);
    }
  };
  const timer = setInterval(run, 15 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { syncWorkspace, syncLeads, startScheduler, getSetting, setSetting, getToken, maskToken, istIsoString, phone10Of };

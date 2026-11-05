'use strict';
// Plans / subscriptions helpers — current subscription, workspace access
// gate (pending / rejected / suspended / expired) and plan limit checks.
// NULL validity_days = never expires; NULL max_* = unlimited.

// Current subscription = latest subscriptions row, joined with its plan.
function currentSub(d, wsId) {
  return d.prepare(`SELECT s.id, s.workspace_id, s.plan_id, s.starts_at, s.expires_at, s.note, s.created_by, s.created_at,
      p.name AS plan_name, p.price AS plan_price, p.validity_days, p.max_employees, p.max_leads
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.workspace_id = ? ORDER BY s.id DESC LIMIT 1`).get(wsId) || null;
}

function subExpired(sub) {
  return !!(sub && sub.expires_at && new Date(sub.expires_at).getTime() <= Date.now());
}

// Whole days left (negative when already expired); null = never expires.
function daysLeft(sub) {
  if (!sub || !sub.expires_at) return null;
  return Math.ceil((new Date(sub.expires_at).getTime() - Date.now()) / 86400000);
}

// Can this workspace's users log in / keep working right now?
function workspaceAccess(d, wsId) {
  const ws = d.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  if (!ws) return { ok: false, reason: 'missing', msg: 'Account not found. Please contact support.' };
  if (ws.status === 'pending') return { ok: false, reason: 'pending', msg: 'Approval pending — your company registration is waiting for approval. You can log in as soon as it is approved.' };
  if (ws.status === 'rejected') return { ok: false, reason: 'rejected', msg: 'Sorry, your signup request was not approved. Please contact support.' };
  if (ws.status === 'suspended') return { ok: false, reason: 'suspended', msg: 'Account suspended — please contact support' };
  const sub = currentSub(d, wsId);
  if (subExpired(sub)) return { ok: false, reason: 'expired', msg: 'Plan expired — please contact support' };
  return { ok: true, ws, sub };
}

function userCount(d, wsId) {
  return d.prepare('SELECT COUNT(*) c FROM users WHERE workspace_id=?').get(wsId).c;
}
function leadCount(d, wsId) {
  return d.prepare('SELECT COUNT(*) c FROM leads WHERE workspace_id=?').get(wsId).c;
}

// { limited, max, used, left, ok } — left is Infinity when unlimited.
function roomFor(used, max) {
  if (max === null || max === undefined) return { limited: false, max: null, used, left: Infinity, ok: true };
  const left = Math.max(0, max - used);
  return { limited: true, max, used, left, ok: left > 0 };
}
function employeeRoom(d, wsId) {
  const sub = currentSub(d, wsId);
  return roomFor(userCount(d, wsId), sub ? sub.max_employees : null);
}
function leadRoom(d, wsId) {
  const sub = currentSub(d, wsId);
  return roomFor(leadCount(d, wsId), sub ? sub.max_leads : null);
}

// Create a new current subscription row for a workspace on a plan.
// extend=true renews from the current expiry when it is still in the future
// (no paid days are lost); otherwise the period starts now.
function assignPlan(d, wsId, planId, createdBy, note, extend) {
  const plan = d.prepare('SELECT * FROM plans WHERE id=?').get(planId);
  if (!plan) return null;
  const now = new Date();
  let start = now;
  if (extend) {
    const cur = currentSub(d, wsId);
    if (cur && cur.expires_at && new Date(cur.expires_at).getTime() > now.getTime()) start = new Date(cur.expires_at);
  }
  const expires = plan.validity_days === null || plan.validity_days === undefined
    ? null
    : new Date(start.getTime() + plan.validity_days * 86400000).toISOString();
  const id = d.prepare('INSERT INTO subscriptions (workspace_id, plan_id, starts_at, expires_at, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(wsId, plan.id, start.toISOString(), expires, note || null, createdBy || 'super', now.toISOString()).lastInsertRowid;
  return d.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
}

module.exports = { currentSub, subExpired, daysLeft, workspaceAccess, userCount, leadCount, employeeRoom, leadRoom, assignPlan };

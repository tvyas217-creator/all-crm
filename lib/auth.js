'use strict';
const { getDb } = require('../db');

// Attach req.user from session; keep last_active_at fresh (throttled to 60s).
function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    const d = getDb();
    const u = d.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
    if (u && u.active) {
      req.user = u;
      const last = u.last_active_at ? new Date(u.last_active_at).getTime() : 0;
      if (Date.now() - last > 60000) {
        d.prepare('UPDATE users SET last_active_at=? WHERE id=?').run(new Date().toISOString(), u.id);
      }
    } else if (u && !u.active) {
      req.session.destroy(() => {});
    }
  }
  res.locals.user = req.user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) {
      req.session.flash = { type: 'err', msg: 'Aapko is page ki permission nahi hai.' };
      return res.redirect('/');
    }
    next();
  };
}

// Can the current user see/act on this lead?
function canAccessLead(user, lead) {
  if (!lead) return false;
  if (lead.workspace_id !== user.workspace_id) return false;
  if (user.role === 'employee') return lead.assigned_to === user.id;
  return true;
}

module.exports = { loadUser, requireAuth, requireRole, canAccessLead };

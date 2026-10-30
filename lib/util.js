'use strict';
// Shared helpers: HTML escaping, IST time handling, mobile normalisation.
const TZ = 'Asia/Kolkata';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function nowISO() { return new Date().toISOString(); }

const _dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function istDate(d = new Date()) { return _dateFmt.format(d); } // 'YYYY-MM-DD' in IST

// [startISO, endISO) UTC instants covering one IST calendar date.
function istDayRange(dateStr) {
  const start = new Date(dateStr + 'T00:00:00+05:30');
  return [start.toISOString(), new Date(start.getTime() + 86400000).toISOString()];
}

function addDaysIST(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00+05:30');
  d.setUTCDate(d.getUTCDate() + n);
  return istDate(d);
}

// IST wall-clock -> UTC ISO. time = 'HH:MM'
function istToISO(dateStr, time = '10:00') {
  return new Date(dateStr + 'T' + time + ':00+05:30').toISOString();
}

const _dtFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
const _dFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
const _tFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
function fmtDT(iso) { return iso ? _dtFmt.format(new Date(iso)) : '—'; }
function fmtD(iso) { return iso ? _dFmt.format(new Date(iso)) : '—'; }
function fmtT(iso) { return iso ? _tFmt.format(new Date(iso)) : '—'; }

function timeAgo(iso) {
  if (!iso) return 'kabhi nahi';
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + ' sec pehle';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min pehle';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' ghante pehle';
  const d = Math.floor(h / 24);
  return d + ' din pehle';
}

// Normalise an Indian mobile to 10 digits ( strips +91 / 0 prefixes ).
function cleanMobile(raw) {
  let m = String(raw ?? '').replace(/\D/g, '');
  if (m.length > 10 && m.startsWith('91')) m = m.slice(m.length - 10);
  if (m.length === 11 && m.startsWith('0')) m = m.slice(1);
  return m;
}
function validMobile(m) { return /^[6-9]\d{9}$/.test(m); }

function paginate(req, total, perPage = 20) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  let page = parseInt(req.query.page || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > pages) page = pages;
  return { page, pages, perPage, offset: (page - 1) * perPage };
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

module.exports = {
  TZ, esc, nowISO, istDate, istDayRange, addDaysIST, istToISO, fmtDT, fmtD, fmtT,
  timeAgo, cleanMobile, validMobile, paginate, qs,
};

'use strict';
const { esc } = require('./util');
const { getDb } = require('../db');
const { istDate, istDayRange } = require('./util');

const CSS = `
:root{--green:#0e9f6e;--green-d:#0b7a56;--blue:#2563eb;--ink:#0f172a;--mut:#64748b;--bg:#f1f5f9;--card:#fff;--line:#e2e8f0;--red:#dc2626;--amber:#f59e0b;--radius:14px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Devanagari',sans-serif;background:var(--bg);color:var(--ink);font-size:16px}
a{color:var(--blue);text-decoration:none}
.topbar{position:fixed;top:0;left:0;right:0;height:56px;background:linear-gradient(90deg,#0b7a56,#2563eb);color:#fff;display:flex;align-items:center;gap:12px;padding:0 16px;z-index:40}
.logo{font-weight:800;font-size:20px;color:#fff;display:flex;align-items:center;gap:8px}
.logo .dot{width:28px;height:28px;border-radius:8px;background:#fff;color:#0b7a56;display:inline-flex;align-items:center;justify-content:center;font-size:16px}
.topbar .sp{flex:1}
.topbar .who{font-size:14px;opacity:.95;text-align:right;line-height:1.2}
.topbar .who small{display:block;opacity:.8;font-size:12px}
.sidebar{display:none}
.main{padding:72px 14px 92px;max-width:1100px;margin:0 auto}
@media(min-width:900px){
 .sidebar{display:block;position:fixed;top:56px;bottom:0;left:0;width:228px;background:#fff;border-right:1px solid var(--line);padding:14px 10px;overflow:auto}
 .sidebar a{display:flex;gap:10px;align-items:center;padding:11px 12px;border-radius:10px;color:var(--ink);font-weight:600;margin-bottom:2px}
 .sidebar a.on{background:#e8f7f1;color:var(--green-d)}
 .sidebar a .bdg{margin-left:auto}
 .main{margin-left:228px;padding:72px 22px 40px}
 .bottomnav{display:none!important}
}
.bottomnav{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);display:flex;z-index:40;padding-bottom:env(safe-area-inset-bottom)}
.bottomnav a{flex:1;text-align:center;padding:8px 2px 7px;color:var(--mut);font-size:11.5px;font-weight:600;position:relative}
.bottomnav a .ic{display:block;font-size:21px;line-height:1.15}
.bottomnav a.on{color:var(--green-d)}
.bdg{display:inline-block;min-width:19px;height:19px;line-height:19px;border-radius:10px;background:var(--red);color:#fff;font-size:11.5px;font-weight:700;text-align:center;padding:0 5px}
.bottomnav .bdg{position:absolute;top:3px;right:calc(50% - 21px)}
h1{font-size:22px;margin:4px 0 14px}h2{font-size:18px;margin:20px 0 10px}h3{font-size:16px;margin:14px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:14px}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px}
@media(min-width:700px){.stats{grid-template-columns:repeat(4,1fr)}}
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px}
.stat .n{font-size:27px;font-weight:800;line-height:1.1}
.stat .l{color:var(--mut);font-size:13.5px;font-weight:600}
.stat.red .n{color:var(--red)}.stat.green .n{color:var(--green-d)}.stat.amber .n{color:#b45309}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--green);color:#fff;border:0;border-radius:11px;padding:12px 18px;font-size:16px;font-weight:700;cursor:pointer;min-height:48px}
.btn:hover{background:var(--green-d)}.btn.blue{background:var(--blue)}.btn.blue:hover{background:#1d4ed8}
.btn.ghost{background:#fff;color:var(--ink);border:1.5px solid var(--line)}.btn.ghost:hover{border-color:var(--mut)}
.btn.red{background:var(--red)}.btn.sm{min-height:38px;padding:7px 13px;font-size:14px;border-radius:9px}
.btn.block{width:100%}.btn:disabled{opacity:.55}
input,select,textarea{width:100%;padding:12px;border:1.5px solid var(--line);border-radius:10px;font-size:16px;background:#fff;min-height:48px;font-family:inherit}
textarea{min-height:84px}label{font-weight:600;font-size:14px;display:block;margin:12px 0 5px}
label:first-child{margin-top:0}
.grid2{display:grid;gap:0 14px}@media(min-width:700px){.grid2{grid-template-columns:1fr 1fr}}
table{width:100%;border-collapse:collapse;font-size:14.5px}
th,td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mut);font-size:12.5px;text-transform:uppercase;letter-spacing:.03em}
.tblwrap{overflow-x:auto}
.chip{display:inline-block;padding:2.5px 10px;border-radius:20px;color:#fff;font-size:12.5px;font-weight:700;white-space:nowrap}
.tag{display:inline-block;background:#e0f2fe;color:#075985;padding:2px 9px;border-radius:14px;font-size:12.5px;font-weight:600;margin:1px 2px}
.prio-Hot{color:#dc2626;font-weight:800}.prio-Warm{color:#b45309;font-weight:700}.prio-Cold{color:#64748b;font-weight:700}
.flash{padding:12px 15px;border-radius:11px;margin-bottom:14px;font-weight:600}
.flash.ok{background:#dcfce7;color:#166534}.flash.err{background:#fee2e2;color:#991b1b}
.mut{color:var(--mut)}.small{font-size:13px}.right{text-align:right}.center{text-align:center}
.rowflex{display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.leadrow{display:flex;gap:11px;align-items:center;padding:12px 4px;border-bottom:1px solid var(--line)}
.leadrow .info{flex:1;min-width:0}.leadrow .nm{font-weight:700;font-size:16.5px}
.leadrow .sub{color:var(--mut);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.callbtn{width:50px;height:50px;border-radius:50%;background:var(--green);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:22px;border:0;cursor:pointer;flex:none}
.wabtn{width:50px;height:50px;border-radius:50%;background:#25d366;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:22px;border:0;cursor:pointer;flex:none}
.tl{position:relative;margin:6px 0 0;padding-left:20px}
.tl:before{content:'';position:absolute;left:6px;top:6px;bottom:6px;width:2px;background:var(--line)}
.tl .ev{position:relative;padding:9px 0 9px 6px;border-bottom:1px dashed var(--line)}
.tl .ev:before{content:'';position:absolute;left:-19px;top:15px;width:10px;height:10px;border-radius:50%;background:var(--green)}
.tl .ev .when{color:var(--mut);font-size:12.5px}
.pager{display:flex;gap:8px;justify-content:center;margin:16px 0}
.pager a,.pager span{padding:9px 14px;border:1.5px solid var(--line);border-radius:9px;background:#fff;font-weight:600}
.pager .cur{background:var(--green);color:#fff;border-color:var(--green)}
.statuschips{display:flex;flex-wrap:wrap;gap:8px}
.statuschips label{margin:0}
.statuschips input{display:none}
.statuschips span{display:inline-block;padding:11px 15px;border:2px solid var(--line);border-radius:24px;font-weight:700;cursor:pointer;background:#fff}
.statuschips input:checked+span{border-color:var(--green-d);background:#e8f7f1;color:var(--green-d)}
.quickchips{display:flex;flex-wrap:wrap;gap:7px;margin-top:7px}
.quickchips button{background:#f1f5f9;border:1px solid var(--line);border-radius:16px;padding:7px 12px;font-size:13.5px;cursor:pointer;font-weight:600}
.bigcall{text-align:center;padding:26px 10px}
.bigcall .num{font-size:31px;font-weight:800;letter-spacing:.5px;margin:8px 0}
.overdue{color:var(--red);font-weight:700}
.due-today{color:#b45309;font-weight:700}
details.fold{border:1px solid var(--line);border-radius:11px;padding:11px 13px;margin:12px 0;background:#fbfdff}
details.fold summary{font-weight:700;cursor:pointer}
.kv{display:grid;grid-template-columns:130px 1fr;gap:5px 12px;font-size:15px}
.kv dt{color:var(--mut);font-weight:600}.kv dd{margin:0}
input[type=checkbox],input[type=radio]{width:22px;height:22px;min-height:0;vertical-align:middle}
.checkcell{width:34px}
.loginwrap{max-width:400px;margin:9vh auto;padding:0 16px}
.progressnote{background:#fffbeb;border:1px solid #fde68a;border-radius:11px;padding:11px 14px;font-size:14px;margin-bottom:14px}
`;

function badgesFor(user) {
  const d = getDb();
  const today = istDate();
  const [t0, t1] = istDayRange(today);
  let fu = 0, pending = 0;
  if (user) {
    fu = d.prepare('SELECT COUNT(*) c FROM follow_ups WHERE user_id=? AND done=0 AND due_at<?').get(user.id, t1).c;
    pending = d.prepare("SELECT COUNT(*) c FROM calls WHERE user_id=? AND state='started'").get(user.id).c;
  }
  return { fu, pending };
}

function navItems(user) {
  const items = [
    ['/', '🏠', 'Home', 'home'],
    ['/leads', '👥', 'Leads', 'leads'],
    ['/dialer', '📞', 'Dialer', 'dialer'],
    ['/followups', '⏰', 'Follow-up', 'followups'],
    ['/pending', '📝', 'Disposition', 'pending'],
  ];
  if (user && (user.role === 'manager' || user.role === 'admin')) {
    items.push(['/team', '📡', 'Live Team', 'team'], ['/reports', '📊', 'Reports', 'reports'], ['/lost', '🧊', 'Lost Leads', 'lost']);
  }
  items.push(['/import', '⬆️', 'Import', 'import']);
  if (user && user.role === 'admin') items.push(['/templates', '💬', 'WA Templates', 'templates'], ['/settings', '⚙️', 'Settings', 'settings']);
  else if (user && user.role === 'manager') items.push(['/templates', '💬', 'WA Templates', 'templates']);
  return items;
}

function page(req, { title, body, active = '' }) {
  const user = req.user;
  const flash = req.session ? req.session.flash : null;
  if (req.session) req.session.flash = null;
  const b = user ? badgesFor(user) : { fu: 0, pending: 0 };
  const items = user ? navItems(user) : [];
  const bottom = [
    ['/', '🏠', 'Home', 'home', 0],
    ['/leads', '👥', 'Leads', 'leads', 0],
    ['/dialer', '📞', 'Dialer', 'dialer', 0],
    ['/followups', '⏰', 'Follow-up', 'followups', b.fu],
    ['/pending', '📝', 'Baaki', 'pending', b.pending],
  ];
  return `<!DOCTYPE html><html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · All CRM</title>
<meta name="theme-color" content="#0b7a56">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="All CRM">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>${CSS}</style></head><body>
${user ? `<div class="topbar"><a class="logo" href="/"><span class="dot">A</span>All CRM</a><div class="sp"></div>
<div class="who">${esc(user.name)}<small>${esc(user.role)} · ${esc(user.email)}</small></div>
<form method="post" action="/logout" style="margin:0"><button class="btn sm ghost" type="submit">Logout</button></form></div>
<nav class="sidebar">${items.map(([href, ic, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}"><span>${ic}</span>${label}${key === 'followups' && b.fu ? `<span class="bdg">${b.fu}</span>` : ''}${key === 'pending' && b.pending ? `<span class="bdg">${b.pending}</span>` : ''}</a>`).join('')}</nav>
<nav class="bottomnav">${bottom.map(([href, ic, label, key, n]) => `<a href="${href}" class="${active === key ? 'on' : ''}"><span class="ic">${ic}</span>${label}${n ? `<span class="bdg">${n}</span>` : ''}</a>`).join('')}</nav>` : ''}
<main class="main">
${flash ? `<div class="flash ${flash.type === 'err' ? 'err' : 'ok'}">${esc(flash.msg)}</div>` : ''}
${body}
</main>
<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}</script>
</body></html>`;
}

function statusChip(st) {
  if (!st) return '<span class="chip" style="background:#94a3b8">No Status</span>';
  return `<span class="chip" style="background:${esc(st.color)}">${esc(st.name)}</span>`;
}

module.exports = { page, statusChip, CSS };

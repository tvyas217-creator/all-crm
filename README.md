# All CRM — Phase 1

**Har lead, har call, har follow-up — ek hi jagah.**
A mobile-first telecalling + sales CRM that runs in the phone and PC browser. Employees call from their **own SIM** (the Call button opens the phone's normal dialer via `tel:`), and the CRM captures the outcome in a 2–3 tap after-call sheet. Managers see everything live on the web.

Built exactly to `~/workspace/all-crm/SPEC.md` Phase 1. Stack: **Node 24 + Express 4 + SQLite (better-sqlite3)** — server-rendered pages, no build step, no frontend framework.

---

## Run locally

```bash
cd app
npm install
npm start            # http://localhost:3000
```

- Port: `process.env.PORT || 3000`
- Database file: `process.env.DATA_DIR || ./data` → `data/allcrm.db` (auto-created)
- On first boot the DB is seeded automatically (idempotent): demo workspace, 10 statuses, 4 demo users, 30 sample Indian leads, sample calls/follow-ups, 2 WhatsApp templates.
- Set `SESSION_SECRET` in production.

## Deploy on Render

1. Push this `app/` folder as the root of a GitHub repo (or set the service Root Directory to `app`).
2. Create a **Web Service** → Runtime: **Node**, Build Command: `npm install`, Start Command: `npm start`.
3. Environment variables:
   - `SESSION_SECRET` = any long random string
   - `DATA_DIR` = `/var/data` **only if** you attach a persistent disk (see caveat)
4. Render sets `PORT` automatically — the app already uses it.

> ⚠️ **Free-tier caveat:** Render's free plan has no persistent disk and sleeps when idle — the SQLite data can reset on redeploy/restart. For real team use, attach a Render Disk and set `DATA_DIR` to its mount path, or use the in-app **Settings → Backup Download** regularly. (Phase 3 can move the DB to hosted Postgres.)

## Demo accounts (seeded)

| Role | Email | Password | Sees |
|---|---|---|---|
| Admin | `admin@allcrm.local` | `Admin@123` | Everything + Settings, users, backup |
| Manager | `manager@allcrm.local` | `Manager@123` | Whole workspace, team board, reports |
| Employee | `emp1@allcrm.local` | `Emp@123` | Only own leads (Rahul Verma) |
| Employee | `emp2@allcrm.local` | `Emp@123` | Only own leads (Sneha Kulkarni) |

Change these passwords after first login (Settings → Users → Reset).

## Super Admin (owner-only panel)

**URL:** `/super/login` — completely separate from company logins; workspace users cannot open it.

| | |
|---|---|
| Email | `owner@allcrm.local` |
| Default password | `Owner@123` |

> ⚠️ **Change this password immediately** after first login (Super panel → "🔑 Mera Password"). Anyone with it controls every company on the platform.

From the Super panel the owner can:

- **Dashboard** — total companies (active / trial / expired / suspended / pending), total users, total leads, this week's signups, and a "expiring within 3 days" list.
- **Clients** — every company with owner name/email/mobile, team size, lead count, current plan, expiry, status and last activity; search + status filter. Per company: **Approve / Reject** pending signups, **Suspend** (login blocked, data untouched) / **Reactivate**, **Assign or change plan**, **Renew** (extends from current expiry — no days lost), **Extend by N days**, **reset the company admin's password** (temporary password shown once), and **Delete workspace** (hard delete, requires typing the exact company name).
- **Plans** — create/edit/deactivate plans (name, ₹ price, validity days, max team size, max leads; blank = unlimited / never expires). Plans are never hard-deleted.

### Plans seeded on first boot

| Plan | Price | Validity | Max team | Max leads | Notes |
|---|---|---|---|---|---|
| Legacy | ₹0 | never | unlimited | unlimited | Auto-assigned to every pre-billing workspace (grandfathering) |
| Trial | ₹0 | 3 days | 5 | 200 | Starts when a new signup is **approved** |
| Basic | ₹499 | 30 days | 10 | 2000 | Placeholder pricing — edit in the panel |
| Pro | ₹999 | 30 days | unlimited | unlimited | Placeholder pricing — edit in the panel |

### Signup approval flow

Public `/register` now creates the company in **pending** state (owner sees a "request received" page; login is blocked with an "Approval pending" message). The Super Admin approves it → the 3-day **Trial** starts at the approval moment. Reject → login stays blocked with a polite message. Company admins see their own plan, expiry, days-left and usage (team/leads vs limits) read-only in **Settings → Mera Plan**.

Enforcement: suspended or plan-expired workspaces are blocked at login and their live sessions are cut on the next request ("Account suspended — contact support" / "Plan expired — contact support"). Team-size and lead limits are enforced on user creation, lead add, CSV import (imports fill up to the limit and report how many rows were skipped) and the lead webhook.

**Grandfathering:** every workspace that existed before this billing layer (including the demo workspace) automatically received the never-expiring **Legacy** plan on first boot of the new code — no existing customer was locked out by the upgrade.

## Features (all working, no dummy buttons)

- **Auth & roles** — bcrypt passwords, sessions; employees see only their own leads everywhere (list, search, detail, follow-ups).
- **Dashboards** — employee (my leads, today's calls + connected, follow-ups due, pending dispositions, weekly performance) and manager/admin (totals, unassigned count, status funnel, per-employee today table, live activity feed). Feed auto-refreshes every 10 s via `/api/live`.
- **Leads** — CRUD, search (name/mobile/city), filters (status, source, assigned, priority, tag, follow-up due), pagination, bulk select, custom fields (text/number/dropdown/date), tags, Hot/Warm/Cold priority, duplicate-mobile check on add **and** import, exactly-one-owner rule, transfer with history.
- **Lead timeline** — one chronological feed: calls, remarks, status changes, transfers, follow-ups, WhatsApp sends, notes.
- **Calling flow (SPEC 3.5)** — Call button → server logs a `started` call instantly (manager sees "on call") → phone dialer opens (`tel:`) → **Pending Dispositions** + after-call sheet: one-tap status chips, remark + quick chips, follow-up presets (tomorrow / +2 days / next week / custom date), optional duration → saved record appears on timeline + manager feed immediately. Manual "+ Log Call" (incoming/outgoing) also supported.
- **Auto Dialer** — start a session from a filter; one lead at a time (caller screen with last remark + history); Call Now → disposition → auto-advance; Skip; **Not Picked / Busy / Switched Off go to a redial queue** and are re-offered in the same session (attempts limit from Settings); end-of-session summary (attempted / connected / follow-ups / skipped).
- **Follow-ups** — Today / Overdue / Upcoming tabs, team view for managers, mark done / reschedule inline, call straight from the list.
- **Monitoring** — Live Team Board (calls today, connected, follow-ups due, last activity, on-call state from open `started` calls), Reports (date range; per-employee calls/connected/connect %/follow-ups/talk time; per-status counts), **Lost leads** (status Lost OR no activity in X days — X in Settings, default 7).
- **WhatsApp (Phase 1 mode)** — admin-managed templates with `{{name}} {{city}} {{source}} {{mobile}}` variables; lead page → pick template → opens `wa.me` with the rendered message → the send is logged on the timeline. (Sends go from the employee's own WhatsApp — no API in Phase 1. Only for opted-in contacts.)
- **Import / Export** — CSV + XLSX upload with header auto-match (name, mobile, city, email, source + custom-field columns), duplicate skip, import report (added/duplicates/errors) and import history; optional assign-to / round-robin on import; filtered CSV export.
- **Assignment** — bulk assign + round-robin of selected/unassigned leads across chosen employees.
- **Settings (admin)** — company name, statuses editor (name/color/connected flag/order, delete only when unused), custom fields editor, redial attempts, lost-lead days, user management (add / disable / reset password), **DB backup download + restore**, and the webhook API token.
- **Lead webhook (Phase-3 ready)** — `POST /api/webhook/leads` with header `x-api-token: <token from Settings>` and JSON `{name, mobile, city, email, source}` → creates a lead (duplicate-safe) and auto-assigns round-robin.
- **PWA** — manifest ("All CRM", standalone, green/blue), service worker (shell cache + offline page), mobile meta tags → installable on phone home screens. Mobile UI: bottom nav; desktop: sidebar.

## Honest Phase-1 limits (from the SPEC, told upfront)

A web browser **cannot** read the phone's SIM call log — so call **duration and recording are NOT auto-synced** in Phase 1. Duration is an optional manual field; the Reports "Recording" column is a placeholder. "Live monitoring" shows *call started / disposition pending / last activity* — the best a browser can truthfully do.

## Phase 2 (next)

A small **Android companion app** (same login) that reads the call log after each call and auto-syncs **exact duration + recording**, shows a floating after-call sheet, and enables true live monitoring. iPhone cannot support this (Apple restrictions) — Android only.

## Phase 3 (optional)

Cloud telephony (Exotel/MyOperator/Twilio) for in-browser calling on a virtual number, click-to-call for PC users, number masking, IVR — plus the **official WhatsApp API** for template campaigns to opted-in audiences (the webhook + templates above are already shaped for it).

## Project layout

```
server.js          Express app (routes mounted, session, static PWA files)
db.js              SQLite schema + idempotent seed
lib/util.js        IST dates, mobile cleaning, formatting helpers
lib/auth.js        session user loader + role/ownership guards
lib/layout.js      page shell (sidebar/bottom-nav, CSS)
routes/            auth, api (live feed + webhook), dashboard, leads, calls,
                   dialer, followups, imports, monitor, whatsapp, settings
public/            manifest.json, sw.js, icons
tools/             gen-icons.js, e2e-test.sh (curl end-to-end suite)
TESTS.md           test commands + recorded results
```

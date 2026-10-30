# All CRM — Test Record

Date: 2026-10-30 · Machine: this VM (Node v24.22.1) · Server test port: 3100

## 1. npm install

```bash
cd ~/workspace/all-crm/app && npm install
```
Result: **success**. Note: `better-sqlite3` is pinned to `^12` — v11 has no Node 24
prebuild and its node-gyp source build fails on this VM (header tarball extraction
hits an `fchown` EPERM). v12 ships a working prebuild and the API used here is identical.

## 2. Server boot (fresh DB → seed runs)

```bash
rm -rf data && PORT=3100 node server.js
# → "All CRM chal raha hai → http://localhost:3100"
curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/login   # 200
```

## 3. End-to-end curl suite — `tools/e2e-test.sh`

Re-runnable: start the server, then `PORT=3100 bash tools/e2e-test.sh`.
It logs in with cookie jars as all 4 seeded users and exercises the real HTTP flow
(no DB shortcuts except read-only state assertions). Recorded output of the final
clean run (fresh seed DB):

```
== 1. Login as each role ==
PASS: login admin@allcrm.local -> 302
PASS: login manager@allcrm.local -> 302
PASS: login emp1@allcrm.local -> 302
PASS: login emp2@allcrm.local -> 302
PASS: emp1 dashboard shows his name/stats
PASS: manager dashboard renders
PASS: admin dashboard renders
== 2. Employee creates a lead ==
PASS: lead created, id=31
PASS: lead detail page shows the lead
PASS: emp2 cannot open emp1's lead (isolation)
PASS: emp2 search does not leak emp1's lead
== 3. Duplicate mobile flagged ==
PASS: duplicate mobile rejected with message
== 4. Call start creates a 'started' record ==
PASS: call-start page shows dialer link
PASS: pending dispositions lists the started call (id=12)
PASS: DB: call state = started
== 5. Disposition save completes call + sets follow-up ==
call row: completed|fu-set|furows=1
PASS: DB: call completed, follow-up row created
PASS: follow-up appears on Upcoming tab
PASS: remark on lead timeline
== 6. Manager sees it (dashboard feed + report) ==
PASS: manager live feed shows the call
PASS: report lists Rahul
PASS: live team board renders
== 7. CSV import: 2 valid + 1 duplicate ==
PASS: import report: added=2 duplicates=1
== 8. Dialer session loads a lead ==
PASS: dialer caller screen shows a lead with Call Now
== 9. Extras: live JSON, PWA, webhook, export ==
PASS: /api/live JSON ok
PASS: manifest.json served
PASS: sw.js served
PASS: webhook lead import works
PASS: CSV export contains the test lead

RESULT: 28 passed, 0 failed
```

## 4. Extra spot checks (also run, all passed)

- **Page sweep:** every GET route requested as admin / manager / employee —
  admin 200 on all 17 pages; manager correctly redirected (302) away from
  admin-only `/settings*`; employee correctly blocked from `/team`, `/reports`,
  `/lost`, `/settings*`.
- **XLSX import:** a generated 2-row `.xlsx` imported via the same JSON/base64
  endpoint → "2 leads jud gayi, 0 duplicate skip, 0 error rows".
- **Dialer redial loop:** emp2 session filtered to one lead → Call Now →
  disposition "Not Picked" → same lead re-offered from the redial queue in the
  same session → end-of-session summary renders (attempted/connected/follow-ups/skipped).
- **Backup:** `GET /settings/backup` as admin → HTTP 200, valid SQLite file
  (122,880 bytes on the test DB, `users` table present).
- **Duplicate detail:** duplicate add shows "Ye number pehle se maujood hai —
  duplicate nahi banega" and the leads table still holds exactly 1 row for that mobile.

## 5. Bugs found by testing and fixed

1. `GET /leads/export` was registered after `GET /leads/:id`, so Express treated
   "export" as a lead id and export never ran → route moved above `/:id`.
2. (Test-script bugs, app was correct: lead-create posts to `POST /leads`,
   dashboard JSON key is `feedHtml`.)

---

## 7. Multi-company self-signup (`/register`) — 2026-10-30

Feature: public "Nayi Company" registration. `GET /register` renders a form in the
login page's style (Company Name, Your Name, Email, Password, Confirm Password);
the login page links to it and it links back. `POST /register` validates
(required fields, email format, password ≥ 6 chars + match, email globally
unique across all users), then in ONE transaction creates the workspace,
seeds the standard 10 statuses, and creates the owner as `admin` — clean
slate, no demo data. The new admin is logged in immediately. In-memory rate
limit: max 10 POST /register attempts per IP per 15 minutes → HTTP 429 with a
plain Hindi message.

Changed code: `routes/auth.js` (routes + rate limit + login-page link),
`db.js` (status list extracted to exported `STATUS_DEFS`/`seedStatuses()`,
reused by both the demo seed and registration — no behaviour change).

Method: fresh DB (`rm -rf data`, server on PORT=3100), curl + cookie jars.

```
== R1. Login page links to register; register page renders ==
PASS: login page has Register link
PASS: register form has company field
PASS: register page links back to login
== R2. Register new company 'Test Traders' ==
PASS: register -> 302 (auto-login)
PASS: new admin dashboard: 0 leads
PASS: dashboard greets new owner
PASS: settings shows own company name 'Test Traders'
PASS: new admin sees ZERO demo leads
PASS: new admin's user list has no demo users
== R3. Duplicate email + validation errors ==
PASS: duplicate email -> friendly error
PASS: demo admin email also blocked (global uniqueness)
PASS: short password rejected
PASS: password mismatch rejected
PASS: bad email format rejected
PASS: DB: exactly 2 workspaces, 1 test user (no duplicates)
PASS: DB: new workspace seeded with 10 statuses
== R4. Demo admin unaffected; isolation both ways ==
PASS: demo admin still sees 30 demo leads
PASS: demo admin's user list does NOT show test company
PASS: new admin CANNOT see demo lead data by URL
PASS: cross-ws access gives 'Lead nahi mili' (no leak)
== R5. Rate limit ==
PASS: attempts 1-10 register fine, 11th attempt -> HTTP 429 + plain message
```

Registration-specific result: **21 passed, 0 failed**.

Regression: after these tests, on a brand-new fresh DB, the existing suite was
re-run exactly once — **RESULT: 28 passed, 0 failed** (unchanged).
(Note: running `tools/e2e-test.sh` twice against the same DB makes its import
check fail because the first run's imported mobiles already exist — that is
pre-existing test behaviour on a dirty DB, not an app regression.)

## 8. Litestream replication — backup/restore on ephemeral disks — 2026-10-30

`lib/replication.js` + one line at the top of `server.js`
(`require('./lib/replication').bootstrap()` before `openDb()`). Completely
off unless `REPLICA_S3_BUCKET` (S3 mode) or `REPLICA_FILE_PATH` (file mode)
is set. On boot it downloads the pinned Litestream v0.3.13 binary into
`DATA_DIR/bin/` if missing, generates `DATA_DIR/litestream.yml`, restores
the DB from the replica if the local file is gone, then runs
`litestream replicate` detached (output → `DATA_DIR/litestream.log`).
Any failure logs `[replication] …` and the app boots without replication.

### 8a. File-replica round trip (the money test) — PASSED

```bash
rm -rf /tmp/repl-test && mkdir -p /tmp/repl-test/data /tmp/repl-test/replica
cd ~/workspace/all-crm/app
DATA_DIR=/tmp/repl-test/data REPLICA_FILE_PATH=/tmp/repl-test/replica \
  PORT=3100 node server.js
```

Boot 1 log (module downloaded the binary itself via curl through the proxy):

```
[replication] replica configured (file mode), config: /tmp/repl-test/data/litestream.yml
[replication] litestream binary not found — downloading https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz
[replication] litestream binary ready: /tmp/repl-test/data/bin/litestream
[replication] no local DB — checking replica for a restore…
[replication] no replica data found — fresh start (… msg="no matching backups found")
[replication] DB not created yet — replication will start when it appears
All CRM chal raha hai → http://localhost:3100
[replication] replication running (pid …), log: /tmp/repl-test/data/litestream.log
```

Register + verify + replica contents:

```bash
curl -c jar -b jar -X POST \
  -d "company=Replica Test Co&name=Test Owner&email=owner@repltest.local&password=Test@123&confirm=Test@123" \
  http://localhost:3100/register        # -> 302 (auto-login)
curl -b jar http://localhost:3100/settings | grep "Replica Test Co"   # found
find /tmp/repl-test/replica -type f
# replica/generations/<id>/snapshots/00000000.snapshot.lz4
# replica/generations/<id>/wal/00000000_00000000.wal.lz4
# replica/generations/<id>/wal/00000000_00139d60.wal.lz4
```

Stop app + litestream, delete the ENTIRE data dir (fresh-instance
simulation — binary and config must regenerate too), boot again:

```
[replication] replica configured (file mode), config: /tmp/repl-test/data/litestream.yml
[replication] litestream binary not found — downloading …
[replication] litestream binary ready: /tmp/repl-test/data/bin/litestream
[replication] no local DB — checking replica for a restore…
[replication] DB restored from replica → /tmp/repl-test/data/allcrm.db
[replication] replication running (pid …), log: /tmp/repl-test/data/litestream.log
All CRM chal raha hai → http://localhost:3100
```

Post-restore verification:

```bash
curl -c jar2 -b jar2 -X POST -d "email=owner@repltest.local&password=Test@123" \
  http://localhost:3100/login           # -> 302
curl -b jar2 http://localhost:3100/settings | grep "Replica Test Co"   # found
# read-only DB check:
#   workspaces = [{"id":1,"name":"All CRM Demo"},{"id":2,"name":"Replica Test Co"}]
#   users      = [{"email":"owner@repltest.local","role":"admin","workspace_id":2}]
```

**Result: restore works — the registered company and its admin survive a
complete data-dir wipe.**

### 8b. Regression with replication OFF — PASSED

```bash
rm -rf data && PORT=3100 node server.js   # no REPLICA_* env
PORT=3100 bash tools/e2e-test.sh
# boot log contains NO [replication] lines; suite ends:
# RESULT: 28 passed, 0 failed
```

Test artifacts cleaned up afterwards (`/tmp/repl-test`, app `data/`).

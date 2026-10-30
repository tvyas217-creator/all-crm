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

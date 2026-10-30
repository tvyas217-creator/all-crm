#!/bin/bash
# All CRM end-to-end test. Usage: PORT=3100 bash tools/e2e-test.sh  (server must be running)
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
B=http://localhost:${PORT:-3100}
DBQ="require('$APP_DIR/node_modules/better-sqlite3')('$APP_DIR/data/allcrm.db',{readonly:true})"
PASS=0; FAIL=0
chk(){ if [ "$1" = "0" ]; then echo "PASS: $2"; PASS=$((PASS+1)); else echo "FAIL: $2"; FAIL=$((FAIL+1)); fi }

echo "== 1. Login as each role =="
for spec in "admin@allcrm.local:Admin@123:admin" "manager@allcrm.local:Manager@123:mgr" "emp1@allcrm.local:Emp@123:e1" "emp2@allcrm.local:Emp@123:e2"; do
  IFS=: read -r email pw tag <<< "$spec"
  code=$(curl -s -c /tmp/jar_$tag.txt -o /dev/null -w "%{http_code}" -d "email=$email&password=$pw" $B/login)
  [ "$code" = "302" ]; chk $? "login $email -> 302"
done
curl -s -b /tmp/jar_e1.txt $B/ | grep -q "Rahul Verma"; chk $? "emp1 dashboard shows his name/stats"
curl -s -b /tmp/jar_mgr.txt $B/ | grep -q "Lead Status Funnel"; chk $? "manager dashboard renders"
curl -s -b /tmp/jar_admin.txt $B/ | grep -q "Lead Status Funnel"; chk $? "admin dashboard renders"

echo "== 2. Employee creates a lead =="
out=$(curl -s -b /tmp/jar_e1.txt -o /dev/null -w "%{redirect_url}" -d "name=Test Lead&mobile=9812345678&city=Jaipur&source=Test&priority=Hot" $B/leads)
LEAD_ID=$(basename "$out")
[ -n "$LEAD_ID" ] && [ "$LEAD_ID" != "new" ]; chk $? "lead created, id=$LEAD_ID"
curl -s -b /tmp/jar_e1.txt $B/leads/$LEAD_ID | grep -q "Test Lead"; chk $? "lead detail page shows the lead"
curl -s -b /tmp/jar_e2.txt $B/leads/$LEAD_ID | grep -q "Test Lead"; [ $? -ne 0 ]; chk $? "emp2 cannot open emp1's lead (isolation)"
curl -s -b /tmp/jar_e2.txt "$B/leads?q=9812345678" | grep -q "Test Lead"; [ $? -ne 0 ]; chk $? "emp2 search does not leak emp1's lead"

echo "== 3. Duplicate mobile flagged =="
curl -s -L -b /tmp/jar_e1.txt -d "name=Dup Lead&mobile=9812345678" $B/leads | grep -qi "duplicate"; chk $? "duplicate mobile rejected with message"

echo "== 4. Call start creates a 'started' record =="
curl -s -b /tmp/jar_e1.txt -d "lead_id=$LEAD_ID&return_to=/leads/$LEAD_ID" $B/calls/start | grep -q "Dialer Kholein"; chk $? "call-start page shows dialer link"
CALL_ID=$(curl -s -b /tmp/jar_e1.txt $B/pending | grep -o 'calls/[0-9]*/disposition' | head -1 | cut -d/ -f2)
[ -n "$CALL_ID" ]; chk $? "pending dispositions lists the started call (id=$CALL_ID)"
STATE=$(node -e "const db=$DBQ;console.log(db.prepare('SELECT state FROM calls WHERE id=?').get($CALL_ID).state)")
[ "$STATE" = "started" ]; chk $? "DB: call state = started"

echo "== 5. Disposition save completes call + sets follow-up =="
ST_ID=$(node -e "const db=$DBQ;console.log(db.prepare(\"SELECT id FROM statuses WHERE name='Interested'\").get().id)")
curl -s -b /tmp/jar_e1.txt -o /dev/null -d "status_id=$ST_ID&remark=Test remark — kal follow-up&fu=tomorrow&duration_sec=95&return_to=/leads/$LEAD_ID" $B/calls/$CALL_ID/complete
ROW=$(node -e "const db=$DBQ;const c=db.prepare('SELECT state, follow_up_at FROM calls WHERE id=?').get($CALL_ID);const f=db.prepare('SELECT COUNT(*) c FROM follow_ups WHERE call_id=?').get($CALL_ID);console.log(c.state+'|'+(c.follow_up_at?'fu-set':'fu-missing')+'|furows='+f.c)")
echo "call row: $ROW"
[ "$ROW" = "completed|fu-set|furows=1" ]; chk $? "DB: call completed, follow-up row created"
curl -s -b /tmp/jar_e1.txt "$B/followups?tab=upcoming" | grep -q "Test Lead"; chk $? "follow-up appears on Upcoming tab"
curl -s -b /tmp/jar_e1.txt $B/leads/$LEAD_ID | grep -q "Test remark"; chk $? "remark on lead timeline"

echo "== 6. Manager sees it (dashboard feed + report) =="
curl -s -b /tmp/jar_mgr.txt $B/ | grep -q "Test Lead"; chk $? "manager live feed shows the call"
curl -s -b /tmp/jar_mgr.txt "$B/reports" | grep -q "Rahul Verma"; chk $? "report lists Rahul"
curl -s -b /tmp/jar_mgr.txt $B/team | grep -q "Rahul Verma"; chk $? "live team board renders"

echo "== 7. CSV import: 2 valid + 1 duplicate =="
printf 'Name,Mobile,City,Email,Source\nImport One,9812000001,Delhi,one@test.in,JustDial\nImport Two,9812000002,Mumbai,,IndiaMART\nDup Again,9812345678,Jaipur,,Test\n' > /tmp/imp.csv
B64=$(base64 -w0 /tmp/imp.csv)
curl -s -b /tmp/jar_mgr.txt -H 'Content-Type: application/json' -d "{\"filename\":\"imp.csv\",\"data_base64\":\"$B64\",\"assign\":\"\"}" $B/import > /tmp/imp_out.html
grep -q "2</b> leads jud gayi" /tmp/imp_out.html && grep -q "1</b> duplicate" /tmp/imp_out.html; chk $? "import report: added=2 duplicates=1"

echo "== 8. Dialer session loads a lead =="
curl -s -b /tmp/jar_e1.txt -o /dev/null -d "scope=mine" $B/dialer/start
curl -s -b /tmp/jar_e1.txt $B/dialer/session | grep -q "Call Now"; chk $? "dialer caller screen shows a lead with Call Now"
curl -s -b /tmp/jar_e1.txt -o /dev/null -X POST $B/dialer/end

echo "== 9. Extras: live JSON, PWA, webhook, export =="
curl -s -b /tmp/jar_mgr.txt $B/api/live | grep -q '"feedHtml"'; chk $? "/api/live JSON ok"
curl -s -o /dev/null -w "%{http_code}" $B/manifest.json | grep -q 200; chk $? "manifest.json served"
curl -s -o /dev/null -w "%{http_code}" $B/sw.js | grep -q 200; chk $? "sw.js served"
TOKEN=$(node -e "const db=$DBQ;console.log(db.prepare('SELECT api_token FROM workspaces LIMIT 1').get().api_token)")
curl -s -H "x-api-token: $TOKEN" -H 'Content-Type: application/json' -d '{"name":"Webhook Lead","mobile":"9812000099","source":"Website"}' $B/api/webhook/leads | grep -q '"ok":true'; chk $? "webhook lead import works"
curl -s -b /tmp/jar_mgr.txt "$B/leads/export" | grep -q "9812345678"; chk $? "CSV export contains the test lead"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"

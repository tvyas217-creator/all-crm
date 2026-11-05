#!/bin/bash
# All CRM — Super Admin / plans / subscriptions / approval-flow test.
# Self-contained: boots its own server on a scratch DATA_DIR, runs, cleans up.
# Usage: bash tools/super-test.sh   (PORT override: PORT=3300 bash tools/super-test.sh)
set -u
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-3200}
B=http://localhost:$PORT
SCRATCH=$(mktemp -d /tmp/allcrm-super-test.XXXXXX)
DBF=$SCRATCH/allcrm.db
J=/tmp/sjar
PASS=0; FAIL=0
chk(){ if [ "$1" = "0" ]; then echo "PASS: $2"; PASS=$((PASS+1)); else echo "FAIL: $2"; FAIL=$((FAIL+1)); fi }
dbq(){ node -e "const db=require('$APP_DIR/node_modules/better-sqlite3')('$DBF',{readonly:true});let r;try{r=($1)}catch(e){console.log('ERR:'+e.message);process.exit(0)}console.log(r===undefined||r===null?'':r)"; }
SRVPID=""
start_server(){
  ( cd "$APP_DIR" && exec env DATA_DIR="$SCRATCH" PORT=$PORT node server.js ) > "$SCRATCH/boot.log" 2>&1 &
  SRVPID=$!
  for i in $(seq 1 40); do curl -s -o /dev/null $B/login && break; sleep 0.5; done
  sleep 0.3; grep -q "chal raha hai" "$SCRATCH/boot.log" || { echo "BOOT LOG:"; cat "$SCRATCH/boot.log"; }
}
stop_server(){ if [ -n "$SRVPID" ]; then kill $SRVPID 2>/dev/null; wait $SRVPID 2>/dev/null; SRVPID=""; fi }
trap 'stop_server; rm -rf $SCRATCH ${J}_*.txt' EXIT
command -v fuser >/dev/null && fuser -k ${PORT}/tcp 2>/dev/null; sleep 0.5

start_server
grep -q "chal raha hai" $SCRATCH/boot.log; chk $? "server boots on scratch DB"

echo "== 1. Super admin auth =="
code=$(curl -s -o /dev/null -w "%{http_code}" $B/super/login); [ "$code" = "200" ]; chk $? "GET /super/login -> 200"
curl -s -c ${J}_sup.txt -o /dev/null -d "email=owner@allcrm.local&password=WrongPass" $B/super/login
curl -s -b ${J}_sup.txt $B/super/login | grep -q "Incorrect email or password"; chk $? "super login: wrong password rejected"
out=$(curl -s -c ${J}_sup.txt -o /dev/null -w "%{redirect_url}" -d "email=owner@allcrm.local&password=Owner@123" $B/super/login)
[ "$out" = "$B/super" ]; chk $? "super login: correct password -> /super"
curl -s -b ${J}_sup.txt $B/super | grep -q "Total Companies"; chk $? "super dashboard renders totals"
curl -s -b ${J}_sup.txt $B/super | grep -q "Expiring Within 3 Days"; chk $? "super dashboard: expiring-soon card renders"
curl -s -b ${J}_sup.txt $B/super/clients | grep -q "All CRM Demo"; chk $? "clients list shows demo company"

echo "== 2. Workspace user + guest cannot enter /super =="
curl -s -c ${J}_e1.txt -o /dev/null -d "email=emp1@allcrm.local&password=Emp@123" $B/login
out=$(curl -s -b ${J}_e1.txt -o /dev/null -w "%{redirect_url}" $B/super)
[ "$out" = "$B/super/login" ]; chk $? "workspace employee GET /super -> /super/login"
out=$(curl -s -o /dev/null -w "%{redirect_url}" $B/super)
[ "$out" = "$B/super/login" ]; chk $? "guest GET /super -> /super/login"

echo "== 3. Grandfather: seeded demo workspace has Legacy, login fine =="
P=$(dbq "db.prepare('SELECT p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.workspace_id=1 ORDER BY s.id DESC LIMIT 1').get().name")
[ "$P" = "Legacy" ]; chk $? "demo workspace grandfathered onto Legacy plan"
curl -s -b ${J}_e1.txt $B/ | grep -q "Rahul Verma"; chk $? "demo employee dashboard works (not locked)"

echo "== 4. New signup -> pending -> login blocked =="
curl -s -d "company=QA Traders&name=QA Owner&phone=9812345670&email=qa@qa.local&password=Qa@12345&confirm=Qa@12345" $B/register | grep -q "Request Received"; chk $? "register shows 'request received' page (no auto-login)"
WSID=$(dbq "db.prepare(\"SELECT id FROM workspaces WHERE name='QA Traders'\").get().id")
ST=$(dbq "db.prepare('SELECT status FROM workspaces WHERE id=$WSID').get().status")
[ "$ST" = "pending" ]; chk $? "DB: new workspace status = pending"
PH=$(dbq "db.prepare(\"SELECT phone FROM users WHERE email='qa@qa.local'\").get().phone")
[ "$PH" = "9812345670" ]; chk $? "DB: owner phone captured from signup form"
out=$(curl -s -c ${J}_qa.txt -o /dev/null -w "%{redirect_url}" -d "email=qa@qa.local&password=Qa@12345" $B/login)
[ "$out" = "$B/login" ]; chk $? "pending owner login blocked (redirect back to /login)"
curl -s -b ${J}_qa.txt $B/login | grep -qi "Approval pending"; chk $? "pending login message shows 'Approval pending'"

echo "== 5. Approve -> 3-day Trial starts -> login works =="
curl -s -b ${J}_sup.txt -o /dev/null -d "" $B/super/clients/$WSID/approve
ST=$(dbq "db.prepare('SELECT status FROM workspaces WHERE id=$WSID').get().status")
[ "$ST" = "active" ]; chk $? "DB: after approve status = active"
node -e "const db=require('$APP_DIR/node_modules/better-sqlite3')('$DBF',{readonly:true});const s=db.prepare('SELECT s.*,p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.workspace_id=$WSID ORDER BY s.id DESC LIMIT 1').get();const dd=(new Date(s.expires_at)-Date.now())/864e5;if(s.name!=='Trial'||dd<2.9||dd>3.1){console.log('BAD',s.name,dd);process.exit(1)}" ; chk $? "DB: subscription = Trial, expiry ~3 days from approval"
out=$(curl -s -c ${J}_qa.txt -o /dev/null -w "%{redirect_url}" -d "email=qa@qa.local&password=Qa@12345" $B/login)
[ "$out" = "$B/" ]; chk $? "approved owner can login"
curl -s -b ${J}_qa.txt $B/settings | grep -q "My Plan"; chk $? "settings shows read-only 'My Plan' card"
curl -s -b ${J}_qa.txt $B/settings | grep -q "Trial"; chk $? "plan card shows Trial"

echo "== 6. Suspend -> session cut + login blocked; Activate -> works =="
curl -s -b ${J}_sup.txt -o /dev/null -d "" $B/super/clients/$WSID/suspend
out=$(curl -s -b ${J}_qa.txt -o /dev/null -w "%{redirect_url}" $B/)
[ "$out" = "$B/login" ]; chk $? "suspended: live session cut on next request"
curl -s -b ${J}_qa.txt $B/login | grep -qi "suspended"; chk $? "suspended message: 'Account suspended — contact support'"
out=$(curl -s -c ${J}_qa.txt -o /dev/null -w "%{redirect_url}" -d "email=qa@qa.local&password=Qa@12345" $B/login)
[ "$out" = "$B/login" ]; chk $? "suspended: fresh login also blocked"
curl -s -b ${J}_sup.txt -o /dev/null -d "" $B/super/clients/$WSID/activate
out=$(curl -s -c ${J}_qa.txt -o /dev/null -w "%{redirect_url}" -d "email=qa@qa.local&password=Qa@12345" $B/login)
[ "$out" = "$B/" ]; chk $? "reactivated: login works again"

echo "== 7. Expired plan -> blocked; Renew (Basic) -> works, +30d; Extend +10 =="
dbw(){ node -e "const db=require('$APP_DIR/node_modules/better-sqlite3')('$DBF');$1"; }
dbw "db.prepare(\"UPDATE subscriptions SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=(SELECT MAX(id) FROM subscriptions WHERE workspace_id=$WSID)\").run()"
out=$(curl -s -b ${J}_qa.txt -o /dev/null -w "%{redirect_url}" $B/)
[ "$out" = "$B/login" ]; chk $? "expired: live session cut"
curl -s -b ${J}_qa.txt $B/login | grep -qi "Plan expired"; chk $? "expired message: 'Plan expired — contact support'"
BASIC=$(dbq "db.prepare(\"SELECT id FROM plans WHERE name='Basic'\").get().id")
curl -s -b ${J}_sup.txt -o /dev/null -d "plan_id=$BASIC" $B/super/clients/$WSID/renew
node -e "const db=require('$APP_DIR/node_modules/better-sqlite3')('$DBF',{readonly:true});const s=db.prepare('SELECT s.*,p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.workspace_id=$WSID ORDER BY s.id DESC LIMIT 1').get();const dd=(new Date(s.expires_at)-Date.now())/864e5;if(s.name!=='Basic'||dd<29.9||dd>30.1){console.log('BAD',s.name,dd);process.exit(1)}"; chk $? "renew: Basic plan, expiry ~+30 days"
out=$(curl -s -c ${J}_qa.txt -o /dev/null -w "%{redirect_url}" -d "email=qa@qa.local&password=Qa@12345" $B/login)
[ "$out" = "$B/" ]; chk $? "renewed: login works"
curl -s -b ${J}_sup.txt -o /dev/null -d "days=10" $B/super/clients/$WSID/extend
node -e "const db=require('$APP_DIR/node_modules/better-sqlite3')('$DBF',{readonly:true});const s=db.prepare('SELECT expires_at FROM subscriptions WHERE workspace_id=$WSID ORDER BY id DESC LIMIT 1').get();const dd=(new Date(s.expires_at)-Date.now())/864e5;if(dd<39.9||dd>40.1){console.log('BAD',dd);process.exit(1)}"; chk $? "extend +10: expiry ~+40 days"

echo "== 8. Plan CRUD =="
curl -s -b ${J}_sup.txt -o /dev/null -d "name=Tiny&price=99&validity_days=30&max_employees=2&max_leads=2&sort=9&is_active=on" $B/super/plans
TINY=$(dbq "db.prepare(\"SELECT id FROM plans WHERE name='Tiny'\").get().id")
[ -n "$TINY" ]; chk $? "plan create: Tiny exists"
curl -s -b ${J}_sup.txt -o /dev/null -d "name=Tiny&price=149&validity_days=30&max_employees=2&max_leads=2&sort=9&is_active=on" $B/super/plans/$TINY
PR=$(dbq "db.prepare('SELECT price FROM plans WHERE id=$TINY').get().price")
[ "$PR" = "149" ]; chk $? "plan edit: price updated to 149"
curl -s -b ${J}_sup.txt $B/super/plans | grep -q "Tiny"; chk $? "plans page lists Tiny"

echo "== 9. Limits: employees + leads + import =="
curl -s -b ${J}_sup.txt -o /dev/null -d "plan_id=$TINY" $B/super/clients/$WSID/plan
curl -s -b ${J}_qa.txt -o /dev/null -d "name=U Two&email=u2@qa.local&password=User@123&role=employee" $B/settings/users
N=$(dbq "db.prepare('SELECT COUNT(*) c FROM users WHERE workspace_id=$WSID').get().c")
[ "$N" = "2" ]; chk $? "user #2 (up to limit) created"
curl -s -b ${J}_qa.txt -o /dev/null -d "name=U Three&email=u3@qa.local&password=User@123&role=employee" $B/settings/users
curl -s -b ${J}_qa.txt $B/settings/users | grep -q "Team limit reached"; chk $? "user #3 blocked with team-limit message"
N=$(dbq "db.prepare('SELECT COUNT(*) c FROM users WHERE workspace_id=$WSID').get().c")
[ "$N" = "2" ]; chk $? "DB: still exactly 2 users"
curl -s -b ${J}_qa.txt -o /dev/null -d "name=Lead One&mobile=9811111111" $B/leads
curl -s -b ${J}_qa.txt -o /dev/null -d "name=Lead Two&mobile=9822222222" $B/leads
curl -s -b ${J}_qa.txt -o /dev/null -d "name=Lead Three&mobile=9833333333" $B/leads
curl -s -b ${J}_qa.txt $B/leads | grep -q "Lead limit reached"; chk $? "lead #3 blocked with lead-limit message"
N=$(dbq "db.prepare('SELECT COUNT(*) c FROM leads WHERE workspace_id=$WSID').get().c")
[ "$N" = "2" ]; chk $? "DB: exactly 2 leads"
# raise lead limit to 4, then import 3 rows -> 2 fit, 1 limit-skipped
curl -s -b ${J}_sup.txt -o /dev/null -d "name=Tiny&price=149&validity_days=30&max_employees=2&max_leads=4&sort=9&is_active=on" $B/super/plans/$TINY
CSV64=$(printf 'Name,Mobile\nImp One,9844444444\nImp Two,9855555555\nImp Three,9866666666' | base64 -w0)
IMP=$(curl -s -b ${J}_qa.txt -H 'Content-Type: application/json' -d "{\"filename\":\"t.csv\",\"data_base64\":\"$CSV64\",\"assign\":\"\"}" $B/import)
echo "$IMP" | grep -q "2</b> leads added"; chk $? "import: 2 leads added up to the limit"
echo "$IMP" | grep -q "not added because of the limit"; chk $? "import: report counts the limit-skipped row"
N=$(dbq "db.prepare('SELECT COUNT(*) c FROM leads WHERE workspace_id=$WSID').get().c")
[ "$N" = "4" ]; chk $? "DB: leads now exactly at limit (4)"

echo "== 10. Reset workspace admin password (shown once) =="
curl -s -b ${J}_sup.txt -o /dev/null -d "" $B/super/clients/$WSID/reset-admin
curl -s -b ${J}_sup.txt $B/super/clients/$WSID | grep -q "temporary password: Tmp@"; chk $? "reset-admin flashes a one-time temporary password"

echo "== 11. Delete workspace needs typed name =="
dbw "const h=require('$APP_DIR/node_modules/bcryptjs').hashSync('Del@123',10);const w=db.prepare(\"INSERT INTO workspaces (name,created_at) VALUES ('Del Co',datetime('now'))\").run();db.prepare(\"INSERT INTO users (workspace_id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,'admin',datetime('now'))\").run(w.lastInsertRowid,'Del Owner','del@del.local',h);console.log(w.lastInsertRowid)" > $SCRATCH/delid
DELID=$(cat $SCRATCH/delid)
curl -s -b ${J}_sup.txt -o /dev/null -d "confirm_name=Galat Naam" $B/super/clients/$DELID/delete
N=$(dbq "db.prepare('SELECT COUNT(*) c FROM workspaces WHERE id=$DELID').get().c")
[ "$N" = "1" ]; chk $? "delete with wrong name: workspace survives"
curl -s -b ${J}_sup.txt -o /dev/null -d "confirm_name=Del Co" $B/super/clients/$DELID/delete
N=$(dbq "db.prepare('SELECT COUNT(*) c FROM workspaces WHERE id=$DELID').get().c")
[ "$N" = "0" ]; chk $? "delete with exact name: workspace gone"

echo "== 12. Super admin changes own password =="
curl -s -b ${J}_sup.txt -o /dev/null -d "current=GalatPass&next=NewOwner@123&confirm=NewOwner@123" $B/super/password
curl -s -b ${J}_sup.txt $B/super/password | grep -q "Current password is incorrect"; chk $? "password change: wrong current rejected"
curl -s -b ${J}_sup.txt -o /dev/null -d "current=Owner@123&next=NewOwner@123&confirm=NewOwner@123" $B/super/password
curl -s -b ${J}_sup.txt -o /dev/null -X POST $B/super/logout
out=$(curl -s -c ${J}_sup2.txt -o /dev/null -w "%{redirect_url}" -d "email=owner@allcrm.local&password=NewOwner@123" $B/super/login)
[ "$out" = "$B/super" ]; chk $? "login with new super password works"

echo "== 13. Grandfather on reboot: pre-billing workspace (no subscription) =="
stop_server
dbw "const h=require('$APP_DIR/node_modules/bcryptjs').hashSync('Old@123',10);const w=db.prepare(\"INSERT INTO workspaces (name,created_at) VALUES ('Old Co','2026-10-01T00:00:00.000Z')\").run();db.prepare(\"INSERT INTO users (workspace_id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,'admin','2026-10-01T00:00:00.000Z')\").run(w.lastInsertRowid,'Old Owner','old@old.local',h);console.log(w.lastInsertRowid)" > $SCRATCH/oldid
OLDID=$(cat $SCRATCH/oldid)
N=$(dbq "db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE workspace_id=$OLDID').get().c")
[ "$N" = "0" ]; chk $? "setup: Old Co has NO subscription before reboot"
start_server
P=$(dbq "db.prepare('SELECT p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.workspace_id=$OLDID ORDER BY s.id DESC LIMIT 1').get().name")
[ "$P" = "Legacy" ]; chk $? "after reboot: Old Co auto-got Legacy plan"
out=$(curl -s -c ${J}_old.txt -o /dev/null -w "%{redirect_url}" -d "email=old@old.local&password=Old@123" $B/login)
[ "$out" = "$B/" ]; chk $? "grandfathered Old Co admin logs in fine"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]

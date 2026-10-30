'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { istDate, istToISO, addDaysIST } = require('./lib/util');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'allcrm.db');

let db = null;

function initSchema(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'All CRM Demo',
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    lost_lead_days INTEGER NOT NULL DEFAULT 7,
    redial_attempts INTEGER NOT NULL DEFAULT 2,
    api_token TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','manager','employee')),
    active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    last_active_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    counts_connected INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    mobile TEXT NOT NULL,
    alt_mobile TEXT,
    email TEXT,
    city TEXT,
    source TEXT,
    status_id INTEGER REFERENCES statuses(id),
    assigned_to INTEGER REFERENCES users(id),
    priority TEXT NOT NULL DEFAULT 'Warm' CHECK (priority IN ('Hot','Warm','Cold')),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leads_ws_mobile ON leads(workspace_id, mobile);
  CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
  CREATE TABLE IF NOT EXISTS custom_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text','number','dropdown','date')),
    options TEXT,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS lead_custom_values (
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
    value TEXT,
    PRIMARY KEY (lead_id, field_id)
  );
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lead_tags (
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (lead_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    direction TEXT NOT NULL DEFAULT 'outgoing' CHECK (direction IN ('outgoing','incoming')),
    state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started','completed','cancelled')),
    status_id INTEGER REFERENCES statuses(id),
    remark TEXT,
    duration_sec INTEGER,
    started_at TEXT NOT NULL,
    saved_at TEXT,
    follow_up_at TEXT,
    created_via TEXT NOT NULL DEFAULT 'web',
    session_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_calls_user_state ON calls(user_id, state);
  CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
  CREATE TABLE IF NOT EXISTS follow_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    call_id INTEGER REFERENCES calls(id),
    due_at TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fu_user_due ON follow_ups(user_id, done, due_at);
  CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS whatsapp_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    template_id INTEGER REFERENCES whatsapp_templates(id),
    message TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    filename TEXT,
    added INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    user_id INTEGER REFERENCES users(id),
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dialer_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    filters TEXT,
    queue TEXT NOT NULL DEFAULT '[]',
    redial TEXT NOT NULL DEFAULT '[]',
    attempts TEXT NOT NULL DEFAULT '{}',
    stats TEXT NOT NULL DEFAULT '{}',
    current_lead_id INTEGER,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','ended')),
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  `);
}

// The standard 10 lead statuses every workspace starts with.
const STATUS_DEFS = [
  ['New', '#64748b', 0], ['Interested', '#16a34a', 1], ['Not Interested', '#dc2626', 1],
  ['Follow-up', '#f59e0b', 1], ['Busy', '#f97316', 0], ['Not Picked', '#78716c', 0],
  ['Switched Off', '#78716c', 0], ['Wrong Number', '#a8a29e', 0], ['Converted', '#059669', 1],
  ['Lost', '#991b1b', 0],
];

function seedStatuses(d, wsId) {
  const st = {};
  STATUS_DEFS.forEach(([name, color, conn], i) => {
    st[name] = d.prepare('INSERT INTO statuses (workspace_id, name, color, counts_connected, sort) VALUES (?,?,?,?,?)')
      .run(wsId, name, color, conn, i).lastInsertRowid;
  });
  return st;
}

function seed(d) {
  const wsCount = d.prepare('SELECT COUNT(*) c FROM workspaces').get().c;
  if (wsCount > 0) return;
  const now = new Date().toISOString();
  const today = istDate();
  const yday = addDaysIST(today, -1);

  const wsId = d.prepare('INSERT INTO workspaces (name, timezone, api_token, created_at) VALUES (?,?,?,?)')
    .run('All CRM Demo', 'Asia/Kolkata', crypto.randomBytes(20).toString('hex'), now).lastInsertRowid;

  const mkUser = (name, email, pass, role) => d.prepare(
    'INSERT INTO users (workspace_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?)'
  ).run(wsId, name, email, bcrypt.hashSync(pass, 10), role, now).lastInsertRowid;

  const adminId = mkUser('Admin (Owner)', 'admin@allcrm.local', 'Admin@123', 'admin');
  const mgrId = mkUser('Priya Manager', 'manager@allcrm.local', 'Manager@123', 'manager');
  const emp1 = mkUser('Rahul Verma', 'emp1@allcrm.local', 'Emp@123', 'employee');
  const emp2 = mkUser('Sneha Kulkarni', 'emp2@allcrm.local', 'Emp@123', 'employee');

  const st = seedStatuses(d, wsId);

  d.prepare('INSERT INTO custom_fields (workspace_id, name, type, options, sort) VALUES (?,?,?,?,?)')
    .run(wsId, 'Budget (₹)', 'number', null, 1);
  d.prepare('INSERT INTO custom_fields (workspace_id, name, type, options, sort) VALUES (?,?,?,?,?)')
    .run(wsId, 'Interested In', 'dropdown', 'Basic Plan,Pro Plan,Enterprise', 2);

  const tagIds = {};
  ['VIP', 'Festival Offer', 'Callback Requested'].forEach((t) => {
    tagIds[t] = d.prepare('INSERT INTO tags (workspace_id, name) VALUES (?,?)').run(wsId, t).lastInsertRowid;
  });

  const rawLeads = [
    ['Amit Sharma', 'Jaipur', 'IndiaMART', 'Interested', emp1, 'Hot'],
    ['Kavita Rao', 'Mumbai', 'Facebook', 'Follow-up', emp1, 'Hot'],
    ['Mohit Yadav', 'Delhi', 'JustDial', 'New', emp1, 'Warm'],
    ['Sunita Desai', 'Pune', 'Website', 'New', emp1, 'Warm'],
    ['Rajesh Gupta', 'Lucknow', 'Referral', 'Converted', emp1, 'Hot'],
    ['Anjali Mehta', 'Ahmedabad', 'IndiaMART', 'Not Picked', emp1, 'Warm'],
    ['Vikram Singh', 'Indore', 'Google', 'Busy', emp1, 'Cold'],
    ['Pooja Nair', 'Kochi', 'Facebook', 'New', emp2, 'Warm'],
    ['Sandeep Patil', 'Nagpur', 'JustDial', 'Interested', emp2, 'Hot'],
    ['Rekha Joshi', 'Surat', 'Website', 'Follow-up', emp2, 'Warm'],
    ['Arun Kumar', 'Chennai', 'IndiaMART', 'New', emp2, 'Warm'],
    ['Neha Bansal', 'Chandigarh', 'Referral', 'Not Interested', emp2, 'Cold'],
    ['Farhan Sheikh', 'Hyderabad', 'Facebook', 'New', emp2, 'Hot'],
    ['Divya Iyer', 'Bengaluru', 'Google', 'Switched Off', emp2, 'Cold'],
    ['Karan Malhotra', 'Delhi', 'IndiaMART', 'New', null, 'Warm'],
    ['Meena Kumari', 'Patna', 'JustDial', 'New', null, 'Warm'],
    ['Suresh Raina', 'Kanpur', 'Walk-in', 'New', null, 'Cold'],
    ['Ishita Kapoor', 'Noida', 'Website', 'New', null, 'Hot'],
    ['Ravi Teja', 'Vizag', 'Facebook', 'New', null, 'Warm'],
    ['Anita Deshmukh', 'Nashik', 'IndiaMART', 'New', null, 'Warm'],
    ['Deepak Verma', 'Bhopal', 'JustDial', 'Lost', emp1, 'Cold'],
    ['Shalini Menon', 'Kochi', 'Referral', 'Wrong Number', emp2, 'Cold'],
    ['Nikhil Arora', 'Gurugram', 'Google', 'Interested', emp2, 'Hot'],
    ['Geeta Nair', 'Jaipur', 'IndiaMART', 'Follow-up', emp1, 'Warm'],
    ['Prakash Jha', 'Ranchi', 'Walk-in', 'New', emp1, 'Warm'],
    ['Ritu Sharma', 'Udaipur', 'Facebook', 'New', emp2, 'Warm'],
    ['Manoj Tiwari', 'Varanasi', 'JustDial', 'New', null, 'Warm'],
    ['Swati Kulkarni', 'Pune', 'Website', 'Converted', emp2, 'Hot'],
    ['Aditya Rao', 'Mysuru', 'IndiaMART', 'New', null, 'Warm'],
    ['Kamlesh Yadav', 'Agra', 'Referral', 'New', emp1, 'Cold'],
  ];
  const insLead = d.prepare(`INSERT INTO leads (workspace_id, name, mobile, city, source, status_id, assigned_to, priority, created_by, created_at, updated_at, last_activity_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const leadIds = [];
  rawLeads.forEach(([name, city, source, status, owner, priority], i) => {
    const mobile = '9811000' + String(100 + i);
    const created = istToISO(addDaysIST(today, -(i % 5)), '09:30');
    const id = insLead.run(wsId, name, mobile, city, source, st[status], owner, priority, mgrId, created, created, created).lastInsertRowid;
    leadIds.push(id);
  });
  d.prepare('INSERT INTO lead_tags (lead_id, tag_id) VALUES (?,?)').run(leadIds[0], tagIds['VIP']);
  d.prepare('INSERT INTO lead_tags (lead_id, tag_id) VALUES (?,?)').run(leadIds[1], tagIds['Callback Requested']);

  // Seed some completed calls + follow-ups so dashboards/monitoring are alive.
  const insCall = d.prepare(`INSERT INTO calls (lead_id, user_id, direction, state, status_id, remark, duration_sec, started_at, saved_at, follow_up_at, created_via)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insFU = d.prepare(`INSERT INTO follow_ups (lead_id, user_id, call_id, due_at, done, done_at, note, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insEvent = d.prepare('INSERT INTO timeline_events (lead_id, user_id, type, text, created_at) VALUES (?,?,?,?,?)');
  const seedCall = (leadIdx, userId, statusName, remark, dur, dayStr, time, fuDateStr) => {
    const started = istToISO(dayStr, time);
    const saved = new Date(new Date(started).getTime() + 120000).toISOString();
    const fuAt = fuDateStr ? istToISO(fuDateStr, '10:00') : null;
    const cid = insCall.run(leadIds[leadIdx], userId, 'outgoing', 'completed', st[statusName], remark, dur, started, saved, fuAt, 'web').lastInsertRowid;
    if (fuAt) insFU.run(leadIds[leadIdx], userId, cid, fuAt, 0, null, 'Seed follow-up', saved);
    d.prepare('UPDATE leads SET last_activity_at=? WHERE id=?').run(saved, leadIds[leadIdx]);
    return cid;
  };
  // emp1 today
  seedCall(0, emp1, 'Interested', 'Brochure bhejna hai, price par soch rahe hain', 240, today, '10:05', addDaysIST(today, 1));
  seedCall(2, emp1, 'Not Picked', 'Phone nahi uthaya', 0, today, '10:40', null);
  seedCall(3, emp1, 'Interested', 'Demo chahte hain', 310, today, '11:15', null);
  seedCall(5, emp1, 'Busy', 'Meeting me the, baad me call karna hai', 45, today, '12:00', today); // due today
  // emp1 yesterday + one overdue follow-up
  seedCall(1, emp1, 'Follow-up', 'Kal pakka baat hogi bola', 180, yday, '15:30', yday); // follow-up was due yesterday -> overdue
  seedCall(6, emp1, 'Busy', 'Kal subah try karna', 30, yday, '16:10', null);
  // emp2 today
  seedCall(8, emp2, 'Interested', 'Payment link manga hai', 265, today, '10:20', addDaysIST(today, 2));
  seedCall(10, emp2, 'Not Picked', 'Ring gayi, uthaya nahi', 0, today, '11:00', null);
  seedCall(12, emp2, 'Interested', 'Bahut interested, family se pooch kar batayenge', 420, today, '11:45', today); // due today
  // emp2 yesterday + overdue
  seedCall(9, emp2, 'Follow-up', 'Rate compare kar rahe hain', 150, yday, '14:00', yday); // overdue follow-up
  seedCall(22, emp2, 'Interested', 'Second call par positive', 200, yday, '17:20', addDaysIST(today, 3));

  const t1 = d.prepare('INSERT INTO whatsapp_templates (workspace_id, name, body, created_at) VALUES (?,?,?,?)');
  t1.run(wsId, 'Intro / Brochure', 'Namaste {{name}} ji, main All CRM se bol raha hoon. Aapne {{source}} par enquiry ki thi, isiliye jaankari bhej raha hoon. Koi sawal ho to yahi reply kar dein. Dhanyavaad!', now);
  t1.run(wsId, 'Follow-up Reminder', 'Namaste {{name}} ji, aapki aur hamari baat hui thi. Kya aapne offer par socha? Main aapko best rate bhej deta hoon. — All CRM team', now);

  d.prepare('INSERT INTO audit_log (workspace_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)')
    .run(wsId, adminId, 'seed', 'Demo workspace seed data created', now);
}

function openDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  seed(db);
  return db;
}
function getDb() { if (!db) openDb(); return db; }
function closeDb() { if (db) { db.close(); db = null; } }
function touchLead(d, leadId) {
  d.prepare('UPDATE leads SET last_activity_at=?, updated_at=? WHERE id=?')
    .run(new Date().toISOString(), new Date().toISOString(), leadId);
}
function logEvent(d, leadId, userId, type, text) {
  d.prepare('INSERT INTO timeline_events (lead_id, user_id, type, text, created_at) VALUES (?,?,?,?,?)')
    .run(leadId, userId || null, type, text, new Date().toISOString());
}
function audit(d, wsId, userId, action, detail) {
  d.prepare('INSERT INTO audit_log (workspace_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)')
    .run(wsId || null, userId || null, action, detail || null, new Date().toISOString());
}

module.exports = { getDb, openDb, closeDb, DB_PATH, DATA_DIR, touchLead, logEvent, audit, seedStatuses, STATUS_DEFS };

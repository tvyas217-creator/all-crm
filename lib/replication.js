'use strict';
// Optional continuous backup of the SQLite DB via Litestream.
//
// Hosts like Render's free tier have an ephemeral disk: when the instance
// changes, ./data (and allcrm.db with it) disappears. When a replica is
// configured, this module (a) restores the DB from the replica before the
// app opens it, and (b) runs `litestream replicate` alongside the app so
// every write is streamed to S3-compatible object storage (or a local file
// replica in tests). Data then survives instance changes.
//
// Completely OFF unless one of these env vars is set — local dev is
// unaffected:
//   REPLICA_S3_BUCKET           -> S3 mode (bucket name)
//   REPLICA_S3_ENDPOINT         -> S3 endpoint (e.g. Backblaze B2 / R2)
//   REPLICA_S3_REGION           -> default 'auto'
//   REPLICA_S3_PATH             -> key prefix, default 'allcrm'
//   REPLICA_S3_ACCESS_KEY_ID    -> credentials
//   REPLICA_S3_SECRET_ACCESS_KEY
//   REPLICA_FILE_PATH           -> file mode (tests): replica directory
//
// bootstrap() must NEVER throw: any failure logs a line and the app boots
// normally, just without replication.
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

// Same DATA_DIR / DB_PATH computation as db.js.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const DB_PATH = path.join(DATA_DIR, 'allcrm.db');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const BIN_PATH = path.join(BIN_DIR, 'litestream');
const CONFIG_PATH = path.join(DATA_DIR, 'litestream.yml');
const LOG_PATH = path.join(DATA_DIR, 'litestream.log');

const LITESTREAM_VERSION = 'v0.3.13';
const LITESTREAM_URL = 'https://github.com/benbjohnson/litestream/releases/download/'
  + LITESTREAM_VERSION + '/litestream-' + LITESTREAM_VERSION + '-linux-amd64.tar.gz';

let replicateStarted = false;

function log(...args) { console.log('[replication]', ...args); }

// JSON string syntax is valid YAML for a scalar — safe for credentials with
// special characters.
const yq = (v) => JSON.stringify(String(v));

function replicaMode() {
  if (process.env.REPLICA_S3_BUCKET) return 's3';
  if (process.env.REPLICA_FILE_PATH) return 'file';
  return null;
}

function writeConfig(mode) {
  let replica;
  if (mode === 's3') {
    const lines = [
      '      - type: s3',
      '        bucket: ' + yq(process.env.REPLICA_S3_BUCKET),
      '        path: ' + yq(process.env.REPLICA_S3_PATH || 'allcrm'),
    ];
    if (process.env.REPLICA_S3_ENDPOINT) lines.push('        endpoint: ' + yq(process.env.REPLICA_S3_ENDPOINT));
    lines.push('        region: ' + yq(process.env.REPLICA_S3_REGION || 'auto'));
    if (process.env.REPLICA_S3_ACCESS_KEY_ID) lines.push('        access-key-id: ' + yq(process.env.REPLICA_S3_ACCESS_KEY_ID));
    if (process.env.REPLICA_S3_SECRET_ACCESS_KEY) lines.push('        secret-access-key: ' + yq(process.env.REPLICA_S3_SECRET_ACCESS_KEY));
    lines.push('        sync-interval: 10s');
    lines.push('        retention: 24h');
    replica = lines.join('\n');
  } else {
    replica = [
      '      - type: file',
      '        path: ' + yq(path.resolve(process.env.REPLICA_FILE_PATH)),
      '        sync-interval: 1s',
    ].join('\n');
  }
  const yml = 'dbs:\n  - path: ' + yq(DB_PATH) + '\n    replicas:\n' + replica + '\n';
  fs.writeFileSync(CONFIG_PATH, yml);
  return CONFIG_PATH;
}

// Returns the litestream binary path, downloading the pinned release if
// needed. Returns null (never throws) when the binary cannot be obtained.
function ensureBinary() {
  if (fs.existsSync(BIN_PATH)) return BIN_PATH;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tarball = path.join(BIN_DIR, 'litestream.tar.gz');
  log('litestream binary not found — downloading ' + LITESTREAM_URL);
  let downloaded = false;
  const attempts = [
    ['curl', ['-fL', '--max-time', '180', '-o', tarball, LITESTREAM_URL]],
    ['wget', ['-q', '-T', '180', '-O', tarball, LITESTREAM_URL]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const r = spawnSync(cmd, args, { stdio: 'pipe' });
      if (r.status === 0 && fs.existsSync(tarball) && fs.statSync(tarball).size > 1000000) {
        downloaded = true;
        break;
      }
      log('download via ' + cmd + ' failed (status ' + r.status + ')');
    } catch (e) {
      log('download via ' + cmd + ' errored: ' + e.message);
    }
  }
  if (!downloaded) {
    try { fs.unlinkSync(tarball); } catch { /* ignore */ }
    return null;
  }
  const ex = spawnSync('tar', ['-xzf', tarball, '-C', BIN_DIR, 'litestream'], { stdio: 'pipe' });
  try { fs.unlinkSync(tarball); } catch { /* ignore */ }
  if (ex.status !== 0 || !fs.existsSync(BIN_PATH)) {
    log('litestream tarball extract failed (status ' + ex.status + ')');
    return null;
  }
  fs.chmodSync(BIN_PATH, 0o755);
  log('litestream binary ready: ' + BIN_PATH);
  return BIN_PATH;
}

// Synchronous: runs before openDb(), so a fresh instance gets its data back
// before the app (and its seed-on-empty logic) ever sees the disk.
function restoreIfNeeded(bin) {
  if (fs.existsSync(DB_PATH)) {
    log('local DB exists — no restore needed');
    return;
  }
  log('no local DB — checking replica for a restore…');
  const r = spawnSync(bin, ['restore', '-if-replica-exists', '-config', CONFIG_PATH, DB_PATH], {
    timeout: 300000, encoding: 'utf8', stdio: 'pipe',
  });
  if (r.error) {
    log('restore command errored: ' + r.error.message + ' — continuing with a fresh DB');
    return;
  }
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' | ');
  if (fs.existsSync(DB_PATH)) {
    log('DB restored from replica → ' + DB_PATH);
  } else {
    log('no replica data found — fresh start' + (tail ? ' (' + tail + ')' : ''));
  }
}

function startReplicate(bin) {
  if (replicateStarted) return;
  replicateStarted = true;
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(bin, ['replicate', '-config', CONFIG_PATH], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.on('error', (e) => log('replicate process error: ' + e.message));
  child.on('exit', (code, signal) => log('replicate process exited (code ' + code + ', signal ' + signal + ') — see ' + LOG_PATH));
  child.unref();
  log('replication running (pid ' + child.pid + '), log: ' + LOG_PATH);
}

function bootstrap() {
  try {
    const mode = replicaMode();
    if (!mode) return; // replication not configured — stay completely out of the way
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeConfig(mode);
    log('replica configured (' + mode + ' mode), config: ' + CONFIG_PATH);
    const bin = ensureBinary();
    if (!bin) {
      log('litestream binary unavailable — continuing WITHOUT replication');
      return;
    }
    restoreIfNeeded(bin);
    if (fs.existsSync(DB_PATH)) {
      startReplicate(bin);
    } else {
      // Fresh start: the DB file appears a moment later when db.js opens
      // it. Start replicating as soon as it exists.
      log('DB not created yet — replication will start when it appears');
      const iv = setInterval(() => {
        if (fs.existsSync(DB_PATH)) {
          clearInterval(iv);
          startReplicate(bin);
        }
      }, 1000);
      iv.unref();
    }
  } catch (e) {
    console.error('[replication] bootstrap failed — continuing WITHOUT replication:', e.message);
  }
}

module.exports = { bootstrap };

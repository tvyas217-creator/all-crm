'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { openDb } = require('./db');
const { loadUser } = require('./lib/auth');

openDb(); // creates schema + seed on first boot

// PWA icons are generated artifacts (not kept in git) — regenerate at boot if missing.
if (!require('fs').existsSync(path.join(__dirname, 'public', 'icon-192.png'))) {
  try { require('./tools/gen-icons'); } catch (e) { console.error('icon generation failed', e); }
}

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false })); // inline CSS/JS app — CSP off for Phase 1, other headers on
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '20mb' })); // base64 file uploads (import / restore)
app.use(session({
  secret: process.env.SESSION_SECRET || 'all-crm-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(loadUser);

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/api'));
app.use('/', require('./routes/dashboard'));
app.use('/', require('./routes/leads'));
app.use('/', require('./routes/calls'));
app.use('/', require('./routes/dialer'));
app.use('/', require('./routes/followups'));
app.use('/', require('./routes/imports'));
app.use('/', require('./routes/monitor'));
app.use('/', require('./routes/whatsapp'));
app.use('/', require('./routes/settings'));

app.use((req, res) => {
  if (!req.user) return res.redirect('/login');
  res.status(404).send('<p style="font-family:sans-serif;padding:30px">Page nahi mila. <a href="/">Home →</a></p>');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('<p style="font-family:sans-serif;padding:30px">Kuch gadbad ho gayi (server error). Thodi der baad phir try karein. <a href="/">Home →</a></p>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('All CRM chal raha hai → http://localhost:' + PORT));

#!/usr/bin/env node
/*
 * RallyPoint — hub server
 * Serves the static apps and runs the WebSocket hub that keeps every court
 * tablet and the organizer desk on the same tournament state.
 *
 *   npm start                 # https://localhost:3000 (HTTPS only — voice needs it)
 *   node server/index.js --port 8080 --courts 4
 *   node server/index.js --reset   # wipe data/tournament.json
 *
 * HTTPS only: browsers gate the microphone behind a secure context, so
 * plain http://192.168.x.x breaks voice. Certs live in certs/ (generated
 * automatically on first boot, or via `npm run cert`):
 *   node server/index.js --key certs/key.pem --cert certs/cert.pem
 */
const https = require('https');
const os = require('os');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const hub = require('../public/js/hub.js');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const PORT = parseInt(process.env.PORT || arg('port', '3000'), 10);
const COURTS = parseInt(arg('courts', '2'), 10);
const DATA = path.join(__dirname, '..', 'data', 'tournament.json');
const PUBLIC = path.join(__dirname, '..', 'public');
const CERT_DIR = path.join(__dirname, '..', 'certs');
const KEY_PATH = path.resolve(arg('key', process.env.SSL_KEY || path.join(CERT_DIR, 'key.pem')));
const CERT_PATH = path.resolve(arg('cert', process.env.SSL_CERT || path.join(CERT_DIR, 'cert.pem')));

function certsExist() { try { return fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH); } catch (e) { return false; } }

// HTTPS only — voice/mic requires a secure context. A self-signed cert is
// generated on first boot when certs/ is empty.
if (!certsExist()) {
  console.log('No cert found at ' + KEY_PATH + ' / ' + CERT_PATH + ' — generating a self-signed one…');
  const gen = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'generate-cert.js')], { stdio: 'inherit' });
  if (gen.status !== 0 || !certsExist()) {
    console.error('Could not create a certificate. Run `npm run cert` (needs openssl) or pass --key/--cert.');
    process.exit(1);
  }
}

if (args.includes('--reset')) { try { fs.unlinkSync(DATA); } catch (e) { /* none */ } console.log('Tournament data reset.'); if (args.length === 1) process.exit(0); }

let saved = null;
try { saved = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { saved = null; }
if (saved) Object.values(saved.courts).forEach(c => { c.online = false; });

let saveTimer = null;
const host = hub.createHost({
  state: saved || undefined,
  courts: COURTS,
  persist: (state) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdir(path.dirname(DATA), { recursive: true }, () => fs.writeFile(DATA, JSON.stringify(state), () => {}));
    }, 300);
  }
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function requestHandler(req, res) {
  const url = new URL(req.url, 'https://localhost');
  if (url.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(host.state)); }
  if (url.pathname === '/api/results.csv') {
    const t = host.state;
    const rows = [['match', 'round', 'format', 'court', 'winner', 'loser', 'score', 'duration_min', 'finished_at']].concat(t.results.map(r => [r.number, r.round, r.format, t.courts[r.courtId] ? t.courts[r.courtId].name : r.courtId, r.result && r.result.winnerName, r.result && r.result.loserName, r.result && r.result.line, r.result ? Math.round(r.result.durationSec / 60) : '', new Date(r.ts).toISOString()]));
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="results.csv"' });
    return res.end(rows.map(r => r.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\n'));
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

let server;
try {
  const key = fs.readFileSync(KEY_PATH);
  const cert = fs.readFileSync(CERT_PATH);
  server = https.createServer({ key, cert }, requestHandler);
} catch (e) {
  console.error('Could not read cert files:\n  ' + KEY_PATH + '\n  ' + CERT_PATH + '\nRun `npm run cert` (needs openssl), or pass --key/--cert.');
  process.exit(1);
}

const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map(); // ws -> {id, role, courtId}
let nextId = 1;

function sendTo(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function dispatch(out) {
  out.forEach(o => {
    if (o.to === 'all') clients.forEach((meta, ws) => sendTo(ws, o.msg));
    else clients.forEach((meta, ws) => { if (meta.id === o.to) sendTo(ws, o.msg); });
  });
}

wss.on('connection', (ws) => {
  const meta = { id: 'c' + (nextId++), role: null, courtId: null };
  clients.set(ws, meta);
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'hello') { meta.role = msg.role; meta.courtId = msg.courtId != null ? String(msg.courtId) : null; }
    if (msg.type === 'ping') {
      // presence only: keep lastSeen fresh without touching the snapshot
      if (meta.role === 'court' && meta.courtId && host.state.courts[meta.courtId]) { host.state.courts[meta.courtId].lastSeen = Date.now(); host.state.courts[meta.courtId].online = true; }
      return;
    }
    dispatch(host.handle(msg, meta.id));
  });
  ws.on('close', () => {
    clients.delete(ws);
    if (meta.role === 'court' && meta.courtId) dispatch(host.handle({ type: 'bye', courtId: meta.courtId }, meta.id));
  });
});

setInterval(() => dispatch(host.handle({ type: 'tick' }, 'server')), 5000);

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('RallyPoint hub on https://localhost:' + PORT + (lan.length ? '  (LAN: ' + lan.map(a => 'https://' + a + ':' + PORT).join(', ') + ')' : ''));
  console.log('  Self-signed cert: tablets will show a one-time warning — accept it, then voice works.');
  console.log('  Organizer desk  /organizer.html');
  for (let i = 1; i <= COURTS; i++) console.log('  Court ' + i + ' tablet  /court.html?court=' + i);
  console.log('  Split demo      /demo.html');
});

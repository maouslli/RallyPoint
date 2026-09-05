#!/usr/bin/env node
/*
 * CourtSide AI — hub server
 * Serves the static apps and runs the WebSocket hub that keeps every court
 * tablet and the organizer desk on the same tournament state.
 *
 *   npm start                 # http://localhost:3000
 *   node server/index.js --port 8080 --courts 4
 *   node server/index.js --reset   # wipe data/tournament.json
 */
const http = require('http');
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
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
});

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
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('CourtSide AI hub on http://localhost:' + PORT + (lan.length ? '  (LAN: ' + lan.map(a => 'http://' + a + ':' + PORT).join(', ') + ')' : ''));
  console.log('  Organizer desk  /organizer.html');
  for (let i = 1; i <= COURTS; i++) console.log('  Court ' + i + ' tablet  /court.html?court=' + i);
  console.log('  Split demo      /demo.html');
});

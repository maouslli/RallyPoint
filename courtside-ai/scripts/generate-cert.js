#!/usr/bin/env node
/*
 * Generate a self-signed cert for local HTTPS (needed for mic/voice on LAN
 * tablets — browsers only expose the microphone in a secure context).
 *
 *   npm run cert
 *   node scripts/generate-cert.js --force
 *
 * Writes certs/key.pem + certs/cert.pem with a SAN covering localhost,
 * 127.0.0.1 and every LAN IPv4 on this machine. Tablets will show a
 * "not private / proceed anyway" warning once; after accepting, voice works.
 * For a warning-free setup use mkcert or put real certs behind --key/--cert.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'certs')));
const DAYS = arg('days', '825');
const FORCE = args.includes('--force');

const KEY = path.join(OUT, 'key.pem');
const CERT = path.join(OUT, 'cert.pem');

if (fs.existsSync(KEY) && fs.existsSync(CERT) && !FORCE) {
  console.log('Certs already exist at ' + OUT + ' (use --force to regenerate).');
  process.exit(0);
}

function lanIPs() {
  const nets = os.networkInterfaces();
  return Object.values(nets).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);
}

const ips = [...new Set(['127.0.0.1', ...lanIPs()])];
const sans = ['DNS:localhost', ...ips.map(ip => 'IP:' + ip)].join(',');
console.log('Generating self-signed cert for: ' + sans);

fs.mkdirSync(OUT, { recursive: true });

const opensslArgs = [
  'req', '-x509', '-newkey', 'rsa:2048',
  '-keyout', KEY, '-out', CERT,
  '-days', String(DAYS), '-nodes',
  '-subj', '/CN=CourtSide AI LAN/',
  '-addext', 'subjectAltName=' + sans,
];
const r = spawnSync('openssl', opensslArgs, { stdio: 'inherit' });
if (r.error || r.status !== 0) {
  console.error('\nopenssl failed. Install OpenSSL (macOS: `brew install openssl`, Ubuntu: `apt install openssl`) and retry.');
  process.exit(1);
}
console.log('\nWrote:\n  ' + KEY + '\n  ' + CERT);
console.log('Start with:  npm start -- --https   (or just `npm start` — HTTPS auto-enables when these files exist)');

// The product is RallyPoint. Nothing user-facing or code-facing should still say CourtSide.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'vendor' || name === 'dist' || name === '.git') continue;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|html|css|json|md)$/.test(name) && name !== 'package-lock.json') out.push(p);
  }
  return out;
}

test('package is named rallypoint', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'rallypoint');
});

test('the homepage is titled RallyPoint', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /<title>RallyPoint<\/title>/);
});

test('the browser global is window.RallyPoint', () => {
  const src = fs.readFileSync(path.join(root, 'public', 'js', 'scoring.js'), 'utf8');
  assert.match(src, /window\.RallyPoint/);
});

test('no source file still says CourtSide', () => {
  const offenders = walk(root, []).filter(p => p !== __filename && /courtside/i.test(fs.readFileSync(p, 'utf8'))).map(p => path.relative(root, p));
  assert.deepEqual(offenders, []);
});

// The homepage rally is scored by the real engine: every rally ends in a point,
// the call under the headline is what the server would say next.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/js/scoring.js');
const L = require('../public/js/landing-rally.js');

test('demo match starts live at love all with a named server', () => {
  const d = L.createDemoMatch();
  assert.equal(d.state.status, 'live');
  assert.equal(d.call, 'Love all');
  assert.ok(d.server && d.server.name.length > 0);
});

test('a point for the server reads 15-Love', () => {
  const d = L.createDemoMatch();
  const r = d.point(d.server.team);
  assert.equal(r.call, '15-Love');
  assert.equal(d.call, '15-Love');
  assert.deepEqual(r.events, []);
});

test('winning a game reports a game event and the call resets', () => {
  const d = L.createDemoMatch();
  let r;
  for (let i = 0; i < 4; i++) r = d.point(0);
  assert.ok(r.events.includes('game'), 'game event after four straight points, got ' + JSON.stringify(r.events));
  assert.equal(d.state.games[0], 1);
  assert.equal(d.call, 'Love all');
});

test('a finished match restarts fresh', () => {
  // one set to one game, won by two clear games: eight straight points end the match
  const d = L.createDemoMatch({ rules: { bestOf: 1, gamesPerSet: 1 } });
  let r;
  for (let i = 0; i < 8; i++) r = d.point(0);
  assert.ok(r.events.includes('match'), 'match event, got ' + JSON.stringify(r.events));
  assert.equal(d.state.status, 'live');
  assert.deepEqual(d.state.sets, []);
  assert.deepEqual(d.state.points, [0, 0]);
  assert.equal(d.call, 'Love all');
});

test('the set line summarises finished sets', () => {
  const d = L.createDemoMatch({ rules: { bestOf: 3, gamesPerSet: 1, finalSetMatchTiebreak: false } });
  for (let i = 0; i < 8; i++) d.point(1);
  assert.equal(d.setLine, '0-2');
  assert.equal(S.setsWon(d.state, 1), 1);
});

// Without WebGL the homepage must still stand: flat CSS court, scoreboard ticking.
let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (e) { /* optional */ }
test('homepage falls back to the CSS court without WebGL and keeps scoring', { skip: !JSDOM && 'jsdom missing' }, async () => {
  const fs = require('fs');
  const path = require('path');
  const { VirtualConsole } = require('jsdom');
  const file = path.join(__dirname, '..', 'public', 'index.html');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/not implemented/i.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, url: require('url').pathToFileURL(file).href, virtualConsole: vc });
  const doc = dom.window.document;
  await new Promise(r => dom.window.addEventListener('load', r));
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(errors, []);
  assert.ok(doc.body.classList.contains('no-webgl'), 'no-webgl class set');
  assert.equal(doc.querySelector('.row[data-team="0"] .nm span').textContent, 'S. Gagnon');
  assert.equal(doc.getElementById('board-call').textContent, 'Love all');
  await new Promise(r => setTimeout(r, 2800));
  assert.notEqual(doc.getElementById('board-call').textContent, 'Love all', 'scoreboard ticked without WebGL');
  dom.window.close();
});

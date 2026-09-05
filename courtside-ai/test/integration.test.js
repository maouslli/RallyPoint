// End-to-end run of the split-screen demonstrator inside jsdom.
// Needs `npm i -D jsdom` and `npm run build` first; skips cleanly otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (e) { /* optional */ }
const file = path.join(__dirname, '..', 'dist', 'courtside-standalone.html');
const available = JSDOM && fs.existsSync(file);

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('demonstrator: assign, start, call scores, go offline and replay, push rules, record a result', { skip: !available && 'jsdom or dist/ missing' }, async () => {
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/demo.html' });
  const { window } = dom;
  const doc = window.document;
  window.localStorage.clear();
  await sleep(900);
  const demo = window.demo;
  assert.ok(demo, 'demo globals exist');
  const desk = doc.getElementById('desk');
  const c1 = doc.getElementById('court1'), c2 = doc.getElementById('court2');

  // desk connected and shows both courts + queue
  assert.match(desk.textContent, /Court 1/); assert.match(desk.textContent, /Court 2/);
  assert.match(desk.textContent, /#104/);
  assert.match(c1.textContent, /No match on this court/);

  // assign #104 to court 1 from the desk
  desk.querySelector('[data-action="assign-next"][data-court="1"]').click();
  await sleep(700);
  assert.match(c1.textContent, /Start match/);
  assert.match(c1.textContent, /J\. Tremblay \/ A\. Roy/);
  assert.match(desk.textContent, /Assigned/);

  // pick A. Roy to serve first, start
  c1.querySelector('[data-action="first-server"][data-team="0"][data-player="1"]').click();
  c1.querySelector('[data-action="start"]').click();
  await sleep(700);
  assert.match(c1.textContent, /Serving: A\. Roy/);
  assert.match(desk.textContent, /Live/);
  assert.match(desk.textContent, /Love all/);

  // spoken (typed) calls go through the same pipeline
  demo.courts['1'].say('15 love');
  assert.equal(demo.courts['1'].state.match.points[0], 1);
  demo.courts['1'].say('15 all');          // receiver point
  demo.courts['1'].say('forty thirty');    // unreachable from 15-15 (needs 30-15 or 15-30) -> rejected
  assert.deepEqual(Array.from(demo.courts['1'].state.match.points), [1, 1], 'unreachable call is ignored');
  assert.match(c1.textContent, /Not reachable/);
  demo.courts['1'].say('30 15');
  demo.courts['1'].say('correction');
  assert.deepEqual(Array.from(demo.courts['1'].state.match.points), [1, 1]);
  demo.courts['1'].say('fault'); demo.courts['1'].say('fault');
  assert.deepEqual(Array.from(demo.courts['1'].state.match.points), [1, 2], 'double fault -> receiver point');
  await sleep(700);
  assert.match(desk.textContent, /15-30|15-30/);

  // court 2: assign, start, cut the internet, keep scoring
  desk.querySelector('[data-action="assign-next"][data-court="2"]').click();
  await sleep(700);
  c2.querySelector('[data-action="start"]').click();
  await sleep(700);
  assert.match(desk.textContent, /S\. Gagnon/);
  demo.courts['2'].setOnline(false);
  await sleep(300);
  assert.match(c2.textContent, /Offline/);
  for (let i = 0; i < 4; i++) demo.courts['2'].point(0); // game to Gagnon
  assert.equal(demo.courts['2'].state.match.games[0], 1);
  await sleep(500);
  assert.equal(demo.host.state.courts['2'].snapshot.sb.teams[0].games, 0, 'desk has not seen offline scoring');
  assert.ok(demo.courts['2'].transport.queued >= 1, 'updates are queued on the tablet');
  demo.courts['2'].setOnline(true);
  await sleep(900);
  assert.equal(demo.host.state.courts['2'].snapshot.sb.teams[0].games, 1, 'replayed after reconnect');
  assert.ok(demo.host.state.alerts.some(a => a.kind === 'info' && /replayed/.test(a.message)));

  // umpire call reaches the desk
  c1.querySelector('[data-action="umpire"]').click();
  await sleep(500);
  assert.match(desk.textContent, /tournament director/i);
  c1.querySelector('[data-action="close-modal"]').click();

  // push No-Ad from the desk, both live courts pick it up
  const v0 = demo.host.state.rulesVersion;
  desk.querySelector('[data-action="preset"][data-preset="noad"]').click();
  desk.querySelector('[data-action="push-rules"]').click();
  await sleep(700);
  assert.equal(demo.host.state.rulesVersion, v0 + 1);
  assert.equal(demo.courts['1'].state.match.rules.noAd, true);
  assert.equal(demo.courts['2'].state.match.rulesVersion, v0 + 1);

  // finish court 1 quickly (Fast4-ish via points), result lands on the desk
  const app = demo.courts['1'];
  let guard = 0;
  while (app.state.phase === 'live' && guard++ < 400) {
    if (app.state.restEndsAt) { c1.querySelector('[data-action="end-rest"]') && c1.querySelector('[data-action="end-rest"]').click(); }
    app.point(0);
  }
  assert.equal(app.state.phase, 'done');
  assert.match(c1.textContent, /defeats/);
  await sleep(700);
  assert.equal(demo.host.state.results.length, 1);
  assert.match(desk.textContent, /Results/);
  assert.match(desk.textContent, /6-0/);
  c1.querySelector('[data-action="clear"]').click();
  await sleep(600);
  assert.equal(demo.host.state.courts['1'].status, 'free');
  assert.ok(demo.host.state.alerts.some(a => a.kind === 'freed'));

  // changeover on court 2 shows the sponsor loop
  const app2 = demo.courts['2'];
  while (app2.state.match.games[0] + app2.state.match.games[1] < 3) app2.point(app2.state.match.games[0] === 1 ? 1 : 0);
  assert.ok(app2.state.restEndsAt > Date.now(), 'changeover timer running');
  await sleep(400);
  assert.match(c2.textContent, /Changeover/);
  assert.match(c2.textContent, /Café Racquet|Physio Verdun|Cordage|Marché/);
  await sleep(700);
  assert.ok(Object.values(demo.host.state.impressions).reduce((a, b) => a + b, 0) >= 1, 'impression counted on the desk');

  window.close();
});

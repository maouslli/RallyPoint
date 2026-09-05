const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/js/voice.js');
const H = require('../public/js/hub.js');

const p = (t, o) => V.parseCall(t, o);

test('parses English score calls', () => {
  assert.deepEqual(p('thirty fifteen'), { kind: 'score', a: 30, b: 15, words: true, raw: 'thirty fifteen' });
  assert.equal(p('30-15').a, 30); assert.equal(p('30-15').b, 15);
  assert.equal(p('forty love').b, 0);
  assert.equal(p('love forty').a, 0);
  assert.deepEqual([p('15 all').a, p('15 all').b], [15, 15]);
  assert.deepEqual([p('love all').a, p('love all').b], [0, 0]);
  assert.equal(p('forty five').b, 15, '"forty-five" is casual shorthand for 40-15');
  assert.deepEqual([p('3015').a, p('3015').b], [30, 15]);
  assert.deepEqual([p('the score is 40 to 30').a, p('the score is 40 to 30').b], [40, 30]);
});

test('parses French score calls', () => {
  assert.deepEqual([p('trente quinze').a, p('trente quinze').b], [30, 15]);
  assert.deepEqual([p('quinze partout').a, p('quinze partout').b], [15, 15]);
  assert.equal(p('égalité').kind, 'deuce');
  assert.equal(p('avantage service').kind, 'adIn');
  assert.equal(p('avantage relance').kind, 'adOut');
  assert.equal(p('jeu').kind, 'game');
  assert.equal(p('faute').cmd, 'fault');
  assert.equal(p('correction').cmd, 'correction');
  assert.equal(p('arbitre').cmd, 'umpire');
});

test('special scores and commands', () => {
  assert.equal(p('deuce').kind, 'deuce');
  assert.equal(p('juice').kind, 'deuce', 'common misrecognition');
  assert.equal(p('ad in').kind, 'adIn');
  assert.equal(p('advantage server').kind, 'adIn');
  assert.equal(p('ad out').kind, 'adOut');
  assert.equal(p('advantage').kind, 'ad');
  assert.equal(p('game').kind, 'game');
  assert.equal(p('game point'), null);
  assert.equal(p('fault').cmd, 'fault');
  assert.equal(p('double fault').cmd, 'doubleFault');
  assert.equal(p('let').cmd, 'let');
  assert.equal(p('correction').cmd, 'correction');
  assert.equal(p('scratch that').cmd, 'correction');
  assert.equal(p('umpire').cmd, 'umpire');
  assert.equal(p('call the referee').cmd, 'umpire');
  assert.equal(p('time').cmd, 'time');
  assert.equal(p('point server').cmd, 'pointServer');
  assert.equal(p('point to the receiver').cmd, 'pointReceiver');
  assert.equal(p('force changeover').cmd, 'changeover');
});

test('ignores chatter with no score in it', () => {
  assert.equal(p('nice shot'), null);
  assert.equal(p('fifteen'), null, 'a single number is not a score');
  assert.equal(p(''), null);
});

test('wake word gates everything when set', () => {
  assert.equal(p('thirty fifteen', { wakeWord: 'court two' }), null);
  assert.equal(p('court two thirty fifteen', { wakeWord: 'court two' }).a, 30);
  assert.equal(p('court 2 fault', { wakeWord: 'court two' }).cmd, 'fault');
});

test('tiebreak-style numeric calls', () => {
  const r = p('5 3');
  assert.equal(r.kind, 'score'); assert.equal(r.a, 5); assert.equal(r.b, 3); assert.equal(r.words, false);
});

/* ---------------- hub ---------------- */

test('hub: assign, live state, result and freed court', () => {
  let t = H.initialState({ courts: 2 });
  assert.equal(t.queue.length, 5);
  let r = H.reduce(t, { type: 'org:assign', courtId: '1', matchId: 'm104' }, 1000);
  t = r.state;
  assert.equal(t.courts['1'].status, 'assigned');
  assert.equal(t.matches.m104.status, 'assigned');
  assert.equal(t.queue.indexOf('m104'), -1);
  r = H.reduce(t, { type: 'court:state', courtId: '1', seq: 5, snapshot: { status: 'live', matchId: 'm104', rulesVersion: 1 } }, 2000);
  t = r.state;
  assert.equal(t.courts['1'].status, 'live');
  assert.equal(t.matches.m104.status, 'live');
  r = H.reduce(t, { type: 'court:state', courtId: '1', seq: 6, snapshot: { status: 'done', matchId: 'm104', result: { line: '6-4 6-3', winner: 0 } } }, 3000);
  t = r.state;
  assert.equal(t.matches.m104.status, 'done');
  assert.equal(t.results.length, 1);
  assert.equal(t.results[0].result.line, '6-4 6-3');
  r = H.reduce(t, { type: 'court:state', courtId: '1', seq: 7, snapshot: { status: 'free' } }, 4000);
  t = r.state;
  assert.equal(t.courts['1'].status, 'free');
  assert.ok(t.alerts.some(a => a.kind === 'freed'));
});

test('hub: stale snapshots are ignored, rules and sponsors are versioned', () => {
  let t = H.initialState({ courts: 1 });
  t = H.reduce(t, { type: 'court:state', courtId: '1', seq: 10, snapshot: { status: 'live', matchId: 'm105' } }).state;
  t = H.reduce(t, { type: 'court:state', courtId: '1', seq: 4, snapshot: { status: 'free' } }).state;
  assert.equal(t.courts['1'].status, 'live');
  const v = t.rulesVersion;
  t = H.reduce(t, { type: 'org:rules', rules: { noAd: true, serveClockSec: 20 } }).state;
  assert.equal(t.rulesVersion, v + 1);
  assert.equal(t.rules.noAd, true);
  assert.equal(t.rules.serveClockSec, 20);
  t = H.reduce(t, { type: 'org:sponsors', sponsors: [{ name: 'Test' }], adRateCad: 0.5 }).state;
  assert.equal(t.sponsors.length, 1);
  assert.ok(t.sponsors[0].id);
  t = H.reduce(t, { type: 'court:event', courtId: '1', event: { kind: 'impression', sponsorId: t.sponsors[0].id } }).state;
  t = H.reduce(t, { type: 'court:event', courtId: '1', event: { kind: 'impression', sponsorId: t.sponsors[0].id } }).state;
  assert.deepEqual(H.revenue(t), { impressions: 2, estimateCad: 1 });
});

test('hub host replies with a snapshot on hello and broadcasts changes', () => {
  const host = H.createHost({ courts: 2 });
  const out = host.handle({ type: 'hello', role: 'court', courtId: '2' }, 'c2');
  assert.equal(out[0].to, 'c2');
  assert.equal(out[0].msg.type, 'snapshot');
  assert.equal(out[1].to, 'all');
  assert.equal(host.state.courts['2'].online, true);
  const none = host.handle({ type: 'ping' }, 'c2');
  assert.equal(none.length, 0);
});

test('hub: umpire call raises an alert that can be acknowledged', () => {
  let t = H.initialState({ courts: 1 });
  t = H.reduce(t, { type: 'court:event', courtId: '1', event: { kind: 'umpire' } }).state;
  assert.equal(t.alerts.length, 1);
  t = H.reduce(t, { type: 'org:ack', alertId: t.alerts[0].id }).state;
  assert.equal(t.alerts[0].ack, true);
});

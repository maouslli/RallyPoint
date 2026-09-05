const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/js/scoring.js');

const singles = (rules) => S.startMatch(S.createMatch({
  format: 'singles', rules,
  teams: [{ players: ['S. Gagnon'] }, { players: ['L. Nguyen'] }]
})).state;

const doubles = (rules, start) => S.startMatch(S.createMatch({
  format: 'doubles', rules,
  teams: [{ players: ['J. Tremblay', 'A. Roy'] }, { players: ['M. Dubois', 'P. Lefebvre'] }]
}), start || { firstServer: { team: 0, player: 0 }, opponentFirstPlayer: 0 }).state;

function pts(m, seq) {
  let ev = [];
  for (const ch of seq) { const r = S.applyPoint(m, ch === 'a' ? 0 : 1); m = r.state; ev = ev.concat(r.events); }
  return { m, ev };
}
function winGame(m, team) { return pts(m, (team === 0 ? 'a' : 'b').repeat(4)).m; }
function winGames(m, team, n) { for (let i = 0; i < n; i++) m = winGame(m, team); return m; }

test('standard game: 15 30 40 game', () => {
  let m = singles();
  m = pts(m, 'a').m; assert.equal(S.callString(m), '15-Love');
  m = pts(m, 'a').m; assert.equal(S.callString(m), '30-Love');
  m = pts(m, 'b').m; assert.equal(S.callString(m), '30-15');
  m = pts(m, 'a').m; assert.equal(S.callString(m), '40-15');
  const r = S.applyPoint(m, 0);
  assert.deepEqual(r.state.games, [1, 0]);
  assert.ok(r.events.some(e => e.type === 'game'));
  assert.deepEqual(r.state.points, [0, 0]);
});

test('deuce and advantage with ad scoring', () => {
  let m = pts(singles(), 'aaabbb').m;
  assert.equal(S.callString(m), 'Deuce');
  m = pts(m, 'a').m; assert.equal(S.callString(m), 'Ad in');
  assert.deepEqual(S.pointLabels(m), ['AD', '40']);
  m = pts(m, 'b').m; assert.equal(S.callString(m), 'Deuce');
  m = pts(m, 'b').m; assert.equal(S.callString(m), 'Ad out');
  m = pts(m, 'b').m; assert.deepEqual(m.games, [0, 1]);
});

test('no-ad: deciding point at deuce', () => {
  let m = pts(singles({ noAd: true }), 'aaabbb').m;
  assert.equal(S.callString(m), 'Deuce, deciding point');
  assert.equal(S.scoreboard(m).decidingPoint, true);
  m = pts(m, 'b').m;
  assert.deepEqual(m.games, [0, 1]);
});

test('serve alternates each game in singles and 90 s changeover after odd games', () => {
  let m = singles();
  assert.equal(S.serverOf(m).name, 'S. Gagnon');
  const r1 = pts(m, 'aaaa');
  m = r1.m;
  assert.equal(S.serverOf(m).name, 'L. Nguyen');
  const rest1 = r1.ev.find(e => e.type === 'rest');
  assert.equal(rest1.kind, 'changeEnds'); // no rest after the first game of a set
  assert.equal(rest1.restSec, 0);
  m = winGame(m, 1);
  assert.equal(m.rest, null);
  const r3 = pts(m, 'aaaa');
  const rest3 = r3.ev.find(e => e.type === 'rest');
  assert.equal(rest3.kind, 'changeover');
  assert.equal(rest3.restSec, 90);
});

test('set won at 6-4, then 120 s set break', () => {
  let m = winGames(singles(), 0, 5);
  m = winGames(m, 1, 4);
  const r = S.applyPoint(pts(m, 'aaa').m, 0);
  assert.equal(r.state.sets.length, 1);
  assert.deepEqual(r.state.sets[0].games, [6, 4]);
  assert.deepEqual(r.state.games, [0, 0]);
  const rest = r.events.find(e => e.type === 'rest');
  assert.equal(rest.kind, 'setBreak');
  assert.equal(rest.restSec, 120);
});

test('set tiebreak at 6-6: to 7 by 2, ends change every 6 points, server rotation 1-2-2', () => {
  let m = winGames(singles(), 0, 6); // 6-0? no: alternating to avoid set win
  m = singles();
  for (let i = 0; i < 6; i++) { m = winGame(m, 0); m = winGame(m, 1); }
  assert.deepEqual(m.games, [6, 6]);
  assert.equal(m.tiebreak.kind, 'set');
  const first = S.serverOf(m).name;
  m = pts(m, 'a').m;                   // point 1 served by first
  assert.notEqual(S.serverOf(m).name, first); // point 2: other player
  m = pts(m, 'b').m;
  assert.notEqual(S.serverOf(m).name, first); // point 3: same
  m = pts(m, 'a').m;
  assert.equal(S.serverOf(m).name, first);    // point 4: back to first
  const r6 = pts(m, 'bab'); // points 4,5,6
  const endsEv = r6.ev.find(e => e.type === 'rest' && e.kind === 'changeEnds');
  assert.ok(endsEv, 'change ends after 6 points');
  m = r6.m;
  assert.deepEqual(m.points, [3, 3]);
  m = pts(m, 'aaaa').m;               // 7-3
  assert.equal(m.sets.length, 1);
  assert.deepEqual(m.sets[0].games, [7, 6]);
  assert.deepEqual(m.sets[0].tb, [7, 3]);
  assert.equal(S.setLine(m), '7-6(3)');
});

test('tiebreak must be won by two', () => {
  let m = singles();
  for (let i = 0; i < 6; i++) { m = winGame(m, 0); m = winGame(m, 1); }
  m = pts(m, 'aaaaaabbbbbb').m; // 6-6
  m = pts(m, 'a').m;             // 7-6 not over
  assert.equal(m.tiebreak.kind, 'set');
  m = pts(m, 'a').m;             // 8-6
  assert.equal(m.sets.length, 1);
});

test('match tiebreak to 10 replaces the third set and is recorded as [10-x]', () => {
  let m = singles({ finalSetMatchTiebreak: true });
  m = winGames(m, 0, 6);
  m = winGames(m, 1, 6);
  assert.equal(m.sets.length, 2);
  assert.equal(m.tiebreak.kind, 'match');
  assert.equal(m.tiebreak.to, 10);
  m = pts(m, 'aaaaaaaaabbbbbbbb').m; // 9-8
  assert.equal(m.status, 'live');
  const r = S.applyPoint(m, 0);       // 10-8
  assert.equal(r.state.status, 'done');
  assert.equal(r.state.winner, 0);
  assert.equal(S.setLine(r.state), '6-0 0-6 [10-8]');
});

test('best of 3 without match tiebreak plays a full third set', () => {
  let m = singles({ finalSetMatchTiebreak: false });
  m = winGames(m, 0, 6); m = winGames(m, 1, 6);
  assert.equal(m.tiebreak, null);
  m = winGames(m, 0, 6);
  assert.equal(m.status, 'done');
  assert.equal(S.setLine(m), '6-0 0-6 6-0');
});

test('Fast4 / express: 4-game sets, no-ad, tiebreak at 3-3 to 5, no rest', () => {
  let m = singles(S.PRESETS.fast4);
  for (let i = 0; i < 3; i++) { m = winGame(m, 0); m = winGame(m, 1); }
  assert.equal(m.tiebreak.kind, 'set');
  assert.equal(m.tiebreak.to, 5);
  const r = pts(m, 'aaaaa');
  assert.deepEqual(r.m.sets[0].games, [4, 3]);
  const rest = r.ev.find(e => e.type === 'rest');
  assert.equal(rest.kind, 'changeEnds');
  assert.equal(rest.restSec, 0);
  let n = singles(S.PRESETS.fast4);
  n = winGame(n, 0); n = winGame(n, 1);
  const r3 = pts(n, 'aaaa');
  assert.equal(r3.ev.find(e => e.type === 'rest').restSec, 0, 'no 90 s changeover in express mode');
});

test('doubles: server rotation A1 B1 A2 B2 and receivers alternate deuce/ad courts', () => {
  let m = doubles();
  assert.equal(S.serverOf(m).name, 'J. Tremblay');
  assert.equal(S.receiverOf(m).name, 'M. Dubois');
  assert.equal(S.receiverOf(m).court, 'deuce');
  m = pts(m, 'a').m;
  assert.equal(S.receiverOf(m).name, 'P. Lefebvre');
  assert.equal(S.receiverOf(m).court, 'ad');
  m = pts(m, 'aaa').m; // game 1 to team A
  assert.equal(S.serverOf(m).name, 'M. Dubois');
  m = winGame(m, 1);
  assert.equal(S.serverOf(m).name, 'A. Roy');
  m = winGame(m, 0);
  assert.equal(S.serverOf(m).name, 'P. Lefebvre');
  m = winGame(m, 1);
  assert.equal(S.serverOf(m).name, 'J. Tremblay');
});

test('doubles: chosen first server and opponent order are respected', () => {
  const m = doubles(null, { firstServer: { team: 1, player: 1 }, opponentFirstPlayer: 1 });
  const order = m.serveOrder.map(s => m.teams[s.team].players[s.player].name);
  assert.deepEqual(order, ['P. Lefebvre', 'A. Roy', 'M. Dubois', 'J. Tremblay']);
});

test('doubles tiebreak: rotation continues, receivers keep their courts, next set opens with the side that received first', () => {
  let m = doubles();
  for (let i = 0; i < 6; i++) { m = winGame(m, 0); m = winGame(m, 1); }
  assert.equal(m.tiebreak.kind, 'set');
  const seq = [];
  for (let i = 0; i < 7; i++) { seq.push(S.serverOf(m).name + '>' + S.receiverOf(m).name); m = pts(m, 'a').m; }
  // games 1..12 rotate through 4 servers three times, so game 13 (the tiebreak) begins with J. Tremblay
  assert.deepEqual(seq.slice(0, 4), ['J. Tremblay>M. Dubois', 'M. Dubois>A. Roy', 'M. Dubois>J. Tremblay', 'A. Roy>P. Lefebvre']);
  assert.equal(m.sets.length, 1);
  // next set: player after the tiebreak's first server serves
  assert.equal(S.serverOf(m).name, 'M. Dubois');
});

test('fault then double fault gives the point to the receiver', () => {
  let m = singles();
  let r = S.applyFault(m);
  assert.equal(r.state.faults, 1);
  r = S.applyFault(r.state);
  assert.ok(r.events.some(e => e.type === 'doubleFault'));
  assert.deepEqual(r.state.points, [0, 1]);
  assert.equal(r.state.faults, 0);
});

test('correction (undo) restores the previous state including a game boundary', () => {
  let m = pts(singles(), 'aaa').m;
  const before = S.callString(m);
  const won = S.applyPoint(m, 0).state;
  assert.deepEqual(won.games, [1, 0]);
  const back = S.undo(won).state;
  assert.deepEqual(back.games, [0, 0]);
  assert.equal(S.callString(back), before);
  assert.equal(S.undo(S.undo(S.undo(S.undo(back).state).state).state).state.history.length, 0);
});

test('override sets games and points directly', () => {
  const m = S.override(singles(), { games: [3, 2], points: [2, 1], serveIdx: 1 }).state;
  assert.deepEqual(m.games, [3, 2]);
  assert.equal(S.callString(m), '15-30');
  assert.equal(S.serverOf(m).name, 'L. Nguyen');
});

test('organizer rules push applies to the live match', () => {
  const m = S.setRules(pts(singles(), 'aaabbb').m, { noAd: true }, 3).state;
  assert.equal(m.rulesVersion, 3);
  assert.equal(S.callString(m), 'Deuce, deciding point');
});

test('reconcile: server-first calls become points, matches confirm, unreachable calls are rejected', () => {
  let m = singles(); // S. Gagnon serves
  let r = S.reconcile(m, { kind: 'score', a: 15, b: 0 });
  assert.equal(r.action, 'apply'); assert.equal(r.team, 0);
  m = S.applyPoint(m, 0).state;
  r = S.reconcile(m, { kind: 'score', a: 15, b: 0 });
  assert.equal(r.action, 'confirm');
  r = S.reconcile(m, { kind: 'score', a: 15, b: 15 });
  assert.equal(r.action, 'apply'); assert.equal(r.team, 1);
  r = S.reconcile(m, { kind: 'score', a: 40, b: 30 });
  assert.equal(r.action, 'reject'); assert.equal(r.unreachable, true);
});

test('reconcile: receiver-first call is accepted only if it is the sole reachable reading', () => {
  const m = pts(singles(), 'aaab').m; // 40-15 server
  const r = S.reconcile(m, { kind: 'score', a: 30, b: 40 }); // unreachable as server-first, reachable swapped (40-30)
  assert.equal(r.action, 'apply'); assert.equal(r.team, 1);
  assert.match(r.reason, /receiver-first/);
});

test('reconcile: deuce, ad in, ad out and game', () => {
  let m = pts(singles(), 'aaabb').m; // 40-30
  assert.equal(S.reconcile(m, { kind: 'deuce' }).team, 1);
  m = pts(m, 'b').m; // deuce
  assert.equal(S.reconcile(m, { kind: 'adIn' }).team, 0);
  assert.equal(S.reconcile(m, { kind: 'adOut' }).team, 1);
  assert.equal(S.reconcile(m, { kind: 'ad' }).action, 'reject');
  m = pts(m, 'a').m; // ad in
  assert.equal(S.reconcile(m, { kind: 'ad' }).action, 'confirm');
  assert.equal(S.reconcile(m, { kind: 'game' }).team, 0);
  assert.equal(S.reconcile(m, { kind: 'deuce' }).team, 1);
});

test('reconcile: "game" is ambiguous on a no-ad deciding point', () => {
  const m = pts(singles({ noAd: true }), 'aaabbb').m;
  const r = S.reconcile(m, { kind: 'game' });
  assert.equal(r.action, 'ambiguous');
  assert.deepEqual(r.teams.sort(), [0, 1]);
});

test('reconcile in a tiebreak uses raw numbers', () => {
  let m = singles();
  for (let i = 0; i < 6; i++) { m = winGame(m, 0); m = winGame(m, 1); }
  m = pts(m, 'ab').m; // 1-1; L. Nguyen serves point 3, S. Gagnon will call the score before point 4
  assert.equal(S.serverOf(m).team, 1);
  // calls are read from the perspective of whoever serves next
  assert.equal(S.reconcile(m, { kind: 'score', a: 2, b: 1 }).team, 0);
  assert.equal(S.reconcile(m, { kind: 'score', a: 1, b: 2 }).team, 1);
  assert.equal(S.reconcile(m, { kind: 'score', a: 15, b: 30, words: true }).action, 'reject');
});

test('applyAssertionAsOverride forces the spoken score after a mismatch', () => {
  const m = singles();
  const r = S.applyAssertionAsOverride(m, { kind: 'score', a: 40, b: 30 }).state;
  assert.equal(S.callString(r), '40-30');
});

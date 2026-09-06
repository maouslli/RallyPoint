/*
 * RallyPoint — scoring engine
 * Pure functions over a plain match object. No DOM, no timers.
 * Works in the browser (window.RallyPoint.scoring) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RallyPoint = root.RallyPoint || {}; root.RallyPoint.scoring = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_RULES = {
    preset: 'standard',
    bestOf: 3,                  // 1, 3 or 5 sets
    gamesPerSet: 6,
    noAd: false,                // deciding point at deuce
    tiebreakAt: 6,              // games-all that triggers a set tiebreak
    tiebreakTo: 7,
    finalSetMatchTiebreak: true,// 10-point tiebreak in lieu of the deciding set
    matchTiebreakTo: 10,
    express: false,             // Fast-Play: change ends, no rest periods
    serveClockSec: 25,
    changeoverSec: 90,
    setBreakSec: 120,
    timeCallSec: 80             // "Time" is called this many seconds into a changeover
  };

  const PRESETS = {
    standard: { preset: 'standard', bestOf: 3, gamesPerSet: 6, noAd: false, tiebreakAt: 6, tiebreakTo: 7, finalSetMatchTiebreak: true, express: false, changeoverSec: 90, setBreakSec: 120 },
    noad:     { preset: 'noad', bestOf: 3, gamesPerSet: 6, noAd: true, tiebreakAt: 6, tiebreakTo: 7, finalSetMatchTiebreak: true, express: false, changeoverSec: 90, setBreakSec: 120 },
    fast4:    { preset: 'fast4', bestOf: 3, gamesPerSet: 4, noAd: true, tiebreakAt: 3, tiebreakTo: 5, finalSetMatchTiebreak: true, express: true, changeoverSec: 0, setBreakSec: 0 },
    oneset:   { preset: 'oneset', bestOf: 1, gamesPerSet: 6, noAd: false, tiebreakAt: 6, tiebreakTo: 7, finalSetMatchTiebreak: false, express: false, changeoverSec: 90, setBreakSec: 120 }
  };

  const POINT_LABELS = ['0', '15', '30', '40'];
  const HISTORY_LIMIT = 80;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function normalizeRules(r) { return Object.assign({}, DEFAULT_RULES, r || {}); }

  function playerName(team, idx) {
    const p = team.players[idx] || team.players[0];
    return p ? p.name : '';
  }
  function teamLabel(team) {
    return team.name || team.players.map(p => p.name).join(' / ');
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  function createMatch(opts) {
    opts = opts || {};
    const format = opts.format === 'doubles' ? 'doubles' : 'singles';
    const perTeam = format === 'doubles' ? 2 : 1;
    const teams = (opts.teams || []).slice(0, 2).map(t => ({
      name: t.name || '',
      players: (t.players || []).slice(0, perTeam).map(p => ({ name: typeof p === 'string' ? p : (p && p.name) || '' }))
    }));
    while (teams.length < 2) teams.push({ name: '', players: [] });
    teams.forEach((t, i) => { while (t.players.length < perTeam) t.players.push({ name: 'Player ' + (i + 1) + String.fromCharCode(65 + t.players.length) }); });

    const serveOrder = format === 'doubles'
      ? [{ team: 0, player: 0 }, { team: 1, player: 0 }, { team: 0, player: 1 }, { team: 1, player: 1 }]
      : [{ team: 0, player: 0 }, { team: 1, player: 0 }];

    return {
      id: opts.id || null,
      number: opts.number || null,
      round: opts.round || '',
      format, teams,
      rules: normalizeRules(opts.rules),
      rulesVersion: opts.rulesVersion || 0,
      status: 'ready',            // ready | live | done
      sets: [],                   // [{games:[a,b], tb:[a,b]|null, matchTiebreak:bool}]
      games: [0, 0],
      points: [0, 0],
      tiebreak: null,             // {kind:'set'|'match', to, firstServeIdx}
      serveOrder,
      serveIdx: 0,
      gameFirstServeIdx: 0,
      receiveOrder: [[0, 1], [0, 1]], // per team: [deuce-court player, ad-court player]
      faults: 0,
      ends: 0,
      rest: null,                 // {kind:'changeover'|'setBreak'|'changeEnds', restSec, swap, forced}
      winner: null,
      startedAt: null,
      endedAt: null,
      history: [],
      log: [],
      seq: 0
    };
  }

  function stripped(m) {
    const s = Object.assign({}, m);
    delete s.history;
    return clone(s);
  }

  function pushHistory(m) {
    const next = stripped(m);
    next.history = (m.history || []).concat([stripped(m)]).slice(-HISTORY_LIMIT);
    return next;
  }

  function addLog(m, text, now) {
    m.log = (m.log || []).concat([{ t: now || Date.now(), text }]).slice(-40);
  }

  /**
   * Start play. firstServer = {team, player}. opponentFirstPlayer picks which
   * member of the other team serves first (doubles). receiveOrder optionally
   * fixes deuce/ad court receivers per team.
   */
  function startMatch(m, opts, now) {
    opts = opts || {};
    const st = pushHistory(m);
    const fs = opts.firstServer || { team: 0, player: 0 };
    const other = 1 - fs.team;
    const of = opts.opponentFirstPlayer == null ? 0 : opts.opponentFirstPlayer;
    if (st.format === 'doubles') {
      st.serveOrder = [
        { team: fs.team, player: fs.player },
        { team: other, player: of },
        { team: fs.team, player: 1 - fs.player },
        { team: other, player: 1 - of }
      ];
    } else {
      st.serveOrder = [{ team: fs.team, player: 0 }, { team: other, player: 0 }];
    }
    if (opts.receiveOrder) st.receiveOrder = clone(opts.receiveOrder);
    st.serveIdx = 0;
    st.gameFirstServeIdx = 0;
    st.status = 'live';
    st.startedAt = now || Date.now();
    st.rest = null;
    st.seq++;
    addLog(st, 'Match started. ' + serverName(st) + ' to serve.', now);
    return { state: st, events: [{ type: 'start' }] };
  }

  /* ------------------------------------------------------------------ */
  /* Who serves, who receives                                            */
  /* ------------------------------------------------------------------ */

  function serverOf(m) {
    const n = m.serveOrder.length;
    let idx = m.serveIdx;
    if (m.tiebreak) {
      const t = m.points[0] + m.points[1];
      idx = (m.tiebreak.firstServeIdx + Math.floor((t + 1) / 2)) % n;
    }
    const s = m.serveOrder[idx];
    return { team: s.team, player: s.player, name: playerName(m.teams[s.team], s.player), idx };
  }

  function receiverOf(m) {
    const s = serverOf(m);
    const r = 1 - s.team;
    const t = m.points[0] + m.points[1];
    const court = t % 2 === 0 ? 'deuce' : 'ad';
    const player = m.format === 'doubles' ? m.receiveOrder[r][t % 2] : 0;
    return { team: r, player, court, name: playerName(m.teams[r], player) };
  }

  function serverName(m) { return serverOf(m).name; }

  /* ------------------------------------------------------------------ */
  /* Scoring                                                              */
  /* ------------------------------------------------------------------ */

  function setsWon(m, team) {
    return m.sets.filter(s => setWinner(s) === team).length;
  }
  function setWinner(s) {
    return s.games[0] > s.games[1] ? 0 : 1;
  }
  function setsNeeded(m) { return Math.floor(m.rules.bestOf / 2) + 1; }

  function applyPoint(m, team, now) {
    if (m.status !== 'live') return { state: m, events: [] };
    now = now || Date.now();
    const st = pushHistory(m);
    const ev = [];
    const o = 1 - team;
    st.faults = 0;
    st.rest = null;
    st.points[team]++;
    ev.push({ type: 'point', team });
    const p = st.points;

    let gameWon = false;
    if (st.tiebreak) {
      const to = st.tiebreak.to;
      if (p[team] >= to && p[team] - p[o] >= 2) gameWon = true;
      else if ((p[0] + p[1]) % 6 === 0) {
        st.ends ^= 1;
        st.rest = { kind: 'changeEnds', restSec: 0, swap: true };
        ev.push({ type: 'rest', kind: 'changeEnds', restSec: 0, swap: true });
      }
    } else if (st.rules.noAd) {
      if (p[team] >= 4) gameWon = true;
    } else if (p[team] >= 4 && p[team] - p[o] >= 2) {
      gameWon = true;
    }

    if (!gameWon) {
      st.seq++;
      addLog(st, 'Point ' + teamLabel(st.teams[team]) + ' — ' + callString(st), now);
      return { state: st, events: ev };
    }

    // ---- game won ----
    const tb = st.tiebreak;
    const tbPoints = tb ? [p[0], p[1]] : null;
    st.points = [0, 0];
    st.tiebreak = null;
    const n = st.serveOrder.length;

    if (tb && tb.kind === 'match') {
      ev.push({ type: 'game', team, games: st.games.slice() });
      addLog(st, 'Match tiebreak ' + tbPoints.join('-') + ' to ' + teamLabel(st.teams[team]), now);
      return finishSet(st, team, ev, { setGames: [team === 0 ? 1 : 0, team === 1 ? 1 : 0], tb: tbPoints, matchTiebreak: true, tbFirst: tb.firstServeIdx }, now);
    }

    st.games[team]++;
    ev.push({ type: 'game', team, games: st.games.slice() });
    addLog(st, 'Game ' + teamLabel(st.teams[team]) + ' — ' + st.games.join('-'), now);
    const g = st.games;

    let setWon = false;
    if (tb) setWon = true;
    else if (g[team] >= st.rules.gamesPerSet && g[team] - g[o] >= 2) setWon = true;
    if (setWon) {
      return finishSet(st, team, ev, { setGames: g.slice(), tb: tbPoints, matchTiebreak: false, tbFirst: tb ? tb.firstServeIdx : null }, now);
    }

    // next game: rotate server
    st.serveIdx = (st.gameFirstServeIdx + 1) % n;
    st.gameFirstServeIdx = st.serveIdx;

    if (g[0] === st.rules.tiebreakAt && g[1] === st.rules.tiebreakAt) {
      st.tiebreak = { kind: 'set', to: st.rules.tiebreakTo, firstServeIdx: st.serveIdx };
      ev.push({ type: 'tiebreak', kind: 'set', to: st.rules.tiebreakTo });
      addLog(st, 'Tiebreak to ' + st.rules.tiebreakTo, now);
    }

    const total = g[0] + g[1];
    if (total % 2 === 1) {
      st.ends ^= 1;
      const restSec = (total === 1 || st.rules.express) ? 0 : st.rules.changeoverSec;
      st.rest = { kind: restSec > 0 ? 'changeover' : 'changeEnds', restSec, swap: true };
      ev.push({ type: 'rest', kind: st.rest.kind, restSec, swap: true });
    }
    st.seq++;
    return { state: st, events: ev };
  }

  function finishSet(st, team, ev, info, now) {
    const n = st.serveOrder.length;
    st.sets.push({ games: info.setGames, tb: info.tb, matchTiebreak: !!info.matchTiebreak });
    st.games = [0, 0];
    st.tiebreak = null;
    ev.push({ type: 'set', team, sets: st.sets.map(s => s.games.slice()) });
    addLog(st, (info.matchTiebreak ? 'Match tiebreak' : 'Set') + ' to ' + teamLabel(st.teams[team]) + ' (' + setLine(st) + ')', now);

    const need = setsNeeded(st);
    const won = setsWon(st, team);
    const lost = setsWon(st, 1 - team);
    if (won >= need) {
      st.status = 'done';
      st.winner = team;
      st.endedAt = now;
      st.rest = null;
      st.seq++;
      ev.push({ type: 'match', winner: team, score: setLine(st) });
      addLog(st, 'Match: ' + teamLabel(st.teams[team]) + ' wins ' + setLine(st), now);
      return { state: st, events: ev };
    }

    // The side that served first in a tiebreak receives first in the next set.
    st.serveIdx = ((info.tbFirst == null ? st.gameFirstServeIdx : info.tbFirst) + 1) % n;
    st.gameFirstServeIdx = st.serveIdx;

    const decider = st.sets.length === st.rules.bestOf - 1 && won === need - 1 && lost === need - 1;
    if (decider && st.rules.finalSetMatchTiebreak) {
      st.tiebreak = { kind: 'match', to: st.rules.matchTiebreakTo, firstServeIdx: st.serveIdx };
      ev.push({ type: 'tiebreak', kind: 'match', to: st.rules.matchTiebreakTo });
      addLog(st, 'Match tiebreak to ' + st.rules.matchTiebreakTo, now);
    }

    const totalGames = info.setGames[0] + info.setGames[1];
    const swap = totalGames % 2 === 1;
    if (swap) st.ends ^= 1;
    const restSec = st.rules.express ? 0 : st.rules.setBreakSec;
    st.rest = { kind: restSec > 0 ? 'setBreak' : 'changeEnds', restSec, swap };
    ev.push({ type: 'rest', kind: st.rest.kind, restSec, swap });
    st.seq++;
    return { state: st, events: ev };
  }

  function applyFault(m, now) {
    if (m.status !== 'live') return { state: m, events: [] };
    if (m.faults === 0) {
      const st = pushHistory(m);
      st.faults = 1;
      st.seq++;
      addLog(st, 'Fault. Second serve.', now);
      return { state: st, events: [{ type: 'fault', n: 1 }] };
    }
    const r = receiverOf(m).team;
    const res = applyPoint(m, r, now);
    res.events.unshift({ type: 'doubleFault' });
    addLog(res.state, 'Double fault.', now);
    return res;
  }

  function applyLet(m, now) {
    if (m.status !== 'live') return { state: m, events: [] };
    const st = clone(m);
    addLog(st, 'Let. Replay the serve.', now);
    return { state: st, events: [{ type: 'let' }] };
  }

  function undo(m, now) {
    if (!m.history || !m.history.length) return { state: m, events: [] };
    const prev = clone(m.history[m.history.length - 1]);
    prev.history = m.history.slice(0, -1);
    prev.seq = m.seq + 1;
    prev.log = (m.log || []).slice();
    addLog(prev, 'Correction — back to ' + callString(prev), now);
    return { state: prev, events: [{ type: 'correction' }] };
  }

  /** Manual override from the tablet: any of games, points, server index, tiebreak flag. */
  function override(m, patch, now) {
    const st = pushHistory(m);
    if (patch.games) st.games = [Math.max(0, patch.games[0] | 0), Math.max(0, patch.games[1] | 0)];
    if (patch.points) st.points = [Math.max(0, patch.points[0] | 0), Math.max(0, patch.points[1] | 0)];
    if (patch.serveIdx != null) { st.serveIdx = patch.serveIdx % st.serveOrder.length; st.gameFirstServeIdx = st.serveIdx; }
    if (patch.tiebreak === true && !st.tiebreak) st.tiebreak = { kind: 'set', to: st.rules.tiebreakTo, firstServeIdx: st.serveIdx };
    if (patch.tiebreak === false) st.tiebreak = null;
    if (patch.sets) st.sets = clone(patch.sets);
    st.faults = 0;
    st.rest = null;
    st.seq++;
    addLog(st, 'Override — ' + setLine(st, true) + ' ' + st.games.join('-') + ' (' + callString(st) + ')', now);
    return { state: st, events: [{ type: 'override' }] };
  }

  /** Organizer pushed new rules. Applies immediately to future games. */
  function setRules(m, rules, version) {
    const st = clone(m);
    st.rules = normalizeRules(Object.assign({}, m.rules, rules));
    if (version != null) st.rulesVersion = version;
    if (st.tiebreak && st.tiebreak.kind === 'set') st.tiebreak.to = st.rules.tiebreakTo;
    if (st.tiebreak && st.tiebreak.kind === 'match') st.tiebreak.to = st.rules.matchTiebreakTo;
    st.seq++;
    addLog(st, 'Rules updated by the organizer desk (v' + st.rulesVersion + ')');
    return { state: st, events: [{ type: 'rules' }] };
  }

  function forceRest(m, restSec, now) {
    const st = clone(m);
    st.rest = { kind: 'changeover', restSec: restSec == null ? m.rules.changeoverSec || 90 : restSec, swap: false, forced: true };
    st.seq++;
    addLog(st, 'Changeover forced by the court.', now);
    return { state: st, events: [{ type: 'rest', kind: 'changeover', restSec: st.rest.restSec, swap: false, forced: true }] };
  }

  function endRest(m, now) {
    const st = clone(m);
    st.rest = null;
    st.seq++;
    return { state: st, events: [{ type: 'time' }] };
  }

  /* ------------------------------------------------------------------ */
  /* Display                                                              */
  /* ------------------------------------------------------------------ */

  function pointLabels(m) {
    const p = m.points;
    if (m.tiebreak) return [String(p[0]), String(p[1])];
    if (p[0] >= 3 && p[1] >= 3) {
      if (p[0] === p[1]) return ['40', '40'];
      return p[0] > p[1] ? ['AD', '40'] : ['40', 'AD'];
    }
    return [POINT_LABELS[Math.min(p[0], 3)], POINT_LABELS[Math.min(p[1], 3)]];
  }

  function spokenLabel(p) {
    return p === 0 ? 'Love' : POINT_LABELS[p];
  }

  /** The score as the server would call it before serving. */
  function callString(m) {
    const s = serverOf(m).team;
    const r = 1 - s;
    const ps = m.points[s], pr = m.points[r];
    if (m.tiebreak) return ps === pr ? ps + ' all' : ps + '-' + pr;
    if (ps >= 3 && pr >= 3) {
      if (ps === pr) return m.rules.noAd ? 'Deuce, deciding point' : 'Deuce';
      return ps > pr ? 'Ad in' : 'Ad out';
    }
    if (ps === pr) return ps === 0 ? 'Love all' : POINT_LABELS[ps] + ' all';
    return spokenLabel(ps) + '-' + spokenLabel(pr);
  }

  function setLine(m, includeCurrent) {
    const parts = m.sets.map(s => s.matchTiebreak ? '[' + s.tb.join('-') + ']' : (s.games.join('-') + (s.tb ? '(' + Math.min(s.tb[0], s.tb[1]) + ')' : '')));
    if (includeCurrent && (m.games[0] || m.games[1] || m.points[0] || m.points[1])) parts.push(m.games.join('-'));
    return parts.join(' ');
  }

  function scoreboard(m) {
    const live = m.status !== 'ready';
    const srv = live ? serverOf(m) : null;
    const rcv = live ? receiverOf(m) : null;
    const pl = pointLabels(m);
    const decidingPoint = !m.tiebreak && m.rules.noAd && m.points[0] === 3 && m.points[1] === 3;
    const teams = m.teams.map((t, i) => ({
      label: teamLabel(t),
      players: t.players.map(p => p.name),
      sets: setsWon(m, i),
      games: m.games[i],
      points: pl[i],
      serving: !!srv && srv.team === i,
      receiving: !!rcv && rcv.team === i,
      activePlayer: srv && srv.team === i ? srv.player : (rcv && rcv.team === i ? rcv.player : null),
      activeName: srv && srv.team === i ? srv.name : (rcv && rcv.team === i ? rcv.name : ''),
      gamePoint: gamePointFor(m, i),
      winner: m.winner === i
    }));
    return {
      status: m.status,
      format: m.format,
      teams,
      sets: m.sets.map(s => ({ games: s.games.slice(), tb: s.tb ? s.tb.slice() : null, matchTiebreak: s.matchTiebreak })),
      setLine: setLine(m),
      call: live ? callString(m) : '',
      server: srv, receiver: rcv,
      tiebreak: m.tiebreak ? m.tiebreak.kind : null,
      tiebreakTo: m.tiebreak ? m.tiebreak.to : null,
      decidingPoint,
      faults: m.faults,
      rest: m.rest,
      ends: m.ends,
      rules: m.rules,
      rulesVersion: m.rulesVersion,
      seq: m.seq,
      winner: m.winner
    };
  }

  function gamePointFor(m, team) {
    const p = m.points, o = 1 - team;
    if (m.status !== 'live') return false;
    if (m.tiebreak) return p[team] >= m.tiebreak.to - 1 && p[team] - p[o] >= 1;
    if (m.rules.noAd) return p[team] === 3;
    return p[team] >= 3 && p[team] - p[o] >= 1;
  }

  /* ------------------------------------------------------------------ */
  /* Voice-call reconciliation                                            */
  /* ------------------------------------------------------------------ */

  function scoreKey(m, events) {
    if (events && events.some(e => e.type === 'game')) return ['game'];
    const s = serverOf(m).team;
    const ps = m.points[s], pr = m.points[1 - s];
    if (m.tiebreak) return ['tb:' + ps + '-' + pr];
    if (ps >= 3 && pr >= 3) {
      if (ps === pr) return ['deuce'];
      return [ps > pr ? 'adin' : 'adout'];
    }
    return [POINT_LABELS[ps] + '-' + POINT_LABELS[pr]];
  }

  function assertionKey(m, a) {
    if (a.kind === 'deuce') return 'deuce';
    if (a.kind === 'adIn') return 'adin';
    if (a.kind === 'adOut') return 'adout';
    if (a.kind === 'game') return 'game';
    if (a.kind === 'score') {
      if (m.tiebreak && !a.words) return 'tb:' + a.a + '-' + a.b;
      if (m.tiebreak && a.words) return 'tb:' + a.a + '-' + a.b; // "fifteen" in a tiebreak is a misfire; will not match
      const ok = v => [0, 15, 30, 40].indexOf(v) >= 0;
      if (!ok(a.a) || !ok(a.b)) return null;
      if (a.a === 40 && a.b === 40) return 'deuce';
      return a.a + '-' + a.b;
    }
    return null;
  }

  /**
   * Treat a spoken call as an assertion about the score and work out which
   * single point (if any) makes it true. Only scores reachable within one
   * point of the current state are accepted, which is what filters out calls
   * drifting over from the next court.
   */
  function reconcile(m, a, now) {
    if (!a) return { action: 'reject', reason: 'Nothing recognizable in that call.' };
    if (a.kind === 'command') return { action: 'command', cmd: a.cmd, assertion: a };
    if (m.status !== 'live') return { action: 'reject', reason: 'The match is not live yet.', assertion: a };

    const s = serverOf(m).team, r = 1 - s;
    const ifServer = applyPoint(m, s, now), ifReceiver = applyPoint(m, r, now);
    const cands = [
      { team: null, keys: scoreKey(m, null) },
      { team: s, keys: scoreKey(ifServer.state, ifServer.events) },
      { team: r, keys: scoreKey(ifReceiver.state, ifReceiver.events) }
    ];

    if (a.kind === 'ad') {
      const inOk = cands.filter(c => c.keys.indexOf('adin') >= 0);
      const outOk = cands.filter(c => c.keys.indexOf('adout') >= 0);
      const poss = inOk.concat(outOk);
      if (poss.length === 1) return decide(poss, a, m, 'Advantage ' + (inOk.length ? 'in' : 'out'));
      return { action: 'reject', reason: 'Say "ad in" or "ad out".', assertion: a };
    }

    const key = assertionKey(m, a);
    if (!key) return { action: 'reject', reason: 'That is not a tennis score.', assertion: a };
    let matches = cands.filter(c => c.keys.indexOf(key) >= 0);
    let note = '';
    if (!matches.length && a.kind === 'score' && a.a !== a.b) {
      const swapped = assertionKey(m, { kind: 'score', a: a.b, b: a.a, words: a.words });
      matches = cands.filter(c => c.team != null && c.keys.indexOf(swapped) >= 0);
      if (matches.length) note = 'Heard receiver-first; read as ' + swapped.replace('tb:', '') + '.';
    }
    if (!matches.length) {
      return { action: 'reject', reason: 'Heard "' + describe(a) + '" but the score is ' + callString(m) + '. Not reachable in one point — ignored.', assertion: a, unreachable: true };
    }
    return decide(matches, a, m, note);
  }

  function decide(matches, a, m, note) {
    const withTeam = matches.filter(c => c.team != null);
    const current = matches.some(c => c.team == null);
    if (current && !withTeam.length) return { action: 'confirm', reason: 'Score confirmed: ' + callString(m), assertion: a };
    if (withTeam.length === 1) return { action: 'apply', team: withTeam[0].team, reason: note || ('Point to ' + teamLabel(m.teams[withTeam[0].team])), assertion: a };
    if (current && withTeam.length) return { action: 'confirm', reason: 'Score confirmed: ' + callString(m), assertion: a };
    return { action: 'ambiguous', teams: withTeam.map(c => c.team), reason: 'Both sides had game point — who won it?', assertion: a };
  }

  function describe(a) {
    if (!a) return '';
    if (a.kind === 'score') return a.a + '-' + a.b;
    if (a.kind === 'deuce') return 'deuce';
    if (a.kind === 'adIn') return 'ad in';
    if (a.kind === 'adOut') return 'ad out';
    if (a.kind === 'ad') return 'advantage';
    if (a.kind === 'game') return 'game';
    if (a.kind === 'command') return a.cmd;
    return a.raw || '';
  }

  /** Force the score to a spoken assertion (used after a mismatch, with a tap to confirm). */
  function applyAssertionAsOverride(m, a, now) {
    const s = serverOf(m).team, r = 1 - s;
    const pts = [0, 0];
    if (a.kind === 'score') {
      const toIdx = v => m.tiebreak ? v : { 0: 0, 15: 1, 30: 2, 40: 3 }[v];
      if (toIdx(a.a) == null || toIdx(a.b) == null) return { state: m, events: [] };
      pts[s] = toIdx(a.a); pts[r] = toIdx(a.b);
    } else if (a.kind === 'deuce') { pts[s] = 3; pts[r] = 3; }
    else if (a.kind === 'adIn') { pts[s] = 4; pts[r] = 3; }
    else if (a.kind === 'adOut') { pts[s] = 3; pts[r] = 4; }
    else return { state: m, events: [] };
    return override(m, { points: pts }, now);
  }

  function durationSec(m, now) {
    if (!m.startedAt) return 0;
    return Math.round(((m.endedAt || now || Date.now()) - m.startedAt) / 1000);
  }

  return {
    DEFAULT_RULES, PRESETS, clone, normalizeRules,
    createMatch, startMatch, applyPoint, applyFault, applyLet, undo, override, setRules, forceRest, endRest,
    serverOf, receiverOf, scoreboard, callString, setLine, pointLabels, teamLabel, setsWon,
    reconcile, applyAssertionAsOverride, describe, durationSec
  };
});

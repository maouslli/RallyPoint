/*
 * RallyPoint — landing rally
 * Drives a demonstration match for the homepage through the real scoring
 * engine, so the call under the headline is what the server would say next.
 * Works in the browser (window.RallyPoint.landingRally) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scoring.js'));
  else { root.RallyPoint = root.RallyPoint || {}; root.RallyPoint.landingRally = factory(root.RallyPoint.scoring); }
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  const DEFAULT_TEAMS = [{ players: ['S. Gagnon'] }, { players: ['L. Nguyen'] }];

  /**
   * createDemoMatch({ teams, format, rules }) -> driver
   * driver.point(team) applies a point and returns { call, server, setLine, board, events }.
   * events is a subset of ['game', 'set', 'match']. A finished match restarts fresh.
   */
  function createDemoMatch(opts) {
    opts = opts || {};
    let m;
    function fresh() {
      m = S.startMatch(
        S.createMatch({ format: opts.format || 'singles', teams: opts.teams || DEFAULT_TEAMS, rules: opts.rules }),
        { firstServer: { team: 0, player: 0 } }
      ).state;
    }
    fresh();

    function snapshot(events) {
      return { call: S.callString(m), server: S.serverOf(m), setLine: S.setLine(m), board: S.scoreboard(m), events: events || [] };
    }

    return {
      get state() { return m; },
      get call() { return S.callString(m); },
      get server() { return S.serverOf(m); },
      get setLine() { return S.setLine(m); },
      get board() { return S.scoreboard(m); },
      point(team) {
        const r = S.applyPoint(m, team);
        m = r.state;
        const events = ['game', 'set', 'match'].filter(k => r.events.some(e => e.type === k));
        if (m.status === 'done') fresh();
        return snapshot(events);
      }
    };
  }

  return { createDemoMatch, DEFAULT_TEAMS };
});

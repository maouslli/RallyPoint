/*
 * RallyPoint — tournament hub
 * The one source of truth for courts, the match queue, rules, sponsors,
 * alerts, results and ad impressions. Pure reducer + a small host wrapper
 * that turns client messages into broadcasts. Runs in Node and the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scoring.js'));
  else { root.RallyPoint = root.RallyPoint || {}; root.RallyPoint.hub = factory(root.RallyPoint.scoring); }
})(typeof self !== 'undefined' ? self : this, function (scoring) {
  'use strict';

  const OFFLINE_AFTER_MS = 12000;

  function uid(prefix) { return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

  function defaultSponsors() {
    return [
      { id: 'sp_racquet', name: 'Café Racquet', tagline: 'Espresso and a fresh regrip, two blocks from the courts', colour: '#1F5F8B', text: '#FFFFFF', audio: 'Café Racquet, on Avenue du Parc. Show your draw sheet for a free espresso.', durationSec: 12, enabled: true, imageUrl: '' },
      { id: 'sp_physio', name: 'Physio Verdun', tagline: 'Same-week appointments for tennis elbow and sore shoulders', colour: '#2E7D4F', text: '#FFFFFF', audio: 'Physio Verdun. Same-week appointments for players.', durationSec: 12, enabled: true, imageUrl: '' },
      { id: 'sp_strings', name: 'Cordage Côte-des-Neiges', tagline: 'Restrung while you play the next round. Ready in 40 minutes.', colour: '#D6F53C', text: '#0B1F2A', audio: 'Cordage Côte-des-Neiges. Restrung while you play your next round.', durationSec: 12, enabled: true, imageUrl: '' },
      { id: 'sp_marche', name: 'Marché du Parc', tagline: 'Fruit, water and bagels at the tournament desk all weekend', colour: '#C84B31', text: '#FFFFFF', audio: 'Marché du Parc. Fruit, water and bagels at the tournament desk.', durationSec: 12, enabled: true, imageUrl: '' }
    ];
  }

  function defaultMatches() {
    const mk = (number, round, format, a, b) => ({
      id: 'm' + number, number, round, format,
      teams: [{ name: '', players: a.map(n => ({ name: n })) }, { name: '', players: b.map(n => ({ name: n })) }],
      status: 'queued', courtId: null, result: null, createdAt: Date.now()
    });
    return [
      mk(104, 'Doubles Masters 45+ · R1', 'doubles', ['J. Tremblay', 'A. Roy'], ['M. Dubois', 'P. Lefebvre']),
      mk(105, 'Open Singles · R1', 'singles', ['S. Gagnon'], ['L. Nguyen']),
      mk(106, 'Mixed Doubles · R1', 'doubles', ['C. Bouchard', 'É. Morin'], ['N. Lavoie', 'R. Fortin']),
      mk(107, 'Open Singles · R1', 'singles', ['K. Pelletier'], ['D. Côté']),
      mk(108, 'Junior U16 Singles · R1', 'singles', ['A. Bélanger'], ['T. Girard'])
    ];
  }

  function initialState(opts) {
    opts = opts || {};
    const courts = {};
    const n = opts.courts || 2;
    for (let i = 1; i <= n; i++) courts[String(i)] = { id: String(i), name: 'Court ' + i, online: false, status: 'free', matchId: null, snapshot: null, seq: 0, lastSeen: 0, rulesVersion: 0 };
    const matches = {};
    const queue = [];
    defaultMatches().forEach(m => { matches[m.id] = m; queue.push(m.id); });
    return {
      name: 'Tennis Montréal Open',
      venue: 'Parc Jarry · public courts',
      rules: Object.assign({}, scoring.DEFAULT_RULES),
      rulesVersion: 1,
      sponsors: defaultSponsors(),
      sponsorsVersion: 1,
      adRateCad: 0.35,           // estimated value per sponsor impression
      courts, matches, queue,
      alerts: [], results: [], impressions: {},
      updatedAt: Date.now()
    };
  }

  function nextMatchNumber(t) {
    return Object.values(t.matches).reduce((m, x) => Math.max(m, x.number || 0), 100) + 1;
  }

  function addAlert(t, courtId, kind, message, now) {
    t.alerts = t.alerts.concat([{ id: uid('al'), courtId, kind, message, ts: now, ack: false }]).slice(-30);
  }

  /**
   * reduce(state, msg, now) -> { state, changed, reply }
   * reply is a message for the sender only (used for hello -> snapshot).
   */
  function reduce(t, msg, now) {
    now = now || Date.now();
    const s = scoring.clone(t);
    let changed = true;
    let reply = null;
    const court = msg.courtId != null ? s.courts[String(msg.courtId)] : null;

    switch (msg.type) {
      case 'hello': {
        if (msg.role === 'court' && court) { court.online = true; court.lastSeen = now; }
        else changed = false;
        reply = { type: 'snapshot', tournament: s };
        break;
      }
      case 'bye': {
        if (court) court.online = false; else changed = false;
        break;
      }
      case 'court:state': {
        if (!court) { changed = false; break; }
        court.online = true; court.lastSeen = now;
        if (msg.seq != null && msg.seq < court.seq) { changed = true; break; } // stale, but presence changed
        court.seq = msg.seq || court.seq;
        court.snapshot = msg.snapshot || null;
        court.rulesVersion = msg.snapshot ? (msg.snapshot.rulesVersion || 0) : court.rulesVersion;
        const snap = msg.snapshot || {};
        const status = snap.status || 'free';
        const prevStatus = court.status;
        if (status === 'done' && snap.matchId && s.matches[snap.matchId] && s.matches[snap.matchId].status !== 'done') {
          const m = s.matches[snap.matchId];
          m.status = 'done';
          m.result = snap.result || null;
          s.results = [{ id: uid('r'), matchId: m.id, number: m.number, round: m.round, format: m.format, courtId: court.id, teams: m.teams, result: m.result, ts: now }].concat(s.results).slice(0, 100);
          addAlert(s, court.id, 'result', court.name + ' finished match #' + m.number + (m.result ? ' — ' + m.result.line : ''), now);
        }
        if (status === 'free' || status === 'done') {
          if (prevStatus !== 'free' && status === 'free') addAlert(s, court.id, 'freed', court.name + ' is free. Assign the next match.', now);
        }
        if (status === 'free') { court.matchId = null; court.snapshot = null; }
        else court.matchId = snap.matchId || court.matchId;
        if (snap.matchId && s.matches[snap.matchId] && status === 'live' && s.matches[snap.matchId].status !== 'done') s.matches[snap.matchId].status = 'live';
        court.status = status;
        break;
      }
      case 'court:event': {
        if (!court) { changed = false; break; }
        court.online = true; court.lastSeen = now;
        const e = msg.event || {};
        if (e.kind === 'umpire') addAlert(s, court.id, 'umpire', court.name + ' is asking for the tournament director' + (e.note ? ' — ' + e.note : '') + '.', now);
        else if (e.kind === 'impression') { s.impressions[e.sponsorId] = (s.impressions[e.sponsorId] || 0) + 1; }
        else if (e.kind === 'dispute') addAlert(s, court.id, 'dispute', court.name + ': ' + (e.note || 'score dispute'), now);
        else if (e.kind === 'offlineReplay') addAlert(s, court.id, 'info', court.name + ' reconnected and replayed ' + e.count + ' queued update' + (e.count === 1 ? '' : 's') + '.', now);
        else changed = false;
        break;
      }
      case 'org:assign': {
        const m = s.matches[msg.matchId];
        if (!court || !m) { changed = false; break; }
        if (court.matchId && court.matchId !== m.id && s.matches[court.matchId] && s.matches[court.matchId].status !== 'done') {
          const old = s.matches[court.matchId]; old.status = 'queued'; old.courtId = null; if (s.queue.indexOf(old.id) < 0) s.queue.unshift(old.id);
        }
        m.status = 'assigned'; m.courtId = court.id;
        s.queue = s.queue.filter(id => id !== m.id);
        court.matchId = m.id; court.status = 'assigned'; court.snapshot = null;
        break;
      }
      case 'org:clearCourt': {
        if (!court) { changed = false; break; }
        const m = court.matchId ? s.matches[court.matchId] : null;
        if (m && m.status !== 'done') { m.status = 'queued'; m.courtId = null; if (s.queue.indexOf(m.id) < 0) s.queue.unshift(m.id); }
        court.matchId = null; court.status = 'free'; court.snapshot = null;
        break;
      }
      case 'org:rules': {
        s.rules = scoring.normalizeRules(Object.assign({}, s.rules, msg.rules || {}));
        s.rulesVersion = (s.rulesVersion || 0) + 1;
        break;
      }
      case 'org:sponsors': {
        s.sponsors = (msg.sponsors || []).map(sp => Object.assign({ id: uid('sp'), enabled: true, durationSec: 12, colour: '#1F5F8B', text: '#FFFFFF' }, sp));
        s.sponsorsVersion = (s.sponsorsVersion || 0) + 1;
        if (msg.adRateCad != null) s.adRateCad = Number(msg.adRateCad) || 0;
        break;
      }
      case 'org:ack': {
        s.alerts = s.alerts.map(a => a.id === msg.alertId ? Object.assign({}, a, { ack: true }) : a);
        break;
      }
      case 'org:ackAll': { s.alerts = s.alerts.map(a => Object.assign({}, a, { ack: true })); break; }
      case 'org:addMatch': {
        const m = Object.assign({ id: uid('m'), number: nextMatchNumber(s), round: '', format: 'singles', status: 'queued', courtId: null, result: null, createdAt: now }, msg.match || {});
        s.matches[m.id] = m;
        s.queue.push(m.id);
        break;
      }
      case 'org:removeMatch': {
        const m = s.matches[msg.matchId];
        if (!m || m.status === 'live') { changed = false; break; }
        delete s.matches[msg.matchId];
        s.queue = s.queue.filter(id => id !== msg.matchId);
        break;
      }
      case 'org:reorderQueue': {
        const ids = (msg.queue || []).filter(id => s.matches[id] && s.matches[id].status === 'queued');
        s.queue = ids.concat(s.queue.filter(id => ids.indexOf(id) < 0));
        break;
      }
      case 'org:setTournament': {
        if (msg.name != null) s.name = String(msg.name).slice(0, 80);
        if (msg.venue != null) s.venue = String(msg.venue).slice(0, 80);
        break;
      }
      case 'org:reset': {
        return { state: initialState({ courts: Object.keys(s.courts).length }), changed: true, reply: null };
      }
      case 'tick': {
        changed = false;
        Object.values(s.courts).forEach(c => { if (c.online && now - c.lastSeen > OFFLINE_AFTER_MS) { c.online = false; changed = true; } });
        break;
      }
      default:
        changed = false;
    }
    if (changed) s.updatedAt = now;
    return { state: changed ? s : t, changed, reply };
  }

  /**
   * Host wrapper: keeps state, persists it, and returns outbound messages.
   * handle(msg, clientId) -> [{to:'all'|clientId, msg}]
   */
  function createHost(opts) {
    opts = opts || {};
    let state = opts.state || initialState(opts);
    const persist = opts.persist || function () {};
    const host = {
      get state() { return state; },
      set state(v) { state = v; persist(state); },
      handle(msg, clientId, now) {
        const out = [];
        const r = reduce(state, msg, now);
        if (r.changed) { state = r.state; persist(state); }
        if (r.reply) out.push({ to: clientId, msg: r.reply });
        if (r.changed) out.push({ to: 'all', msg: { type: 'tournament', tournament: state } });
        return out;
      },
      reset() { state = initialState(opts); persist(state); return state; }
    };
    return host;
  }

  function freeCourts(t) { return Object.values(t.courts).filter(c => c.status === 'free'); }
  function queuedMatches(t) { return t.queue.map(id => t.matches[id]).filter(Boolean); }
  function revenue(t) {
    const total = Object.values(t.impressions || {}).reduce((a, b) => a + b, 0);
    return { impressions: total, estimateCad: Math.round(total * (t.adRateCad || 0) * 100) / 100 };
  }

  return { initialState, reduce, createHost, defaultSponsors, defaultMatches, freeCourts, queuedMatches, revenue, uid, OFFLINE_AFTER_MS };
});

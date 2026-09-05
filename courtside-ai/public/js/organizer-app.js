/*
 * CourtSide AI — organizer desk
 * createOrganizerApp(rootElement, { localHub?, mode?, wsUrl?, courts? })
 */
(function (root) {
  'use strict';
  const S = root.CourtSide.scoring, H = root.CourtSide.hub, A = root.CourtSide.audio, SY = root.CourtSide.sync;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const names = t => t.players.map(p => p.name).join(' / ');
  const shortLabel = tm => { const parts = String(tm.label || '').split(' / '); return parts.length > 1 ? parts.map(n => n.trim().split(' ').pop()).join(' / ') : tm.label; };
  const hhmm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const dur = sec => sec >= 3600 ? Math.floor(sec / 3600) + ' h ' + Math.round((sec % 3600) / 60) + ' min' : Math.round(sec / 60) + ' min';

  function createOrganizerApp(rootEl, opts) {
    opts = opts || {};
    const st = {
      t: null,
      net: { status: 'connecting', mode: '', queued: 0 },
      rulesDraft: null, rulesDirty: false,
      spDraft: null, spDirty: false, adRate: null,
      form: { round: '', format: 'singles', a1: '', a2: '', b1: '', b2: '' },
      spForm: { name: '', tagline: '', colour: '#1F5F8B', audio: '', durationSec: 12, imageUrl: '' },
      seenAlerts: {},
      firstTournament: true
    };
    rootEl.classList.add('desk-root');

    // the organizer tab can host the hub itself when there is no server
    const host = H.createHost({ state: SY.load('cs:tournament', null) || undefined, courts: opts.courts || 2, persist: s => SY.save('cs:tournament', s) });

    const transport = SY.createTransport({
      role: 'organizer', localHub: opts.localHub, mode: opts.mode, wsUrl: opts.wsUrl,
      hubHandler: (msg, from) => host.handle(msg, from),
      onStatus: (s, info) => { st.net = { status: s, mode: info.mode, queued: info.queued }; renderTop(); },
      onMessage: msg => {
        if (msg.type !== 'snapshot' && msg.type !== 'tournament') return;
        st.t = msg.tournament;
        if (!st.rulesDirty) st.rulesDraft = Object.assign({}, st.t.rules);
        if (!st.spDirty) { st.spDraft = S.clone(st.t.sponsors); st.adRate = st.t.adRateCad; }
        if (!st.firstTournament) {
          st.t.alerts.forEach(a => { if (!a.ack && !st.seenAlerts[a.id]) { st.seenAlerts[a.id] = true; if (a.kind === 'umpire' || a.kind === 'dispute') A.cues.alert(); else if (a.kind === 'freed' || a.kind === 'result') A.cues.confirm(); } });
        } else st.t.alerts.forEach(a => { st.seenAlerts[a.id] = true; });
        st.firstTournament = false;
        render();
      }
    });
    function send(msg) { transport.send(msg); }

    /* ------------------------------------------------------------ */
    /* render                                                       */
    /* ------------------------------------------------------------ */
    function render() {
      if (!st.t) {
        rootEl.innerHTML = top() + '<div class="dk-main"><div class="dk-panel courts" style="grid-column:1/-1"><div class="body"><p>Connecting to the hub…</p><p class="empty">Run <code>npm start</code> for the WebSocket hub, or open this page and the court tablets in the same browser to sync between tabs.</p></div></div></div>';
        return;
      }
      const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.keep : null;
      rootEl.innerHTML = top() + alerts() + '<div class="dk-main">' +
        '<div class="col-left">' + queuePanel() + '</div>' +
        '<div class="courts-col"><div class="courts">' + Object.values(st.t.courts).map(courtCard).join('') + '</div>' + resultsPanel() + '</div>' +
        '<div class="col-right">' + rulesPanel() + sponsorsPanel() + '</div>' +
        '</div>';
      if (focus) { const el = rootEl.querySelector('[data-keep="' + focus + '"]'); if (el) el.focus(); }
    }
    function renderTop() { const el = rootEl.querySelector('.dk-top'); if (el) el.outerHTML = top(); }

    function top() {
      const hub = st.net.status !== 'online' ? ['hub-off', st.net.status === 'connecting' ? 'Connecting to hub' : 'Hub offline'] :
        st.net.mode === 'ws' ? ['hub-ws', 'Hub: server'] : st.net.mode === 'local' ? ['hub-local', 'Hub: in-page demo'] : ['hub-bc', 'Hub: this tab'];
      const t = st.t;
      return '<div class="dk-top"><h1>' + (t ? '<input data-field="name" data-keep="name" value="' + esc(t.name) + '" aria-label="Tournament name"><small>' + esc(t.venue || '') + '</small>' : 'CourtSide AI') + '</h1>' +
        '<span class="pill" style="border-color:#3A4045;color:#AEB7BC">Organizer desk</span><span class="spacer"></span>' +
        '<span class="pill ' + hub[0] + '">' + hub[1] + '</span><span class="clock">' + hhmm(Date.now()) + '</span></div>';
    }

    function alerts() {
      const list = st.t.alerts.filter(a => !a.ack).slice(-6).reverse();
      if (!list.length) return '';
      return '<div class="dk-alerts">' + list.map(a => {
        const court = st.t.courts[a.courtId];
        const acts = a.kind === 'umpire' || a.kind === 'dispute'
          ? '<button class="btn sm primary" data-action="ack" data-id="' + a.id + '">On my way</button>'
          : a.kind === 'freed' && court && court.status === 'free' && st.t.queue.length
            ? '<button class="btn sm go" data-action="assign-next" data-court="' + esc(a.courtId) + '">Assign #' + st.t.matches[st.t.queue[0]].number + '</button><button class="btn sm ghost" data-action="ack" data-id="' + a.id + '">Dismiss</button>'
            : '<button class="btn sm ghost" data-action="ack" data-id="' + a.id + '">Dismiss</button>';
        return '<div class="dk-alert ' + esc(a.kind) + '"><span class="when">' + hhmm(a.ts) + '</span><span class="txt">' + esc(a.message) + '</span><span class="acts">' + acts + '</span></div>';
      }).join('') + (list.length > 1 ? '<div style="text-align:right"><button class="btn sm ghost" data-action="ack-all">Clear all</button></div>' : '') + '</div>';
    }

    function statusOf(c) {
      if (!c.online && c.status !== 'free') return ['offline', 'Offline'];
      if (!c.online) return ['offline', 'Tablet offline'];
      const snap = c.snapshot || {};
      if (c.status === 'live' && snap.rest && snap.rest.endsAt > Date.now()) return ['rest', snap.rest.kind === 'setBreak' ? 'Set break' : 'Changeover'];
      return { live: ['live', 'Live'], free: ['free', 'Free'], assigned: ['assigned', 'Assigned'], ready: ['ready', 'Ready to start'], done: ['done', 'Finished'] }[c.status] || ['free', c.status];
    }

    function courtCard(c) {
      const t = st.t, snap = c.snapshot, sb = snap && snap.sb;
      const [cls, label] = statusOf(c);
      const match = c.matchId ? t.matches[c.matchId] : null;
      const umpire = t.alerts.some(a => !a.ack && a.courtId === c.id && (a.kind === 'umpire' || a.kind === 'dispute'));
      let plan;
      if (sb && (c.status === 'live' || c.status === 'done')) {
        plan = '<div class="score">' + sb.teams.map(tm => '<div class="row ' + (tm.serving ? 'serving' : '') + (tm.winner ? ' winner' : '') + '"><div class="nm"><span class="dot"></span><span>' + esc(shortLabel(tm)) + '</span></div><div class="n">' + tm.sets + '</div><div class="n">' + tm.games + '</div><div class="n pts">' + esc(tm.points) + '</div></div>').join('') + '</div>';
      } else {
        const msg = c.status === 'free' ? 'Free<small>' + (t.queue.length ? 'Next in queue: #' + t.matches[t.queue[0]].number : 'Queue is empty') + '</small>'
          : c.status === 'assigned' || c.status === 'ready' ? 'Match #' + (match ? match.number : '') + '<small>' + (match ? names(match.teams[0]) + ' v ' + names(match.teams[1]) : '') + '<br>Waiting for the tablet to start play</small>'
            : c.online ? 'Waiting for the tablet' : 'Tablet offline<small>Scores are kept on the tablet and sync when it reconnects</small>';
        plan = '<div class="free-msg"><div>' + msg + '</div></div>';
      }
      const rest = sb && snap.rest && snap.rest.endsAt > Date.now() ? '<div><span>Rest ends in</span><b data-rest-until="' + snap.rest.endsAt + '">' + mmss(snap.rest.endsAt - Date.now()) + '</b></div>' : '';
      const meta = match ? '<div class="cc-meta">' +
        '<div><span>Match</span><b>#' + match.number + ' · ' + esc(match.format) + '</b></div>' +
        '<div><span>Round</span><b>' + esc(match.round || '—') + '</b></div>' +
        (sb ? '<div><span>Sets</span><b>' + esc(sb.setLine || '—') + '</b></div><div><span>Call</span><b>' + esc(sb.call || '—') + (sb.tiebreak ? ' · ' + (sb.tiebreak === 'match' ? 'match TB' : 'TB') : '') + '</b></div>' : '') +
        (sb && sb.server ? '<div><span>Serving</span><b>' + esc(sb.server.name) + '</b></div>' : '') +
        rest +
        '<div><span>Rules</span><b class="' + (c.rulesVersion < t.rulesVersion && c.status !== 'free' ? 'warn' : '') + '">v' + (c.rulesVersion || 0) + (c.rulesVersion < t.rulesVersion && c.status !== 'free' ? ' (desk is v' + t.rulesVersion + ')' : '') + '</b></div>' +
        '<div><span>Voice</span><b>' + esc(snap && snap.voice === 'listening' ? 'Active' : snap && snap.voice === 'blocked' ? 'Mic blocked' : 'Off') + '</b></div>' +
        '<div><span>Updated</span><b>' + (c.lastSeen ? hhmm(c.lastSeen) : '—') + '</b></div>' +
        (snap && snap.result ? '<div><span>Result</span><b>' + esc(snap.result.winnerName) + ' ' + esc(snap.result.line) + '</b></div>' : '') +
        '</div>' : '<div class="cc-meta"><div><span>Updated</span><b>' + (c.lastSeen ? hhmm(c.lastSeen) : '—') + '</b></div><div><span>Tablet</span><b>' + (c.online ? 'Connected' : 'Offline') + '</b></div></div>';
      const canAssign = (c.status === 'free' || c.status === 'done') && t.queue.length;
      const acts = '<div class="cc-acts">' +
        (canAssign ? '<button class="btn go" data-action="assign-next" data-court="' + esc(c.id) + '">Assign next (#' + t.matches[t.queue[0]].number + ')</button>' : '') +
        (umpire ? '<button class="btn primary" data-action="ack-court" data-court="' + esc(c.id) + '">On my way</button>' : '') +
        (c.matchId ? '<button class="btn ghost" data-action="clear-court" data-court="' + esc(c.id) + '">' + (c.status === 'done' ? 'Clear court' : 'Send back to queue') + '</button>' : '') +
        '<span class="spacer"></span>' +
        (st.net.mode !== 'local' ? '<a class="btn ghost" href="court.html?court=' + esc(c.id) + '" target="_blank" rel="noopener">Open tablet view</a>' : '') +
        '</div>';
      return '<div class="court-card" data-court-id="' + esc(c.id) + '"><div class="cc-head"><h3>' + esc(c.name) + '</h3>' + (umpire ? '<span class="umpire">Director requested</span>' : '') + '<span class="st ' + cls + '">' + label + '</span></div>' +
        '<div class="plan ' + (c.online ? '' : 'dim') + '"><div class="lines"><div class="sl t"></div><div class="sl b"></div><div class="sv l"></div><div class="sv r"></div><div class="cs"></div></div>' + plan + '</div>' + meta + acts + '</div>';
    }

    function queuePanel() {
      const t = st.t;
      const free = H.freeCourts(t);
      const items = H.queuedMatches(t).map((m, i) => '<div class="queue-item"><div><span class="no">#' + m.number + '</span> <span class="rd">' + esc(m.round || (m.format === 'doubles' ? 'Doubles' : 'Singles')) + '</span></div>' +
        '<div class="asg">' + Object.values(t.courts).map(c => '<button class="btn sm ' + (c.status === 'free' ? 'go' : 'ghost') + '" data-action="assign" data-court="' + esc(c.id) + '" data-match="' + esc(m.id) + '" title="' + (c.status === 'free' ? 'Court is free' : 'Court is busy — this will replace its assignment') + '">' + esc(c.name.replace('Court ', 'C')) + '</button>').join('') +
        '<button class="btn sm ghost" data-action="remove-match" data-match="' + esc(m.id) + '" aria-label="Remove">×</button></div>' +
        '<div class="who">' + esc(names(m.teams[0])) + '<span class="v">v</span>' + esc(names(m.teams[1])) + '</div></div>').join('');
      const f = st.form;
      const dbl = f.format === 'doubles';
      const form = '<form class="add-match" data-action="add-match">' +
        '<div class="two"><label class="field">Round<input data-form="round" data-keep="round" value="' + esc(f.round) + '" placeholder="Open Singles · R2"></label>' +
        '<label class="field">Format<select data-form="format"><option value="singles"' + (dbl ? '' : ' selected') + '>Singles</option><option value="doubles"' + (dbl ? ' selected' : '') + '>Doubles</option></select></label></div>' +
        '<div class="two"><label class="field">Side A<input data-form="a1" data-keep="a1" value="' + esc(f.a1) + '" placeholder="Player" required></label>' + (dbl ? '<label class="field">Partner<input data-form="a2" data-keep="a2" value="' + esc(f.a2) + '" placeholder="Partner" required></label>' : '<span></span>') + '</div>' +
        '<div class="two"><label class="field">Side B<input data-form="b1" data-keep="b1" value="' + esc(f.b1) + '" placeholder="Player" required></label>' + (dbl ? '<label class="field">Partner<input data-form="b2" data-keep="b2" value="' + esc(f.b2) + '" placeholder="Partner" required></label>' : '<span></span>') + '</div>' +
        '<div><button class="btn primary" type="submit">Add to queue</button></div></form>';
      return '<div class="dk-panel"><h2>Match queue <small>' + t.queue.length + ' waiting · ' + free.length + ' court' + (free.length === 1 ? '' : 's') + ' free</small></h2><div class="body">' + (items || '<p class="empty">The queue is empty. Add a match below.</p>') + form + '</div></div>';
    }

    function rulesPanel() {
      const r = st.rulesDraft || st.t.rules;
      const t = st.t;
      const preset = Object.keys(S.PRESETS).map(k => '<button class="btn sm ' + (r.preset === k ? 'on' : 'ghost') + '" data-action="preset" data-preset="' + k + '">' + ({ standard: 'Standard', noad: 'No-Ad', fast4: 'Fast4 / Express', oneset: 'One set' }[k]) + '</button>').join('');
      const sel = (k, opts, lbl) => '<label class="field row">' + lbl + '<select data-rule="' + k + '">' + opts.map(o => '<option value="' + o[0] + '"' + (String(r[k]) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>';
      const chk = (k, lbl) => '<label class="field row">' + lbl + '<input type="checkbox" data-rule="' + k + '"' + (r[k] ? ' checked' : '') + '></label>';
      const num = (k, lbl, step) => '<label class="field row">' + lbl + '<input type="number" min="0" step="' + (step || 5) + '" data-rule="' + k + '" data-keep="' + k + '" value="' + esc(r[k]) + '"></label>';
      const courts = Object.values(t.courts).filter(c => c.status !== 'free').map(c => c.name.replace('Court ', 'C') + ' v' + (c.rulesVersion || 0)).join(' · ');
      return '<div class="dk-panel"><h2>Rules for all courts <small>v' + t.rulesVersion + '</small></h2><div class="body rules-grid">' +
        '<div class="preset">' + preset + '</div>' +
        sel('bestOf', [[1, 'One set'], [3, 'Best of 3'], [5, 'Best of 5']], 'Match length') +
        sel('gamesPerSet', [[4, '4 games'], [6, '6 games']], 'Games per set') +
        chk('noAd', 'No-Ad scoring (deciding point at deuce)') +
        sel('tiebreakTo', [[5, 'To 5'], [7, 'To 7']], 'Set tiebreak') +
        chk('finalSetMatchTiebreak', 'Match tiebreak instead of a deciding set') +
        sel('matchTiebreakTo', [[7, 'To 7'], [10, 'To 10']], 'Match tiebreak') +
        chk('express', 'Express / Fast-Play: change ends, no rest') +
        num('serveClockSec', 'Serve clock (s)', 5) +
        num('changeoverSec', 'Changeover rest (s)', 10) +
        num('setBreakSec', 'Set break (s)', 10) +
        num('timeCallSec', '“Time” call at (s)', 5) +
        '<div class="push ' + (st.rulesDirty ? 'dirty' : '') + '"><span>' + (st.rulesDirty ? 'Unpushed changes' : (courts ? 'Courts on: ' + esc(courts) : 'No live courts')) + '</span><button class="btn ' + (st.rulesDirty ? 'yellow' : 'ghost') + '" data-action="push-rules">Push to courts</button></div>' +
        '</div></div>';
    }

    function sponsorsPanel() {
      const t = st.t, list = st.spDraft || t.sponsors;
      const rev = H.revenue(t);
      const items = list.map((sp, i) => '<div class="sp-item ' + (sp.enabled === false ? 'off' : '') + '"><div class="sw" style="background:' + esc(sp.colour) + '"></div><div><div class="nm">' + esc(sp.name) + '<small>' + (sp.durationSec || 12) + ' s</small></div><div class="tg">' + esc(sp.tagline) + '</div></div><div class="im"><b>' + (t.impressions[sp.id] || 0) + '</b>plays</div>' +
        '<div class="acts"><button class="btn sm ghost" data-action="sp-toggle" data-i="' + i + '">' + (sp.enabled === false ? 'Enable' : 'Pause') + '</button><button class="btn sm ghost" data-action="sp-remove" data-i="' + i + '">Remove</button></div></div>').join('');
      const f = st.spForm;
      const form = '<form class="add-match" data-action="add-sponsor">' +
        '<div class="two"><label class="field">Sponsor<input data-sp="name" data-keep="spname" value="' + esc(f.name) + '" required placeholder="Café Racquet"></label><label class="field">Colour<input type="color" data-sp="colour" value="' + esc(f.colour) + '"></label></div>' +
        '<label class="field">Tagline (shown on court)<input data-sp="tagline" data-keep="sptag" value="' + esc(f.tagline) + '" placeholder="Free espresso with your draw sheet"></label>' +
        '<label class="field">Audio line (read aloud during changeovers)<input data-sp="audio" data-keep="spaudio" value="' + esc(f.audio) + '" placeholder="Optional"></label>' +
        '<div class="two"><label class="field">Seconds per play<input type="number" min="5" max="60" data-sp="durationSec" value="' + esc(f.durationSec) + '"></label><label class="field">Image URL<input data-sp="imageUrl" data-keep="spimg" value="' + esc(f.imageUrl) + '" placeholder="Optional logo"></label></div>' +
        '<div><button class="btn primary" type="submit">Add sponsor</button></div></form>';
      return '<div class="dk-panel"><h2>Court-side sponsors <small>changeover loop</small></h2><div class="body">' +
        '<div class="sp-list">' + (items || '<p class="empty">No sponsors yet. Changeovers show the score only.</p>') + '</div>' +
        '<div class="push ' + (st.spDirty ? 'dirty' : '') + '"><label class="field row" style="gap:6px">Value per play $<input type="number" step="0.05" min="0" data-sp-rate data-keep="rate" value="' + esc(st.adRate == null ? t.adRateCad : st.adRate) + '" style="width:80px"></label><button class="btn ' + (st.spDirty ? 'yellow' : 'ghost') + '" data-action="push-sponsors">Push loop to courts</button></div>' +
        '<div class="rev"><div><span>Plays today</span><b>' + rev.impressions + '</b></div><div><span>Estimated value</span><b>$' + rev.estimateCad.toFixed(2) + '</b></div></div>' +
        form + '</div></div>';
    }

    function resultsPanel() {
      const t = st.t;
      const rows = t.results.map(r => '<tr><td>#' + r.number + '<br><small style="color:var(--muted)">' + esc(r.round || r.format) + '</small></td><td><span class="w">' + esc(r.result ? r.result.winnerName : '') + '</span><br>' + esc(r.result ? r.result.loserName : '') + '</td><td class="sc">' + esc(r.result ? r.result.line : '') + '</td><td>' + esc(t.courts[r.courtId] ? t.courts[r.courtId].name : r.courtId) + '<br><small style="color:var(--muted)">' + hhmm(r.ts) + ' · ' + (r.result ? dur(r.result.durationSec) : '') + '</small></td></tr>').join('');
      return '<div class="dk-panel" style="margin-top:18px"><h2>Results <small>' + t.results.length + ' recorded</small>' + (t.results.length ? '<button class="btn sm ghost" data-action="export">Export CSV</button>' : '') + '</h2><div class="body">' +
        (rows ? '<table class="res-table"><thead><tr><th>Match</th><th>Winner / loser</th><th>Score</th><th>Court · time</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="empty">Results arrive here the moment a tablet records the final point.</p>') + '</div></div>';
    }

    /* ------------------------------------------------------------ */
    /* events                                                       */
    /* ------------------------------------------------------------ */
    rootEl.addEventListener('click', e => {
      const b = e.target.closest('[data-action]');
      if (!b || b.tagName === 'FORM' || b.tagName === 'A') return;
      A.unlock();
      const t = st.t; if (!t) return;
      switch (b.dataset.action) {
        case 'assign': send({ type: 'org:assign', courtId: b.dataset.court, matchId: b.dataset.match }); break;
        case 'assign-next': if (t.queue.length) send({ type: 'org:assign', courtId: b.dataset.court, matchId: t.queue[0] }); break;
        case 'clear-court': send({ type: 'org:clearCourt', courtId: b.dataset.court }); break;
        case 'remove-match': send({ type: 'org:removeMatch', matchId: b.dataset.match }); break;
        case 'ack': send({ type: 'org:ack', alertId: b.dataset.id }); break;
        case 'ack-all': send({ type: 'org:ackAll' }); break;
        case 'ack-court': t.alerts.filter(a => !a.ack && a.courtId === b.dataset.court).forEach(a => send({ type: 'org:ack', alertId: a.id })); break;
        case 'preset': st.rulesDraft = S.normalizeRules(Object.assign({}, st.rulesDraft || t.rules, S.PRESETS[b.dataset.preset])); st.rulesDirty = true; render(); break;
        case 'push-rules': send({ type: 'org:rules', rules: st.rulesDraft }); st.rulesDirty = false; break;
        case 'sp-toggle': st.spDraft[+b.dataset.i].enabled = st.spDraft[+b.dataset.i].enabled === false; st.spDirty = true; render(); break;
        case 'sp-remove': st.spDraft.splice(+b.dataset.i, 1); st.spDirty = true; render(); break;
        case 'push-sponsors': send({ type: 'org:sponsors', sponsors: st.spDraft, adRateCad: st.adRate }); st.spDirty = false; break;
        case 'export': exportCsv(); break;
      }
    });
    rootEl.addEventListener('submit', e => {
      const f = e.target.closest('form[data-action]');
      if (!f) return;
      e.preventDefault();
      if (f.dataset.action === 'add-match') {
        const d = st.form;
        const dbl = d.format === 'doubles';
        const team = (a, b) => ({ name: '', players: [{ name: a.trim() }].concat(dbl ? [{ name: b.trim() }] : []) });
        send({ type: 'org:addMatch', match: { round: d.round.trim(), format: d.format, teams: [team(d.a1, d.a2), team(d.b1, d.b2)] } });
        st.form = { round: d.round, format: d.format, a1: '', a2: '', b1: '', b2: '' };
      } else if (f.dataset.action === 'add-sponsor') {
        const s = st.spForm;
        const dark = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s.colour);
        const lum = dark ? (0.299 * parseInt(dark[1], 16) + 0.587 * parseInt(dark[2], 16) + 0.114 * parseInt(dark[3], 16)) : 0;
        st.spDraft.push({ id: H.uid('sp'), name: s.name.trim(), tagline: s.tagline.trim(), colour: s.colour, text: lum > 150 ? '#0B1F2A' : '#FFFFFF', audio: s.audio.trim(), durationSec: Math.max(5, +s.durationSec || 12), imageUrl: s.imageUrl.trim(), enabled: true });
        st.spDirty = true;
        st.spForm = { name: '', tagline: '', colour: s.colour, audio: '', durationSec: s.durationSec, imageUrl: '' };
        render();
      }
    });
    rootEl.addEventListener('input', e => {
      const el = e.target;
      if (el.dataset.form) { st.form[el.dataset.form] = el.value; if (el.dataset.form === 'format') render(); }
      else if (el.dataset.sp) st.spForm[el.dataset.sp] = el.value;
      else if (el.hasAttribute('data-sp-rate')) { st.adRate = parseFloat(el.value) || 0; st.spDirty = true; }
      else if (el.dataset.rule) {
        const r = st.rulesDraft || Object.assign({}, st.t.rules);
        const v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Math.max(0, parseInt(el.value, 10) || 0) : (isNaN(+el.value) ? el.value : +el.value));
        r[el.dataset.rule] = v;
        if (el.dataset.rule === 'gamesPerSet') r.tiebreakAt = v;
        if (el.dataset.rule === 'express') { r.changeoverSec = v ? 0 : 90; r.setBreakSec = v ? 0 : 120; }
        r.preset = 'custom';
        st.rulesDraft = r; st.rulesDirty = true;
        const push = rootEl.querySelector('.push');
        if (push) { push.classList.add('dirty'); push.querySelector('span').textContent = 'Unpushed changes'; push.querySelector('button').className = 'btn yellow'; }
      }
    });
    rootEl.addEventListener('change', e => {
      const el = e.target;
      if (el.dataset.field === 'name') send({ type: 'org:setTournament', name: el.value });
      if (el.dataset.form === 'format') { st.form.format = el.value; render(); }
      if (el.dataset.sp === 'colour') st.spForm.colour = el.value;
    });

    function exportCsv() {
      const t = st.t;
      const rows = [['match', 'round', 'format', 'court', 'winner', 'loser', 'score', 'duration_min', 'finished_at']].concat(t.results.map(r => [r.number, r.round, r.format, t.courts[r.courtId] ? t.courts[r.courtId].name : r.courtId, r.result && r.result.winnerName, r.result && r.result.loserName, r.result && r.result.line, r.result ? Math.round(r.result.durationSec / 60) : '', new Date(r.ts).toISOString()]));
      const csv = rows.map(r => r.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = (t.name || 'results').replace(/[^\w]+/g, '-').toLowerCase() + '-results.csv';
      document.body.appendChild(a); a.click(); a.remove();
    }

    // clocks: rest countdowns and the wall clock, without re-rendering forms
    setInterval(() => {
      rootEl.querySelectorAll('[data-rest-until]').forEach(el => { const ms = +el.dataset.restUntil - Date.now(); el.textContent = mmss(ms); if (ms <= 0) render(); });
      const c = rootEl.querySelector('.dk-top .clock'); if (c) c.textContent = hhmm(Date.now());
    }, 1000);

    render();
    return { transport, state: st, render, host, send };
  }

  root.CourtSide.createOrganizerApp = createOrganizerApp;
})(typeof self !== 'undefined' ? self : this);

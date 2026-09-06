/*
 * CourtSide AI — court scorer tablet
 * createCourtApp(rootElement, { courtId, localHub?, mode?, wsUrl? })
 */
(function (root) {
  'use strict';
  const S = root.CourtSide.scoring, V = root.CourtSide.voice, A = root.CourtSide.audio, SY = root.CourtSide.sync;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // on the wall, doubles pairs read as family names so they fit at 40 m
  const wallLabel = team => team.players.length > 1 ? team.players.map(p => p.name.trim().split(' ').pop()).join(' / ') : (team.name || team.players[0].name);
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const shortNames = t => t.players.map(p => p.name).join(' / ');

  function createCourtApp(rootEl, opts) {
    const courtId = String(opts.courtId || '1');
    const key = (opts.storagePrefix || 'cs') + ':court:' + courtId;
    const saved = SY.load(key + ':state', null);
    const st = {
      tournament: null,
      match: saved ? saved.match : null,
      assigned: saved ? saved.assigned : null,
      phase: saved ? saved.phase : 'free',
      seq: saved ? saved.seq || 0 : 0,
      restEndsAt: saved ? saved.restEndsAt || 0 : 0,
      restStartedAt: saved ? saved.restStartedAt || 0 : 0,
      restKind: saved ? saved.restKind || '' : '',
      timeCalled: false,
      serveClockEndsAt: 0, serveClockBeeped: false,
      adIdx: -1, adNextAt: 0,
      voice: { status: 'idle', transcript: '', interim: '', result: '', kind: '' },
      toast: null, modal: null, settingsOpen: false, timeFlashUntil: 0,
      net: { status: 'connecting', mode: '', queued: 0 },
      firstServer: { team: 0, player: 0 }, oppFirst: 0,
      settings: Object.assign({ lang: 'en-CA', wakeWord: '', arm: false, announce: true, sponsorAudio: true, glare: false, voiceAuto: true }, SY.load(key + ':settings', {}))
    };
    if (st.restEndsAt && st.restEndsAt < Date.now()) { st.restEndsAt = 0; }

    rootEl.classList.add('court-root');
    let toastTimer = null, hbTimer = null, tickTimer = null;

    /* ------------------------------------------------------------ */
    /* transport                                                    */
    /* ------------------------------------------------------------ */
    const transport = SY.createTransport({
      role: 'court', courtId, localHub: opts.localHub, mode: opts.mode, wsUrl: opts.wsUrl, storagePrefix: opts.storagePrefix,
      onStatus: (s, info) => { st.net = { status: s, mode: info.mode, queued: info.queued }; renderTopOnly(); },
      onMessage: onHubMessage
    });

    function onHubMessage(msg) {
      if (msg.type !== 'snapshot' && msg.type !== 'tournament') return;
      const t = msg.tournament;
      st.tournament = t;
      const court = t.courts[courtId];
      if (!court) return;
      // rules pushed from the desk
      if (st.match && st.match.status !== 'done' && (t.rulesVersion || 0) > (st.match.rulesVersion || 0)) {
        st.match = S.setRules(st.match, t.rules, t.rulesVersion).state;
        toast('Rules updated from the organizer desk (v' + t.rulesVersion + ')', 'ok');
        A.cues.alert();
      }
      // assignment
      if (court.matchId && t.matches[court.matchId]) {
        const m = t.matches[court.matchId];
        const mine = st.assigned && st.assigned.id === m.id;
        if (!mine && (st.phase === 'free' || st.phase === 'done' || st.phase === 'ready') && m.status !== 'done') acceptAssignment(m, t);
        else if (mine && st.phase === 'ready') { st.assigned = m; if (st.match.rulesVersion < (t.rulesVersion || 0)) st.match = S.setRules(st.match, t.rules, t.rulesVersion).state; }
      } else if (!court.matchId && (st.phase === 'ready' || st.phase === 'done')) {
        clearCourt(false);
      } else if (!court.matchId && st.phase === 'live' && court.status === 'free' && st.seq <= court.seq) {
        toast('The organizer desk cleared this court.', 'bad');
        clearCourt(false);
      }
      persist(); render();
    }

    function acceptAssignment(m, t) {
      st.assigned = m;
      st.match = S.createMatch({ id: m.id, number: m.number, round: m.round, format: m.format, teams: m.teams, rules: t.rules, rulesVersion: t.rulesVersion });
      st.phase = 'ready';
      st.firstServer = { team: 0, player: 0 }; st.oppFirst = 0;
      st.restEndsAt = 0;
      A.cues.alert();
      toast('Match #' + m.number + ' assigned to this court.', 'ok');
      sendState();
    }

    function clearCourt(send) {
      st.assigned = null; st.match = null; st.phase = 'free'; st.restEndsAt = 0; st.modal = null;
      if (send !== false) sendState();
      persist(); render();
    }

    function snapshot() {
      const m = st.match;
      const snap = { status: st.phase, matchId: st.assigned ? st.assigned.id : null, courtName: 'Court ' + courtId, updatedAt: Date.now(), voice: st.voice.status, rulesVersion: m ? m.rulesVersion : (st.tournament ? st.tournament.rulesVersion : 0) };
      if (m) {
        snap.sb = S.scoreboard(m);
        snap.number = m.number;
        snap.round = m.round;
        if (st.restEndsAt > Date.now()) snap.rest = { kind: st.restKind, endsAt: st.restEndsAt };
        if (m.status === 'done') snap.result = { winner: m.winner, line: S.setLine(m), durationSec: S.durationSec(m), winnerName: shortNames(m.teams[m.winner]), loserName: shortNames(m.teams[1 - m.winner]) };
      }
      return snap;
    }
    function sendState() { st.seq++; transport.send({ type: 'court:state', courtId, seq: st.seq, snapshot: snapshot() }); persist(); }
    function sendEvent(event) { transport.send({ type: 'court:event', courtId, seq: st.seq, event }); }
    function persist() { SY.save(key + ':state', { match: st.match, assigned: st.assigned, phase: st.phase, seq: st.seq, restEndsAt: st.restEndsAt, restStartedAt: st.restStartedAt, restKind: st.restKind }); }
    function saveSettings() { SY.save(key + ':settings', st.settings); }

    /* ------------------------------------------------------------ */
    /* voice                                                        */
    /* ------------------------------------------------------------ */
    const rec = V.createRecognizer({
      lang: st.settings.lang, wakeWord: st.settings.wakeWord,
      validate: a => {
        if (a.kind === 'command') return { ok: true };
        if (!st.match || st.phase !== 'live') return { ok: false, reason: 'No live match' };
        const r = S.reconcile(st.match, a);
        return { ok: r.action !== 'reject', reason: r.reason };
      },
      onStatus: s => { st.voice.status = s; renderTopOnly(); renderVoiceOnly(); },
      onInterim: t => { st.voice.interim = t; renderVoiceOnly(); },
      onCall: (a, meta) => { st.voice.interim = ''; st.voice.transcript = meta.transcript; handleAssertion(a, meta); if (st.settings.arm) { rec.arm(false); renderVoiceOnly(); } },
      onRejected: (a, reason, transcript) => { st.voice.interim = ''; st.voice.transcript = transcript; onRejectedCall(a, reason); },
      onIgnored: (transcript, reason) => { st.voice.interim = ''; st.voice.transcript = transcript; st.voice.result = reason; st.voice.kind = 'bad'; renderVoiceOnly(); }
    });
    rec.arm(!st.settings.arm);

    function handleAssertion(a, meta) {
      if (a.kind === 'command') return runCommand(a.cmd, meta);
      if (!st.match || st.phase !== 'live') return;
      const r = S.reconcile(st.match, a);
      const heard = meta && meta.transcript ? 'Heard “' + meta.transcript + '”. ' : '';
      if (r.action === 'apply') {
        doPoint(r.team, 'voice');
        st.voice.result = r.reason; st.voice.kind = 'ok';
        toast(heard + 'Point ' + shortNames(st.match.teams[r.team]) + '. Now ' + S.callString(st.match) + '.', 'ok', { label: 'Undo', action: 'correction' }, 4500);
      } else if (r.action === 'confirm') {
        A.cues.confirm();
        st.voice.result = r.reason; st.voice.kind = 'ok';
        renderVoiceOnly();
      } else if (r.action === 'ambiguous') {
        st.modal = { type: 'ambiguous', teams: r.teams, text: r.reason };
        A.cues.warn(); render();
      } else {
        onRejectedCall(a, r.reason);
      }
    }

    function onRejectedCall(a, reason) {
      st.voice.result = reason; st.voice.kind = 'bad';
      A.cues.reject();
      if (a && a.kind !== 'command' && st.match && st.phase === 'live' && /Not reachable|Low confidence/.test(reason)) {
        toast(reason, 'bad', { label: 'Set score to ' + S.describe(a), action: 'force', assertion: a }, 7000);
      } else renderVoiceOnly();
    }

    function runCommand(cmd, meta) {
      const m = st.match;
      switch (cmd) {
        case 'correction': return doUndo();
        case 'fault': return doFault();
        case 'doubleFault': doFault(); return doFault();
        case 'let': if (m && st.phase === 'live') { st.match = S.applyLet(m).state; resetServeClock(); toast('Let. Replay the serve.', 'ok', null, 2000); announce('Let'); } return;
        case 'umpire': return callUmpire();
        case 'changeover': return forceChangeover();
        case 'time': case 'resume':
          if (st.restEndsAt) return endRest(true);
          if (st.phase === 'ready') return startMatch();
          return;
        case 'pointServer': if (m && st.phase === 'live') { doPoint(S.serverOf(m).team, 'voice'); toast('Point to the server. ' + S.callString(st.match) + '.', 'ok', { label: 'Undo', action: 'correction' }, 4000); } return;
        case 'pointReceiver': if (m && st.phase === 'live') { doPoint(S.receiverOf(m).team, 'voice'); toast('Point to the receiver. ' + S.callString(st.match) + '.', 'ok', { label: 'Undo', action: 'correction' }, 4000); } return;
      }
    }

    function speak(text) {
      const ms = A.speak(text, { lang: st.settings.lang });
      if (ms) rec.mute(ms + 300);   // do not let the tablet transcribe itself
    }
    function announce(text) { if (st.settings.announce) speak(text); }

    /* ------------------------------------------------------------ */
    /* match actions                                                */
    /* ------------------------------------------------------------ */
    function startMatch() {
      if (!st.match || st.phase !== 'ready') return;
      const r = S.startMatch(st.match, { firstServer: st.firstServer, opponentFirstPlayer: st.oppFirst });
      st.match = r.state; st.phase = 'live';
      resetServeClock();
      A.cues.game();
      announce(S.serverOf(st.match).name + ' to serve. Love all.');
      if (st.settings.voiceAuto && rec.supported && rec.status === 'idle') rec.start();
      sendState(); render();
    }

    function clearRestQuietly() {
      // a point or fault called during a rest means play has resumed
      if (!st.restEndsAt) return;
      st.restEndsAt = 0; st.timeFlashUntil = 0; A.stopSpeaking();
    }
    function doPoint(team, source) {
      if (!st.match || st.phase !== 'live') return;
      clearRestQuietly();
      const r = S.applyPoint(st.match, team);
      st.match = r.state;
      afterEvents(r.events, source);
    }
    function doFault() {
      if (!st.match || st.phase !== 'live') return;
      clearRestQuietly();
      const r = S.applyFault(st.match);
      st.match = r.state;
      if (r.events.some(e => e.type === 'doubleFault')) { toast('Double fault. ' + S.callString(st.match) + '.', 'ok', { label: 'Undo', action: 'correction' }, 4000); }
      else { A.cues.confirm(); announce('Fault'); toast('Fault. Second serve.', 'ok', { label: 'Undo', action: 'correction' }, 2500); }
      afterEvents(r.events.filter(e => e.type !== 'fault'), 'tap');
    }
    function doUndo() {
      if (!st.match || !st.match.history || !st.match.history.length) { toast('Nothing to correct yet.', 'bad', null, 2000); return; }
      const wasDone = st.match.status === 'done';
      st.match = S.undo(st.match).state;
      if (wasDone || st.phase === 'done') st.phase = 'live';
      st.restEndsAt = 0; st.modal = null;
      A.cues.warn();
      announce('Correction. ' + S.callString(st.match));
      toast('Correction. Score is ' + S.callString(st.match) + '.', 'ok', null, 3000);
      sendState(); render();
    }
    function afterEvents(events, source) {
      const m = st.match;
      let spoken = null;
      events.forEach(ev => {
        if (ev.type === 'game') A.cues.game();
        if (ev.type === 'tiebreak') { toast((ev.kind === 'match' ? 'Match tiebreak' : 'Tiebreak') + ' to ' + ev.to + '. First to ' + ev.to + ' by two.', 'ok', null, 4000); spoken = (ev.kind === 'match' ? 'Match tiebreak' : 'Tiebreak') + ' to ' + ev.to; }
        if (ev.type === 'match') { st.phase = 'done'; st.restEndsAt = 0; spoken = 'Game, set and match, ' + shortNames(m.teams[ev.winner]) + '. ' + ev.score; }
        if (ev.type === 'rest') {
          if (ev.restSec > 0) startRest(ev.kind, ev.restSec);
          else if (ev.swap) { toast('Change ends.' + (ev.kind === 'changeEnds' && m.rules.express ? ' No rest in express mode.' : ''), 'ok', null, 3000); spoken = spoken || 'Change ends'; }
        }
      });
      if (st.phase === 'live') resetServeClock();
      if (spoken) announce(spoken);
      else if (st.phase === 'live' && !st.restEndsAt && source !== 'voice') announce(S.callString(m));
      else if (st.phase === 'live' && !st.restEndsAt && source === 'voice' && m.points[0] + m.points[1] === 0) announce('Game. ' + S.callString(m));
      sendState(); render();
    }

    function resetServeClock() {
      const secs = st.match ? st.match.rules.serveClockSec : 25;
      st.serveClockEndsAt = Date.now() + secs * 1000; st.serveClockBeeped = false;
    }

    function startRest(kind, restSec) {
      st.restKind = kind; st.restStartedAt = Date.now(); st.restEndsAt = st.restStartedAt + restSec * 1000;
      st.timeCalled = false; st.adIdx = -1; st.adNextAt = 0;
      A.cues.alert();
      speak((kind === 'setBreak' ? 'Set break. ' : 'Changeover. ') + restSec + ' seconds.');
    }
    function endRest(byUser) {
      st.restEndsAt = 0; st.timeFlashUntil = 0;
      if (st.match && st.phase === 'live') { st.match = S.endRest(st.match).state; resetServeClock(); announce((byUser ? 'Time. ' : '') + S.serverOf(st.match).name + ' to serve. ' + S.callString(st.match)); }
      A.stopSpeaking();
      sendState(); render();
    }
    function forceChangeover() {
      if (!st.match || st.phase !== 'live') return;
      const secs = st.match.rules.changeoverSec || 90;
      st.match = S.forceRest(st.match, secs).state;
      startRest('changeover', secs);
      sendState(); render();
    }
    function callUmpire() {
      sendEvent({ kind: 'umpire', note: st.match ? S.setLine(st.match, true) + ' ' + S.callString(st.match) : '' });
      st.modal = { type: 'umpire' };
      A.cues.alert(); render();
    }

    /* ------------------------------------------------------------ */
    /* toast                                                        */
    /* ------------------------------------------------------------ */
    function toast(text, kind, action, ms) {
      clearTimeout(toastTimer);
      st.toast = { text, kind: kind || 'ok', action, ms: ms || 3000, at: Date.now() };
      toastTimer = setTimeout(() => { st.toast = null; render(); }, st.toast.ms);
      render();
    }

    /* ------------------------------------------------------------ */
    /* timers                                                       */
    /* ------------------------------------------------------------ */
    function tick() {
      const now = Date.now();
      if (st.restEndsAt) {
        const m = st.match;
        const timeAt = st.restStartedAt + (m ? m.rules.timeCallSec : 80) * 1000;
        if (!st.timeCalled && now >= timeAt && st.restEndsAt - st.restStartedAt > (m ? m.rules.timeCallSec : 80) * 1000) {
          st.timeCalled = true; st.timeFlashUntil = now + 1800;
          A.cues.time(); speak('Time');
          render();
        }
        if (st.timeFlashUntil && now > st.timeFlashUntil) { st.timeFlashUntil = 0; render(); }
        if (now >= st.restEndsAt) { endRest(false); return; }
        const clock = rootEl.querySelector('#rest-clock');
        if (clock) { clock.textContent = mmss(st.restEndsAt - now); clock.classList.toggle('time', st.timeCalled); }
        // sponsor loop
        const sponsors = activeSponsors();
        if (sponsors.length && now >= st.adNextAt && st.restEndsAt - now > 4000) {
          st.adIdx = (st.adIdx + 1) % sponsors.length;
          const sp = sponsors[st.adIdx];
          st.adNextAt = now + (sp.durationSec || 12) * 1000;
          sendEvent({ kind: 'impression', sponsorId: sp.id });
          if (st.settings.sponsorAudio && sp.audio && !st.timeCalled) speak(sp.audio);
          render();
        }
      } else if (st.phase === 'live' && st.serveClockEndsAt) {
        const el = rootEl.querySelector('#serve-clock');
        const rem = st.serveClockEndsAt - now;
        if (el) {
          el.querySelector('.val').textContent = String(Math.max(0, Math.ceil(rem / 1000)));
          el.classList.toggle('warn', rem <= 5000 && rem > 0);
          el.classList.toggle('late', rem <= 0);
        }
        if (rem <= 0 && !st.serveClockBeeped) { st.serveClockBeeped = true; A.cues.serveClock(); }
      }
    }
    function activeSponsors() { return ((st.tournament && st.tournament.sponsors) || []).filter(s => s.enabled !== false); }

    /* ------------------------------------------------------------ */
    /* render                                                       */
    /* ------------------------------------------------------------ */
    function render() {
      rootEl.classList.toggle('glare', !!st.settings.glare);
      const parts = [renderTop()];
      if (st.phase === 'free') parts.push(renderFree());
      else if (st.phase === 'ready') parts.push(renderReady());
      else if (st.phase === 'done') parts.push(renderDone());
      else parts.push(renderLive());
      if (st.phase === 'live' || st.phase === 'ready') parts.push(renderVoice());
      if (st.restEndsAt > Date.now()) parts.push(renderRest());
      if (st.modal) parts.push(renderModal());
      if (st.toast) parts.push(renderToast());
      if (st.settingsOpen) parts.push(renderSettings());
      rootEl.innerHTML = parts.join('');
      const tin = rootEl.querySelector('#typed-call');
      if (tin && st._typedFocus) { tin.focus(); st._typedFocus = false; }
      const bar = rootEl.querySelector('[data-shrink]');
      if (bar) requestAnimationFrame(() => { bar.style.width = '0%'; });
    }
    function renderTopOnly() { const el = rootEl.querySelector('.ct-top'); if (el) el.outerHTML = renderTop(); else render(); }
    function renderVoiceOnly() {
      const el = rootEl.querySelector('.ct-voice');
      if (!el || !(st.phase === 'live' || st.phase === 'ready')) return;
      const input = el.querySelector('#typed-call');
      const typed = input ? input.value : '', hadFocus = input && document.activeElement === input;
      el.outerHTML = renderVoice();
      const again = rootEl.querySelector('#typed-call');
      if (again && typed) again.value = typed;
      if (again && hadFocus) again.focus();
    }

    function renderTop() {
      const t = st.tournament;
      const net = st.net.status === 'online' ? 'net-online' : (st.net.status === 'offline' ? 'net-offline' : 'net-connecting');
      const netLabel = st.net.status === 'online' ? 'Synced' + (st.net.mode === 'local' ? ' (demo link)' : '') : (st.net.status === 'offline' ? 'Offline' + (st.net.queued ? ' · ' + st.net.queued + ' queued' : ' · scoring locally') : 'Connecting');
      const v = st.voice.status;
      const vcls = v === 'listening' || v === 'starting' ? 'voice-on' : (v === 'blocked' || v === 'unsupported' ? 'voice-blocked' : 'voice-off');
      const vlabel = v === 'listening' ? 'Voice active' : v === 'starting' ? 'Voice starting' : v === 'blocked' ? 'Mic blocked' : v === 'unsupported' ? 'No voice in this browser' : 'Voice off';
      return '<div class="ct-top">' +
        '<span class="id">Court ' + esc(courtId) + '</span>' +
        (st.match ? '<span>Match #' + esc(st.match.number) + '</span>' : '') +
        '<span class="tour">' + esc(t ? t.name : 'Waiting for the organizer desk') + '</span>' +
        '<span class="pill ' + (st.phase === 'live' ? 'live' : '') + '">' + (st.phase === 'live' ? 'Live' : st.phase === 'ready' ? 'Ready' : st.phase === 'done' ? 'Finished' : 'Free') + '</span>' +
        '<span class="pill ' + vcls + '">' + vlabel + '</span>' +
        '<span class="pill ' + net + '">' + netLabel + '</span>' +
        '<button class="ctl" data-action="settings" style="font-size:2cqw;min-height:0;padding:0.5cqw 1cqw" aria-label="Settings">Settings</button>' +
        '</div>';
    }

    function renderFree() {
      return '<div class="ct-center"><div class="msg"><h2>No match on this court</h2><p>The organizer desk assigns matches from the queue. This tablet will switch to the ready screen the moment one arrives.</p>' +
        '<p>' + (st.net.status === 'online' ? 'Connected to the desk.' : 'Not connected yet — the tablet keeps working and syncs when the link is back.') + '</p></div></div>';
    }

    function renderReady() {
      const m = st.match, r = m.rules;
      const ruleBits = [
        r.bestOf === 1 ? 'One set' : 'Best of ' + r.bestOf,
        r.gamesPerSet + '-game sets',
        r.noAd ? 'No-Ad' : 'Ad scoring',
        r.tiebreakTo + '-point tiebreak at ' + r.tiebreakAt + '-' + r.tiebreakAt,
        r.finalSetMatchTiebreak && r.bestOf > 1 ? r.matchTiebreakTo + '-point match tiebreak' : 'Full deciding set',
        r.express ? 'Express — no rest periods' : r.changeoverSec + ' s changeovers',
        r.serveClockSec + ' s serve clock'
      ];
      const opt = (team, player, on) => '<button class="ctl ' + (on ? 'on' : '') + '" data-action="first-server" data-team="' + team + '" data-player="' + player + '">' + esc(m.teams[team].players[player].name) + '</button>';
      let choose = '<div class="choose"><div class="grp"><div class="lbl">Who serves first</div><div class="opts">';
      m.teams.forEach((t, ti) => t.players.forEach((p, pi) => { choose += opt(ti, pi, st.firstServer.team === ti && st.firstServer.player === pi); }));
      choose += '</div></div>';
      if (m.format === 'doubles') {
        const ot = 1 - st.firstServer.team;
        choose += '<div class="grp"><div class="lbl">First server for ' + esc(shortNames(m.teams[ot])) + '</div><div class="opts">' +
          m.teams[ot].players.map((p, pi) => '<button class="ctl ' + (st.oppFirst === pi ? 'on' : '') + '" data-action="opp-first" data-player="' + pi + '">' + esc(p.name) + '</button>').join('') + '</div></div>';
      }
      choose += '</div>';
      return '<div class="ct-center"><div class="msg">' +
        '<p>Match #' + esc(m.number) + (m.round ? ' · ' + esc(m.round) : '') + ' · ' + (m.format === 'doubles' ? 'Doubles' : 'Singles') + '</p>' +
        '<div class="vs">' + esc(shortNames(m.teams[0])) + '<div class="v">against</div>' + esc(shortNames(m.teams[1])) + '</div>' +
        '<div class="rules">' + ruleBits.map(esc).join(' · ') + '</div>' +
        choose +
        '<button class="bigbtn" style="display:inline-flex;text-align:center;align-items:center" data-action="start">Start match<small>Voice starts with it. Say “play” or tap.</small></button>' +
        '</div></div>';
    }

    function renderDone() {
      const m = st.match;
      const sent = st.net.status === 'online';
      return '<div class="ct-center"><div class="msg"><p>Match #' + esc(m.number) + ' · finished in ' + Math.round(S.durationSec(m) / 60) + ' min</p>' +
        '<div class="final">' + esc(shortNames(m.teams[m.winner])) + '</div><p>defeats ' + esc(shortNames(m.teams[1 - m.winner])) + '</p>' +
        '<div class="final" style="color:var(--ball)">' + esc(S.setLine(m)) + '</div>' +
        '<p>' + (sent ? 'Result sent to the organizer desk.' : 'Result saved on this tablet — it will reach the desk when the link is back.') + '</p>' +
        '<div style="display:flex;gap:1cqw;justify-content:center;flex-wrap:wrap"><button class="ctl warn" data-action="correction">Correction</button><button class="bigbtn" style="display:inline-flex;text-align:center" data-action="clear">Clear court<small>Ready for the next match</small></button></div>' +
        '</div></div>';
    }

    function renderLive() {
      const m = st.match, sb = S.scoreboard(m);
      const prev = sb.sets.length ? '<div class="prev-sets">Sets: ' + sb.sets.map(s => '<b>' + (s.matchTiebreak ? '[' + s.tb.join('-') + ']' : s.games.join('-') + (s.tb ? '(' + Math.min(s.tb[0], s.tb[1]) + ')' : '')) + '</b>').join(' &nbsp; ') + '</div>' : '';
      const row = (t, i) => {
        const role = t.serving ? 'Serving: ' + t.activeName : (t.receiving ? 'Receiving: ' + t.activeName + (m.format === 'doubles' && sb.receiver ? ' (' + sb.receiver.court + ' court)' : '') : '');
        const gp = t.gamePoint ? (sb.tiebreak ? (sb.tiebreak === 'match' ? ' · match point' : ' · set point') : ' · game point') : '';
        return '<div class="team-row"><div class="team ' + (t.serving ? 'serving' : '') + '"><div class="names"><span class="dot"></span><span>' + esc(wallLabel(m.teams[i])) + '</span></div><div class="role' + (t.gamePoint ? ' gp' : '') + '">' + esc(role) + esc(gp) + '</div></div>' +
          '<div class="num">' + t.sets + '</div><div class="num">' + t.games + '</div><div class="num pts">' + esc(t.points) + '</div></div>';
      };
      const mode = [m.rules.noAd ? 'No-Ad' : 'Ad', m.rules.express ? 'Express' : (m.rules.bestOf === 1 ? 'One set' : 'Best of ' + m.rules.bestOf), m.rules.finalSetMatchTiebreak && m.rules.bestOf > 1 ? m.rules.matchTiebreakTo + '-pt 3rd TB' : ''].filter(Boolean).join(' · ');
      const tbNote = sb.tiebreak ? '<b>' + (sb.tiebreak === 'match' ? 'Match tiebreak' : 'Tiebreak') + ' to ' + sb.tiebreakTo + '</b><br>' : '';
      const faultNote = sb.faults ? '<b>Second serve</b><br>' : '';
      const deciding = sb.decidingPoint ? '<b>Deciding point — receiver picks the side</b><br>' : '';
      return '<div class="ct-board"><div class="wall">' +
        '<div class="head first">' + esc(m.round || (m.format === 'doubles' ? 'Doubles' : 'Singles')) + '</div><div class="head">Sets</div><div class="head">Games</div><div class="head">Points</div>' +
        row(sb.teams[0], 0) + '<div class="sep"></div>' + row(sb.teams[1], 1) + prev +
        '</div><div class="ct-side">' +
        '<div class="serve-clock" id="serve-clock"><div class="lbl">Serve clock</div><div class="val">' + Math.max(0, Math.ceil((st.serveClockEndsAt - Date.now()) / 1000)) + '</div></div>' +
        '<div class="call">' + esc(sb.call) + '<small>' + esc(sb.server ? sb.server.name + ' serving' : '') + '</small></div>' +
        '<div class="mode">' + tbNote + faultNote + deciding + esc(mode) + '</div>' +
        '</div></div>' +
        '<div class="ct-controls"><div class="points">' +
        '<button class="bigbtn" data-action="point" data-team="0">Point ' + esc(sb.teams[0].label) + '<small>' + esc(sb.teams[0].serving ? 'server' : 'receiver') + '</small></button>' +
        '<button class="bigbtn" data-action="point" data-team="1">Point ' + esc(sb.teams[1].label) + '<small>' + esc(sb.teams[1].serving ? 'server' : 'receiver') + '</small></button>' +
        '</div><div class="row">' +
        '<button class="ctl" data-action="fault">' + (sb.faults ? 'Double fault' : 'Fault') + '</button>' +
        '<button class="ctl" data-action="let">Let</button>' +
        '<button class="ctl warn" data-action="correction"' + (m.history.length ? '' : ' disabled') + '>Correction</button>' +
        '<button class="ctl" data-action="override">Override</button>' +
        '<button class="ctl" data-action="changeover">Force changeover</button>' +
        '<button class="ctl danger" data-action="umpire">Call umpire</button>' +
        '</div></div>';
    }

    function renderVoice() {
      const v = st.voice, s = v.status;
      const btnCls = s === 'listening' || s === 'starting' ? (st.settings.arm && !rec.armed ? 'on' : (st.settings.arm ? 'armed' : 'on')) : (s === 'blocked' || s === 'unsupported' ? 'blocked' : '');
      const label = s === 'listening' ? (st.settings.arm ? (rec.armed ? 'Armed — say the score' : 'Tap to arm') : 'Listening · ' + st.settings.lang) : s === 'starting' ? 'Starting mic' : s === 'blocked' ? 'Microphone blocked in this browser' : s === 'unsupported' ? 'Voice needs Chrome, Edge or Safari' : 'Tap to start voice';
      const heard = v.interim ? '<div class="t">Hearing <q>' + esc(v.interim) + '</q>…</div>' : (v.transcript ? '<div class="t">Heard <q>' + esc(v.transcript) + '</q></div>' : '<div class="t">Say the score before you serve, server first: “30-15”, “deuce”, “ad in”, “game”. Or “fault”, “let”, “correction”, “umpire”.</div>');
      const res = v.result ? '<div class="r ' + esc(v.kind) + '">' + esc(v.result) + '</div>' : '';
      return '<div class="ct-voice"><div class="mic"><button class="' + btnCls + '" data-action="mic" aria-label="Voice"><svg width="55%" height="55%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button><span>' + esc(label) + '</span></div>' +
        '<div class="heard">' + heard + res + '</div>' +
        '<form class="typed" data-action="typed"><input id="typed-call" placeholder="Type a call, e.g. 30-15" autocomplete="off"><button type="submit">Send</button></form></div>';
    }

    function renderRest() {
      const m = st.match;
      const sponsors = activeSponsors();
      const sp = sponsors.length && st.adIdx >= 0 ? sponsors[st.adIdx % sponsors.length] : null;
      const kindLabel = st.restKind === 'setBreak' ? 'Set break' : 'Changeover';
      const sb = m ? S.scoreboard(m) : null;
      const scoreLine = sb ? wallLabel(m.teams[0]) + ' ' + sb.teams[0].games + '–' + sb.teams[1].games + ' ' + wallLabel(m.teams[1]) + (sb.sets.length ? ' · sets ' + sb.teams[0].sets + '–' + sb.teams[1].sets : '') + (sb.setLine ? ' · ' + sb.setLine : '') : '';
      const ad = sp
        ? '<div class="ad" style="background:' + esc(sp.colour) + ';color:' + esc(sp.text || '#fff') + '"><div class="who">Court-side sponsor · ' + esc(st.tournament ? st.tournament.name : '') + '</div><div class="body">' + (sp.imageUrl ? '<img src="' + esc(sp.imageUrl) + '" alt="">' : '') + '<div class="name">' + esc(sp.name) + '</div><div class="tag">' + esc(sp.tagline) + '</div></div>' +
          '<div class="foot"><div class="dots">' + sponsors.map((x, i) => '<i class="' + (i === st.adIdx % sponsors.length ? 'on' : '') + '"></i>').join('') + '</div><div class="score">' + esc(scoreLine) + '</div></div></div>'
        : '<div class="ad" style="background:#0A0C0E"><div class="who">' + esc(st.tournament ? st.tournament.name : '') + '</div><div class="body"><div class="name">' + esc(kindLabel) + '</div><div class="tag">' + esc(scoreLine) + '</div></div><div class="foot"><span></span><span class="score">Sponsors added on the organizer desk appear here.</span></div></div>';
      return '<div class="ct-overlay"><div class="bar"><div class="k">' + esc(kindLabel) + '<small>Time is called at ' + (m ? m.rules.timeCallSec : 80) + ' s · ' + esc(sb && sb.server ? sb.server.name + ' serves next' : '') + '</small></div><div class="clock' + (st.timeCalled ? ' time' : '') + '" id="rest-clock">' + mmss(st.restEndsAt - Date.now()) + '</div></div>' +
        ad +
        '<div class="actions"><button class="ctl on" data-action="end-rest">Resume play</button><button class="ctl" data-action="correction">Correction</button><button class="ctl danger" data-action="umpire">Call umpire</button></div>' +
        (st.timeFlashUntil > Date.now() ? '<div class="timecall">TIME</div>' : '') +
        '</div>';
    }

    function renderModal() {
      const mo = st.modal, m = st.match;
      let inner = '';
      if (mo.type === 'ambiguous') {
        inner = '<h3>Who won that game?</h3><p>' + esc(mo.text) + '</p><div class="btns">' + mo.teams.map(t => '<button class="bigbtn" data-action="resolve" data-team="' + t + '">' + esc(shortNames(m.teams[t])) + '</button>').join('') + '<button class="ctl" data-action="close-modal">Cancel</button></div>';
      } else if (mo.type === 'umpire') {
        inner = '<h3>Tournament director called</h3><p>The organizer desk has been alerted with the current score. Play stops until they arrive. Use Correction or Override if the score needs fixing first.</p><div class="btns"><button class="ctl" data-action="override">Override score</button><button class="ctl on" data-action="close-modal">Back to the match</button></div>';
      } else if (mo.type === 'override') {
        const o = mo.draft;
        const stepper = (lbl, k, i) => '<div class="stepper"><div class="lbl">' + esc(lbl) + '</div><div class="ctr"><button class="ctl" data-action="ov" data-k="' + k + '" data-i="' + i + '" data-d="-1">−</button><div class="v">' + o[k][i] + '</div><button class="ctl" data-action="ov" data-k="' + k + '" data-i="' + i + '" data-d="1">+</button></div></div>';
        const ptLbl = i => (o.tiebreak ? 'Tiebreak points' : 'Points (0 15 30 40 AD)') + ' · ' + shortNames(m.teams[i]);
        inner = '<h3>Override the score</h3><p>Set games and points directly. The change is logged and can be corrected.</p><div class="grid">' +
          stepper('Games · ' + shortNames(m.teams[0]), 'games', 0) + stepper('Games · ' + shortNames(m.teams[1]), 'games', 1) +
          stepper(ptLbl(0), 'points', 0) + stepper(ptLbl(1), 'points', 1) + '</div>' +
          '<div class="grid"><div class="stepper"><div class="lbl">Server</div><div class="opts" style="display:flex;flex-wrap:wrap;gap:0.6cqw">' + m.serveOrder.map((s, i) => '<button class="ctl ' + (o.serveIdx === i ? 'on' : '') + '" data-action="ov-server" data-i="' + i + '">' + esc(m.teams[s.team].players[s.player].name) + '</button>').join('') + '</div></div>' +
          '<div class="stepper"><div class="lbl">Tiebreak</div><button class="ctl ' + (o.tiebreak ? 'on' : '') + '" data-action="ov-tb">' + (o.tiebreak ? 'In a tiebreak' : 'Not in a tiebreak') + '</button></div></div>' +
          '<div class="btns"><button class="ctl" data-action="close-modal">Cancel</button><button class="ctl on" data-action="ov-apply">Apply override</button></div>';
      }
      return '<div class="ct-modal"><div class="box">' + inner + '</div></div>';
    }

    function renderToast() {
      const t = st.toast;
      const btn = t.action ? '<button data-action="toast-action">' + esc(t.action.label) + '</button>' : '';
      const left = Math.max(0, t.ms - (Date.now() - t.at));
      return '<div class="ct-toast ' + esc(t.kind) + '"><span>' + esc(t.text) + '</span>' + btn + '<div class="bar" style="width:100%;transition-duration:' + left + 'ms" data-shrink></div></div>';
    }

    function renderSettings() {
      const s = st.settings;
      const chk = (k, lbl) => '<label>' + esc(lbl) + '<input type="checkbox" data-setting="' + k + '"' + (s[k] ? ' checked' : '') + '></label>';
      const log = st.match && st.match.log ? st.match.log.slice().reverse().slice(0, 12).map(l => '<div>' + new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + esc(l.text) + '</div>').join('') : '<div>No match yet.</div>';
      return '<div class="ct-settings"><h3>This tablet</h3>' +
        '<label>Voice language<select data-setting="lang"><option value="en-CA"' + (s.lang === 'en-CA' ? ' selected' : '') + '>English (Canada)</option><option value="fr-CA"' + (s.lang === 'fr-CA' ? ' selected' : '') + '>Français (Canada)</option><option value="en-US"' + (s.lang === 'en-US' ? ' selected' : '') + '>English (US)</option></select></label>' +
        '<label>Wake word (optional)<input type="text" data-setting="wakeWord" value="' + esc(s.wakeWord) + '" placeholder="e.g. court ' + esc(courtId) + '"></label>' +
        chk('arm', 'Tap the mic before each call (noisy courts)') +
        chk('voiceAuto', 'Start listening when a match starts') +
        chk('announce', 'Read the score aloud after each point') +
        chk('sponsorAudio', 'Read sponsor messages during changeovers') +
        chk('glare', 'Sun glare mode (brighter text)') +
        '<div class="log"><b>Match log</b>' + log + '</div>' +
        '<button class="ctl on close" data-action="settings">Close</button></div>';
    }

    /* ------------------------------------------------------------ */
    /* events                                                       */
    /* ------------------------------------------------------------ */
    rootEl.addEventListener('click', e => {
      const b = e.target.closest('[data-action]');
      if (!b || b.tagName === 'FORM') return;
      A.unlock();
      const act = b.dataset.action;
      const m = st.match;
      switch (act) {
        case 'settings': st.settingsOpen = !st.settingsOpen; render(); break;
        case 'first-server': st.firstServer = { team: +b.dataset.team, player: +b.dataset.player }; render(); break;
        case 'opp-first': st.oppFirst = +b.dataset.player; render(); break;
        case 'start': startMatch(); break;
        case 'point': { const team = +b.dataset.team; doPoint(team, 'tap'); toast('Point ' + shortNames(st.match.teams[team]) + '. ' + (st.phase === 'live' ? S.callString(st.match) : ''), 'ok', { label: 'Undo', action: 'correction' }, 3500); break; }
        case 'fault': doFault(); break;
        case 'let': runCommand('let'); break;
        case 'correction': doUndo(); break;
        case 'override': if (m) { st.modal = { type: 'override', draft: { games: m.games.slice(), points: m.points.slice(), serveIdx: S.serverOf(m).idx, tiebreak: !!m.tiebreak } }; render(); } break;
        case 'ov': { const d = st.modal.draft; d[b.dataset.k][+b.dataset.i] = Math.max(0, d[b.dataset.k][+b.dataset.i] + (+b.dataset.d)); render(); break; }
        case 'ov-server': st.modal.draft.serveIdx = +b.dataset.i; render(); break;
        case 'ov-tb': st.modal.draft.tiebreak = !st.modal.draft.tiebreak; render(); break;
        case 'ov-apply': { const d = st.modal.draft; st.match = S.override(m, { games: d.games, points: d.points, serveIdx: d.serveIdx, tiebreak: d.tiebreak }).state; st.modal = null; st.restEndsAt = 0; resetServeClock(); announce('Override. ' + S.callString(st.match)); sendState(); render(); break; }
        case 'changeover': forceChangeover(); break;
        case 'umpire': callUmpire(); break;
        case 'end-rest': endRest(true); break;
        case 'clear': clearCourt(true); break;
        case 'resolve': doPoint(+b.dataset.team, 'voice'); st.modal = null; render(); break;
        case 'close-modal': st.modal = null; render(); break;
        case 'mic': toggleMic(); break;
        case 'toast-action': { const a = st.toast && st.toast.action; st.toast = null; if (a) { if (a.action === 'correction') doUndo(); else if (a.action === 'force' && m) { st.match = S.applyAssertionAsOverride(m, a.assertion).state; announce('Override. ' + S.callString(st.match)); sendState(); render(); } } else render(); break; }
      }
    });
    rootEl.addEventListener('submit', e => {
      const f = e.target.closest('form[data-action="typed"]');
      if (!f) return;
      e.preventDefault();
      const input = f.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      A.unlock();
      st._typedFocus = true;
      rec.feedText(text);
      input.value = '';
    });
    rootEl.addEventListener('change', e => {
      const el = e.target.closest('[data-setting]');
      if (!el) return;
      const k = el.dataset.setting;
      st.settings[k] = el.type === 'checkbox' ? el.checked : el.value;
      saveSettings();
      if (k === 'lang') rec.setLang(st.settings.lang);
      if (k === 'wakeWord') rec.setWakeWord(st.settings.wakeWord);
      if (k === 'arm') rec.arm(!st.settings.arm);
      render();
    });
    function toggleMic() {
      if (!rec.supported) { toast('Voice recognition needs Chrome, Edge or Safari. The buttons do everything voice does.', 'bad', null, 4000); return; }
      if (typeof window !== 'undefined' && window.isSecureContext === false) { toast('Voice needs HTTPS: open this tablet over https:// (run `npm run cert` + `npm run start:https` on the hub). The buttons work meanwhile.', 'bad', null, 6000); return; }
      if (rec.status === 'listening' || rec.status === 'starting') {
        if (st.settings.arm && !rec.armed) { rec.arm(true); renderVoiceOnly(); return; }
        rec.stop();
      } else rec.start();
      renderVoiceOnly();
    }

    /* ------------------------------------------------------------ */
    /* demo / automation hooks                                      */
    /* ------------------------------------------------------------ */
    let autoTimer = null;
    const api = {
      courtId, transport, state: st, render, rec,
      point: team => doPoint(team, 'tap'),
      say: text => rec.feedText(text),
      start: () => { st.phase === 'ready' && startMatch(); },
      setOnline: on => transport.setOnline(on),
      autoplay(on, intervalMs) {
        clearInterval(autoTimer); autoTimer = null;
        if (!on) return;
        autoTimer = setInterval(() => {
          if (st.phase === 'ready') return startMatch();
          if (st.phase !== 'live' || st.restEndsAt || st.modal) return;
          const srv = S.serverOf(st.match).team;
          doPoint(Math.random() < 0.6 ? srv : 1 - srv, 'auto');
        }, intervalMs || 1200);
      },
      destroy() { clearInterval(tickTimer); clearInterval(hbTimer); clearInterval(autoTimer); rec.stop(); transport.close(); }
    };

    tickTimer = setInterval(tick, 250);
    hbTimer = setInterval(() => { if (st.phase !== 'free') sendState(); }, 15000);
    render();
    if (st.phase === 'live') { resetServeClock(); if (st.settings.voiceAuto && rec.supported) rec.start(); }
    return api;
  }

  root.CourtSide.createCourtApp = createCourtApp;
})(typeof self !== 'undefined' ? self : this);

/*
 * RallyPoint — voice module
 * parseCall(): turns a transcript into a score assertion or a command (English + French).
 * createRecognizer(): thin wrapper over the Web Speech API with alternatives,
 * confidence gating, a wake-word option, auto-restart and self-mute during TTS.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RallyPoint = root.RallyPoint || {}; root.RallyPoint.voice = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCORE_WORDS = {
    love: 0, zero: 0, nil: 0, oh: 0, 'zéro': 0,
    fifteen: 15, five: 15, quinze: 15,
    thirty: 30, thirteen: 30, trente: 30,
    forty: 40, fourty: 40, quarante: 40,
    all: 'ALL', partout: 'ALL', 'a': 'ALL'
  };

  // Ordered: earlier patterns win. \b does not work on accented letters, so
  // accented words are matched with explicit boundaries where needed.
  const COMMANDS = [
    ['correction', /\b(correction|undo|scratch that|corrige[rz]?|annule[rz]?)\b/],
    ['doubleFault', /\b(double fault|double faute)\b/],
    ['umpire', /\b(umpire|referee|director|dispute|supervisor|arbitre|superviseur|litige)\b/],
    ['changeover', /\b(force changeover|changeover|change ends|changement de c[oô]t[eé]|changez)\b/],
    ['time', /^\s*(time|temps|reprise)\s*!?\s*$/],
    ['resume', /\b(resume|play|start|reprise du jeu|reprenez|jouez)\b/],
    ['pointServer', /\b(point (to )?(the )?serv(er|eur)|server'?s? point|point serveur)\b/],
    ['pointReceiver', /\b(point (to )?(the )?(receiver|relanceur|returner)|receiver'?s? point|point relanceur)\b/],
    ['let', /\b(let|filet|net cord|net)\b/],
    ['fault', /\b(fault|faute|foot fault)\b/]
  ];

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripWake(text, wake) {
    if (!wake) return { text, matched: true };
    const w = normalize(wake);
    if (!w) return { text, matched: true };
    if (text.startsWith(w)) return { text: text.slice(w.length).trim(), matched: true };
    // tolerate the recognizer dropping a small word: "court 2" vs "court two"
    const alt = w.replace(/\b(one|two|three|four|five|six|seven|eight|nine)\b/g, n => ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }[n]));
    if (text.startsWith(alt)) return { text: text.slice(alt.length).trim(), matched: true };
    return { text, matched: false };
  }

  /**
   * @returns {null|{kind:'score',a,b,words,raw}|{kind:'deuce'|'adIn'|'adOut'|'ad'|'game',raw}|{kind:'command',cmd,raw}}
   */
  function parseCall(transcript, opts) {
    opts = opts || {};
    const raw = String(transcript || '');
    let text = normalize(raw);
    if (!text) return null;
    if (opts.wakeWord) {
      const w = stripWake(text, opts.wakeWord);
      if (!w.matched) return null;
      text = w.text;
      if (!text) return null;
    }

    // advantage first, because "ad out" contains "out" and "ad in" contains "in"
    if (/\b(ad|add|advantage|van|avantage|vantage)\b/.test(text)) {
      if (/\b(in|server|service|serveur|dedans|serving)\b/.test(text)) return { kind: 'adIn', raw };
      if (/\b(out|receiver|relance|relanceur|dehors|receiving)\b/.test(text)) return { kind: 'adOut', raw };
      return { kind: 'ad', raw };
    }
    if (/\b(deuce|deuces|juice|egalite|égalité)\b/.test(text) || /égalité/.test(text)) return { kind: 'deuce', raw };

    for (const [cmd, re] of COMMANDS) {
      if (re.test(text)) return { kind: 'command', cmd, raw };
    }

    if (/\b(game|jeu)\b/.test(text) && !/\b(game point|balle de jeu)\b/.test(text)) return { kind: 'game', raw };

    // Score tokens: digits, glued digits ("3015"), and number words
    const tokens = text.split(' ');
    const vals = [];
    let words = false;
    for (const tok of tokens) {
      if (/^\d+$/.test(tok)) {
        if (tok.length === 4 || tok.length === 3) {
          // "3015" -> 30 15, "015" -> 0 15 (rare), "1530"
          const cut = tok.length === 4 ? 2 : 1;
          const a = parseInt(tok.slice(0, cut), 10), b = parseInt(tok.slice(cut), 10);
          vals.push(a, b);
        } else vals.push(parseInt(tok, 10));
      } else if (SCORE_WORDS.hasOwnProperty(tok)) {
        if (tok === 'a' && vals.length !== 1) continue; // "a" only counts as "all" right after a score
        if (typeof SCORE_WORDS[tok] === 'number') words = true;
        vals.push(SCORE_WORDS[tok]);
      }
    }
    const nums = vals.filter(v => typeof v === 'number');
    const hasAll = vals.indexOf('ALL') >= 0;
    if (hasAll && nums.length >= 1) return { kind: 'score', a: nums[0], b: nums[0], words, raw };
    if (nums.length >= 2) return { kind: 'score', a: nums[0], b: nums[1], words, raw };
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Web Speech API wrapper                                               */
  /* ------------------------------------------------------------------ */

  function createRecognizer(opts) {
    opts = opts || {};
    const SR = (typeof window !== 'undefined') && (window.SpeechRecognition || window.webkitSpeechRecognition);
    const api = {
      supported: !!SR,
      status: SR ? 'idle' : 'unsupported',
      lang: opts.lang || 'en-CA',
      wakeWord: opts.wakeWord || '',
      minConfidence: opts.minConfidence == null ? 0.4 : opts.minConfidence,
      armed: true,
      listening: false,
      mutedUntil: 0,
      start, stop, setLang, setWakeWord, mute, arm, feedText
    };
    let rec = null, wantListening = false, restartTimer = null;

    function emitStatus(s, extra) { api.status = s; if (opts.onStatus) opts.onStatus(s, extra || {}); }

    function build() {
      rec = new SR();
      rec.lang = api.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 4;
      rec.onstart = () => { api.listening = true; emitStatus('listening'); };
      rec.onend = () => {
        api.listening = false;
        if (wantListening) { clearTimeout(restartTimer); restartTimer = setTimeout(() => { try { rec.start(); } catch (e) { /* already started */ } }, 250); }
        else emitStatus('idle');
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wantListening = false; emitStatus('blocked', { error: e.error }); }
        else if (e.error === 'no-speech' || e.error === 'aborted') { /* keep going */ }
        else emitStatus('error', { error: e.error });
      };
      rec.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (!res.isFinal) { if (opts.onInterim) opts.onInterim(res[0].transcript); continue; }
          handleFinal(res);
        }
      };
    }

    function handleFinal(res) {
      const now = Date.now();
      if (now < api.mutedUntil) { if (opts.onIgnored) opts.onIgnored(res[0].transcript, 'Tablet was speaking'); return; }
      if (!api.armed) { if (opts.onIgnored) opts.onIgnored(res[0].transcript, 'Voice not armed — tap the mic'); return; }
      const alts = [];
      for (let k = 0; k < res.length; k++) alts.push({ transcript: res[k].transcript, confidence: res[k].confidence });
      deliver(alts, 'mic');
    }

    /**
     * Try each alternative in confidence order; the first that parses and passes
     * validate() (reachable score, known command) is delivered. Alternatives
     * exist precisely so that "thirty fifteen" heard as "dirty fifteen" still lands.
     */
    function deliver(alts, source) {
      alts.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      let firstParsed = null, firstReason = '';
      for (const alt of alts) {
        const conf = alt.confidence == null || alt.confidence === 0 ? 1 : alt.confidence; // Android often reports 0
        const a = parseCall(alt.transcript, { wakeWord: api.wakeWord });
        if (!a) continue;
        const v = opts.validate ? opts.validate(a) : { ok: true };
        if (v.ok && conf >= api.minConfidence) { opts.onCall(a, { transcript: alt.transcript, confidence: alt.confidence, source }); return; }
        if (!firstParsed) { firstParsed = a; firstReason = v.ok ? 'Low confidence (' + Math.round(conf * 100) + '%)' : (v.reason || 'Not reachable'); }
      }
      if (firstParsed) { if (opts.onRejected) opts.onRejected(firstParsed, firstReason, alts[0].transcript); }
      else if (opts.onIgnored) opts.onIgnored(alts[0].transcript, 'No score or command in that');
    }

    function start() {
      if (!SR) { emitStatus('unsupported'); return false; }
      wantListening = true;
      if (!rec) build();
      try { rec.start(); } catch (e) { /* already running */ }
      emitStatus('starting');
      return true;
    }
    function stop() {
      wantListening = false;
      clearTimeout(restartTimer);
      if (rec) { try { rec.stop(); } catch (e) { /* noop */ } }
      api.listening = false;
      emitStatus('idle');
    }
    function setLang(l) { api.lang = l; if (rec) { rec.lang = l; if (wantListening) { try { rec.stop(); } catch (e) { /* restarts via onend */ } } } }
    function setWakeWord(w) { api.wakeWord = w || ''; }
    function mute(ms) { api.mutedUntil = Date.now() + ms; }
    function arm(on) { api.armed = !!on; }
    /** Typed calls from the fallback box go through the same pipeline. */
    function feedText(text) { deliver([{ transcript: text, confidence: 1 }], 'typed'); }

    return api;
  }

  return { parseCall, normalize, createRecognizer, SCORE_WORDS };
});

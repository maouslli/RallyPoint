/*
 * CourtSide AI — audio
 * Short synthesized tones (no assets needed) and a speak() helper.
 */
(function (root) {
  'use strict';
  let ctx = null;
  function ac() {
    if (ctx) return ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }
  function unlock() { const c = ac(); if (c && c.state === 'suspended') c.resume(); }

  function tone(freq, ms, opts) {
    const c = ac(); if (!c) return;
    opts = opts || {};
    const o = c.createOscillator(), g = c.createGain();
    o.type = opts.type || 'sine';
    o.frequency.value = freq;
    g.gain.value = 0.0001;
    o.connect(g); g.connect(c.destination);
    const t = c.currentTime + (opts.delay || 0) / 1000;
    o.start(t);
    g.gain.exponentialRampToValueAtTime(opts.gain || 0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.stop(t + ms / 1000 + 0.05);
  }

  const cues = {
    confirm() { tone(880, 90); tone(1320, 120, { delay: 100 }); },
    reject() { tone(220, 180, { type: 'square', gain: 0.12 }); },
    game() { tone(660, 120); tone(880, 120, { delay: 130 }); tone(1100, 200, { delay: 260 }); },
    warn() { tone(520, 300, { type: 'triangle' }); },
    time() { tone(1000, 250, { type: 'square', gain: 0.2 }); tone(1000, 250, { type: 'square', gain: 0.2, delay: 350 }); tone(1000, 500, { type: 'square', gain: 0.2, delay: 700 }); },
    alert() { tone(740, 150); tone(740, 150, { delay: 220 }); },
    serveClock() { tone(420, 400, { type: 'sawtooth', gain: 0.1 }); }
  };

  /**
   * speak(text, {lang, rate}) -> estimated milliseconds of speech. Resolves
   * synchronously with an estimate so callers can mute the mic right away.
   */
  function speak(text, opts) {
    opts = opts || {};
    if (!root.speechSynthesis || !text) return 0;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = opts.lang || 'en-CA';
      u.rate = opts.rate || 1.0;
      u.pitch = opts.pitch || 1.0;
      u.volume = opts.volume == null ? 1 : opts.volume;
      if (opts.interrupt !== false) root.speechSynthesis.cancel();
      root.speechSynthesis.speak(u);
    } catch (e) { return 0; }
    return Math.max(800, text.length * 65);
  }
  function stopSpeaking() { if (root.speechSynthesis) root.speechSynthesis.cancel(); }

  root.CourtSide = root.CourtSide || {};
  root.CourtSide.audio = { tone, cues, speak, stopSpeaking, unlock };
})(typeof self !== 'undefined' ? self : this);

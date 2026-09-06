/*
 * RallyPoint — sync
 * createTransport() gives every app the same send()/onMessage() surface over:
 *   ws     — the Node hub (server/index.js), for real deployments
 *   bc     — BroadcastChannel between tabs; the organizer tab hosts the hub
 *   local  — an in-page hub (demo.html) with a simulated link per client
 * Anything sent while disconnected waits in a localStorage outbox and is
 * replayed in order on reconnect. Snapshots coalesce to the latest one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.RallyPoint = root.RallyPoint || {}; root.RallyPoint.sync = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHANNEL = 'rallypoint';

  function storage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  }
  function load(key, fallback) {
    const s = storage(); if (!s) return fallback;
    try { const v = s.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    const s = storage(); if (!s) return;
    try { s.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ }
  }

  function createTransport(opts) {
    const role = opts.role;                       // 'court' | 'organizer'
    const courtId = opts.courtId != null ? String(opts.courtId) : null;
    const clientId = role + (courtId ? '-' + courtId : '') + '-' + Math.random().toString(36).slice(2, 7);
    const outboxKey = (opts.storagePrefix || 'cs') + ':outbox:' + role + (courtId ? ':' + courtId : '');
    let outbox = load(outboxKey, []);
    let mode = opts.mode || 'auto';
    let status = 'connecting';
    let ws = null, bc = null, link = null, retry = 0, retryTimer = null, hbTimer = null;
    let onlineFlag = true;
    let replayedCount = 0;

    const api = {
      clientId, role, courtId,
      get status() { return status; },
      get mode() { return mode; },
      get queued() { return outbox.length; },
      send, close, setOnline, flushNow: flush
    };

    function setStatus(s) {
      if (s === status) return;
      status = s;
      if (opts.onStatus) opts.onStatus(s, { mode, queued: outbox.length });
    }
    function notifyQueue() { if (opts.onStatus) opts.onStatus(status, { mode, queued: outbox.length }); }
    function receive(msg) { if (msg && opts.onMessage) opts.onMessage(msg); }

    function hello() {
      rawSend({ type: 'hello', role, courtId, clientId });
    }

    /* ---------------- outbox ---------------- */
    function enqueue(msg) {
      if (msg.type === 'court:state') outbox = outbox.filter(m => m.type !== 'court:state');
      outbox.push(msg);
      if (outbox.length > 500) outbox = outbox.slice(-500);
      save(outboxKey, outbox);
      notifyQueue();
    }
    function flush() {
      if (status !== 'online' || !outbox.length) return;
      const batch = outbox; outbox = [];
      replayedCount = batch.length;
      batch.forEach(rawSend);
      save(outboxKey, outbox);
      if (role === 'court' && replayedCount > 0) rawSend({ type: 'court:event', courtId, event: { kind: 'offlineReplay', count: replayedCount } });
      notifyQueue();
    }
    function send(msg) {
      if (status === 'online') { rawSend(msg); return true; }
      enqueue(msg);
      return false;
    }
    function rawSend(msg) {
      try {
        if (mode === 'ws' && ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
        else if (mode === 'bc' && bc) bc.postMessage({ to: 'hub', from: clientId, msg });
        else if (mode === 'local' && link) link.send(msg);
      } catch (e) { enqueue(msg); }
    }

    /* ---------------- WebSocket ---------------- */
    function connectWs() {
      mode = 'ws';
      setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      const url = opts.wsUrl || (proto + location.host + '/ws');
      let opened = false;
      try { ws = new WebSocket(url); } catch (e) { return fallbackToBc(); }
      ws.onopen = () => {
        opened = true; retry = 0;
        setStatus('online'); hello(); flush();
        clearInterval(hbTimer);
        hbTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', role, courtId })); }, 5000);
      };
      ws.onmessage = (e) => { try { receive(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
      ws.onclose = () => {
        clearInterval(hbTimer);
        if (!opened && retry === 0 && !opts.wsUrl && opts.allowBcFallback !== false) return fallbackToBc();
        setStatus('offline');
        scheduleRetry();
      };
      ws.onerror = () => { /* onclose follows */ };
    }
    function scheduleRetry() {
      clearTimeout(retryTimer);
      const delay = Math.min(15000, 1000 * Math.pow(1.7, retry++));
      retryTimer = setTimeout(connectWs, delay);
    }
    function fallbackToBc() {
      ws = null;
      if (typeof BroadcastChannel === 'undefined') { setStatus('offline'); return scheduleRetry(); }
      connectBc();
    }

    /* ---------------- BroadcastChannel ---------------- */
    function connectBc() {
      mode = 'bc';
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (e) => {
        const d = e.data || {};
        if (d.from === 'hub' && (d.to === 'all' || d.to === clientId)) {
          if (status !== 'online') { setStatus('online'); flush(); }
          receive(d.msg);
        } else if (d.to === 'hub' && opts.hubHandler) {
          // this tab hosts the hub
          opts.hubHandler(d.msg, d.from).forEach(o => { bc.postMessage({ to: o.to, from: 'hub', msg: o.msg }); if (o.to === 'all') receive(o.msg); });
        }
      };
      if (opts.hubHandler) {
        setStatus('online');
        // loop back the organizer's own messages
        api.send = function (msg) {
          opts.hubHandler(msg, clientId).forEach(o => { if (o.to === 'all' || o.to === clientId) receive(o.msg); else bc.postMessage({ to: o.to, from: 'hub', msg: o.msg }); if (o.to === 'all') bc.postMessage({ to: 'all', from: 'hub', msg: o.msg }); });
          return true;
        };
        api.send({ type: 'hello', role, courtId, clientId });
      } else {
        setStatus('connecting');
        hello();
        // no organizer tab answering? keep scoring locally and retry
        setTimeout(() => { if (status !== 'online') { setStatus('offline'); } }, 2000);
        hbTimer = setInterval(() => { if (status !== 'online') hello(); else rawSend({ type: 'ping', role, courtId }); }, 4000);
      }
    }

    /* ---------------- in-page demo link ---------------- */
    function connectLocal() {
      mode = 'local';
      link = opts.localHub.connect(clientId, {
        onMessage: receive,
        onOnline: (on) => { if (on) { setStatus('online'); hello(); flush(); } else setStatus('offline'); }
      });
      link.setOnline(onlineFlag);
      hbTimer = setInterval(() => { if (status === 'online') rawSend({ type: 'ping', role, courtId }); }, 4000);
    }
    function setOnline(on) {
      onlineFlag = !!on;
      if (mode === 'local' && link) link.setOnline(onlineFlag);
    }

    function close() {
      clearTimeout(retryTimer); clearInterval(hbTimer);
      if (ws) { try { ws.close(); } catch (e) { /* noop */ } }
      if (bc) bc.close();
      if (link) link.close();
    }

    /* ---------------- pick a mode ---------------- */
    if (opts.localHub) connectLocal();
    else if (mode === 'bc') connectBc();
    else if (mode === 'ws' || (typeof location !== 'undefined' && /^https?:/.test(location.protocol))) connectWs();
    else connectBc();

    return api;
  }

  /**
   * In-page hub for demo.html: every client gets a link with its own
   * "internet" switch and a little latency so the sync is visible.
   */
  function createLocalHub(host, opts) {
    opts = opts || {};
    const latency = opts.latencyMs == null ? 180 : opts.latencyMs;
    const links = {};
    function deliver(to, msg) {
      Object.values(links).forEach(l => {
        if (!l.online) return;
        if (to === 'all' || to === l.id) setTimeout(() => l.onMessage(msg), latency);
      });
    }
    return {
      host,
      links,
      connect(id, handlers) {
        const l = { id, online: false, onMessage: handlers.onMessage,
          send(msg) { if (!l.online) return; setTimeout(() => host.handle(msg, id).forEach(o => deliver(o.to, o.msg)), latency); },
          setOnline(on) { const was = l.online; l.online = !!on; if (was !== l.online) handlers.onOnline(l.online); if (!l.online) host.handle({ type: 'bye', courtId: id.split('-')[1] }, id).forEach(o => deliver(o.to, o.msg)); },
          close() { delete links[id]; } };
        links[id] = l;
        return l;
      },
      broadcastState() { deliver('all', { type: 'tournament', tournament: host.state }); }
    };
  }

  return { createTransport, createLocalHub, load, save, CHANNEL };
});

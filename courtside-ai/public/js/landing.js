/*
 * RallyPoint — homepage
 * A night-session hard court in WebGL behind the page, a ball that rallies on
 * real arcs, and a scoreboard the rally drives through the scoring engine.
 * No WebGL: a flat CSS court and the same ticking scoreboard.
 */
(function () {
  'use strict';
  const RP = window.RallyPoint || {};
  const mq = q => !!(window.matchMedia && window.matchMedia(q).matches);
  const reduced = mq('(prefers-reduced-motion: reduce)');
  const rally = RP.landingRally.createDemoMatch({ teams: [{ players: ['S. Gagnon'] }, { players: ['L. Nguyen'] }] });

  /* ------------------------------------------------------------------ */
  /* Scoreboard (DOM)                                                    */
  /* ------------------------------------------------------------------ */
  const boardEl = document.getElementById('board');
  const liveCall = document.getElementById('live-call');
  let flashTimer = 0;

  function paintBoard(snap) {
    if (!boardEl) return;
    const b = snap.board;
    b.teams.forEach((t, i) => {
      const row = boardEl.querySelector('.row[data-team="' + i + '"]');
      if (!row) return;
      row.querySelector('.nm span').textContent = t.label;
      row.querySelector('.s').textContent = t.sets;
      row.querySelector('.g').textContent = t.games;
      row.querySelector('.pts').textContent = t.points;
      row.classList.toggle('serving', t.serving);
    });
    boardEl.querySelector('#board-call').textContent = snap.call;
    boardEl.querySelector('#board-server').textContent = snap.server ? snap.server.name : '';
    boardEl.querySelector('#board-sets').textContent = snap.setLine ? 'Sets ' + snap.setLine : '';
    if (liveCall) liveCall.textContent = snap.call;
    if (snap.events && snap.events.length) {
      boardEl.classList.add('flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => boardEl.classList.remove('flash'), snap.events.includes('game') ? 900 : 500);
    }
  }
  paintBoard({ board: rally.board, call: rally.call, server: rally.server, setLine: rally.setLine, events: [] });

  /* ------------------------------------------------------------------ */
  /* Doors: tilt toward the pointer                                      */
  /* ------------------------------------------------------------------ */
  if (!reduced && mq('(hover: hover)')) {
    document.querySelectorAll('.lp-door').forEach(door => {
      door.addEventListener('pointermove', e => {
        const r = door.getBoundingClientRect();
        const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
        door.style.setProperty('--ty', ((nx - 0.5) * 12).toFixed(2) + 'deg');
        door.style.setProperty('--tx', ((0.5 - ny) * 10).toFixed(2) + 'deg');
        door.style.setProperty('--mx', (nx * 100).toFixed(1) + '%');
        door.style.setProperty('--my', (ny * 100).toFixed(1) + '%');
      });
      door.addEventListener('pointerleave', () => { door.style.setProperty('--tx', '0deg'); door.style.setProperty('--ty', '0deg'); });
    });
  }

  /* ------------------------------------------------------------------ */
  /* WebGL scene                                                         */
  /* ------------------------------------------------------------------ */
  const canvas = document.getElementById('court3d');
  let renderer = null;
  try {
    if (window.THREE && canvas) renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) { renderer = null; }

  if (!renderer) {
    document.body.classList.add('no-webgl');
    if (!reduced) setInterval(() => paintBoard(rally.point(Math.random() < 0.5 ? 0 : 1)), 2600);
    return;
  }

  const T = THREE;
  const BALL = 0xD6F53C, BG = 0x05070A;
  const G = 9.81;
  // court geometry in metres, z runs baseline to baseline, team 0 plays from +z
  const HALF_L = 11.885, HALF_W = 5.485, SINGLES = 4.115, SERVICE = 6.40;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.25 : 1.5));
  renderer.setClearColor(BG, 1);
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new T.Scene();
  scene.fog = new T.Fog(BG, 26, 72);
  const camera = new T.PerspectiveCamera(38, 1, 0.1, 220);

  // ground and court surfaces
  const ground = new T.Mesh(new T.PlaneGeometry(160, 160), new T.MeshStandardMaterial({ color: 0x06121A, roughness: 0.95, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; scene.add(ground);
  const surround = new T.Mesh(new T.PlaneGeometry(HALF_W * 2 + 8, HALF_L * 2 + 10), new T.MeshStandardMaterial({ color: 0x0C2A38, roughness: 0.92 }));
  surround.rotation.x = -Math.PI / 2; surround.position.y = -0.01; scene.add(surround);
  const court = new T.Mesh(new T.PlaneGeometry(HALF_W * 2, HALF_L * 2), new T.MeshStandardMaterial({ color: 0x14405A, roughness: 0.88 }));
  court.rotation.x = -Math.PI / 2; scene.add(court);

  // lines: unlit white so they read as painted under floodlights
  const lineMat = new T.MeshBasicMaterial({ color: 0xFFFFFF, toneMapped: false });
  function line(x1, z1, x2, z2, w) {
    w = w || 0.05;
    const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
    const m = new T.Mesh(new T.BoxGeometry(len + w, 0.012, w), lineMat);
    m.position.set((x1 + x2) / 2, 0.006, (z1 + z2) / 2);
    m.rotation.y = -Math.atan2(dz, dx);
    scene.add(m);
    return m;
  }
  line(-HALF_W, HALF_L, HALF_W, HALF_L, 0.1); line(-HALF_W, -HALF_L, HALF_W, -HALF_L, 0.1);
  line(-HALF_W, -HALF_L, -HALF_W, HALF_L); line(HALF_W, -HALF_L, HALF_W, HALF_L);
  line(-SINGLES, -HALF_L, -SINGLES, HALF_L); line(SINGLES, -HALF_L, SINGLES, HALF_L);
  line(-SINGLES, SERVICE, SINGLES, SERVICE); line(-SINGLES, -SERVICE, SINGLES, -SERVICE);
  line(0, -SERVICE, 0, SERVICE);
  line(0, HALF_L, 0, HALF_L - 0.3); line(0, -HALF_L, 0, -HALF_L + 0.3);

  // net
  const postMat = new T.MeshStandardMaterial({ color: 0x9AA4AA, roughness: 0.5, metalness: 0.6 });
  [-1, 1].forEach(s => { const p = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 1.07, 12), postMat); p.position.set(s * 6.4, 0.535, 0); scene.add(p); });
  const net = new T.Mesh(new T.PlaneGeometry(12.8, 0.95), new T.MeshBasicMaterial({ color: 0x1B2A33, transparent: true, opacity: 0.55, side: T.DoubleSide, depthWrite: false }));
  net.position.set(0, 0.5, 0); scene.add(net);
  const tape = new T.Mesh(new T.BoxGeometry(12.8, 0.06, 0.02), lineMat); tape.position.set(0, 0.97, 0); scene.add(tape);
  const strap = new T.Mesh(new T.BoxGeometry(0.05, 0.92, 0.025), lineMat); strap.position.set(0, 0.46, 0); scene.add(strap);

  // floodlights: four poles, each throwing a cone on its quarter of the court
  scene.add(new T.HemisphereLight(0x223546, 0x000000, 0.45));
  const lampMat = new T.MeshBasicMaterial({ color: 0xFFF4D6, toneMapped: false });
  const coneMat = new T.MeshBasicMaterial({ color: 0xFFF1C0, transparent: true, opacity: 0.028, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false });
  const lights = [];
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
    const head = new T.Vector3(sx * 12, 11.5, sz * 21);
    const target = new T.Vector3(sx * 2.4, 0, sz * 5.2);
    const pole = new T.Mesh(new T.CylinderGeometry(0.09, 0.14, 11.5, 10), postMat);
    pole.position.set(head.x, 5.75, head.z); scene.add(pole);
    const lamp = new T.Mesh(new T.BoxGeometry(1.4, 0.35, 0.7), lampMat);
    lamp.position.copy(head); lamp.lookAt(target); scene.add(lamp);
    const spot = new T.SpotLight(0xFFF3D2, 1500, 0, 0.6, 0.75, 2);
    spot.position.copy(head); spot.target.position.copy(target); scene.add(spot); scene.add(spot.target);
    lights.push(spot);
    const h = head.distanceTo(target) + 0.5;
    const geo = new T.ConeGeometry(Math.tan(0.6) * h * 0.78, h, 40, 1, true);
    geo.translate(0, -h / 2, 0);
    const cone = new T.Mesh(geo, coneMat);
    cone.position.copy(head);
    cone.quaternion.setFromUnitVectors(new T.Vector3(0, -1, 0), target.clone().sub(head).normalize());
    scene.add(cone);
  });

  // LED ribbons along the sidelines and behind the far baseline
  function ledTexture() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#05070A'; g.fillRect(0, 0, c.width, c.height);
    g.font = '700 84px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
    g.textBaseline = 'middle';
    const msg = 'RALLYPOINT   ·   SAY THE SCORE. THE COURT KEEPS IT.   ·   ';
    let x = 0;
    while (x < c.width) { g.fillStyle = '#D6F53C'; g.fillText(msg, x, 66); x += g.measureText(msg).width; }
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace; tex.wrapS = T.RepeatWrapping; tex.wrapT = T.ClampToEdgeWrapping;
    return tex;
  }
  const led = ledTexture();
  const ledMat = new T.MeshBasicMaterial({ map: led, toneMapped: false });
  function ribbon(w, x, z, ry) {
    const m = new T.Mesh(new T.PlaneGeometry(w, 0.8), ledMat.clone());
    m.material.map = led.clone(); m.material.map.repeat.set(w / 12, 1); m.material.map.needsUpdate = true;
    m.position.set(x, 0.42, z); m.rotation.y = ry; scene.add(m);
    return m;
  }
  const ribbons = [ribbon(28, -HALF_W - 4.4, 0, Math.PI / 2), ribbon(28, HALF_W + 4.4, 0, -Math.PI / 2), ribbon(20, 0, -HALF_L - 4.6, 0)];

  // ball, shadow, trail, contact rings
  const ball = new T.Mesh(new T.SphereGeometry(0.15, 28, 18), new T.MeshStandardMaterial({ color: BALL, emissive: 0x39440A, roughness: 0.55 }));
  scene.add(ball);
  const shadow = new T.Mesh(new T.CircleGeometry(0.17, 20), new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.014; scene.add(shadow);
  const TRAIL = 14, trail = [], history = [];
  for (let i = 0; i < TRAIL; i++) {
    const k = i / TRAIL;
    const m = new T.Mesh(new T.SphereGeometry(0.13 * (1 - k) + 0.02, 10, 8), new T.MeshBasicMaterial({ color: BALL, transparent: true, opacity: 0.45 * (1 - k) + 0.03, depthWrite: false }));
    m.visible = false; scene.add(m); trail.push(m);
  }
  function makeRing(color, flat) {
    const m = new T.Mesh(new T.RingGeometry(0.12, 0.2, 40), new T.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false }));
    if (flat) m.rotation.x = -Math.PI / 2;
    m.visible = false; m.userData.t = 1; m.userData.flat = flat; scene.add(m);
    return m;
  }
  const hitRing = makeRing(0xFFFFFF, false), bounceRing = makeRing(BALL, true);
  function fire(ring, pos) { ring.position.copy(pos); if (ring.userData.flat) ring.position.y = 0.02; ring.userData.t = 0; ring.visible = true; }
  function tickRing(ring, dt) {
    if (!ring.visible) return;
    ring.userData.t += dt / 0.38;
    const k = Math.min(1, ring.userData.t);
    ring.scale.setScalar(1 + k * 7);
    ring.material.opacity = 0.9 * (1 - k);
    if (!ring.userData.flat) ring.quaternion.copy(camera.quaternion);
    if (k >= 1) ring.visible = false;
  }

  /* ------------------------------------------------------------------ */
  /* Rally: segments of ballistic flight, bounces, strikes               */
  /* ------------------------------------------------------------------ */
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pos = new T.Vector3(1, 1.5, HALF_L + 0.8), prev = new T.Vector3();
  let seg = null;            // { p0, v, t0, strikeAt?, final?, kind?, stopAt? }
  let time = 0;
  let shotsLeft = 0, finishKind = 'winner';
  let phase = 'wait';        // wait | toss | play | dead
  let phaseUntil = 0.6;
  let pulse = 0;

  function segAt(t) {
    const tau = Math.max(0, t - seg.t0);
    return new T.Vector3(seg.p0.x + seg.v.x * tau, seg.p0.y + seg.v.y * tau - 0.5 * G * tau * tau, seg.p0.z + seg.v.z * tau);
  }
  function plan(from, land, dur, extra) {
    const v = new T.Vector3((land.x - from.x) / dur, (0.5 * G * dur * dur - from.y) / dur, (land.z - from.z) / dur);
    seg = Object.assign({ p0: from.clone(), v, t0: time, T: dur }, extra || {});
  }
  function serverSide() { return rally.server.team === 0 ? 1 : -1; }
  function teamOfSide(z) { return z > 0 ? 0 : 1; }

  function startPoint() {
    const s = serverSide();
    shotsLeft = Math.random() < 0.12 ? 1 : 2 + Math.floor(Math.random() * 6);
    const r = Math.random();
    finishKind = r < 0.5 ? 'winner' : r < 0.8 ? 'long' : 'net';
    if (shotsLeft === 1) finishKind = 'winner'; // an ace
    const x = s * rnd(0.6, 1.6) * (Math.random() < 0.5 ? 1 : -1);
    pos.set(x, 1.55, s * (HALF_L + 0.7));
    seg = { p0: pos.clone(), v: new T.Vector3(0, 5.2, 0), t0: time, T: 0.53, toss: true };
    phase = 'toss';
  }
  function strike() {
    // hit from the current position toward the other side
    const from = pos.clone();
    const dir = from.z > 0 ? -1 : 1;
    shotsLeft--;
    const last = shotsLeft === 0;
    const serve = seg && seg.toss;
    let land, dur, extra = { striker: teamOfSide(from.z) };
    if (serve) {
      land = new T.Vector3(dir * -1 * Math.sign(from.x || 1) * rnd(0.6, 3.4), 0, dir * rnd(5.4, 6.2));
      dur = 0.5;
    } else if (last && finishKind === 'long') {
      land = new T.Vector3(rnd(-3.5, 3.5), 0, dir * rnd(12.5, 14.2)); dur = rnd(1.0, 1.15);
    } else if (last && finishKind === 'net') {
      land = new T.Vector3(rnd(-3, 3), 0, dir * rnd(7, 10)); dur = 0.72; from.y = Math.min(from.y, 0.5);
    } else if (last) {
      land = new T.Vector3((Math.random() < 0.5 ? -1 : 1) * rnd(2.6, 4.0), 0, dir * rnd(7.5, 11.4)); dur = rnd(0.85, 1.0);
    } else {
      land = new T.Vector3(rnd(-3.6, 3.6), 0, dir * rnd(6.8, 11.2)); dur = rnd(1.0, 1.3);
    }
    if (last) extra.final = finishKind;
    plan(from, land, dur, extra);
    fire(hitRing, from);
    phase = 'play';
  }
  function endPoint(winner) {
    paintBoard(rally.point(winner));
    if (rally.state.points[0] === 0 && rally.state.points[1] === 0) pulse = 1;
    phase = 'dead';
    phaseUntil = time + 1.7;
  }
  function bounce() {
    const vy = seg.v.y - G * (time - seg.t0);
    fire(bounceRing, pos);
    if (seg.final) {
      const winner = seg.final === 'winner' ? seg.striker : 1 - seg.striker;
      if (seg.stage !== 'over') endPoint(winner);
      seg = { p0: pos.clone(), v: new T.Vector3(seg.v.x * 0.75, -vy * 0.55, seg.v.z * 0.75), t0: time, final: seg.final, striker: seg.striker, stage: 'over' };
      if (Math.abs(vy) < 1.2) seg.v.set(seg.v.x * 0.5, 0, seg.v.z * 0.5), seg.roll = true;
    } else {
      seg = { p0: pos.clone(), v: new T.Vector3(seg.v.x * 0.86, -vy * 0.72, seg.v.z * 0.86), t0: time, strikeAt: rnd(0.38, 0.5) };
    }
  }
  function netCheck() {
    if (!seg || seg.stage === 'over' || seg.stopped || seg.toss) return;
    if (Math.sign(prev.z) !== Math.sign(pos.z) && Math.abs(pos.x) < 6.4 && pos.y < 0.93) {
      // into the net: drop where it is
      fire(hitRing, pos);
      const striker = seg.striker;
      seg = { p0: new T.Vector3(pos.x, pos.y, Math.sign(prev.z) * 0.12), v: new T.Vector3(0, 0, 0), t0: time, final: 'net', striker, stage: 'over' };
      endPoint(1 - striker);
    }
  }

  function stepBall(dt) {
    time += dt;
    if (phase === 'wait') { if (time >= phaseUntil) startPoint(); return; }
    if (phase === 'dead' && time >= phaseUntil) { phase = 'wait'; phaseUntil = time + 0.4; }
    if (!seg) return;
    prev.copy(pos);
    const p = segAt(time);
    if (seg.roll) {
      const k = Math.exp(-2.2 * (time - seg.t0));
      p.set(seg.p0.x + seg.v.x * (1 - k) / 2.2, 0, seg.p0.z + seg.v.z * (1 - k) / 2.2);
    }
    pos.copy(p);
    if (seg.toss) { if (time - seg.t0 >= seg.T) strike(); return; }
    if (pos.y <= 0 && !seg.roll) { pos.y = 0; bounce(); return; }
    if (seg.strikeAt != null && time - seg.t0 >= seg.strikeAt) { strike(); return; }
    netCheck();
  }

  /* ------------------------------------------------------------------ */
  /* Camera, input, loop                                                 */
  /* ------------------------------------------------------------------ */
  const hero = document.querySelector('.lp-hero');
  let scrollP = 0, mx = 0, my = 0, smx = 0, smy = 0;
  function readScroll() { const h = (hero && hero.offsetHeight) || window.innerHeight; scrollP = Math.max(0, Math.min(1, window.scrollY / h)); }
  window.addEventListener('scroll', readScroll, { passive: true });
  window.addEventListener('pointermove', e => { mx = (e.clientX / window.innerWidth) * 2 - 1; my = (e.clientY / window.innerHeight) * 2 - 1; }, { passive: true });

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect >= 1.25 ? 38 : Math.min(70, 38 + (1.25 - camera.aspect) * 40);
    camera.updateProjectionMatrix();
    readScroll();
  }
  window.addEventListener('resize', resize);
  resize();

  const eye = new T.Vector3(), look = new T.Vector3(0, 0.6, 0.5);
  function placeCamera(t) {
    smx += (mx - smx) * 0.05; smy += (my - smy) * 0.05;
    const drift = reduced ? 0 : Math.sin(t * 0.09) * 0.11;
    const narrow = camera.aspect < 1;
    const wide = camera.aspect >= 1.25;
    const dist = (narrow ? 36 : 34) - scrollP * 9;
    const height = (narrow ? 12 : 13) - scrollP * 8.5;
    // wide screens: the court sits right of the headline; phones: in the window under the copy
    const lx = wide ? -4.5 : 0, ly = narrow ? 12.5 : look.y;
    eye.set(Math.sin(drift) * dist + smx * 2.2, height - smy * 0.9, Math.cos(drift) * dist);
    camera.position.copy(eye);
    camera.lookAt(lx, ly - scrollP * 0.3, look.z);
  }

  const clock = new T.Clock();
  let frame = 0;
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    if (!reduced) stepBall(dt);
    ball.position.copy(pos).y += 0.15;
    ball.rotation.x += dt * 6; ball.rotation.z += dt * 2.5;
    shadow.position.set(pos.x, 0.014, pos.z);
    const sh = 1 / (1 + pos.y * 0.45);
    shadow.scale.setScalar(sh); shadow.material.opacity = 0.55 * sh;
    // trail
    if (frame++ % 2 === 0) { history.unshift(ball.position.clone()); if (history.length > TRAIL * 2) history.pop(); }
    const moving = phase === 'play' || phase === 'toss';
    trail.forEach((m, i) => { const h = history[i * 2 + 1]; m.visible = moving && !!h; if (h) m.position.copy(h); });
    tickRing(hitRing, dt); tickRing(bounceRing, dt);
    // lights breathe on a game
    pulse = Math.max(0, pulse - dt * 0.9);
    const glow = 1 + Math.sin(Math.min(1, pulse) * Math.PI) * 0.7;
    lights.forEach(l => { l.intensity = 1500 * glow; });
    ribbons.forEach((r, i) => { r.material.map.offset.x = (t * 0.035 * (i === 2 ? 1 : -1)) % 1; });
    placeCamera(t);
    renderer.render(scene, camera);
  }

  if (reduced) { placeCamera(0); renderer.render(scene, camera); window.addEventListener('resize', () => { placeCamera(0); renderer.render(scene, camera); }); return; }
  renderer.setAnimationLoop(tick);
  document.addEventListener('visibilitychange', () => { renderer.setAnimationLoop(document.hidden ? null : tick); if (!document.hidden) clock.getDelta(); });
})();

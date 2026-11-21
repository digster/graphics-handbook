/*
 * tearing-simulator.js: chapter 3.1's interactive.
 *
 * A slow-motion model of a game and a display running on two clocks.
 *
 *   The display  refreshes 60 times a second. Each refresh it reads its
 *                picture out of the front buffer row by row, top to bottom
 *                (scan-out), then pauses for a short vertical blank. Rows keep
 *                showing what was read until the next refresh reaches them.
 *   The game     finishes a frame every 1000 / fps milliseconds. A moving bar
 *                is drawn where it is at the moment the frame starts, so its
 *                position records when the game sampled the world.
 *
 * Three ways to hand frames over (the "present"):
 *
 *   Vsync off    swap the instant a frame is done. A swap during scan-out
 *                splits the picture: rows above show the old frame, rows below
 *                the new one (a tear).
 *   Vsync on     swap only at the vertical blank, through a swap chain of two
 *                or three buffers. With two, the GPU waits for the swap before
 *                it can draw again; with three, it draws ahead and finished
 *                frames queue (first in, first out).
 *   VRR          the display waits for each frame and starts a refresh when it
 *                arrives, inside its range (simulated: 30 to 60 Hz). Below the
 *                range it shows each frame twice, evenly spaced (low framerate
 *                compensation). Above it, vsync takes over at 60 Hz.
 *
 * Everything is a pure function of the settings and simulated time, so the
 * demo is deterministic. Real time drives it only through playback speed.
 * Animation runs only while the figure is on screen; with reduced motion the
 * demo never animates and offers step buttons instead.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("tearing-simulator");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Model constants (milliseconds of simulated time) ---------- */

  var P = 1000 / 60;            // one refresh of the simulated 60 Hz display
  var ACTIVE = P * 0.92;        // scan-out part of a refresh; the rest is the vertical blank (widened for visibility)
  var VRR_MAX_GAP = 1000 / 30;  // VRR floor: the panel must refresh at least every 33.3 ms
  var PHASE = 5;                // the GPU starts 5 ms after the first refresh: the two clocks are out of step
  var SPEED = 1.0;              // the bar moves 1 screen unit per ms of game time
  var EPS = 1e-6;
  var START_T = 8 * P + 0.8 * ACTIVE; // opening moment: scan line 80% down, a tear visible above it

  /* ---------- Simulation ---------- */

  /*
   * Builds the schedule of frames, swaps and refreshes for one setting.
   * cfg: { mode: "off" | "vsync" | "vrr", fps, buffers: 2 | 3 }
   * Returns an object whose arrays grow with extend(until):
   *   frames  [{ id, start, done, swap, pos }] in id order; swap is when the
   *           frame became the front buffer (swap times only increase)
   *   scans   refresh start times, increasing
   */
  function createSim(cfg) {
    var T = 1000 / cfg.fps;
    // VRR above the panel's 60 Hz ceiling behaves exactly like vsync.
    var syncLike = cfg.mode === "vsync" || (cfg.mode === "vrr" && T < P - EPS);
    var sim = {
      cfg: cfg,
      T: T,
      kind: cfg.mode === "off" ? "off" : syncLike ? "sync" : "vrr",
      buffers: cfg.mode === "off" || !syncLike ? 2 : cfg.buffers,
      frames: [{ id: 0, start: -T, done: 0, swap: -1e9, pos: SPEED * -T }],
      scans: [],
      horizon: 0
    };

    // State for the event-driven vsync model.
    var nextVblank = 1;
    var queue = [];
    var rendering = null;
    var nextId = 1;

    function newFrame(start) {
      var f = { id: nextId++, start: start, done: start + T, swap: null, pos: SPEED * start };
      sim.frames.push(f);
      return f;
    }

    if (sim.kind === "sync") {
      sim.scans.push(0);
      rendering = newFrame(PHASE);
    }

    /* The GPU may start a frame only when a buffer is free: one buffer is
       the front, one per finished frame waiting, one for the new frame. */
    function tryStart(t) {
      if (!rendering && 2 + queue.length <= sim.buffers) rendering = newFrame(t);
    }

    function extendSync(until) {
      for (;;) {
        var tDone = rendering ? rendering.done : Infinity;
        var tV = nextVblank * P;
        if (Math.min(tDone, tV) > until) break;
        if (tDone <= tV + EPS) {
          // A frame finishing exactly at the blank still makes that swap.
          queue.push(rendering);
          rendering = null;
          tryStart(tDone);
        } else {
          if (queue.length) queue.shift().swap = tV;
          sim.scans.push(tV);
          nextVblank++;
          tryStart(tV);
        }
      }
    }

    function extendOff(until) {
      while (sim.frames[sim.frames.length - 1].start <= until) {
        var f = newFrame(PHASE + (nextId - 1) * T);
        f.swap = f.done;
      }
      var n = sim.scans.length ? Math.round(sim.scans[sim.scans.length - 1] / P) + 1 : 0;
      while (n * P <= until) sim.scans.push(n++ * P);
    }

    /* VRR: each frame is shown when it arrives. If the next one is further
       away than the panel can hold a picture, the frame is shown n times,
       evenly spaced (the driver can predict this from recent frame times;
       here the rate is constant, so the prediction is exact). */
    function extendVrr(until) {
      while (sim.frames[sim.frames.length - 1].start <= until + T) {
        var f = newFrame(PHASE + (nextId - 1) * T);
        f.swap = f.done;
      }
      var frames = sim.frames;
      var from = sim.scans.length ? sim.scans[sim.scans.length - 1] + EPS : -Infinity;
      for (var i = 0; i < frames.length - 1; i++) {
        var a = Math.max(frames[i].swap, 0);
        var gap = frames[i + 1].swap - a;
        if (a > until) break;
        if (frames[i + 1].swap < from) continue;
        var n = Math.max(1, Math.ceil(gap / VRR_MAX_GAP - EPS));
        for (var j = 0; j < n; j++) {
          var s = a + (j * gap) / n;
          if (s >= from && s <= until) sim.scans.push(s);
        }
      }
    }

    sim.extend = function (until) {
      if (until <= sim.horizon) return;
      if (sim.kind === "sync") extendSync(until);
      else if (sim.kind === "off") extendOff(until);
      else extendVrr(until);
      sim.horizon = until;
    };

    /* Drop history older than `before`, keeping one swapped frame and one
       scan before it so lookups at that time still work. */
    sim.prune = function (before) {
      var fr = sim.frames;
      var keepFrom = 0;
      for (var i = 0; i < fr.length; i++) {
        if (fr[i].swap !== null && fr[i].swap < before) keepFrom = i;
        else break;
      }
      if (keepFrom > 0) sim.frames = fr.slice(keepFrom);
      var sc = sim.scans;
      var s0 = 0;
      while (s0 + 1 < sc.length && sc[s0 + 1] < before) s0++;
      if (s0 > 0) sim.scans = sc.slice(s0);
    };

    return sim;
  }

  /* Frame in the front buffer at time t (swaps at exactly t count). */
  function frontAt(sim, t) {
    var fr = sim.frames;
    var lo = 0;
    var hi = fr.length - 1;
    var best = fr[0];
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var sw = fr[mid].swap;
      if (sw !== null && sw <= t + EPS) {
        best = fr[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /* Index of the last scan starting at or before t, or -1. */
  function scanIndexAt(sim, t) {
    var sc = sim.scans;
    var lo = 0;
    var hi = sc.length - 1;
    var best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (sc[mid] <= t + EPS) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /* Swaps that land strictly inside a scan's active part: tears. */
  function tearsIn(sim, s) {
    var out = [];
    sim.frames.forEach(function (f) {
      if (f.swap !== null && f.swap > s + EPS && f.swap < s + ACTIVE - EPS) out.push(f);
    });
    return out;
  }

  /* Steady-state statistics for the readout, from a fresh run. */
  function measure(cfg) {
    var sim = createSim(cfg);
    var W0 = 300;
    var W1 = 1300;
    sim.extend(W1 + 100);
    var scans = sim.scans.filter(function (s) { return s >= W0 && s < W1; });
    var seen = {};
    var tears = 0;
    var ids = [];
    scans.forEach(function (s) {
      var f = frontAt(sim, s);
      seen[f.id] = true;
      ids.push({ s: s, id: f.id });
      var t = tearsIn(sim, s);
      tears += t.length;
      t.forEach(function (x) { seen[x.id] = true; });
    });
    // New frames: swapped in during the window and actually read by a refresh.
    var shown = sim.frames.filter(function (f) {
      return f.swap !== null && f.swap >= W0 && f.swap < W1 && seen[f.id];
    }).length;
    // How long each frame stays up: runs of refreshes starting on the same frame.
    var holds = [];
    for (var i = 1; i < ids.length; i++) {
      if (ids[i].id !== ids[i - 1].id) {
        var j = i - 1;
        while (j > 0 && ids[j - 1].id === ids[i - 1].id) j--;
        if (j > 0) holds.push(ids[i].s - ids[j].s);
      }
    }
    var distinct = [];
    holds.forEach(function (v) {
      if (!distinct.some(function (d) { return Math.abs(d - v) < 0.5; })) distinct.push(v);
    });
    distinct.sort(function (a, b) { return a - b; });
    var waits = sim.frames.filter(function (f) { return f.swap !== null && f.swap >= W0 && f.swap < W1; })
      .map(function (f) { return f.swap - f.done; });
    var wait = waits.length ? Math.max(0, waits.reduce(function (a, b) { return a + b; }, 0) / waits.length) : 0;
    return {
      kind: sim.kind,
      T: sim.T,
      shown: shown * (1000 / (W1 - W0)),
      tears: tears * (1000 / (W1 - W0)),
      holds: distinct,
      wait: wait
    };
  }

  /* ---------- Drawing geometry (viewBox units) ---------- */

  var VIEW = { w: 820, h: 430 };
  var SCR = { x: 36, y: 46, w: 400, h: 225 };  // the screen, 16:9
  var ROWS = 75;                                  // 3 units per row
  var ROW_H = SCR.h / ROWS;
  var BAR_W = 26;
  var WRAP = SCR.w + BAR_W;
  var TL = { x0: 112, x1: 800, before: 5.5 * P, after: 1.5 * P, dispY: 318, gpuY: 366, rowH: 26 };
  var TL_SCALE = (TL.x1 - TL.x0) / (TL.before + TL.after);
  var SLOT = { x: 476, y: 64, w: 324, h: 38, gap: 10 };

  function barLeft(frame) {
    var p = frame.pos % WRAP;
    if (p < 0) p += WRAP;
    return p - BAR_W;
  }

  function fmtMs(v) {
    return v.toFixed(1) + " ms";
  }

  /* ---------- Init ---------- */

  function init(root) {
    var reduced = HB.demos.reducedMotion();
    var state = {
      mode: "off",
      fps: 45,
      buffers: 3,
      slow: 20,
      t: START_T,
      playing: !reduced,
      visible: false
    };
    var sim = null;
    var raf = 0;
    var lastTs = 0;

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Tearing simulator" }),
      h("span", { class: "demo-hint", text: "A 60 Hz display and a game, slowed down so you can watch each refresh." })
    ]));

    /* Controls */
    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Present mode", [
      { value: "off", label: "Vsync off" },
      { value: "vsync", label: "Vsync on" },
      { value: "vrr", label: "VRR" }
    ], state.mode, function (v) { state.mode = v; rebuild(); }));
    controls.appendChild(HB.slider("ts-fps", "Game frame rate", {
      min: 20, max: 90, step: 1, value: state.fps,
      format: function (v) { return v + " fps"; }
    }, function (v) { state.fps = v; rebuild(); }));
    var bufferControl = HB.segmented("Swap chain", [
      { value: 2, label: "Double" },
      { value: 3, label: "Triple" }
    ], state.buffers, function (v) { state.buffers = v; rebuild(); });
    controls.appendChild(bufferControl);

    var playBtn = null;
    var playback = h("div", { class: "control" }, [h("span", { class: "label", text: reduced ? "Step through time" : "Playback" })]);
    var playRow = h("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap" });
    if (!reduced) {
      playBtn = h("button", { type: "button", class: "btn", "aria-pressed": "false", text: "Pause" });
      playBtn.addEventListener("click", function () {
        state.playing = !state.playing;
        syncPlay();
        schedule();
      });
      playRow.appendChild(playBtn);
    }
    var stepBtn = h("button", { type: "button", class: "btn", text: "Step ¼ refresh" });
    stepBtn.addEventListener("click", function () { step(P / 4); });
    var refreshBtn = h("button", { type: "button", class: "btn", text: "Step 1 refresh" });
    refreshBtn.addEventListener("click", function () { step(P); });
    playRow.appendChild(stepBtn);
    playRow.appendChild(refreshBtn);
    playback.appendChild(playRow);
    controls.appendChild(playback);
    if (!reduced) {
      controls.appendChild(HB.segmented("Slow motion", [
        { value: 40, label: "1/40" },
        { value: 20, label: "1/20" },
        { value: 8, label: "1/8" }
      ], state.slow, function (v) { state.slow = v; }));
    }
    root.appendChild(controls);

    /* Stage */
    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "img",
      "aria-label": "A simulated screen showing a moving bar, the swap chain's buffers, and a timeline of display refreshes against GPU frames. The readout below summarises tearing, stutter and waiting for the current settings."
    });
    stage.appendChild(svg);
    root.appendChild(stage);

    var defs = svgEl("defs", null, svg);
    var clip = svgEl("clipPath", { id: "ts-clip" }, defs);
    svgEl("rect", { x: SCR.x, y: SCR.y, width: SCR.w, height: SCR.h }, clip);
    var tlClip = svgEl("clipPath", { id: "ts-tl-clip" }, defs);
    svgEl("rect", { x: TL.x0, y: 296, width: TL.x1 - TL.x0, height: 120 }, tlClip);

    var verdict = h("p", { class: "demo-hint", "aria-live": "polite" });
    var readout = h("div", { class: "demo-readout" });
    root.appendChild(readout);
    root.appendChild(verdict);

    /* Static frame: monitor, labels, timeline rows. */
    (function drawStatic() {
      var g = svgEl("g", null, svg);
      svgEl("text", { x: SCR.x - 16, y: 22, class: "t-caps", text: "WHAT THE PLAYER SEES" }, g);
      svgEl("rect", { x: SCR.x - 10, y: SCR.y - 10, width: SCR.w + 20, height: SCR.h + 20, rx: 8, class: "f-solid s-strong" }, g);
      svgEl("rect", { x: SCR.x, y: SCR.y, width: SCR.w, height: SCR.h * 0.72, class: "f-sunken" }, g);
      svgEl("rect", { x: SCR.x, y: SCR.y + SCR.h * 0.72, width: SCR.w, height: SCR.h * 0.28, class: "f-geo-soft" }, g);

      svgEl("text", { x: 20, y: 300, class: "t-caps", text: "TIMELINE" }, g);
      svgEl("text", { x: 20, y: TL.dispY + 12, class: "t-small t-strong", text: "Display" }, g);
      svgEl("text", { x: 20, y: TL.dispY + 25, class: "t-small t-muted", text: "refreshes" }, g);
      svgEl("text", { x: 20, y: TL.gpuY + 12, class: "t-small t-strong", text: "GPU" }, g);
      svgEl("text", { x: 20, y: TL.gpuY + 25, class: "t-small t-muted", text: "frames" }, g);
      svgEl("line", { x1: TL.x0, y1: TL.dispY + TL.rowH + 11, x2: TL.x1, y2: TL.dispY + TL.rowH + 11, class: "s-line" }, g);
      var sb = P * TL_SCALE;
      svgEl("path", { d: "M" + (TL.x1 - sb) + ",418 h" + sb + " M" + (TL.x1 - sb) + ",414 v8 M" + TL.x1 + ",414 v8", class: "s-muted" }, g);
      svgEl("text", { x: TL.x1 - sb - 6, y: 422, class: "t-small t-muted end", text: "one refresh, 16.7 ms" }, g);
    })();

    var layerScreen = svgEl("g", { "clip-path": "url(#ts-clip)" }, svg);
    var layerScreenFx = svgEl("g", null, svg);
    var layerSlots = svgEl("g", null, svg);
    var layerTimeline = svgEl("g", { "clip-path": "url(#ts-tl-clip)" }, svg);
    var layerNow = svgEl("g", null, svg);

    /* ---------- Screen ---------- */

    function drawScreen() {
      HB.svg.clear(layerScreen);
      HB.svg.clear(layerScreenFx);
      var t = state.t;
      var cur = scanIndexAt(sim, t);
      // Each row shows the frame that was in the front buffer when the
      // latest refresh read that row.
      var bands = [];
      for (var r = 0; r < ROWS; r++) {
        var frac = (r + 0.5) / ROWS;
        var i = scanIndexAt(sim, t - frac * ACTIVE);
        var f = i < 0 ? sim.frames[0] : frontAt(sim, sim.scans[i] + frac * ACTIVE);
        var last = bands[bands.length - 1];
        if (last && last.scan === i && last.frame === f) last.r1 = r + 1;
        else bands.push({ scan: i, frame: f, r0: r, r1: r + 1 });
      }
      var staleTop = null;
      bands.forEach(function (b, k) {
        var y0 = SCR.y + b.r0 * ROW_H;
        var y1 = SCR.y + b.r1 * ROW_H;
        var x = SCR.x + barLeft(b.frame);
        svgEl("rect", { x: x, y: y0, width: BAR_W, height: y1 - y0, class: "f-acc" }, layerScreen);
        if (y1 - y0 >= 13) {
          var right = x + BAR_W + 5 < SCR.x + SCR.w - 30;
          svgEl("text", {
            x: right ? x + BAR_W + 5 : x - 5, y: (y0 + y1) / 2 + 4,
            class: "t-mono t-small " + (right ? "" : "end"), text: "f" + b.frame.id
          }, layerScreen);
        }
        if (b.scan < cur && staleTop === null) staleTop = y0;
        var prev = bands[k - 1];
        if (prev && prev.scan === b.scan && prev.frame !== b.frame) {
          svgEl("line", { x1: SCR.x, y1: y0, x2: SCR.x + SCR.w, y2: y0, class: "s-pix w2" }, layerScreenFx);
          svgEl("text", { x: SCR.x + SCR.w - 6, y: y0 - 5, class: "t-small t-pix t-strong end", text: "tear" }, layerScreenFx);
        }
      });
      // Rows not yet reached by this refresh still show the previous one: veil them.
      if (staleTop !== null) {
        svgEl("rect", { x: SCR.x, y: staleTop, width: SCR.w, height: SCR.y + SCR.h - staleTop, class: "f-surface", "fill-opacity": 0.55 }, layerScreen);
      }
      var into = t - sim.scans[cur];
      if (cur >= 0 && into < ACTIVE) {
        var y = SCR.y + (into / ACTIVE) * SCR.h;
        svgEl("line", { x1: SCR.x - 10, y1: y, x2: SCR.x + SCR.w + 10, y2: y, class: "s-acc w2" }, layerScreenFx);
        svgEl("text", { x: SCR.x + 6, y: y - 5, class: "t-small t-acc t-strong", text: "scan-out" }, layerScreenFx);
      } else {
        svgEl("text", { x: SCR.x + SCR.w / 2, y: SCR.y + SCR.h + 27, class: "t-small t-acc t-strong mid", text: "vertical blank: between refreshes" }, layerScreenFx);
      }
    }

    /* ---------- Swap chain slots ---------- */

    function drawSlots() {
      HB.svg.clear(layerSlots);
      var t = state.t;
      var front = frontAt(sim, t);
      var ready = [];
      var drawing = null;
      sim.frames.forEach(function (f) {
        if (f.start <= t && t < f.done) drawing = f;
        else if (f.done <= t && f.swap !== null && f.swap > t + EPS) ready.push(f);
        else if (f.done <= t && f.swap === null) ready.push(f);
      });
      var n = sim.buffers;
      var slots = [{ kind: "front", f: front }];
      ready.forEach(function (f) { slots.push({ kind: "ready", f: f }); });
      if (drawing) slots.push({ kind: "drawing", f: drawing });
      while (slots.length < n) slots.push({ kind: "free" });
      slots = slots.slice(0, Math.max(n, slots.length));

      svgEl("text", { x: SLOT.x, y: 22, class: "t-caps", text: "SWAP CHAIN · " + n + " BUFFERS" }, layerSlots);
      slots.forEach(function (s, i) {
        var y = SLOT.y + i * (SLOT.h + SLOT.gap);
        var cls = s.kind === "front" ? "f-surface s-acc w2" : s.kind === "ready" ? "f-lit-soft s-lit" : "f-surface s-strong";
        svgEl("rect", { x: SLOT.x, y: y, width: SLOT.w, height: SLOT.h, rx: 5, class: cls }, layerSlots);
        if (s.kind === "drawing") {
          var p = Math.max(0, Math.min(1, (t - s.f.start) / (s.f.done - s.f.start)));
          svgEl("rect", { x: SLOT.x + 1, y: y + 1, width: (SLOT.w - 2) * p, height: SLOT.h - 2, rx: 4, class: "f-acc-soft" }, layerSlots);
        }
        var title = s.kind === "front" ? "Front buffer" : s.kind === "free" ? "Back buffer" : "Back buffer";
        var what = s.kind === "front" ? "f" + s.f.id + " · being read by the display"
          : s.kind === "ready" ? "f" + s.f.id + " · finished, waiting to be shown"
          : s.kind === "drawing" ? "f" + s.f.id + " · GPU drawing, " + Math.round(100 * Math.max(0, Math.min(1, (t - s.f.start) / (s.f.done - s.f.start)))) + "%"
          : "free";
        svgEl("text", { x: SLOT.x + 12, y: y + 16, class: "t-small t-strong" + (s.kind === "front" ? " t-acc" : ""), text: title }, layerSlots);
        svgEl("text", { x: SLOT.x + 12, y: y + 31, class: "t-small t-mono", text: what }, layerSlots);
      });
      var yStatus = SLOT.y + Math.max(n, slots.length) * (SLOT.h + SLOT.gap) + 8;
      var idle = !drawing;
      svgEl("text", {
        x: SLOT.x, y: yStatus,
        class: "t-small " + (idle ? "t-pix t-strong" : "t-muted"),
        text: idle ? "GPU idle: no free buffer to draw into" : "GPU busy: no time lost"
      }, layerSlots);
    }

    /* ---------- Timeline ---------- */

    function tx(time) {
      return TL.x0 + (time - (state.t - TL.before)) * TL_SCALE;
    }

    function drawTimeline() {
      HB.svg.clear(layerTimeline);
      HB.svg.clear(layerNow);
      var t0 = state.t - TL.before - P;
      var t1 = state.t + TL.after + P;
      var dy = TL.dispY;
      var gy = TL.gpuY;
      var sc = sim.scans;
      for (var i = 0; i < sc.length; i++) {
        var s = sc[i];
        if (s + ACTIVE < t0 || s > t1) continue;
        var f = frontAt(sim, s);
        var prevEnd = i > 0 ? frontAt(sim, sc[i - 1] + ACTIVE) : null;
        var torn = tearsIn(sim, s);
        var repeat = !torn.length && prevEnd && prevEnd === f && i > 0 && !tearsIn(sim, sc[i - 1]).length;
        // Under VRR a repeat is deliberate and evenly spaced, so it is not marked as a problem.
        var flag = repeat && sim.kind !== "vrr";
        svgEl("rect", {
          x: tx(s), y: dy, width: ACTIVE * TL_SCALE, height: TL.rowH, rx: 3,
          class: flag ? "f-pix-soft s-pix" : "f-acc-soft s-acc"
        }, layerTimeline);
        var label = "f" + f.id;
        torn.forEach(function (x) { label += " | f" + x.id; });
        if (repeat) label += " again";
        svgEl("text", { x: tx(s) + 6, y: dy + 17, class: "t-small t-mono" + (flag ? " t-pix" : ""), text: label }, layerTimeline);
        torn.forEach(function (x) {
          svgEl("line", { x1: tx(x.swap), y1: dy - 3, x2: tx(x.swap), y2: dy + TL.rowH + 3, class: "s-pix w2" }, layerTimeline);
        });
      }
      sim.frames.forEach(function (f) {
        if (f.id === 0 || f.done < t0 || f.start > t1) return;
        svgEl("rect", { x: tx(f.start), y: gy, width: (f.done - f.start) * TL_SCALE, height: TL.rowH, rx: 3, class: "f-solid s-strong" }, layerTimeline);
        svgEl("text", { x: tx(f.start) + 6, y: gy + 17, class: "t-small t-mono", text: "f" + f.id }, layerTimeline);
        var shownAt = f.swap === null ? Math.min(state.t, t1) : f.swap;
        if (shownAt - f.done > 0.8) {
          svgEl("line", { x1: tx(f.done), y1: gy + TL.rowH / 2, x2: tx(shownAt), y2: gy + TL.rowH / 2, class: "s-lit w2 dash" }, layerTimeline);
        }
        if (f.swap !== null) {
          svgEl("path", { d: "M" + tx(f.swap) + "," + (gy - 2) + " V" + (dy + TL.rowH + 2), class: "s-muted dot-dash" }, layerTimeline);
          svgEl("path", { d: "M" + (tx(f.swap) - 4) + "," + (dy + TL.rowH + 8) + " l4,-6 l4,6 Z", class: "f-muted" }, layerTimeline);
        }
      });
      var nx = tx(state.t);
      svgEl("line", { x1: nx, y1: 302, x2: nx, y2: gy + TL.rowH + 6, class: "s-ink w15" }, layerNow);
      svgEl("text", { x: nx, y: 298, class: "t-small t-strong mid", text: "now" }, layerNow);
    }

    /* ---------- Readout ---------- */

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function describe(m) {
      var fps = state.fps;
      var T = m.T;
      var uneven = m.holds.length > 1;
      var hold = m.holds[0] || T;
      if (m.kind === "off") {
        if (m.tears > 0.5) {
          return "Tearing. The GPU swaps the moment a frame is done, so the display switches frames partway down the screen. Nothing waits, so latency is as low as it gets." +
            (Math.abs(T - P) < 0.01 ? " At exactly 60 fps the tear sits in the same place every refresh." : "");
        }
        return "No tears at this moment, but only by luck: every swap happens to land in the vertical blank.";
      }
      if (m.kind === "vrr") {
        if (T > VRR_MAX_GAP + EPS) {
          return "Below this display's 30 Hz floor, it shows each frame " + Math.ceil(T / VRR_MAX_GAP - EPS) + " times, evenly spaced (low framerate compensation). Motion stays even, with fewer new frames.";
        }
        return "Smooth. The display waits for each frame and refreshes the moment it arrives, so every frame stays up for the same " + fmtMs(T) + ", with no tears.";
      }
      var prefix = state.mode === "vrr" ? "Above this display's 60 Hz ceiling VRR cannot refresh faster, so vsync takes over. " : "";
      if (uneven) {
        return prefix + "Stutter. Frames arrive every " + fmtMs(T) + ", but the screen can only change every 16.7 ms, so some frames stay up for one refresh and some for two. Motion jerks even though the game runs at " + fps + " fps.";
      }
      if (Math.abs(hold - P) < 0.5) {
        return prefix + "Smooth at 60, with no tears. The GPU waits for the vertical blank before each swap" + (fps > 60 ? ", so frames beyond 60 per second are never drawn." : ".");
      }
      var locked = Math.round(1000 / hold);
      return prefix + "Locked to " + locked + " fps. With two buffers the GPU has nowhere to draw while a finished frame waits for the blank, so a frame that misses one refresh waits for the next.";
    }

    function drawReadout() {
      var m = measure({ mode: state.mode, fps: state.fps, buffers: state.buffers });
      var holdText;
      if (m.kind === "off" && m.tears > 0.5) holdText = "split by tears";
      else if (m.holds.length > 1) holdText = m.holds.map(function (v) { return v.toFixed(1); }).join(" or ") + " ms";
      else holdText = fmtMs(m.holds[0] || m.T);
      readout.replaceChildren(
        cell("Game draws", state.fps + " fps · " + fmtMs(m.T)),
        cell("New frames shown", Math.round(m.shown) + " per second"),
        cell("Tear lines", m.tears > 0.5 ? Math.round(m.tears) + " per second" : "none"),
        cell("Each frame stays up", holdText),
        cell("Wait before showing", m.wait.toFixed(1) + " ms on average")
      );
      verdict.textContent = describe(m);
    }

    /* ---------- Loop ---------- */

    function draw() {
      sim.extend(state.t + TL.after + 3 * P);
      drawScreen();
      drawSlots();
      drawTimeline();
    }

    function rebuild() {
      bufferControl.hidden = state.mode === "off";
      sim = createSim({ mode: state.mode, fps: state.fps, buffers: state.buffers });
      sim.extend(state.t + TL.after + 3 * P);
      sim.prune(state.t - TL.before - 4 * P);
      drawReadout();
      draw();
    }

    function step(ms) {
      state.t += ms;
      sim.prune(state.t - TL.before - 4 * P);
      draw();
    }

    function syncPlay() {
      if (!playBtn) return;
      playBtn.textContent = state.playing ? "Pause" : "Play";
      playBtn.setAttribute("aria-pressed", state.playing ? "false" : "true");
    }

    function frame(ts) {
      raf = 0;
      if (!state.playing || !state.visible) return;
      if (lastTs) {
        var dt = Math.min(100, ts - lastTs); // a long gap (tab switch) does not jump ahead
        step(dt / state.slow);
      }
      lastTs = ts;
      raf = window.requestAnimationFrame(frame);
    }

    /* Run the animation only while playing and on screen. */
    function schedule() {
      if (state.playing && state.visible && !raf) {
        lastTs = 0;
        raf = window.requestAnimationFrame(frame);
      } else if ((!state.playing || !state.visible) && raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    if (!reduced && "IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        state.visible = entries[entries.length - 1].isIntersecting;
        schedule();
      }).observe(root);
      document.addEventListener("visibilitychange", function () {
        state.visible = state.visible && !document.hidden;
        if (!document.hidden) {
          var r = root.getBoundingClientRect();
          state.visible = r.bottom > 0 && r.top < window.innerHeight;
        }
        schedule();
      });
    } else {
      state.playing = false;
    }

    syncPlay();
    rebuild();
    log.debug("ready", reduced ? "(reduced motion: stepping only)" : "");
  }

  HB.demos.register("tearing-simulator", init);
})();

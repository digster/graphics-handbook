/*
 * taa-time-machine.js: chapter 9.2's interactive.
 *
 * A 20 x 10 pixel grid with a dark shape on a light background. Every frame
 * the camera moves by a sub-pixel offset from the Halton (2, 3) sequence,
 * each pixel takes one sample at its jittered position, and that sample is
 * blended into a history value, as temporal anti-aliasing does:
 *
 *   history = w * sample + (1 - w) * reprojected history,
 *   w = max(1 / frame, minimum weight)
 *
 * so the first frames are a plain running average and later frames an
 * exponential one. The reader scrubs frames 1 to 16.
 *
 * Still: nothing moves, so each pixel's history is the average of up to 16
 * well-spread samples and the edge, and the thin mast, converge towards
 * their true coverage.
 *
 * Moving: a parallelogram slides right by half a pixel a frame over a light
 * wall and a grey floor. Motion vectors come from what each pixel's sample
 * hit: the object's velocity on the object, zero on the static background.
 * Pixels the object has just uncovered (disocclusion) therefore read their
 * own history, which still holds the object: a ghost trail. Neighbourhood
 * clamping limits the reprojected history to the range of this frame's 3 x 3
 * neighbourhood, which removes the trail except right beside the object.
 *
 * A probe pixel (click, tap, or focus it and use the arrow keys) shows its
 * samples so far and how this frame's blend was made.
 *
 * The grid is a picture of a rendered image, so like the book's other
 * buffer pictures it uses the buffer colours (f-buf-hi, f-buf-lo), which stay
 * the same in both themes: the shape is dark and the wall light in either.
 *
 * The simulation core is exposed as HB.taaTimeMachine for checks.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("taa-time-machine");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Constants ---------- */

  var GW = 20;
  var GH = 10;
  var CELL = 30;
  var OX = 8;
  var OY = 8;
  var FRAMES = 16;
  var SPEED = 0.5;          // pixels per frame, moving scene
  var FLOOR_Y = 9;          // floor starts here in the moving scene
  var FLOOR_V = 0.3;        // floor darkness
  var MOVE_X0 = 1.5;        // moving object's offset at frame 1

  // Still scene: a quadrilateral with a shallow top edge, and a thin mast.
  var STILL = [[1.4, 10.5], [3.2, 2.4], [18.6, 5.8], [17.2, 10.5]];
  var MAST = band([14.1, 0.5], [14.9, 5.6], 0.32);
  // Moving scene: a parallelogram, offset each frame.
  var MOVER = [[0, 9], [4.2, 9], [5.4, 1.8], [1.2, 1.8]];

  /* ---------- Maths ---------- */

  function halton(i, b) {
    var f = 1;
    var r = 0;
    while (i > 0) {
      f /= b;
      r += f * (i % b);
      i = Math.floor(i / b);
    }
    return r;
  }

  function jitter(k) {
    return [halton(k, 2) - 0.5, halton(k, 3) - 0.5];
  }

  function inside(poly, x, y) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  function band(a, b, w) {
    var dx = b[0] - a[0];
    var dy = b[1] - a[1];
    var len = Math.hypot(dx, dy);
    var nx = (-dy / len) * (w / 2);
    var ny = (dx / len) * (w / 2);
    return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
  }

  function moverAt(k) {
    var off = MOVE_X0 + (k - 1) * SPEED;
    return MOVER.map(function (p) { return [p[0] + off, p[1]]; });
  }

  /* The scene: darkness at a point, and whether it is on the moving object. */
  function scene(mode, k) {
    if (mode === "still") {
      return function (x, y) { return { v: inside(STILL, x, y) || inside(MAST, x, y) ? 1 : 0, onObj: false }; };
    }
    var poly = moverAt(k);
    return function (x, y) {
      if (inside(poly, x, y)) return { v: 1, onObj: true };
      return { v: y > FLOOR_Y ? FLOOR_V : 0, onObj: false };
    };
  }

  function grid(fill) {
    var g = [];
    for (var y = 0; y < GH; y++) {
      var row = [];
      for (var x = 0; x < GW; x++) row.push(fill(x, y));
      g.push(row);
    }
    return g;
  }

  /* Bilinear read of a grid at a position in pixels (centres at +0.5). */
  function sample(g, u, v) {
    var x = u - 0.5;
    var y = v - 0.5;
    var x0 = Math.floor(x);
    var y0 = Math.floor(y);
    var fx = x - x0;
    var fy = y - y0;
    function at(i, j) {
      return g[Math.max(0, Math.min(GH - 1, j))][Math.max(0, Math.min(GW - 1, i))];
    }
    return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
      at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
  }

  /* True coverage of each pixel at frame k: an 8 x 8 grid of samples. */
  function truth(mode, k) {
    var f = scene(mode, k);
    return grid(function (x, y) {
      var s = 0;
      for (var j = 0; j < 8; j++) for (var i = 0; i < 8; i++) s += f(x + (i + 0.5) / 8, y + (j + 0.5) / 8).v;
      return s / 64;
    });
  }

  /*
   * Runs frames 1..frames. Returns the history after the last frame, that
   * frame's raw samples, and for the probe pixel its samples so far and the
   * parts of the last blend.
   */
  function simulate(opts) {
    var mode = opts.mode;
    var frames = opts.frames;
    var clamp = opts.clamp;
    var wMin = opts.minWeight;
    var probe = opts.probe || [0, 0];
    var hist = null;
    var raw = null;
    var probeSamples = [];
    var last = null;
    for (var k = 1; k <= frames; k++) {
      var j = jitter(k);
      var f = scene(mode, k);
      var hits = grid(function (x, y) { return f(x + 0.5 + j[0], y + 0.5 + j[1]); });
      raw = hits.map(function (row) { return row.map(function (s) { return s.v; }); });
      probeSamples.push({ k: k, dx: j[0], dy: j[1], v: raw[probe[1]][probe[0]] });
      if (!hist) {
        hist = raw.map(function (row) { return row.slice(); });
        last = { k: k, sample: raw[probe[1]][probe[0]], w: 1, history: null, lo: null, hi: null, clamped: null, result: hist[probe[1]][probe[0]] };
        continue;
      }
      var w = Math.max(1 / k, wMin);
      var prev = hist;
      var next = grid(function () { return 0; });
      for (var y = 0; y < GH; y++) {
        for (var x = 0; x < GW; x++) {
          // Motion vector: what this pixel's sample hit. Background is static.
          var mv = hits[y][x].onObj ? SPEED : 0;
          var hr = sample(prev, x + 0.5 - mv, y + 0.5);
          var lo = Infinity;
          var hi = -Infinity;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              var nv = raw[Math.max(0, Math.min(GH - 1, y + dy))][Math.max(0, Math.min(GW - 1, x + dx))];
              if (nv < lo) lo = nv;
              if (nv > hi) hi = nv;
            }
          }
          var hc = clamp ? Math.min(hi, Math.max(lo, hr)) : hr;
          next[y][x] = w * raw[y][x] + (1 - w) * hc;
          if (x === probe[0] && y === probe[1]) {
            last = { k: k, sample: raw[y][x], w: w, history: hr, lo: lo, hi: hi, clamped: hc, result: next[y][x], mv: mv };
          }
        }
      }
      hist = next;
    }
    return { history: hist, raw: raw, probeSamples: probeSamples, last: last };
  }

  /* Error on partly covered pixels (still) or ghost pixels (moving). */
  function measure(mode, frames, shown, raw) {
    var t = truth(mode, frames);
    var sum = 0;
    var sumRaw = 0;
    var n = 0;
    var ghosts = 0;
    var worst = 0;
    for (var y = 0; y < GH; y++) {
      for (var x = 0; x < GW; x++) {
        var tv = t[y][x];
        if (tv > 0.02 && tv < 0.98 && tv !== FLOOR_V) {
          sum += Math.abs(shown[y][x] - tv);
          sumRaw += Math.abs(raw[y][x] - tv);
          n++;
        }
        var excess = shown[y][x] - tv;
        if (mode === "moving" && tv <= FLOOR_V + 0.001 && excess > 0.1) {
          ghosts++;
          if (excess > worst) worst = excess;
        }
      }
    }
    return { truth: t, edgeError: n ? sum / n : 0, rawError: n ? sumRaw / n : 0, ghosts: ghosts, worst: worst };
  }

  HB.taaTimeMachine = { simulate: simulate, measure: measure, truth: truth, jitter: jitter, GW: GW, GH: GH };

  /* ---------- The interactive ---------- */

  var instance = 0;

  function init(root) {
    instance++;
    var uid = "ttm" + instance;
    var reduced = HB.demos.reducedMotion();
    var state = {
      mode: "still",
      frame: 8,
      clamp: false,
      samples: true,
      show: "blend",
      minWeight: 0.1,
      probe: [10, 4],
      playing: false,
      visible: true
    };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "TAA time machine" }),
      h("span", { class: "demo-hint", text: "Scrub the frames. Then switch the object to Moving and turn on the neighbourhood clamp. Click a pixel, or focus the ringed pixel and use the arrow keys, to inspect it." })
    ]));

    /* ---------- Controls ---------- */

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Object", [
      { value: "still", label: "Still" },
      { value: "moving", label: "Moving" }
    ], state.mode, function (v) {
      state.mode = v;
      state.probe = defaultProbe(v);
      stopPlay();
      draw();
    }));
    var frameCtl = HB.slider(uid + "-frame", "Frame", {
      min: 1, max: FRAMES, step: 1, value: state.frame,
      format: function (v) { return v + " of " + FRAMES; }
    }, function (v) { stopPlay(); state.frame = v; draw(); });
    controls.appendChild(frameCtl);
    var frameInput = frameCtl.querySelector("input");
    var frameOut = frameCtl.querySelector("output");

    var restartBtn = h("button", { type: "button", class: "btn", text: "Frame 1" });
    var playBtn = reduced ? null : h("button", { type: "button", class: "btn is-primary", "aria-pressed": "false", text: "Play" });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Playback" }),
      h("div", { style: "display:flex;gap:.4rem;flex-wrap:wrap" }, [restartBtn, playBtn])
    ]));

    var clampBox = h("input", { type: "checkbox", id: uid + "-clamp" });
    var sampleBox = h("input", { type: "checkbox", id: uid + "-samples", checked: state.samples });
    clampBox.addEventListener("change", function () { state.clamp = clampBox.checked; draw(); });
    sampleBox.addEventListener("change", function () { state.samples = sampleBox.checked; draw(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Options" }),
      h("div", { class: "checks" }, [
        h("label", { for: uid + "-clamp" }, [clampBox, "Neighbourhood clamp"]),
        h("label", { for: uid + "-samples" }, [sampleBox, "This frame's samples"])
      ])
    ]));
    controls.appendChild(HB.segmented("Pixels show", [
      { value: "blend", label: "Blended history" },
      { value: "raw", label: "This frame alone" }
    ], state.show, function (v) { state.show = v; draw(); }));
    controls.appendChild(HB.slider(uid + "-weight", "Minimum weight of the new frame", {
      min: 0.05, max: 0.5, step: 0.01, value: state.minWeight,
      format: function (v) { return v.toFixed(2); }
    }, function (v) { state.minWeight = v; draw(); }));
    root.appendChild(controls);

    /* ---------- Main grid ---------- */

    var stage = h("div", { class: "demo-stage" });
    var VW = OX * 2 + GW * CELL;
    var VH = OY * 2 + GH * CELL;
    // Plain "dg" (no minimum width): the grid shrinks to fit a phone.
    var svg = svgEl("svg", {
      class: "dg",
      viewBox: "0 0 " + VW + " " + VH,
      role: "group",
      "aria-label": "A 20 by 10 pixel grid of a dark shape on a light background. Each pixel's darkness is its blended history; the true outline of the shape is drawn on top, with this frame's sample point in every pixel."
    });
    stage.appendChild(svg);
    root.appendChild(stage);

    svgEl("rect", { x: OX, y: OY, width: GW * CELL, height: GH * CELL, class: "f-buf-hi" }, svg);
    var cells = [];
    var layerCells = svgEl("g", null, svg);
    for (var cy = 0; cy < GH; cy++) {
      for (var cx = 0; cx < GW; cx++) {
        cells.push(svgEl("rect", { x: OX + cx * CELL, y: OY + cy * CELL, width: CELL, height: CELL, class: "f-buf-lo", "fill-opacity": 0 }, layerCells));
      }
    }
    var d = "";
    for (var gx = 0; gx <= GW; gx++) d += "M" + (OX + gx * CELL) + "," + OY + "V" + (OY + GH * CELL);
    for (var gy = 0; gy <= GH; gy++) d += "M" + OX + "," + (OY + gy * CELL) + "H" + (OX + GW * CELL);
    svgEl("path", { d: d, class: "s-line" }, svg);
    svgEl("rect", { x: OX, y: OY, width: GW * CELL, height: GH * CELL, class: "s-strong" }, svg);
    var outlineLayer = svgEl("g", null, svg);
    var dotLayer = svgEl("g", null, svg);
    var probeG = svgEl("g", { tabindex: 0, role: "button", class: "handle" }, svg);
    svgEl("rect", { width: CELL, height: CELL, class: "s-pix w3 hit-ring", rx: 2 }, probeG);
    svgEl("rect", { width: CELL, height: CELL, class: "f-none", "pointer-events": "all" }, probeG);

    /* ---------- Close-up of the probe pixel ---------- */

    var zoomStage = h("div", { class: "demo-stage" });
    var ZW = 600;
    var ZH = 196;
    var zsvg = svgEl("svg", {
      class: "dg",
      viewBox: "0 0 " + ZW + " " + ZH,
      role: "img",
      "aria-label": "The inspected pixel enlarged with its samples so far, and how this frame's blend was made."
    });
    zoomStage.appendChild(zsvg);
    root.appendChild(zoomStage);
    var zdefs = svgEl("defs", null, zsvg);
    var zclip = svgEl("clipPath", { id: uid + "-clip" }, zdefs);
    var ZS = 150;
    var ZX = 8;
    var ZY = 30;
    svgEl("rect", { x: ZX, y: ZY, width: ZS, height: ZS }, zclip);
    var mk = svgEl("marker", { id: uid + "-arr", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, zdefs);
    svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: "f-acc" }, mk);
    var zoomLayer = svgEl("g", null, zsvg);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    /* ---------- Probe interaction ---------- */

    function setProbe(px, py) {
      state.probe = [Math.max(0, Math.min(GW - 1, px)), Math.max(0, Math.min(GH - 1, py))];
      draw();
    }
    layerCells.addEventListener("pointerdown", function (event) {
      var pt = HB.svg.toLocal(svg, event.clientX, event.clientY);
      setProbe(Math.floor((pt.x - OX) / CELL), Math.floor((pt.y - OY) / CELL));
    });
    probeG.addEventListener("keydown", function (event) {
      var m = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!m) return;
      event.preventDefault();
      setProbe(state.probe[0] + m[0], state.probe[1] + m[1]);
    });

    function defaultProbe(mode) {
      // Still: a pixel on the shallow edge, 44% covered. Moving: the wall a
      // pixel behind the object at the current frame, where the ghost is.
      if (mode === "still") return [8, 3];
      return [Math.max(0, Math.floor(MOVE_X0 + (state.frame - 1) * SPEED) - 1), 5];
    }

    /* ---------- Playback ---------- */

    var timer = 0;
    function syncPlay() {
      if (!playBtn) return;
      playBtn.textContent = state.playing ? "Pause" : "Play";
      playBtn.setAttribute("aria-pressed", state.playing ? "true" : "false");
    }
    function setFrame(k) {
      state.frame = k;
      frameInput.value = String(k);
      frameOut.textContent = k + " of " + FRAMES;
    }
    function tick() {
      timer = 0;
      if (!state.playing || !state.visible) return;
      if (state.frame < FRAMES) {
        setFrame(state.frame + 1);
        draw();
      }
      if (state.frame >= FRAMES) { state.playing = false; syncPlay(); return; }
      timer = window.setTimeout(tick, 380);
    }
    function schedule() {
      if (state.playing && state.visible && !timer) timer = window.setTimeout(tick, 380);
      else if ((!state.playing || !state.visible) && timer) { window.clearTimeout(timer); timer = 0; }
    }
    function stopPlay() {
      if (!state.playing) return;
      state.playing = false;
      syncPlay();
      schedule();
    }
    restartBtn.addEventListener("click", function () { stopPlay(); setFrame(1); draw(); });
    if (playBtn) {
      playBtn.addEventListener("click", function () {
        if (state.playing) { stopPlay(); return; }
        if (state.frame >= FRAMES) setFrame(1);
        state.playing = true;
        syncPlay();
        draw();
        schedule();
      });
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          state.visible = entries[entries.length - 1].isIntersecting;
          schedule();
        }).observe(root);
      }
      document.addEventListener("visibilitychange", function () {
        state.visible = !document.hidden;
        schedule();
      });
    }

    /* ---------- Drawing ---------- */

    function pts(poly, x0, y0, s) {
      return poly.map(function (p) { return (x0 + p[0] * s).toFixed(1) + "," + (y0 + p[1] * s).toFixed(1); }).join(" ");
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function fmt(v) {
      return (v < 0 ? "−" : "+") + Math.abs(v).toFixed(3);
    }

    function draw() {
      var sim = simulate({ mode: state.mode, frames: state.frame, clamp: state.clamp, minWeight: state.minWeight, probe: state.probe });
      var shown = state.show === "blend" ? sim.history : sim.raw;
      var m = measure(state.mode, state.frame, shown, sim.raw);

      for (var y = 0; y < GH; y++) {
        for (var x = 0; x < GW; x++) {
          var v = Math.max(0, Math.min(1, shown[y][x]));
          cells[y * GW + x].setAttribute("fill-opacity", (v * 0.9).toFixed(3));
        }
      }

      // True outlines at this frame.
      HB.svg.clear(outlineLayer);
      if (state.mode === "still") {
        svgEl("polygon", { points: pts(STILL, OX, OY, CELL), class: "s-acc w15" }, outlineLayer);
        svgEl("polygon", { points: pts(MAST, OX, OY, CELL), class: "s-acc", "stroke-width": 1 }, outlineLayer);
      } else {
        svgEl("polygon", { points: pts(moverAt(state.frame), OX, OY, CELL), class: "s-acc w15" }, outlineLayer);
        svgEl("line", { x1: OX, y1: OY + FLOOR_Y * CELL, x2: OX + GW * CELL, y2: OY + FLOOR_Y * CELL, class: "s-muted dash" }, outlineLayer);
      }

      // This frame's sample points.
      HB.svg.clear(dotLayer);
      if (state.samples) {
        var j = jitter(state.frame);
        for (var sy = 0; sy < GH; sy++) {
          for (var sx = 0; sx < GW; sx++) {
            var hit = sim.raw[sy][sx] > 0.5;
            svgEl("circle", {
              cx: (OX + (sx + 0.5 + j[0]) * CELL).toFixed(1),
              cy: (OY + (sy + 0.5 + j[1]) * CELL).toFixed(1),
              r: 2.4,
              class: hit ? "f-acc" : "f-surface s-acc"
            }, dotLayer);
          }
        }
      }

      probeG.setAttribute("transform", "translate(" + (OX + state.probe[0] * CELL) + "," + (OY + state.probe[1] * CELL) + ")");
      probeG.setAttribute("aria-label", "Inspected pixel " + state.probe[0] + ", " + state.probe[1] + ". Use the arrow keys to move it.");

      drawZoom(sim, m);

      var jit = jitter(state.frame);
      var pv = shown[state.probe[1]][state.probe[0]];
      var tv = m.truth[state.probe[1]][state.probe[0]];
      var cellsOut = [
        cell("Frame", state.frame + " of " + FRAMES),
        cell("Jitter this frame", fmt(jit[0]) + ", " + fmt(jit[1]) + " px"),
        cell("New frame's weight", sim.last.w.toFixed(2))
      ];
      if (state.mode === "still") {
        cellsOut.push(cell("Edge error, " + (state.show === "blend" ? "blended" : "this frame"), (state.show === "blend" ? m.edgeError : m.rawError).toFixed(2) + (state.show === "blend" ? " (one frame alone: " + m.rawError.toFixed(2) + ")" : "")));
      } else {
        cellsOut.push(cell("Ghost pixels", m.ghosts + (m.ghosts ? " (strongest +" + m.worst.toFixed(2) + ")" : "")));
      }
      cellsOut.push(cell("Inspected pixel", pv.toFixed(2) + " · true " + tv.toFixed(2)));
      readout.replaceChildren.apply(readout, cellsOut);
    }

    function drawZoom(sim, m) {
      HB.svg.clear(zoomLayer);
      var g = zoomLayer;
      var px = state.probe[0];
      var py = state.probe[1];
      svgEl("text", { x: ZX, y: 18, class: "t-caps", text: "PIXEL " + px + ", " + py + ", ENLARGED" }, g);
      svgEl("rect", { x: ZX, y: ZY, width: ZS, height: ZS, class: "f-surface" }, g);
      // The scene inside this pixel at the current frame, clipped to it.
      var clipped = svgEl("g", { "clip-path": "url(#" + uid + "-clip)" }, g);
      function local(poly) {
        return poly.map(function (p) { return [(p[0] - px) * ZS + ZX, (p[1] - py) * ZS + ZY]; });
      }
      function draw2(poly, cls) {
        svgEl("polygon", { points: local(poly).map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "), class: cls }, clipped);
      }
      if (state.mode === "still") {
        draw2(STILL, "f-geo-soft s-geo w15");
        draw2(MAST, "f-geo-soft s-geo w15");
      } else {
        var fy = (FLOOR_Y - py) * ZS + ZY;
        if (fy < ZY + ZS) svgEl("rect", { x: ZX, y: Math.max(ZY, fy), width: ZS, height: ZY + ZS - Math.max(ZY, fy), class: "f-sunken" }, clipped);
        draw2(moverAt(state.frame), "f-geo-soft s-geo w15");
      }
      svgEl("rect", { x: ZX, y: ZY, width: ZS, height: ZS, class: "s-strong w15" }, g);
      sim.probeSamples.forEach(function (s) {
        var cx = ZX + (0.5 + s.dx) * ZS;
        var cy = ZY + (0.5 + s.dy) * ZS;
        var hit = s.v > 0.5;
        svgEl("circle", { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 7.5, class: hit ? "f-acc" : "f-surface s-acc w15" }, g);
        svgEl("text", { x: cx.toFixed(1), y: (cy + 3.5).toFixed(1), class: "mid " + (hit ? "t-on-acc" : "t-acc"), "font-size": 9.5, text: s.k }, g);
        if (s.k === state.frame) svgEl("circle", { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 11, class: "s-pix w2" }, g);
      });

      // The blend for this frame, on a darkness scale.
      var L = m;
      var X0 = 220;
      var W = 340;
      var A = 70;
      function X(v) { return X0 + Math.max(0, Math.min(1, v)) * W; }
      var last = sim.last;
      svgEl("text", { x: X0, y: 18, class: "t-caps", text: "THIS FRAME'S BLEND, ON A DARKNESS SCALE" }, g);
      svgEl("line", { x1: X0, y1: A, x2: X0 + W, y2: A, class: "s-ink" }, g);
      svgEl("text", { x: X0 - 8, y: A + 4, class: "t-mono t-small t-muted end", text: "0" }, g);
      svgEl("text", { x: X0 + W + 8, y: A + 4, class: "t-mono t-small t-muted", text: "1" }, g);
      if (last.history === null) {
        svgEl("text", { x: X0, y: A - 26, class: "t-small t-muted", text: "Frame 1 has no history yet: the pixel is just its first sample." }, g);
      } else {
        var lo = last.lo;
        var hi = last.hi;
        svgEl("rect", {
          x: (X(lo) - 3).toFixed(1), y: A - 10, width: (X(hi) - X(lo) + 6).toFixed(1), height: 20, rx: 3,
          class: state.clamp ? "f-acc-soft s-acc" : "s-muted dash"
        }, g);
        svgEl("text", {
          x: X(lo).toFixed(1), y: A - 16,
          class: "t-small " + (state.clamp ? "t-acc" : "t-muted"),
          text: "3 × 3 range " + lo.toFixed(2) + " to " + hi.toFixed(2) + (state.clamp ? ", clamping" : ", clamp off")
        }, g);
        svgEl("circle", { cx: X(last.history).toFixed(1), cy: A + 34, r: 5.5, class: "f-pix" }, g);
        var histLabelRight = last.history < 0.6;
        svgEl("text", {
          x: (X(last.history) + (histLabelRight ? 10 : -10)).toFixed(1), y: A + 38,
          class: "t-small t-pix" + (histLabelRight ? "" : " end"),
          text: "history " + last.history.toFixed(2) + (last.mv ? " (moved with the object)" : "")
        }, g);
        if (state.clamp && Math.abs(last.clamped - last.history) > 0.005) {
          svgEl("line", {
            x1: X(last.history).toFixed(1), y1: A + 34, x2: (X(last.clamped) + (last.clamped < last.history ? 8 : -8)).toFixed(1), y2: A + 34,
            class: "s-acc w15", "marker-end": "url(#" + uid + "-arr)"
          }, g);
          svgEl("circle", { cx: X(last.clamped).toFixed(1), cy: A + 34, r: 4.5, class: "f-acc" }, g);
        }
        svgEl("rect", { x: (X(last.sample) - 1.5).toFixed(1), y: A - 7, width: 3, height: 14, class: "f-ink" }, g);
      }
      svgEl("circle", { cx: X(last.result).toFixed(1), cy: A + 66, r: 7, class: "f-ink" }, g);
      var resLabelRight = last.result < 0.6;
      svgEl("text", {
        x: (X(last.result) + (resLabelRight ? 12 : -12)).toFixed(1), y: A + 70,
        class: "t-small t-strong" + (resLabelRight ? "" : " end"),
        text: "result " + last.result.toFixed(2)
      }, g);
      var hpart = last.history === null ? "" : " + " + (1 - last.w).toFixed(2) + " × " + (state.clamp ? "clamped " : "") + "history " + last.clamped.toFixed(2);
      svgEl("text", { x: X0, y: A + 98, class: "t-small t-muted", text: "result = " + last.w.toFixed(2) + " × new sample " + last.sample.toFixed(2) + hpart }, g);
      svgEl("text", { x: X0, y: A + 114, class: "t-small t-muted", text: "Black bar: this frame's sample. True coverage: " + L.truth[py][px].toFixed(2) + "." }, g);
    }

    state.probe = defaultProbe(state.mode);
    draw();
    log.debug("ready");
  }

  HB.demos.register("taa-time-machine", init);
})();

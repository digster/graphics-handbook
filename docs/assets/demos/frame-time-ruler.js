/*
 * frame-time-ruler.js: chapter 0.2's interactive.
 *
 * Top: a ruler in milliseconds. The shaded region is the frame budget,
 * 1000 / target fps. Two lanes of work blocks, CPU and GPU, start at zero
 * because the two processors work side by side on different frames. The
 * reader drags the budget's edge, or picks a preset frame rate, and watches
 * the work fit or overflow.
 *
 * Bottom: a frame-time graph of 60 frames in a row. The model is a display
 * that refreshes at the target rate with v-sync on:
 *
 *   work(i)       = max(CPU work, GPU work) for frame i, with a little
 *                   deterministic jitter, plus an optional one-off stall
 *   refreshes(i)  = ceil(work(i) / budget), at least 1
 *   on screen(i)  = refreshes(i) x budget
 *
 * A frame that misses its refresh stays on screen for two or more
 * refreshes, which is exactly what a hitch looks like on a graph. The
 * chapter notes that this model is simplified (no variable refresh rate,
 * no extra queued frames).
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("frame-time-ruler");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Model ---------- */

  var PRESETS = [30, 60, 90, 120, 144, 240];
  var MIN_FPS = 30;
  var MAX_FPS = 240;
  var FRAMES = 60;
  var STALL_FRAME = 40;
  var STALL_MS = 40;

  /* Work per frame, in milliseconds. Block classes follow the book's
     colour meaning: geometry teal, light amber, screen-space rose. */
  var SCENES = {
    typical: {
      cpu: [["Game logic", 3.0], ["Physics", 2.0], ["Animation", 2.4], ["Rendering", 3.0]],
      gpu: [["Shadows", 2.2, "f-lit-soft"], ["Geometry", 3.0, "f-geo-soft"], ["Lighting", 2.6, "f-lit-soft"], ["Post + UI", 2.4, "f-pix-soft"]]
    },
    heavy: {
      cpu: [["Game logic", 4.6], ["Physics", 3.6], ["Animation", 4.2], ["Rendering", 5.0]],
      gpu: [["Shadows", 3.4, "f-lit-soft"], ["Geometry", 4.8, "f-geo-soft"], ["Lighting", 4.4, "f-lit-soft"], ["Post + UI", 3.6, "f-pix-soft"]]
    }
  };

  function sum(blocks) {
    return blocks.reduce(function (a, b) { return a + b[1]; }, 0);
  }

  /* Per-frame jitter: small noise on every frame, and an occasional bump,
     the same every time the page loads. */
  var JITTER = (function () {
    var rand = HB.rng(2026);
    var out = [];
    for (var i = 0; i < FRAMES; i++) {
      var cpu = 1 + 0.035 * (2 * rand() - 1);
      var gpu = 1 + 0.035 * (2 * rand() - 1);
      if (rand() < 0.15) cpu += 0.075 * rand();
      if (rand() < 0.1) gpu += 0.06 * rand();
      out.push({ cpu: cpu, gpu: gpu });
    }
    return out;
  })();

  function simulate(state) {
    var scene = SCENES[state.scene];
    var budget = 1000 / state.fps;
    var cpu = sum(scene.cpu);
    var gpu = sum(scene.gpu);
    var frames = [];
    for (var i = 0; i < FRAMES; i++) {
      var c = cpu * JITTER[i].cpu + (state.stall && i === STALL_FRAME ? STALL_MS : 0);
      var g = gpu * JITTER[i].gpu;
      var work = Math.max(c, g);
      var refreshes = Math.max(1, Math.ceil(work / budget - 1e-9));
      frames.push({ work: work, refreshes: refreshes, shown: refreshes * budget, stall: state.stall && i === STALL_FRAME });
    }
    return { budget: budget, cpu: cpu, gpu: gpu, frames: frames };
  }

  /* ---------- Layout (viewBox units) ---------- */

  var W = 900;
  var X0 = 110;
  var X1 = 870;
  var MS_MAX = 35;
  var K = (X1 - X0) / MS_MAX;
  var LANE = { cpu: 76, gpu: 120, h: 30 };
  var RULER_Y = 168;
  var G = { top: 236, bottom: 396, msMax: 70 };
  var H = 430;

  function x(ms) {
    return X0 + ms * K;
  }

  function gy(ms) {
    return G.bottom - (Math.min(ms, G.msMax) / G.msMax) * (G.bottom - G.top);
  }

  function fmt1(n) {
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  /* ---------- Demo ---------- */

  function init(root) {
    var state = { fps: 60, scene: "typical", stall: true };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Frame-time ruler" }),
      h("span", { class: "demo-hint", text: "Pick a frame rate, or drag the edge of the budget. The handle also takes the arrow keys." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    var rateControl = HB.segmented("Target frame rate", PRESETS.map(function (p) {
      return { value: p, label: p + " fps" };
    }), state.fps, function (v) { setFps(v); });
    controls.appendChild(rateControl);
    var rateButtons = Array.prototype.slice.call(rateControl.querySelectorAll("button"));
    controls.appendChild(HB.segmented("Scene", [
      { value: "typical", label: "Typical" }, { value: "heavy", label: "Heavy battle" }
    ], state.scene, function (v) { state.scene = v; render(); }));
    var stallBox = h("input", { type: "checkbox", id: "ftr-stall", checked: state.stall });
    stallBox.addEventListener("change", function () { state.stall = stallBox.checked; render(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "One-off stall" }),
      h("div", { class: "checks" }, [h("label", { for: "ftr-stall" }, [stallBox, "Frame 40 waits 40 ms for a shader to compile"])])
    ]));
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + W + " " + H,
      role: "group",
      "aria-label": "Top: a millisecond ruler with the frame budget shaded and CPU and GPU work drawn as blocks. Bottom: a frame-time graph of 60 frames, where frames that miss the budget stand out as tall bars."
    });
    stage.appendChild(svg);
    root.appendChild(stage);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    var verdict = h("p", { class: "demo-hint" });
    root.append(readout, verdict);

    var defs = svgEl("defs", null, svg);
    var pat = svgEl("pattern", { id: "ftr-over", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "s-pix", "stroke-width": 2 }, pat);

    var layerStatic = svgEl("g", null, svg);
    var layerBudget = svgEl("g", null, svg);
    var layerWork = svgEl("g", null, svg);
    var layerGraph = svgEl("g", null, svg);
    var handle = svgEl("g", { "aria-label": "Frame budget", "aria-valuemin": MIN_FPS, "aria-valuemax": MAX_FPS }, svg);
    svgEl("rect", { x: -14, y: -11, width: 28, height: 22, rx: 6, class: "f-surface s-acc w2 handle-ring" }, handle);
    svgEl("path", { d: "M-5,-5 L-9,0 L-5,5 M5,-5 L9,0 L5,5", class: "s-acc w15 round" }, handle);

    /* ---------- Static parts: labels, ruler, graph frame ---------- */

    (function drawStatic() {
      svgEl("text", { x: 20, y: 20, class: "t-caps", text: "ONE FRAME · THE BUDGET AND THE WORK" }, layerStatic);
      svgEl("text", { x: 20, y: LANE.cpu + 19, class: "t-strong", text: "CPU" }, layerStatic);
      svgEl("text", { x: 20, y: LANE.gpu + 19, class: "t-strong", text: "GPU" }, layerStatic);
      svgEl("line", { x1: X0, y1: RULER_Y, x2: X1, y2: RULER_Y, class: "s-strong" }, layerStatic);
      for (var ms = 0; ms <= MS_MAX; ms++) {
        var major = ms % 5 === 0;
        svgEl("line", { x1: x(ms), y1: RULER_Y, x2: x(ms), y2: RULER_Y + (major ? 8 : 4), class: major ? "s-strong" : "s-line" }, layerStatic);
        if (major) svgEl("text", { x: x(ms), y: RULER_Y + 21, class: "t-mono t-small t-muted mid", text: String(ms) }, layerStatic);
      }
      svgEl("text", { x: X0 - 10, y: RULER_Y + 21, class: "t-mono t-small t-muted end", text: "ms" }, layerStatic);

      svgEl("text", { x: 20, y: G.top - 14, class: "t-caps", text: "FRAME TIME, 60 FRAMES IN A ROW" }, layerStatic);
      [0, 20, 40, 60].forEach(function (v) {
        svgEl("line", { x1: X0, y1: gy(v), x2: X1, y2: gy(v), class: v === 0 ? "s-strong" : "s-line" }, layerStatic);
        svgEl("text", { x: X0 - 10, y: gy(v) + 4, class: "t-mono t-small t-muted end", text: v + " ms" }, layerStatic);
      });
      svgEl("text", { x: X0, y: G.bottom + 20, class: "t-small t-muted", text: "frame 1" }, layerStatic);
      svgEl("text", { x: X1, y: G.bottom + 20, class: "t-small t-muted end", text: "frame 60" }, layerStatic);
    })();

    /* ---------- Dragging the budget edge ---------- */

    HB.draggable(svg, handle, {
      onDrag: function (pt) {
        var ms = (pt.x - X0) / K;
        var fps = Math.round(1000 / Math.max(ms, 1000 / MAX_FPS));
        setFps(Math.min(MAX_FPS, Math.max(MIN_FPS, fps)));
      },
      onKey: function (dir, big) {
        // Moving right means more milliseconds, so a lower frame rate.
        var list = PRESETS.slice().sort(function (a, b) { return b - a; });
        var next;
        if (big) next = dir > 0 ? list[list.length - 1] : list[0];
        else if (dir > 0) next = list.filter(function (p) { return p < state.fps; })[0];
        else next = list.filter(function (p) { return p > state.fps; }).pop();
        if (next) setFps(next);
      }
    });

    function setFps(fps) {
      if (fps === state.fps) return;
      state.fps = fps;
      rateButtons.forEach(function (b, i) { b.setAttribute("aria-pressed", PRESETS[i] === fps ? "true" : "false"); });
      render();
    }

    /* ---------- Drawing ---------- */

    function drawBudget(sim) {
      HB.svg.clear(layerBudget);
      var bx = x(sim.budget);
      svgEl("rect", { x: X0, y: LANE.cpu - 12, width: bx - X0, height: LANE.gpu + LANE.h + 12 - (LANE.cpu - 12), class: "f-acc-soft" }, layerBudget);
      svgEl("line", { x1: bx, y1: 50, x2: bx, y2: RULER_Y, class: "s-acc w2" }, layerBudget);
      var label = state.fps + " fps → " + fmt1(sim.budget) + " ms per frame";
      var anchor = bx > X1 - 120 ? "end" : bx < X0 + 120 ? "" : "mid";
      var lx = anchor === "end" ? bx - 22 : anchor === "" ? bx + 22 : bx;
      svgEl("text", { x: lx, y: 40, class: "t-acc t-strong " + anchor, text: label }, layerBudget);
      handle.setAttribute("transform", "translate(" + bx + ",56)");
      handle.setAttribute("aria-valuenow", state.fps);
      handle.setAttribute("aria-valuetext", label);
    }

    function drawLane(blocks, y, total, budget, defaultCls) {
      // Blocks first, then the overflow hatching, then labels on top of both.
      var at = 0;
      var labels = [];
      blocks.forEach(function (b) {
        var x0 = x(at);
        var w = b[1] * K;
        svgEl("rect", { x: x0, y: y, width: w, height: LANE.h, class: (b[2] || defaultCls) + " s-strong" }, layerWork);
        if (b[0].length * 5.2 + 4 <= w) labels.push([x0 + w / 2, b[0]]);
        at += b[1];
      });
      var end = x(total);
      var over = total > budget;
      if (over) svgEl("rect", { x: x(budget), y: y, width: end - x(budget), height: LANE.h, fill: "url(#ftr-over)" }, layerWork);
      labels.forEach(function (l) {
        svgEl("text", { x: l[0], y: y + 19, class: "t-small mid", text: l[1] }, layerWork);
      });
      // Status sits clear of both the work and the budget line.
      var sx = Math.max(end, x(budget)) + 8;
      if (over) svgEl("text", { x: sx, y: y + 19, class: "t-small t-pix t-strong", text: fmt1(total) + " ms · over by " + fmt1(total - budget) }, layerWork);
      else svgEl("text", { x: sx, y: y + 19, class: "t-small t-muted", text: fmt1(total) + " ms · fits" }, layerWork);
    }

    function drawGraph(sim) {
      HB.svg.clear(layerGraph);
      var step = (X1 - X0) / FRAMES;
      var bw = step - 3;
      sim.frames.forEach(function (fr, i) {
        var top = gy(fr.shown);
        var missed = fr.refreshes > 1;
        svgEl("rect", {
          x: X0 + i * step + 1.5, y: top, width: bw, height: G.bottom - top,
          class: missed ? "f-pix" : "f-acc-soft s-acc"
        }, layerGraph);
        if (fr.shown > G.msMax) {
          svgEl("path", { d: "M" + (X0 + i * step) + "," + (G.top + 6) + " l" + (step / 2) + ",-6 l" + (step / 2) + ",6", class: "s-surface w2" }, layerGraph);
        }
      });
      var by = gy(sim.budget);
      svgEl("line", { x1: X0, y1: by, x2: X1, y2: by, class: "s-acc dash w15" }, layerGraph);
      svgEl("text", { x: X1, y: G.top - 14, class: "t-small t-acc t-strong end", text: "dashed line: the " + fmt1(sim.budget) + " ms budget" }, layerGraph);
      var stallFrame = sim.frames[STALL_FRAME];
      if (stallFrame.stall) {
        var sx = X0 + STALL_FRAME * step + step / 2;
        var label = "hitch: on screen " + fmt1(stallFrame.shown) + " ms";
        svgEl("text", { x: sx + 10, y: Math.max(G.top + 12, gy(stallFrame.shown) + 12), class: "t-small t-pix t-strong", text: label }, layerGraph);
      }
    }

    function cell(label, value, cls) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v " + (cls || ""), text: value })]);
    }

    function drawReadout(sim) {
      var work = Math.max(sim.cpu, sim.gpu);
      var onTime = sim.frames.filter(function (fr) { return fr.refreshes === 1; }).length;
      var total = sim.frames.reduce(function (a, fr) { return a + fr.shown; }, 0);
      var avg = (FRAMES * 1000) / total;
      var spare = sim.budget - work;
      readout.replaceChildren(
        cell("Budget", fmt1(sim.budget) + " ms"),
        cell("CPU work", fmt1(sim.cpu) + " ms"),
        cell("GPU work", fmt1(sim.gpu) + " ms"),
        cell(spare >= 0 ? "Headroom" : "Over by", fmt1(Math.abs(spare)) + " ms"),
        cell("Frames on time", onTime + " of " + FRAMES),
        cell("Average", Math.round(avg) + " fps")
      );

      // Plain-language summary: regular frames first, then the one-off stall.
      var missed = sim.frames.filter(function (fr) { return fr.refreshes > 1 && !fr.stall; }).length;
      var regular = FRAMES - (state.stall ? 1 : 0);
      var parts = [];
      if (missed === regular) {
        var reps = sim.frames[0].refreshes;
        parts.push("Every frame misses its refresh, so each image stays on screen for " + reps + " refreshes and the game runs at " +
          Math.round(state.fps / reps) + " fps instead of " + state.fps + ".");
        if (work - sim.budget < sim.budget) parts.push("Missing by " + fmt1(work - sim.budget) + " ms costs a whole extra refresh.");
      } else if (missed > 0) {
        parts.push(missed + " frames run slightly over and stay on screen for a second refresh, so the motion turns uneven: poor frame pacing.");
      } else {
        parts.push((state.stall ? "Every other frame fits" : "Every frame fits") + ", with " + fmt1(spare) + " ms to spare, so each image stays on screen for exactly one refresh.");
      }
      if (state.stall) {
        parts.push("Frame 40 stalls and stays on screen for " + sim.frames[STALL_FRAME].refreshes + " refreshes: a hitch. The average reads " +
          Math.round(avg) + " fps, but players see the freeze.");
      } else if (missed === 0) {
        parts.push("That flat line is what smooth looks like.");
      }
      var text = parts.join(" ");
      verdict.textContent = text;
    }

    function render() {
      var sim = simulate(state);
      var scene = SCENES[state.scene];
      drawBudget(sim);
      HB.svg.clear(layerWork);
      drawLane(scene.cpu, LANE.cpu, sim.cpu, sim.budget, "f-surface");
      drawLane(scene.gpu, LANE.gpu, sim.gpu, sim.budget, "f-surface");
      drawGraph(sim);
      drawReadout(sim);
      log.debug("render", state.fps + " fps", state.scene, state.stall ? "stall" : "no stall");
    }

    render();
  }

  HB.demos.register("frame-time-ruler", init);
})();

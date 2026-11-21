/*
 * frame-pipeline-timeline.js: chapter 2.2's interactive.
 *
 * Three lanes, one per pipeline stage: the game thread, the render thread
 * and the GPU. Each frame passes through the lanes in order, and different
 * frames occupy different lanes at the same moment. The reader sets how many
 * milliseconds each stage needs and sees:
 *
 *   - which lane sets the frame rate (the slowest one, when pipelined)
 *   - how long one frame takes from input to finished image (latency)
 *   - where lanes wait for each other (dashed gaps)
 *   - what a one-off hitch on the game thread does to the lanes after it
 *
 * Scheduling model (milliseconds), for frame n with stage costs G, R, P:
 *
 *   Pipelined
 *     game   start = max(game end of n-1, render end of n-2)
 *            (the game thread may run at most one frame ahead of the render
 *             thread, as in Unreal's default "one frame thread lag")
 *     render start = max(game end of n, render end of n-1, GPU end of n-F)
 *            (F = frames in flight: the CPU may not get more than F frames
 *             ahead of the GPU; F = 2, the usual default)
 *     GPU    start = max(render end of n, GPU end of n-1)
 *
 *   One thread, no overlap
 *     each stage starts when the previous stage of the same frame ends, and
 *     the next frame starts when the GPU has finished.
 *
 *   Low-latency mode (pipelined only)
 *     the game thread also delays its start so that, at the usual stage
 *     costs, its work reaches the render thread and the GPU just as they
 *     become free: start >= GPU end of n-1 - (G + R) and
 *     start >= render end of n-1 - G. Work is started "just in time", the
 *     way NVIDIA Reflex or Unreal's r.GTSyncType modes aim to. The frame
 *     rate is unchanged; queueing disappears. The rule only looks at frames
 *     already finished, so it cannot foresee a hitch.
 *
 * Latency is measured from the start of frame N on the game thread (where
 * input is read) to the end of frame N on the GPU. The display's scan-out is
 * not included; the chapter text says so.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("frame-pipeline");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Model constants ---------- */

  var FRAMES = 24;          // frames simulated; enough to reach a steady state
  var N = 10;               // the highlighted frame, well past start-up
  var IN_FLIGHT = 2;        // frames the CPU may queue ahead of the GPU
  var HITCH_MS = 45;        // extra game-thread time on the hitch frame
  var WINDOW_MS = 150;      // visible time span
  var LEAD_MS = 12;         // visible time before frame N starts

  /* ---------- Layout (viewBox units) ---------- */

  var X0 = 130;
  var X1 = 880;
  var PX_PER_MS = (X1 - X0) / WINDOW_MS;
  var LANES = [
    { key: "g", name: "Game thread", sub: "input, gameplay", y: 46 },
    { key: "r", name: "Render thread", sub: "builds GPU work", y: 94 },
    { key: "p", name: "GPU", sub: "draws the frame", y: 142 }
  ];
  var LANE_H = 34;

  /* ---------- Simulation ---------- */

  /**
   * Returns per-frame start and end times for each lane:
   * { g: [[start, end], ...], r: [...], p: [...] }.
   */
  function simulate(s) {
    var g = [];
    var r = [];
    var p = [];
    for (var n = 0; n < FRAMES; n++) {
      var G = s.game + (s.hitch && n === N + 1 ? HITCH_MS : 0);
      var gs;
      var rs;
      var ps;
      if (s.mode === "serial") {
        gs = n ? p[n - 1][1] : 0;
        rs = gs + G;
        ps = rs + s.render;
      } else {
        gs = Math.max(n ? g[n - 1][1] : 0, n >= 2 ? r[n - 2][1] : 0);
        if (s.lowLatency && n) {
          // Just in time: aim to finish game + render as the GPU frees up,
          // and the game update as the render thread frees up. Uses the
          // nominal stage costs, as a real engine's prediction would.
          gs = Math.max(gs, p[n - 1][1] - s.game - s.render, r[n - 1][1] - s.game);
        }
        rs = Math.max(gs + G, n ? r[n - 1][1] : 0, n >= IN_FLIGHT ? p[n - IN_FLIGHT][1] : 0);
        ps = Math.max(rs + s.render, n ? p[n - 1][1] : 0);
      }
      g.push([gs, gs + G]);
      r.push([rs, rs + s.render]);
      p.push([ps, ps + s.gpu]);
    }

    return { g: g, r: r, p: p };
  }

  /** Steady-state numbers for the highlighted frame. */
  function measure(s, sim) {
    var period = sim.p[N - 1][1] - sim.p[N - 2][1];
    var latency = sim.p[N][1] - sim.g[N][0];
    var worst = period;
    if (s.hitch) {
      for (var n = N + 1; n < Math.min(FRAMES, N + 8); n++) {
        worst = Math.max(worst, sim.p[n][1] - sim.p[n - 1][1]);
      }
    }
    var limit;
    if (s.mode === "serial") {
      limit = "All three, in turn";
    } else {
      var top = Math.max(s.game, s.render, s.gpu);
      var names = [];
      if (Math.abs(s.game - top) < 0.01) names.push("Game thread");
      if (Math.abs(s.render - top) < 0.01) names.push("Render thread");
      if (Math.abs(s.gpu - top) < 0.01) names.push("GPU");
      limit = names.join(" and ");
    }
    return { period: period, fps: 1000 / period, latency: latency, frames: latency / period, worst: worst, limit: limit };
  }

  function frameLabel(n) {
    var d = n - N;
    if (d === 0) return "N";
    return d > 0 ? "N+" + d : "N−" + -d;
  }

  /* ---------- Demo ---------- */

  function init(root) {
    var state = { game: 9, render: 6, gpu: 14, mode: "pipe", lowLatency: false, hitch: false };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Frame pipeline timeline" }),
      h("span", { class: "demo-hint", text: "Make one lane slower and watch which one sets the pace." })
    ]));

    /* ---------- Controls ---------- */

    var controls = h("div", { class: "demo-controls" });
    var sliders = {};
    function addSlider(key, id, label) {
      var control = HB.slider(id, label, {
        min: 2, max: 40, step: 0.5, value: state[key],
        format: function (v) { return v.toFixed(1) + " ms"; }
      }, function (v) {
        state[key] = v;
        render();
      });
      sliders[key] = control.querySelector("input");
      controls.appendChild(control);
    }
    addSlider("game", "fpt-game", "Game thread per frame");
    addSlider("render", "fpt-render", "Render thread per frame");
    addSlider("gpu", "fpt-gpu", "GPU per frame");
    root.appendChild(controls);

    var controls2 = h("div", { class: "demo-controls" });
    controls2.appendChild(HB.segmented("Threads", [
      { value: "pipe", label: "Pipelined" },
      { value: "serial", label: "One at a time" }
    ], state.mode, function (v) {
      state.mode = v;
      render();
    }));

    var checks = h("div", { class: "checks" });
    var lowBox = h("input", { type: "checkbox", id: "fpt-low" });
    lowBox.addEventListener("change", function () { state.lowLatency = lowBox.checked; render(); });
    var hitchBox = h("input", { type: "checkbox", id: "fpt-hitch" });
    hitchBox.addEventListener("change", function () { state.hitch = hitchBox.checked; render(); });
    checks.appendChild(h("label", { for: "fpt-low" }, [lowBox, "Low-latency mode"]));
    checks.appendChild(h("label", { for: "fpt-hitch" }, [hitchBox, "Hitch on frame N+1 (+" + HITCH_MS + " ms)"]));
    controls2.appendChild(h("div", { class: "control" }, [h("span", { class: "label", text: "Options" }), checks]));

    /* Presets set all three sliders at once, through their own input events
       so the value labels stay in sync. */
    var presets = h("div", { class: "seg", role: "group", "aria-label": "Presets" });
    [
      { label: "GPU-bound", v: { game: 9, render: 6, gpu: 14 } },
      { label: "CPU-bound", v: { game: 20, render: 7, gpu: 10 } },
      { label: "Balanced", v: { game: 12, render: 11, gpu: 12 } }
    ].forEach(function (preset) {
      var b = h("button", { type: "button", "aria-pressed": "false", text: preset.label });
      b.addEventListener("click", function () {
        ["game", "render", "gpu"].forEach(function (key) {
          sliders[key].value = String(preset.v[key]);
          sliders[key].dispatchEvent(new Event("input"));
        });
        log.debug("preset", preset.label);
      });
      presets.appendChild(b);
    });
    controls2.appendChild(h("div", { class: "control" }, [h("span", { class: "label", text: "Presets" }), presets]));
    root.appendChild(controls2);

    /* ---------- Stage ---------- */

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", { class: "dg is-wide", viewBox: "0 0 900 250", role: "img" });
    stage.appendChild(svg);
    root.appendChild(stage);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);
    root.appendChild(h("p", {
      class: "demo-hint",
      text: "Latency here runs from the game thread reading input for frame N to the GPU finishing it. The display adds its own scan-out time on top. The CPU may queue up to " + IN_FLIGHT + " frames ahead of the GPU."
    }));

    /* ---------- Drawing ---------- */

    function render() {
      var sim = simulate(state);
      var m = measure(state, sim);
      lowBox.disabled = state.mode === "serial";

      var t0 = sim.g[N][0] - LEAD_MS;
      var t1 = t0 + WINDOW_MS;
      var x = function (t) { return X0 + (t - t0) * PX_PER_MS; };

      HB.svg.clear(svg);

      // Time axis: ticks every 10 ms, counted from the moment frame N reads input.
      svgEl("line", { x1: X0, y1: 30, x2: X1, y2: 30, class: "s-line" }, svg);
      for (var k = -1; k * 10 <= WINDOW_MS; k++) {
        var t = sim.g[N][0] + k * 10;
        if (t < t0 || t > t1) continue;
        svgEl("line", { x1: x(t), y1: 26, x2: x(t), y2: 34, class: "s-muted" }, svg);
        svgEl("text", { x: x(t), y: 20, class: "t-mono t-small t-muted mid", text: k === 0 ? "0 ms" : String(k * 10) }, svg);
      }

      LANES.forEach(function (lane) {
        var mid = lane.y + LANE_H / 2;
        svgEl("text", { x: 16, y: mid - 2, class: "t-strong", text: lane.name }, svg);
        svgEl("text", { x: 16, y: mid + 12, class: "t-small t-muted", text: lane.sub }, svg);
        svgEl("line", { x1: X0, y1: lane.y + LANE_H + 4, x2: X1, y2: lane.y + LANE_H + 4, class: "s-line" }, svg);

        var spans = sim[lane.key];
        var prevEnd = null;
        for (var n = 0; n < FRAMES; n++) {
          var s0 = Math.max(spans[n][0], t0);
          var s1 = Math.min(spans[n][1], t1);

          // Waiting: a gap since the previous frame on this lane.
          if (prevEnd !== null) {
            var w0 = Math.max(prevEnd, t0);
            var w1 = Math.min(spans[n][0], t1);
            if (x(w1) - x(w0) > 3) {
              svgEl("line", { x1: x(w0) + 1, y1: mid, x2: x(w1) - 1, y2: mid, class: "s-muted dash" }, svg);
              if (x(w1) - x(w0) > 34) {
                svgEl("text", { x: (x(w0) + x(w1)) / 2, y: mid - 5, class: "t-small t-muted mid", text: lane.key === "p" ? "idle" : "wait" }, svg);
              }
            }
          }
          prevEnd = spans[n][1];
          if (s1 <= s0) continue;

          var isN = n === N;
          var isHitch = state.hitch && lane.key === "g" && n === N + 1;
          var cls = isN ? "f-acc-soft s-acc w15" : isHitch ? "f-pix-soft s-pix" : n % 2 ? "f-solid s-strong" : "f-surface s-strong";
          svgEl("rect", { x: x(s0), y: lane.y, width: Math.max(1, x(s1) - x(s0)), height: LANE_H, rx: 3, class: cls }, svg);
          if (x(s1) - x(s0) > 28) {
            svgEl("text", {
              x: (x(s0) + x(s1)) / 2, y: mid + 4,
              class: "t-mono t-small mid" + (isN ? " t-acc t-strong" : isHitch ? " t-pix t-strong" : ""),
              text: frameLabel(n)
            }, svg);
          }
        }
      });

      // Input marker and latency bracket for frame N.
      var a = x(sim.g[N][0]);
      var b = Math.min(x(sim.p[N][1]), X1);
      svgEl("polygon", { points: (a - 5) + ",36 " + (a + 5) + ",36 " + a + ",44", class: "f-acc" }, svg);
      var by = 196;
      svgEl("path", { d: "M" + a + "," + (by - 6) + " V" + by + " H" + b + " V" + (by - 6), class: "s-acc w15" }, svg);
      var latText = "frame N: input read → GPU done in " + m.latency.toFixed(1) + " ms, " + m.frames.toFixed(1) + " frames";
      svgEl("text", { x: Math.max(X0 + 150, Math.min((a + b) / 2, X1 - 150)), y: by + 16, class: "t-small t-acc t-strong mid", text: latText }, svg);

      svgEl("text", { x: X0, y: 240, class: "t-small t-muted", text: "Each box is one frame's work on that lane. Dashed lines: the lane is waiting." }, svg);

      svg.setAttribute("aria-label",
        "Three lanes for the game thread, render thread and GPU. Frame time " + m.period.toFixed(1) + " ms, limited by " + m.limit +
        ". Frame N takes " + m.latency.toFixed(1) + " ms from input to the GPU finishing it.");

      /* ---------- Readout ---------- */

      function item(label, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
      }
      var items = [
        item("Frame time", m.period.toFixed(1) + " ms"),
        item("Frame rate", Math.round(m.fps) + " fps"),
        item("Limited by", m.limit),
        item("Input latency", m.latency.toFixed(1) + " ms"),
        item("In frames", m.frames.toFixed(1))
      ];
      if (state.hitch) items.push(item("Longest frame", m.worst.toFixed(1) + " ms"));
      readout.replaceChildren.apply(readout, items);

      log.debug("render", state.mode, state.game, state.render, state.gpu, "period", m.period.toFixed(2), "latency", m.latency.toFixed(2));
    }

    render();
  }

  HB.demos.register("frame-pipeline-timeline", init);
})();

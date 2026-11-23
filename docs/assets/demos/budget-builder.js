/*
 * budget-builder.js: chapter 11.1's interactive.
 *
 * A frame budget as three lanes, drawn to scale against the target frame
 * time: the game thread, the render thread and the GPU. They work on
 * different frames at the same time (chapter 2.2), so they do not add up;
 * the longest lane sets the frame time:
 *
 *   budget      = 1000 / target fps
 *   frame time  = max(game thread, render thread, GPU)
 *   uncapped    = 1000 / frame time
 *   on a fixed-refresh display with v-sync at the target rate, a frame that
 *   misses the budget waits for the next refresh:
 *   shown fps   = target / ceil(frame time / budget)
 *
 * The reader picks a target, an internal resolution and quality levels,
 * toggles optional passes and systems, and moves two sliders (draw calls
 * and characters). The demo names the limiting lane and ranks the cuts that
 * would save the most frame time, each with a button that applies it.
 *
 * Every cost is illustrative. Per-pixel GPU passes scale with the internal
 * pixel count relative to 1080p; output-resolution passes (upscaler, post,
 * UI) assume a fixed 4K output. Draw calls cost 5 microseconds each on the
 * render thread, chapter 4.3's illustrative figure, and shadow cascades
 * redraw a share of them. The model leaves out frame-to-frame variation,
 * queued frames and dynamic resolution; the chapter says so.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("budget-builder");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Model: every number below is illustrative ---------- */

  var TARGETS = [30, 60, 90, 120];
  var BASE_PIXELS = 1920 * 1080;
  var RES = [
    { value: "720p", label: "720p", pixels: 1280 * 720 },
    { value: "1080p", label: "1080p", pixels: 1920 * 1080 },
    { value: "1440p", label: "1440p", pixels: 2560 * 1440 },
    { value: "2160p", label: "4K", pixels: 3840 * 2160 }
  ];
  var SHADOWS = [
    { value: "low", label: "Low", gpu: 0.8, redraw: 0.25 },
    { value: "medium", label: "Medium", gpu: 1.5, redraw: 0.5 },
    { value: "high", label: "High", gpu: 2.4, redraw: 0.8 },
    { value: "epic", label: "Epic", gpu: 3.4, redraw: 1.2 }
  ];
  var AO = [
    { value: "off", label: "Off", fixed: 0, perPixel: 0 },
    { value: "half", label: "Half res", fixed: 0.15, perPixel: 0.25 },
    { value: "full", label: "Full res", fixed: 0.2, perPixel: 0.8 }
  ];
  var DRAW_MS = 0.005; // 5 µs to record one draw call (chapter 4.3's model)

  var OPTIONAL = [
    { id: "prepass", label: "Depth pre-pass (GPU 0.6 ms)" },
    { id: "ssr", label: "Screen-space reflections" },
    { id: "gi", label: "Real-time GI (4 ms at 1080p)" },
    { id: "fog", label: "Volumetric fog (GPU 1.0 ms)" },
    { id: "destruction", label: "Destruction physics (CPU 2.5 ms)" }
  ];

  var LANES = [
    { key: "game", label: "Game thread", side: "CPU" },
    { key: "render", label: "Render thread", side: "CPU" },
    { key: "gpu", label: "GPU", side: "GPU" }
  ];

  function find(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i];
    return list[0];
  }

  function indexOf(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return i;
    return 0;
  }

  /* Builds the three lanes for a state. Each item: [label, ms, fill class]. */
  function lanes(s) {
    var pf = find(RES, s.res).pixels / BASE_PIXELS;
    var sh = find(SHADOWS, s.shadows);
    var ao = find(AO, s.ao);
    var native = s.res === "2160p";
    var gpu = [["Shadows", sh.gpu, "f-geo-soft s-geo"]];
    if (s.prepass) gpu.push(["Pre-pass", 0.6, "f-geo-soft s-geo"]);
    gpu.push(["G-buffer", 0.6 + 1.0 * pf, "f-geo-soft s-geo"]);
    if (s.ao !== "off") gpu.push(["AO", ao.fixed + ao.perPixel * pf, "f-lit-soft s-lit"]);
    gpu.push(["Lighting", 0.4 + 0.9 * pf, "f-lit-soft s-lit"]);
    if (s.ssr) gpu.push(["SSR", 0.2 + 0.4 * pf, "f-lit-soft s-lit"]);
    if (s.gi) gpu.push(["GI", 0.6 + 3.4 * pf, "f-lit-soft s-lit"]);
    if (s.fog) gpu.push(["Fog", 1.0, "f-acc-soft s-acc"]);
    gpu.push(["Transparents", 0.3 + 0.6 * pf, "f-acc-soft s-acc"]);
    gpu.push([native ? "TAA" : "Upscaler", native ? 0.8 : 1.5, "f-pix-soft s-pix"]);
    gpu.push(["Post", 1.2, "f-pix-soft s-pix"]);
    gpu.push(["UI", 0.3, "f-pix-soft s-pix"]);

    var game = [["Gameplay", 3.0], ["Physics", 1.5]];
    if (s.destruction) game.push(["Destruction", 2.5]);
    if (s.npcs > 0) {
      game.push(["Animation", 0.04 * s.npcs]);
      game.push(["AI", 0.03 * s.npcs]);
    }
    game.push(["UI logic", 0.6]);

    var render = [
      ["Culling", 1.0],
      ["Scene draws", s.draws * DRAW_MS],
      ["Shadow draws", s.draws * sh.redraw * DRAW_MS]
    ];
    var cpuCls = ["f-surface s-strong", "f-sunken s-strong"];
    [game, render].forEach(function (list) {
      list.forEach(function (item, i) { item[2] = cpuCls[i % 2]; });
    });
    return { game: game, render: render, gpu: gpu };
  }

  function total(list) {
    return list.reduce(function (a, b) { return a + b[1]; }, 0);
  }

  function evaluate(s) {
    var l = lanes(s);
    var t = { game: total(l.game), render: total(l.render), gpu: total(l.gpu) };
    var limit = "gpu";
    if (t.game > t[limit]) limit = "game";
    if (t.render > t[limit]) limit = "render";
    var budget = 1000 / s.target;
    var frame = t[limit];
    var refreshes = Math.max(1, Math.ceil(frame / budget - 1e-9));
    return { lanes: l, totals: t, limit: limit, budget: budget, frame: frame, shownFps: s.target / refreshes, refreshes: refreshes };
  }

  /* Candidate cuts for the limiting lane. Each returns a changed copy of the state. */
  function candidates(s, limit) {
    var out = [];
    function add(label, change) {
      var next = {};
      Object.keys(s).forEach(function (k) { next[k] = s[k]; });
      change(next);
      out.push({ label: label, state: next });
    }
    var ri = indexOf(RES, s.res);
    var si = indexOf(SHADOWS, s.shadows);
    var ai = indexOf(AO, s.ao);
    if (limit === "gpu") {
      if (ri > 0) add("Internal resolution " + RES[ri].label + " → " + RES[ri - 1].label, function (n) { n.res = RES[ri - 1].value; });
      if (s.gi) add("Real-time GI off", function (n) { n.gi = false; });
      if (si > 0) add("Shadows " + SHADOWS[si].label + " → " + SHADOWS[si - 1].label, function (n) { n.shadows = SHADOWS[si - 1].value; });
      if (ai > 0) add("AO " + AO[ai].label.toLowerCase() + " → " + AO[ai - 1].label.toLowerCase(), function (n) { n.ao = AO[ai - 1].value; });
      if (s.fog) add("Volumetric fog off", function (n) { n.fog = false; });
      if (s.ssr) add("Screen-space reflections off", function (n) { n.ssr = false; });
    } else if (limit === "render") {
      if (s.draws > 250) {
        var fewer = Math.max(250, Math.round((s.draws * 0.6) / 250) * 250);
        add("Batching and instancing: draw calls " + HB.fmt.int(s.draws) + " → " + HB.fmt.int(fewer), function (n) { n.draws = fewer; });
      }
      if (si > 0) add("Shadows " + SHADOWS[si].label + " → " + SHADOWS[si - 1].label + " (fewer shadow draws)", function (n) { n.shadows = SHADOWS[si - 1].value; });
    } else {
      if (s.npcs > 0) {
        var half = Math.round(s.npcs / 2 / 10) * 10;
        add("Fewer animated characters, or cheaper animation and AI: " + s.npcs + " → " + half, function (n) { n.npcs = half; });
      }
      if (s.destruction) add("Destruction physics off", function (n) { n.destruction = false; });
    }
    var before = evaluate(s);
    out.forEach(function (c) {
      var after = evaluate(c.state);
      c.laneSaving = before.totals[limit] - after.totals[limit];
      c.frameSaving = before.frame - after.frame;
      c.after = after;
    });
    out.sort(function (a, b) { return b.frameSaving - a.frameSaving || b.laneSaving - a.laneSaving; });
    return out.slice(0, 3);
  }

  /* ---------- Layout (viewBox units) ---------- */

  var W = 760;
  var X0 = 104;
  var X1 = 640;
  var LANE_Y = { game: 52, render: 98, gpu: 144 };
  var LANE_H = 34;
  var RULER_Y = 198;
  var H = 228;

  function fmt1(n) {
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  /* ---------- Demo ---------- */

  function init(root) {
    var state = { target: 60, res: "1440p", shadows: "high", ao: "half", prepass: true, ssr: true, gi: false, fog: true, destruction: false, npcs: 60, draws: 1000 };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Budget builder" }),
      h("span", { class: "demo-hint", text: "Pick a target, add passes and systems, and watch which lane runs out first. Every cost is illustrative." })
    ]));

    /* Controls. Each keeps a sync function so suggestions can update it. */
    var syncs = [];
    function seg(label, options, key) {
      var ctl = HB.segmented(label, options.map(function (o) { return { value: o.value, label: o.label }; }), state[key], function (v) { state[key] = v; render(); });
      var buttons = Array.prototype.slice.call(ctl.querySelectorAll("button"));
      syncs.push(function () {
        buttons.forEach(function (b, i) { b.setAttribute("aria-pressed", options[i].value === state[key] ? "true" : "false"); });
      });
      return ctl;
    }
    function slider(id, label, key, opts) {
      var ctl = HB.slider(id, label, { min: opts.min, max: opts.max, step: opts.step, value: state[key], format: opts.format }, function (v) { state[key] = v; render(); });
      var input = ctl.querySelector("input");
      var out = ctl.querySelector("output");
      syncs.push(function () {
        input.value = String(state[key]);
        out.textContent = opts.format(state[key]);
      });
      return ctl;
    }

    var row1 = h("div", { class: "demo-controls" });
    row1.appendChild(seg("Target frame rate", TARGETS.map(function (t) { return { value: t, label: t + " fps" }; }), "target"));
    row1.appendChild(seg("Internal resolution (output 4K)", RES, "res"));
    root.appendChild(row1);

    var row2 = h("div", { class: "demo-controls" });
    row2.appendChild(seg("Shadows", SHADOWS, "shadows"));
    row2.appendChild(seg("Ambient occlusion", AO, "ao"));
    row2.appendChild(slider("bb-draws", "Draw calls per frame", "draws", { min: 250, max: 3000, step: 250, format: function (v) { return HB.fmt.int(v); } }));
    row2.appendChild(slider("bb-npcs", "Animated characters", "npcs", { min: 0, max: 200, step: 10, format: function (v) { return String(v); } }));
    root.appendChild(row2);

    var checks = h("div", { class: "checks" });
    OPTIONAL.forEach(function (opt) {
      var box = h("input", { type: "checkbox", id: "bb-" + opt.id, checked: state[opt.id] });
      box.addEventListener("change", function () { state[opt.id] = box.checked; render(); });
      syncs.push(function () { box.checked = !!state[opt.id]; });
      checks.appendChild(h("label", { for: "bb-" + opt.id }, [box, opt.label]));
    });
    root.appendChild(h("div", { class: "control" }, [h("span", { class: "label", text: "Add or remove" }), checks]));

    /* The chart. */
    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", { class: "dg is-wide", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Frame budget chart" });
    stage.appendChild(svg);
    root.appendChild(stage);

    var defs = svgEl("defs", null, svg);
    var pat = svgEl("pattern", { id: "bb-over", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "s-pix", "stroke-width": 2 }, pat);
    var layerBudget = svgEl("g", null, svg);
    var layerWork = svgEl("g", null, svg);
    var layerRuler = svgEl("g", null, svg);

    svgEl("text", { x: 0, y: 16, class: "t-caps", text: "ONE FRAME · THREE LANES WORKING SIDE BY SIDE · ILLUSTRATIVE COSTS" }, svg);
    LANES.forEach(function (lane) {
      svgEl("text", { x: 0, y: LANE_Y[lane.key] + 15, class: "t-small t-strong", text: lane.label }, svg);
      svgEl("text", { x: 0, y: LANE_Y[lane.key] + 29, class: "t-small t-muted", text: lane.side }, svg);
    });

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    var cutsHead = h("p", { class: "label" });
    var cutsList = h("ul", { class: "demo-hint", style: "margin:0;padding-left:1.1rem;display:grid;gap:0.35rem" });
    var verdict = h("p", { class: "demo-hint" });
    root.append(readout, verdict, h("div", { class: "control" }, [cutsHead, cutsList]));

    /* Itemised costs, so every number on the chart can be read. */
    var tables = h("div", { class: "fig-row" });
    root.appendChild(tables);

    function apply(next) {
      Object.keys(next).forEach(function (k) { state[k] = next[k]; });
      syncs.forEach(function (f) { f(); });
      render();
    }

    /* ---------- Drawing ---------- */

    function drawLane(items, key, res, scaleX) {
      var y = LANE_Y[key];
      var at = 0;
      var labels = [];
      items.forEach(function (item) {
        var x0 = scaleX(at);
        var w = scaleX(at + item[1]) - x0;
        var r = svgEl("rect", { x: x0.toFixed(1), y: y, width: Math.max(0, w).toFixed(1), height: LANE_H, class: item[2] }, layerWork);
        svgEl("title", { text: item[0] + ": " + fmt1(item[1]) + " ms" }, r);
        if (item[0].length * 5.5 + 6 <= w) labels.push([x0 + w / 2, item[0]]);
        at += item[1];
      });
      var end = scaleX(at);
      var bx = scaleX(res.budget);
      if (at > res.budget) {
        svgEl("rect", { x: bx.toFixed(1), y: y, width: (end - bx).toFixed(1), height: LANE_H, fill: "url(#bb-over)" }, layerWork);
      }
      labels.forEach(function (l) {
        svgEl("text", { x: l[0].toFixed(1), y: y + 21, class: "t-small mid", text: l[1] }, layerWork);
      });
      var isLimit = res.limit === key;
      var over = at > res.budget;
      var sx = Math.max(end, bx) + 8;
      var cls = "t-small " + (over ? "t-pix t-strong" : isLimit ? "t-acc t-strong" : "t-muted");
      svgEl("text", { x: sx.toFixed(1), y: y + 15, class: cls, text: fmt1(at) + " ms" + (over ? " · over by " + fmt1(at - res.budget) : "") }, layerWork);
      if (isLimit) svgEl("text", { x: sx.toFixed(1), y: y + 29, class: cls, text: "sets the frame time" }, layerWork);
    }

    function render() {
      var res = evaluate(state);
      var longest = Math.max(res.totals.game, res.totals.render, res.totals.gpu);
      var span = Math.max(res.budget * 1.25, longest * 1.04);
      var step = span > 40 ? 10 : span > 18 ? 5 : 2;
      span = Math.ceil(span / step) * step;
      var k = (X1 - X0) / span;
      function scaleX(ms) { return X0 + ms * k; }

      HB.svg.clear(layerBudget);
      HB.svg.clear(layerWork);
      HB.svg.clear(layerRuler);

      var bx = scaleX(res.budget);
      svgEl("rect", { x: X0, y: LANE_Y.game - 10, width: (bx - X0).toFixed(1), height: LANE_Y.gpu + LANE_H + 10 - (LANE_Y.game - 10), class: "f-acc-soft" }, layerBudget);
      svgEl("line", { x1: bx.toFixed(1), y1: 30, x2: bx.toFixed(1), y2: RULER_Y, class: "s-acc w2" }, layerBudget);
      var blabel = state.target + " fps → " + fmt1(res.budget) + " ms budget";
      svgEl("text", { x: (bx - 6).toFixed(1), y: 36, class: "t-small t-acc t-strong end", text: blabel }, layerBudget);

      drawLane(res.lanes.game, "game", res, scaleX);
      drawLane(res.lanes.render, "render", res, scaleX);
      drawLane(res.lanes.gpu, "gpu", res, scaleX);

      svgEl("line", { x1: X0, y1: RULER_Y, x2: X1, y2: RULER_Y, class: "s-strong" }, layerRuler);
      for (var ms = 0; ms <= span + 1e-9; ms += step) {
        var x = scaleX(ms);
        svgEl("line", { x1: x.toFixed(1), y1: RULER_Y, x2: x.toFixed(1), y2: RULER_Y + 6, class: "s-strong" }, layerRuler);
        svgEl("text", { x: x.toFixed(1), y: RULER_Y + 19, class: "t-small t-mono t-muted mid", text: String(ms) }, layerRuler);
      }
      svgEl("text", { x: X0 - 10, y: RULER_Y + 19, class: "t-small t-mono t-muted end", text: "ms" }, layerRuler);

      var laneName = { game: "the game thread", render: "the render thread", gpu: "the GPU" };
      var side = res.limit === "gpu" ? "GPU-bound" : "CPU-bound";
      svg.setAttribute("aria-label", "Frame budget " + fmt1(res.budget) + " ms at " + state.target + " fps. Game thread " + fmt1(res.totals.game) +
        " ms, render thread " + fmt1(res.totals.render) + " ms, GPU " + fmt1(res.totals.gpu) + " ms. " + laneName[res.limit] + " sets the frame time: " + side + ".");

      /* Readout. */
      function cell(label, value, cls) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v " + (cls || ""), text: value })]);
      }
      var spare = res.budget - res.frame;
      readout.replaceChildren(
        cell("Budget", fmt1(res.budget) + " ms"),
        cell("Game thread", fmt1(res.totals.game) + " ms"),
        cell("Render thread", fmt1(res.totals.render) + " ms"),
        cell("GPU", fmt1(res.totals.gpu) + " ms"),
        cell("Limited by", { game: "Game thread", render: "Render thread", gpu: "GPU" }[res.limit]),
        cell(spare >= 0 ? "Headroom" : "Over by", fmt1(Math.abs(spare)) + " ms"),
        cell("Uncapped", Math.round(1000 / res.frame) + " fps"),
        cell("With v-sync at " + state.target + " Hz", Math.round(res.shownFps) + " fps")
      );

      /* Verdict. */
      var parts = [];
      parts.push(laneName[res.limit].charAt(0).toUpperCase() + laneName[res.limit].slice(1) + " takes longest, " + fmt1(res.frame) + " ms, so it sets the frame time and the game is " + side + ".");
      if (spare >= 0) {
        parts.push("The frame fits with " + fmt1(spare) + " ms of headroom (" + Math.round((spare / res.budget) * 100) + "% of the budget).");
        if (spare / res.budget < 0.1) parts.push("That is under the 10% many teams keep for spikes.");
      } else {
        parts.push("It misses the " + fmt1(res.budget) + " ms budget by " + fmt1(-spare) + " ms. On a fixed " + state.target +
          " Hz display with v-sync each frame waits for a later refresh, so the game shows " + Math.round(res.shownFps) + " fps, not " + state.target + ".");
      }
      var others = LANES.filter(function (l) { return l.key !== res.limit; }).map(function (l) { return laneName[l.key]; });
      parts.push("Cutting work on " + others.join(" or ") + " changes nothing until " + laneName[res.limit] + " is faster.");
      verdict.textContent = parts.join(" ");

      /* Suggested cuts. */
      var cuts = candidates(state, res.limit);
      cutsHead.textContent = spare >= 0 ? "If you need room, the biggest savings on " + laneName[res.limit] : "What to cut, biggest saving first";
      cutsList.replaceChildren();
      if (!cuts.length) cutsList.appendChild(h("li", { text: "Nothing left to cut on this lane in this model." }));
      cuts.forEach(function (c) {
        var btn = h("button", { type: "button", class: "btn", text: "Apply" });
        btn.addEventListener("click", function () { apply(c.state); });
        var note = c.frameSaving > 0.05
          ? " saves " + fmt1(c.frameSaving) + " ms of frame time" + (c.after.limit !== res.limit ? ", then " + laneName[c.after.limit] + " limits" : "")
          : " saves " + fmt1(c.laneSaving) + " ms on " + laneName[res.limit] + " but another lane still limits";
        cutsList.appendChild(h("li", null, [h("strong", { text: c.label }), note + ". ", btn]));
      });

      /* Itemised table per side. */
      function table(title, rows) {
        var body = h("tbody", null, rows.map(function (r) {
          return h("tr", null, [h("td", { text: r[0] }), h("td", { text: fmt1(r[1]) })]);
        }));
        return h("div", { class: "table-scroll", style: "max-height:none" }, [h("table", { class: "byte-table" }, [
          h("thead", null, [h("tr", null, [h("th", { scope: "col", text: title }), h("th", { scope: "col", text: "ms" })])]),
          body
        ])]);
      }
      tables.replaceChildren(
        table("Game thread", res.lanes.game.concat([["Total", res.totals.game]])),
        table("Render thread", res.lanes.render.concat([["Total", res.totals.render]])),
        table("GPU", res.lanes.gpu.concat([["Total", res.totals.gpu]]))
      );

      log.debug("render", state.target + " fps", state.res, "game " + fmt1(res.totals.game), "render " + fmt1(res.totals.render), "gpu " + fmt1(res.totals.gpu), "limit " + res.limit);
    }

    render();
  }

  HB.demos.register("budget-builder", init);
})();

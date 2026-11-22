/*
 * overdraw-heatmap.js: chapter 5.4's interactive.
 *
 * A pile of up to 12 overlapping layers on a 40 x 24 pixel grid, shown two
 * ways: what the player sees, and a heat map of how many times the pixel
 * shader ran at each pixel. The reader changes:
 *
 *   layers      how many layers are drawn (1 to 12)
 *   material    opaque discs, cut-out leaf cards, or transparent smoke
 *   draw order  back to front, unsorted (creation order), front to back
 *   pre-pass    a depth-only pass first, then shading with an EQUAL test
 *
 * The simulation follows the rules the chapter teaches, one sample per pixel:
 *   opaque       early-Z: a fragment is shaded only if it is nearer than the
 *                depth already stored; it then writes its depth.
 *   cut-out      the card covers a square, the leaf inside it is what is
 *                kept. The early depth test still runs, but depth is written
 *                only after the shader has decided to keep the pixel, so
 *                every card pixel that passes the test is shaded, and the
 *                empty corners are shaded and thrown away.
 *   transparent  blended layers do not write depth and cannot be skipped;
 *                they are always drawn back to front so they blend correctly.
 *   pre-pass     pass 1 writes the nearest depth (for cut-outs it must run
 *                the alpha test to do so); pass 2 shades only fragments whose
 *                depth equals the stored depth: one run per visible pixel.
 *
 * Everything is SVG with diagram classes, so it follows the theme. The heat
 * map is a grid of rects filled with f-pix at stepped opacities.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("overdraw-heatmap");
  var svgEl = HB.svg.el;
  var h = HB.html;

  var GW = 40;
  var GH = 24;
  var CELL = 10;
  var MAX_LAYERS = 12;
  var PANEL = { a: 15, b: 15, top: 44 };
  var HEAT_STEPS = [0.18, 0.34, 0.5, 0.64, 0.76, 0.86, 0.94, 1];
  var SOFT = ["f-acc-soft", "f-geo-soft", "f-lit-soft", "f-pix-soft"];

  /* ---------- Scene: a seeded pile of layers ---------- */

  function buildScene() {
    var rand = HB.rng(11);
    var depths = [];
    for (var i = 0; i < MAX_LAYERS; i++) depths.push(i + 1);
    for (var j = depths.length - 1; j > 0; j--) {
      var k = Math.floor(rand() * (j + 1));
      var t = depths[j]; depths[j] = depths[k]; depths[k] = t;
    }
    var layers = [];
    for (var n = 0; n < MAX_LAYERS; n++) {
      // A loose spiral around the middle, so later layers pile onto earlier ones.
      var a = n * 2.39996;
      var d = Math.sqrt(n + 0.5) * 1.7;
      layers.push({
        id: n,
        cx: 20 + Math.cos(a) * d * 1.35 + (rand() - 0.5) * 2,
        cy: 12 + Math.sin(a) * d * 0.8 + (rand() - 0.5) * 2,
        r: 5.2 + rand() * 2.2,
        rot: Math.round(rand() * 180),
        depth: depths[n] // 1 = nearest to the camera
      });
    }
    return layers;
  }

  /* Does layer l cover the pixel centre (x, y)? Cut-out cards are squares. */
  function covers(l, x, y, material) {
    var dx = x - l.cx;
    var dy = y - l.cy;
    if (material === "cutout") return Math.abs(dx) <= l.r && Math.abs(dy) <= l.r;
    return dx * dx + dy * dy <= l.r * l.r;
  }

  /* The leaf inside a cut-out card: a rotated ellipse, about 37% of the card. */
  function leafKeeps(l, x, y) {
    var a = (l.rot * Math.PI) / 180;
    var dx = x - l.cx;
    var dy = y - l.cy;
    var u = dx * Math.cos(a) + dy * Math.sin(a);
    var v = -dx * Math.sin(a) + dy * Math.cos(a);
    var ru = 0.95 * l.r;
    var rv = 0.5 * l.r;
    return (u * u) / (ru * ru) + (v * v) / (rv * rv) <= 1;
  }

  function drawOrder(layers, state) {
    var list = layers.slice(0, state.count);
    if (state.material === "transparent" || state.order === "btf") return list.sort(function (p, q) { return q.depth - p.depth; });
    if (state.order === "ftb") return list.sort(function (p, q) { return p.depth - q.depth; });
    return list; // unsorted: the order the layers were created in
  }

  /*
   * Runs the frame and returns per-pixel shader runs plus totals.
   * "visible" counts pixels whose final colour came from a shader run.
   */
  function simulate(layers, state) {
    var order = drawOrder(layers, state);
    var mat = state.material;
    var N = GW * GH;
    var depth = new Float64Array(N);
    var runs = new Int32Array(N);
    var prePass = 0;
    var discarded = 0;
    var i, x, y, l, idx, px, py, o;
    for (i = 0; i < N; i++) depth[i] = Infinity;

    function each(fn) {
      for (o = 0; o < order.length; o++) {
        l = order[o];
        for (y = 0; y < GH; y++) {
          py = y + 0.5;
          for (x = 0; x < GW; x++) {
            px = x + 0.5;
            if (covers(l, px, py, mat)) fn(l, y * GW + x, px, py);
          }
        }
      }
    }

    if (mat === "transparent") {
      each(function (layer, k) { runs[k]++; });
    } else if (state.prepass) {
      // Pass 1: depth only (cut-outs run their alpha test here).
      each(function (layer, k, sx, sy) {
        if (layer.depth >= depth[k]) return;
        prePass++;
        if (mat !== "cutout" || leafKeeps(layer, sx, sy)) depth[k] = layer.depth;
      });
      // Pass 2: shade only the fragment whose depth won.
      each(function (layer, k) {
        if (layer.depth === depth[k]) runs[k]++;
      });
    } else {
      each(function (layer, k, sx, sy) {
        if (layer.depth >= depth[k]) return; // early-Z rejects it
        runs[k]++;
        if (mat !== "cutout" || leafKeeps(layer, sx, sy)) depth[k] = layer.depth;
        else discarded++;
      });
    }

    var total = 0;
    var max = 0;
    var touched = 0;
    var visible = 0;
    for (idx = 0; idx < N; idx++) {
      total += runs[idx];
      if (runs[idx] > max) max = runs[idx];
      if (runs[idx] > 0) touched++;
      if (mat === "transparent" ? runs[idx] > 0 : depth[idx] !== Infinity) visible++;
    }
    var wasted = mat === "transparent" ? 0 : total - visible;
    return { order: order, runs: runs, total: total, max: max, touched: touched, visible: visible, wasted: wasted, discarded: discarded, prePass: prePass };
  }

  function init(root) {
    var layers = buildScene();
    var state = { count: 8, material: "opaque", order: "btf", prepass: false };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Overdraw heat map" }),
      h("span", { class: "demo-hint", text: "Change the layers, the material, the draw order and the pre-pass. The right panel counts pixel shader runs per pixel." })
    ]));

    /* ---------- Controls ---------- */

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.slider("od-layers", "Layers", {
      min: 1, max: MAX_LAYERS, step: 1, value: state.count,
      format: function (v) { return String(v); }
    }, function (v) { state.count = v; render(); }));
    controls.appendChild(HB.segmented("Material", [
      { value: "opaque", label: "Opaque" },
      { value: "cutout", label: "Cut-out leaves" },
      { value: "transparent", label: "Transparent smoke" }
    ], state.material, function (v) { state.material = v; render(); }));
    var orderControl = HB.segmented("Draw order", [
      { value: "btf", label: "Back to front" },
      { value: "unsorted", label: "Unsorted" },
      { value: "ftb", label: "Front to back" }
    ], state.order, function (v) { state.order = v; render(); });
    controls.appendChild(orderControl);
    var preBox = h("input", { type: "checkbox", id: "od-prepass" });
    preBox.addEventListener("change", function () { state.prepass = preBox.checked; render(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Depth" }),
      h("div", { class: "checks" }, [h("label", { for: "od-prepass" }, [preBox, "Depth pre-pass"])])
    ]));
    root.appendChild(controls);
    var rule = h("p", { class: "demo-hint", "aria-live": "polite" });
    root.appendChild(rule);

    /* ---------- SVG: two panels that sit side by side, or stack on phones ---------- */

    var row = h("div", { class: "fig-row" });
    function panel(label) {
      return svgEl("svg", { class: "dg", viewBox: "0 0 430 336", role: "img", "aria-label": label });
    }
    var imgSvg = panel("A pile of overlapping layers as the player sees it.");
    var heatSvg = panel("A heat map of pixel shader runs per pixel, from none to eight or more.");
    row.appendChild(imgSvg);
    row.appendChild(heatSvg);
    root.appendChild(row);

    svgEl("text", { x: PANEL.a, y: 30, class: "t-caps", text: "WHAT THE PLAYER SEES" }, imgSvg);
    svgEl("text", { x: PANEL.b, y: 30, class: "t-caps", text: "PIXEL SHADER RUNS PER PIXEL" }, heatSvg);
    var W = GW * CELL;
    var H = GH * CELL;
    svgEl("rect", { x: PANEL.a, y: PANEL.top, width: W, height: H, class: "f-sunken s-strong" }, imgSvg);
    var imageLayer = svgEl("g", null, imgSvg);
    var clipDefs = svgEl("defs", null, imgSvg);
    var clip = svgEl("clipPath", { id: "od-clip" }, clipDefs);
    svgEl("rect", { x: PANEL.a, y: PANEL.top, width: W, height: H }, clip);
    imageLayer.setAttribute("clip-path", "url(#od-clip)");
    svgEl("rect", { x: PANEL.a, y: PANEL.top, width: W, height: H, class: "s-strong" }, imgSvg);

    var heatCells = [];
    // crispEdges stops anti-aliased seams showing between neighbouring cells.
    var heatLayer = svgEl("g", { "shape-rendering": "crispEdges" }, heatSvg);
    for (var y = 0; y < GH; y++) {
      for (var x = 0; x < GW; x++) {
        heatCells.push(svgEl("rect", { x: PANEL.b + x * CELL, y: PANEL.top + y * CELL, width: CELL, height: CELL, class: "f-sunken" }, heatLayer));
      }
    }
    svgEl("rect", { x: PANEL.b, y: PANEL.top, width: W, height: H, class: "s-strong" }, heatSvg);

    // Legend: 0 to 8+ runs.
    var ly = PANEL.top + H + 22;
    svgEl("text", { x: PANEL.b, y: ly + 11, class: "t-small t-muted", text: "runs" }, heatSvg);
    for (var s = 0; s <= 8; s++) {
      var lx = PANEL.b + 36 + s * 40;
      svgEl("rect", { x: lx, y: ly, width: 28, height: 14, class: s === 0 ? "f-sunken s-line" : "f-pix", "fill-opacity": s === 0 ? null : HEAT_STEPS[s - 1] }, heatSvg);
      svgEl("text", { x: lx + 14, y: ly + 28, class: "t-mono t-small t-muted mid", text: s === 8 ? "8+" : String(s) }, heatSvg);
    }
    var imageNote = svgEl("text", { x: PANEL.a, y: ly + 11, class: "t-small t-muted" }, imgSvg);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    function setDisabled(control, off) {
      control.querySelectorAll("button").forEach(function (b) { b.disabled = off; });
    }

    function drawImage(sim) {
      HB.svg.clear(imageLayer);
      // The player sees the nearest surfaces on top: paint back to front.
      var painted = sim.order.slice().sort(function (p, q) { return q.depth - p.depth; });
      painted.forEach(function (l) {
        var cx = PANEL.a + l.cx * CELL;
        var cy = PANEL.top + l.cy * CELL;
        var r = l.r * CELL;
        if (state.material === "transparent") {
          svgEl("circle", { cx: cx, cy: cy, r: r, class: "f-ink", "fill-opacity": 0.16 }, imageLayer);
        } else if (state.material === "cutout") {
          svgEl("rect", { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, class: "s-muted dot-dash" }, imageLayer);
          svgEl("ellipse", { cx: cx, cy: cy, rx: 0.95 * r, ry: 0.5 * r, transform: "rotate(" + l.rot + " " + cx + " " + cy + ")", class: "f-geo-soft s-geo w15" }, imageLayer);
        } else {
          svgEl("circle", { cx: cx, cy: cy, r: r, class: SOFT[l.id % SOFT.length] + " s-strong w15" }, imageLayer);
        }
      });
      imageNote.textContent = state.material === "cutout" ? "Dotted squares: the cards the GPU actually rasterizes." :
        state.material === "transparent" ? "Every layer shows through the ones in front." : "Nearer discs hide the ones behind.";
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function render() {
      var transparent = state.material === "transparent";
      setDisabled(orderControl, transparent);
      preBox.disabled = transparent;
      var sim = simulate(layers, state);

      sim.runs.forEach(function (n, i) {
        var c = heatCells[i];
        if (n === 0) {
          c.setAttribute("class", "f-sunken");
          c.removeAttribute("fill-opacity");
        } else {
          c.setAttribute("class", "f-pix");
          c.setAttribute("fill-opacity", HEAT_STEPS[Math.min(n, 8) - 1]);
        }
      });
      drawImage(sim);

      if (transparent) rule.textContent = "Transparent layers do not write depth, so nothing can reject them. Order and the pre-pass are off: every layer is shaded wherever it covers.";
      else if (state.prepass) rule.textContent = state.material === "cutout" ? "The pre-pass runs the leaf cut-out test to find the nearest kept surface, then the main pass shades each visible pixel once." : "The pre-pass writes the nearest depth first, so the main pass shades each visible pixel exactly once, in any order.";
      else if (state.material === "cutout") rule.textContent = "The early depth test still rejects pixels behind leaves already drawn, but depth is written only after the shader keeps a pixel, so the empty corners of every card are shaded too.";
      else rule.textContent = "Early-Z shades a pixel only if it is nearer than what is already drawn. Drawing far layers first means every layer passes.";

      var avg = sim.touched ? sim.total / sim.touched : 0;
      readout.replaceChildren(
        cell("Pixel shader runs", HB.fmt.int(sim.total)),
        cell("Pixels shaded", HB.fmt.int(sim.touched)),
        cell("Average overdraw", avg.toFixed(2) + "×"),
        cell("Worst pixel", sim.max + (sim.max === 1 ? " run" : " runs")),
        cell("Wasted runs", HB.fmt.int(sim.wasted) + (sim.total ? " (" + Math.round((100 * sim.wasted) / sim.total) + "%)" : "")),
        cell("Pre-pass", transparent || !state.prepass ? "off" : HB.fmt.int(sim.prePass) + (state.material === "cutout" ? " cut-out tests" : " depth-only fragments"))
      );
      heatSvg.setAttribute("aria-label", "Heat map of " + state.count + " " + state.material + " layers: " + sim.total + " pixel shader runs over " + sim.touched + " pixels, average " + avg.toFixed(2) + ", worst pixel " + sim.max + ".");
      log.debug("render", state, sim.total, sim.max);
    }

    render();
    log.debug("ready");
  }

  HB.demos.register("overdraw-heatmap", init);
})();

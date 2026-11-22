/*
 * forest-draws.js: chapter 4.3's interactive.
 *
 * A forest of identical trees, each using one of four materials (A to D),
 * drawn four ways:
 *
 *   per-tree   one draw call per tree, in scene order, so the material
 *              changes almost every draw
 *   sorted     one draw call per tree, sorted by material first
 *   merged     every tree of one material merged into one big mesh:
 *              four draws, but each merged mesh spans the whole forest
 *   instanced  one instanced draw; the material differences move into
 *              per-instance data (a tint per tree)
 *
 * The CPU cost is an ILLUSTRATIVE model, stated on screen: a fixed cost to
 * record a draw, a larger one to change material, a tiny one per instance.
 * The point is the shape (cost grows with draws and state changes, not
 * with triangles), not the absolute numbers, which vary ten times or more
 * between engines, APIs and CPUs.
 *
 * "Cull to the camera" adds the trade-off with chapter 4.4: separate draws
 * and instances can skip trees outside the view; a merged mesh cannot,
 * because it is one object that touches every part of the forest.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("forest-draws");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- The cost model (illustrative) ---------- */

  var COST = {
    drawUs: 5,        // record one draw call: per-object constants, checks, the command
    stateUs: 15,      // change material: shader, textures, material constants
    instanceUs: 0.02  // write one instance's 80 bytes into the instance buffer
  };
  var TREE = {
    triangles: 2000,
    vertices: 1200,
    stride: 32,              // bytes per vertex (position, normal, UV)
    indexBytes: 2,           // 16-bit indices
    instanceBytes: 80        // 4 x 4 matrix (64 B) + tint (16 B)
  };
  var MESH_BYTES = TREE.vertices * TREE.stride + TREE.triangles * 3 * TREE.indexBytes;
  var MAX_TREES = 4000;
  var MATERIALS = [
    { id: "A", fill: "f-geo" },
    { id: "B", fill: "f-geo-soft s-geo" },
    { id: "C", fill: "f-lit" },
    { id: "D", fill: "f-lit-soft s-lit" }
  ];
  var MODES = [
    { value: "per-tree", label: "One draw per tree" },
    { value: "sorted", label: "Per tree, sorted" },
    { value: "merged", label: "Merged by material" },
    { value: "instanced", label: "One instanced draw" }
  ];

  /* ---------- Layout (viewBox units) ---------- */

  var VIEW = { w: 900, h: 490 };
  var FOREST = { x0: 24, x1: 876, y0: 40, y1: 214 };
  var STRIP = { x0: 24, y0: 268, cell: 7, cells: 96, h: 26 };
  var CHART = { x0: 250, x1: 850, msMax: 20, top: 334, row: 28, bar: 18 };
  // The camera used when culling is on: on the near edge, looking up and right.
  var CAMERA = { x: 330, y: 210, dir: -0.9, halfFov: 0.6 };

  function msToX(ms) {
    return CHART.x0 + (Math.min(ms, CHART.msMax) / CHART.msMax) * (CHART.x1 - CHART.x0);
  }

  /* Trees: fixed seeded positions and materials, so the first N trees are
     the same whatever the count. Materials are assigned in scene order at
     random, which is what makes unsorted drawing change state so often. */
  function makeTrees() {
    var rand = HB.rng(4031);
    var list = [];
    for (var i = 0; i < MAX_TREES; i++) {
      list.push({
        x: FOREST.x0 + 8 + rand() * (FOREST.x1 - FOREST.x0 - 16),
        y: FOREST.y0 + 8 + rand() * (FOREST.y1 - FOREST.y0 - 16),
        m: Math.floor(rand() * 4)
      });
    }
    return list;
  }

  function inView(t) {
    var dx = t.x - CAMERA.x;
    var dy = t.y - CAMERA.y;
    var a = Math.atan2(dy, dx);
    var d = a - CAMERA.dir;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) <= CAMERA.halfFov;
  }

  /* What the CPU records for one mode. Returns the command list (for the
     strip), the counts and the modelled CPU time in microseconds. */
  function plan(mode, trees, cull) {
    var visible = cull ? trees.filter(inView) : trees;
    var cmds = [];
    var draws = 0;
    var changes = 0;
    var instances = 0;
    var triangles = 0;
    var memory = 0;
    if (mode === "per-tree" || mode === "sorted") {
      var order = visible.slice();
      if (mode === "sorted") order.sort(function (a, b) { return a.m - b.m; });
      var last = -1;
      order.forEach(function (t) {
        var change = t.m !== last;
        if (change) changes++;
        last = t.m;
        draws++;
        cmds.push({ m: t.m, change: change, trees: 1 });
      });
      triangles = order.length * TREE.triangles;
    } else if (mode === "merged") {
      // One merged mesh per material, each spread over the whole forest:
      // it is drawn whole if any of it is in view, so culling saves nothing.
      MATERIALS.forEach(function (mat, m) {
        var n = trees.filter(function (t) { return t.m === m; }).length;
        if (!n) return;
        draws++;
        changes++;
        cmds.push({ m: m, change: true, trees: n });
      });
      triangles = trees.length * TREE.triangles;
      memory = trees.length * MESH_BYTES;
    } else {
      draws = visible.length ? 1 : 0;
      changes = draws;
      instances = visible.length;
      cmds.push({ m: -1, change: true, trees: visible.length });
      triangles = visible.length * TREE.triangles;
      memory = trees.length * TREE.instanceBytes;
    }
    var drawUs = draws * COST.drawUs;
    var stateUs = changes * COST.stateUs;
    var instUs = instances * COST.instanceUs;
    return {
      cmds: cmds, draws: draws, changes: changes, instances: instances, triangles: triangles,
      memory: memory, drawUs: drawUs, stateUs: stateUs, instUs: instUs, totalUs: drawUs + stateUs + instUs,
      visible: visible.length
    };
  }

  function fmtMs(us) {
    var ms = us / 1000;
    if (ms >= 10) return ms.toFixed(1) + " ms";
    if (ms >= 0.1) return ms.toFixed(2) + " ms";
    return ms.toFixed(3) + " ms";
  }

  function fmtTris(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + " M";
    if (n >= 1e3) return Math.round(n / 1e3) + " K";
    return String(n);
  }

  function init(root) {
    var trees = makeTrees();
    var state = { mode: "per-tree", count: 1000, cull: false };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Forest draws" }),
      h("span", { class: "demo-hint", text: "Pick how the forest is drawn, change the number of trees, and watch the CPU time." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Draw the forest as", MODES, state.mode, function (v) {
      state.mode = v;
      render();
    }));
    controls.appendChild(HB.slider("fd-count", "Trees", {
      min: 100, max: MAX_TREES, step: 100, value: state.count,
      format: function (v) { return HB.fmt.int(v); }
    }, function (v) {
      state.count = v;
      render();
    }));
    var cullBox = h("input", { type: "checkbox", id: "fd-cull" });
    cullBox.addEventListener("change", function () {
      state.cull = cullBox.checked;
      render();
    });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Culling" }),
      h("div", { class: "checks" }, [h("label", { for: "fd-cull" }, [cullBox, "Skip trees outside the camera's view"])])
    ]));
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", { class: "dg is-wide", viewBox: "0 0 " + VIEW.w + " " + VIEW.h, role: "img" });
    stage.appendChild(svg);
    root.appendChild(stage);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);
    root.appendChild(h("p", {
      class: "demo-hint",
      text: "Illustrative cost model: " + COST.drawUs + " µs to record a draw call, " + COST.stateUs +
        " µs to change material, " + COST.instanceUs + " µs to write one tree's instance data. Real engines, APIs and CPUs differ by ten times or more; the shape holds."
    }));

    var layerStatic = svgEl("g", null, svg);
    var layerForest = svgEl("g", null, svg);
    var layerStrip = svgEl("g", null, svg);
    var layerChart = svgEl("g", null, svg);

    /* Labels, the chart axis and the legend never change. */
    (function drawStatic() {
      var lx = FOREST.x1;
      svgEl("text", { x: lx - 4 * 34 - 52, y: 26, class: "t-caps end", text: "MATERIAL" }, layerStatic);
      MATERIALS.forEach(function (mat, i) {
        var x = lx - (3 - i) * 34 - 30;
        svgEl("circle", { cx: x, cy: 22, r: 5, class: mat.fill }, layerStatic);
        svgEl("text", { x: x + 9, y: 26, class: "t-mono t-small", text: mat.id }, layerStatic);
      });
      svgEl("text", { x: STRIP.x0, y: STRIP.y0 - 10, class: "t-caps", text: "WHAT THE CPU RECORDS, IN ORDER" }, layerStatic);
      svgEl("text", { x: CHART.x0 - 230, y: CHART.top - 12, class: "t-caps", text: "CPU TIME TO RECORD THE FOREST · ILLUSTRATIVE MODEL" }, layerStatic);
      var axisY = CHART.top + 4 * CHART.row + 6;
      svgEl("line", { x1: CHART.x0, y1: axisY, x2: CHART.x1, y2: axisY, class: "s-strong" }, layerStatic);
      [0, 5, 10, 15, 20].forEach(function (ms) {
        var x = msToX(ms);
        svgEl("line", { x1: x, y1: axisY, x2: x, y2: axisY + 5, class: "s-strong" }, layerStatic);
        svgEl("text", { x: x, y: axisY + 18, class: "t-mono t-muted t-small mid", text: ms + " ms" }, layerStatic);
      });
      [[16.7, "60 fps frame"], [8.3, "120 fps frame"]].forEach(function (pair) {
        var x = msToX(pair[0]);
        svgEl("line", { x1: x, y1: CHART.top - 4, x2: x, y2: axisY, class: "s-pix dash" }, layerStatic);
        svgEl("text", { x: x + 4, y: axisY + 32, class: "t-small t-pix", text: pair[1] + " " + pair[0] + " ms" }, layerStatic);
      });
      var ly = axisY + 32;
      svgEl("rect", { x: 24, y: ly - 9, width: 12, height: 10, class: "f-acc" }, layerStatic);
      svgEl("text", { x: 40, y: ly, class: "t-small", text: "draw calls" }, layerStatic);
      svgEl("rect", { x: 110, y: ly - 9, width: 12, height: 10, class: "f-acc-soft s-acc" }, layerStatic);
      svgEl("text", { x: 126, y: ly, class: "t-small", text: "material changes" }, layerStatic);
      svgEl("rect", { x: 236, y: ly - 9, width: 12, height: 10, class: "f-geo" }, layerStatic);
      svgEl("text", { x: 252, y: ly, class: "t-small", text: "instance data" }, layerStatic);
    })();

    function drawForest(list, p) {
      HB.svg.clear(layerForest);
      var r = list.length <= 1000 ? 3.4 : list.length <= 2000 ? 2.7 : 2.1;
      if (state.cull) {
        var len = 1100;
        var a0 = CAMERA.dir - CAMERA.halfFov;
        var a1 = CAMERA.dir + CAMERA.halfFov;
        svgEl("polygon", {
          points: [CAMERA.x, CAMERA.y, CAMERA.x + len * Math.cos(a0), CAMERA.y + len * Math.sin(a0),
            CAMERA.x + len * Math.cos(a1), CAMERA.y + len * Math.sin(a1)].join(" "),
          class: "f-acc-soft", "clip-path": "url(#fd-clip)"
        }, layerForest);
      }
      svgEl("rect", { x: FOREST.x0, y: FOREST.y0, width: FOREST.x1 - FOREST.x0, height: FOREST.y1 - FOREST.y0, class: "s-line", rx: 6 }, layerForest);
      var merged = state.mode === "merged";
      var instanced = state.mode === "instanced";
      list.forEach(function (t) {
        var shown = !state.cull || merged || inView(t);
        svgEl("circle", {
          cx: t.x.toFixed(1), cy: t.y.toFixed(1), r: r,
          class: shown ? MATERIALS[t.m].fill : "f-line"
        }, layerForest);
      });
      if (state.cull) {
        svgEl("circle", { cx: CAMERA.x, cy: CAMERA.y, r: 7, class: "f-acc" }, layerForest);
        svgEl("text", { x: CAMERA.x + 12, y: CAMERA.y + 4, class: "t-small t-acc t-strong", text: "camera" }, layerForest);
      }
      var note = merged
        ? "Each merged mesh spreads across the whole forest, so it is drawn whole whenever any of it is in view."
        : instanced
          ? "One mesh, one material; each tree's position and tint come from per-instance data."
          : "Every tree is its own object with its own draw call.";
      svgEl("text", { x: FOREST.x0, y: FOREST.y1 + 18, class: "t-small t-muted", text: note }, layerForest);
      if (state.cull) {
        var culled = merged ? 0 : list.length - p.visible;
        svgEl("text", {
          x: FOREST.x1, y: FOREST.y1 + 18, class: "t-small t-acc end",
          text: merged ? "culling skips nothing" : HB.fmt.int(culled) + " trees culled"
        }, layerForest);
      }
    }

    function drawStrip(p) {
      HB.svg.clear(layerStrip);
      var y = STRIP.y0;
      var x = STRIP.x0;
      if (state.mode === "per-tree" || state.mode === "sorted") {
        var shown = p.cmds.slice(0, STRIP.cells);
        var shownChanges = 0;
        shown.forEach(function (c, i) {
          var cx = x + i * STRIP.cell;
          svgEl("rect", { x: cx, y: y, width: STRIP.cell - 1, height: STRIP.h, class: MATERIALS[c.m].fill }, layerStrip);
          if (c.change) {
            shownChanges++;
            svgEl("line", { x1: cx - 0.5, y1: y - 4, x2: cx - 0.5, y2: y + STRIP.h + 4, class: "s-acc w15" }, layerStrip);
          }
        });
        var endX = x + shown.length * STRIP.cell;
        var rest = p.cmds.length - shown.length;
        svgEl("text", {
          x: endX + 8, y: y + 11, class: "t-small",
          text: rest > 0 ? "… " + HB.fmt.int(rest) + " more draws" : HB.fmt.int(p.cmds.length) + " draws"
        }, layerStrip);
        svgEl("text", {
          x: endX + 8, y: y + 25, class: "t-small t-acc",
          text: HB.fmt.int(shownChanges) + " changes in the first " + shown.length
        }, layerStrip);
      } else if (state.mode === "merged") {
        var w = 200;
        p.cmds.forEach(function (c, i) {
          var cx = x + i * (w + 6);
          svgEl("rect", { x: cx, y: y, width: w, height: STRIP.h, class: "f-surface s-strong" }, layerStrip);
          svgEl("circle", { cx: cx + 14, cy: y + STRIP.h / 2, r: 6, class: MATERIALS[c.m].fill }, layerStrip);
          svgEl("line", { x1: cx - 0.5, y1: y - 4, x2: cx - 0.5, y2: y + STRIP.h + 4, class: "s-acc w15" }, layerStrip);
          svgEl("text", { x: cx + 28, y: y + 17, class: "t-small t-strong", text: "merged mesh " + MATERIALS[c.m].id + " · " + HB.fmt.int(c.trees) + " trees" }, layerStrip);
        });
      } else {
        var wi = 300;
        svgEl("rect", { x: x, y: y, width: wi, height: STRIP.h, class: "f-acc-soft s-acc" }, layerStrip);
        svgEl("line", { x1: x - 0.5, y1: y - 4, x2: x - 0.5, y2: y + STRIP.h + 4, class: "s-acc w15" }, layerStrip);
        svgEl("text", { x: x + wi / 2, y: y + 17, class: "t-small t-strong mid", text: "1 draw · " + HB.fmt.int(p.instances) + " instances" }, layerStrip);
        svgEl("text", { x: x + wi + 10, y: y + 17, class: "t-small t-muted", text: "+ an instance buffer of " + HB.fmt.bytes(p.instances * TREE.instanceBytes) + " written this frame" }, layerStrip);
      }
    }

    function drawChart(list) {
      HB.svg.clear(layerChart);
      MODES.forEach(function (m, i) {
        var p = plan(m.value, list, state.cull);
        var y = CHART.top + i * CHART.row;
        var on = m.value === state.mode;
        svgEl("text", { x: CHART.x0 - 230, y: y + 13, class: on ? "t-strong t-acc" : "t-muted", text: m.label }, layerChart);
        svgEl("text", { x: CHART.x0 - 10, y: y + 13, class: "t-mono t-small end " + (on ? "t-acc" : "t-muted"), text: HB.fmt.int(p.draws) + " draws" }, layerChart);
        var parts = [[p.drawUs, "f-acc"], [p.stateUs, "f-acc-soft s-acc"], [p.instUs, "f-geo"]];
        var usSoFar = 0;
        parts.forEach(function (part) {
          if (part[0] <= 0) return;
          var xa = msToX(usSoFar / 1000);
          usSoFar += part[0];
          var xb = msToX(usSoFar / 1000);
          var wid = Math.max(xb - xa, 1);
          svgEl("rect", { x: xa, y: y, width: wid, height: CHART.bar, class: part[1], opacity: on ? 1 : 0.55 }, layerChart);
        });
        var total = p.totalUs / 1000;
        var end = msToX(total);
        var over = total > CHART.msMax;
        // Long bars carry their value inside, so it never sits on a budget line.
        var inside = over || end - CHART.x0 > 160;
        svgEl("text", {
          x: inside ? end - 8 : end + 6, y: y + 13,
          class: "t-mono t-small " + (inside ? "end t-acc " : "") + (on ? "t-strong" : "t-muted"),
          text: fmtMs(p.totalUs) + (over ? ", off the scale" : "")
        }, layerChart);
        if (on) {
          svgEl("rect", { x: CHART.x0 - 236, y: y - 5, width: CHART.x1 - CHART.x0 + 236 + 46, height: CHART.bar + 10, rx: 4, class: "s-acc" }, layerChart);
        }
      });
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function render() {
      var list = trees.slice(0, state.count);
      var p = plan(state.mode, list, state.cull);
      drawForest(list, p);
      drawStrip(p);
      drawChart(list);
      readout.replaceChildren(
        cell("Draw calls", HB.fmt.int(p.draws)),
        cell("Material changes", HB.fmt.int(p.changes)),
        cell("CPU time (model)", fmtMs(p.totalUs)),
        cell("Triangles to the GPU", fmtTris(p.triangles)),
        cell("Extra memory", p.memory ? HB.fmt.bytes(p.memory) : "none")
      );
      var label = MODES.filter(function (m) { return m.value === state.mode; })[0].label;
      svg.setAttribute("aria-label", "A forest of " + HB.fmt.int(state.count) + " trees in four materials, drawn as: " + label +
        (state.cull ? ", with culling to the camera view" : "") + ". " + HB.fmt.int(p.draws) + " draw calls, " +
        HB.fmt.int(p.changes) + " material changes, about " + fmtMs(p.totalUs) + " of CPU time in the illustrative model, " +
        fmtTris(p.triangles) + " triangles for the GPU.");
      root.setAttribute("data-draws", String(p.draws));
    }

    // Clip for the camera wedge, so it stays inside the forest panel.
    var defs = svgEl("defs", null, svg);
    var clip = svgEl("clipPath", { id: "fd-clip" }, defs);
    svgEl("rect", { x: FOREST.x0, y: FOREST.y0, width: FOREST.x1 - FOREST.x0, height: FOREST.y1 - FOREST.y0, rx: 6 }, clip);
    svg.insertBefore(defs, svg.firstChild);

    render();
    log.debug("ready");
  }

  HB.demos.register("forest-draws", init);
})();

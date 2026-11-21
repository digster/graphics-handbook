/*
 * horizon-explorer.js: chapter 8.3's interactive.
 *
 * A side-on slice through a small scene, seen by a camera looking straight
 * down. The depth buffer therefore holds, for each x, the height of the
 * topmost surface: a heightfield. Point P sits on that heightfield and can
 * be dragged. Three estimates of P's sky visibility (1 = open, 0 = blocked)
 * are computed and compared:
 *
 *   Ground truth  rays cast against the REAL geometry, cosine weighted.
 *                 Sees under the table and past the screen edge.
 *   SSAO          random points in the half-disk of radius R, tested against
 *                 the depth buffer (below the surface = occluded). Not
 *                 cosine weighted, and noisy: each pixel gets other samples.
 *   GTAO          march the depth buffer left and right in steps, keep the
 *                 highest elevation found on each side (the horizons), then
 *                 integrate the visible arc exactly: (cos hL + cos hR) / 2.
 *
 * The scene is chosen so the two classic screen-space blind spots show:
 * the gap under the table (the depth buffer thinks it is solid) and the
 * pillar beyond the right screen edge (the depth buffer has no data there).
 *
 * Units: 1 world unit = 0.5 m. The plot under the slice repeats all three
 * estimates for every position along the floor.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("horizon-explorer");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Scene (world units, y up) ---------- */

  var SCREEN = { x0: 0, x1: 20 };
  var WORLD = { x0: -1.5, x1: 23.5, y0: -0.8, y1: 7 };
  var BOXES = [
    { name: "floor", x0: -1.5, x1: 23.5, y0: -1, y1: 0 },
    { name: "wall", x0: 0, x1: 1.6, y0: 0, y1: 5.5 },
    { name: "table", x0: 8.5, x1: 12.5, y0: 2.0, y1: 2.4 },
    { name: "crate", x0: 15, x1: 17.5, y0: 0, y1: 1.6 },
    { name: "pillar", x0: 20.6, x1: 22, y0: 0, y1: 6 }
  ];
  var M_PER_UNIT = 0.5;

  /* What the depth buffer knows: the top surface at x, inside the screen. */
  function depthHeight(x) {
    if (x < SCREEN.x0 || x > SCREEN.x1) return null;
    var top = -Infinity;
    for (var i = 0; i < BOXES.length; i++) {
      var b = BOXES[i];
      if (x >= b.x0 && x <= b.x1 && b.y1 > top) top = b.y1;
    }
    return top;
  }

  /* Distance along a ray to the nearest real box, or Infinity. Slab test. */
  function rayHit(ox, oy, dx, dy) {
    var best = Infinity;
    for (var i = 0; i < BOXES.length; i++) {
      var b = BOXES[i];
      var tmin = -Infinity;
      var tmax = Infinity;
      if (Math.abs(dx) < 1e-9) {
        if (ox < b.x0 || ox > b.x1) continue;
      } else {
        var tx1 = (b.x0 - ox) / dx;
        var tx2 = (b.x1 - ox) / dx;
        tmin = Math.max(tmin, Math.min(tx1, tx2));
        tmax = Math.min(tmax, Math.max(tx1, tx2));
      }
      if (Math.abs(dy) < 1e-9) {
        if (oy < b.y0 || oy > b.y1) continue;
      } else {
        var ty1 = (b.y0 - oy) / dy;
        var ty2 = (b.y1 - oy) / dy;
        tmin = Math.max(tmin, Math.min(ty1, ty2));
        tmax = Math.min(tmax, Math.max(ty1, ty2));
      }
      if (tmax >= Math.max(tmin, 1e-6) && tmin < best) best = Math.max(tmin, 0);
    }
    return best;
  }

  /* ---------- The three estimates ---------- */

  /* Ground truth: N rays over the upper half circle. Angle a runs from 0
     (along +x) to PI (along -x); the normal is straight up, so a ray's
     cosine weight is sin(a). Returns visibility and, optionally, the rays. */
  function groundTruth(px, py, radius, n, keepRays) {
    var open = 0;
    var total = 0;
    var rays = keepRays ? [] : null;
    for (var i = 0; i < n; i++) {
      var a = ((i + 0.5) / n) * Math.PI;
      var w = Math.sin(a);
      var dx = Math.cos(a);
      var dy = Math.sin(a);
      var t = rayHit(px, py + 1e-4, dx, dy);
      var blocked = t <= radius;
      total += w;
      if (!blocked) open += w;
      if (rays) rays.push({ dx: dx, dy: dy, t: blocked ? t : radius, blocked: blocked });
    }
    return { v: open / total, rays: rays };
  }

  /* GTAO on one slice: K steps each side; horizons are elevations above
     P's tangent line (the floor). Samples outside the screen or beyond the
     radius are ignored, exactly as a real implementation must. */
  function gtao(px, py, radius, steps, keepSamples) {
    var horizon = [0, 0];
    var hit = [null, null];
    var samples = keepSamples ? [] : null;
    [-1, 1].forEach(function (side, s) {
      for (var k = 1; k <= steps; k++) {
        var sx = px + side * (k / steps) * radius;
        var sy = depthHeight(sx);
        if (sy === null) {
          if (samples) samples.push({ x: sx, y: null, side: s });
          continue;
        }
        if (samples) samples.push({ x: sx, y: sy, side: s });
        var ddx = Math.abs(sx - px);
        var ddy = sy - py;
        if (Math.sqrt(ddx * ddx + ddy * ddy) > radius) continue;
        var elev = Math.atan2(ddy, ddx);
        if (elev > horizon[s]) {
          horizon[s] = elev;
          hit[s] = { x: sx, y: sy };
        }
      }
    });
    return {
      v: (Math.cos(horizon[0]) + Math.cos(horizon[1])) / 2,
      left: horizon[0],
      right: horizon[1],
      hit: hit,
      samples: samples
    };
  }

  /* SSAO: K random points in the upper half-disk, area-uniform. A point is
     occluded when it is below the depth-buffer surface by less than R
     (the range check that stops far-away walls from counting). */
  function ssao(px, py, radius, count, seed, keepSamples) {
    var rand = HB.rng(seed);
    var occluded = 0;
    var samples = keepSamples ? [] : null;
    for (var i = 0; i < count; i++) {
      var r = radius * Math.sqrt(rand());
      var a = rand() * Math.PI;
      var sx = px + r * Math.cos(a);
      var sy = py + 1e-3 + r * Math.sin(a);
      var surface = depthHeight(sx);
      var occ = surface !== null && sy < surface && surface - sy < radius;
      if (occ) occluded++;
      if (samples) samples.push({ x: sx, y: sy, occ: occ, offscreen: surface === null });
    }
    return { v: 1 - occluded / count, samples: samples };
  }

  /* ---------- Drawing ---------- */

  var VIEW = { w: 820, h: 452 };
  var SCALE = 31;
  function sx(x) { return 30 + (x - WORLD.x0) * SCALE; }
  function sy(y) { return 252 - y * SCALE; }
  function fromSx(px) { return (px - 30) / SCALE + WORLD.x0; }
  var PLOT = { top: 300, bottom: 420 };
  function py(v) { return PLOT.bottom - v * (PLOT.bottom - PLOT.top); }

  function init(root) {
    // Starts beside the table, where the screen-space blind spot shows.
    var state = {
      x: 7.6,
      radius: 3,
      method: "gtao",
      ssaoCount: 8,
      gtaoSteps: 8,
      showDepth: true
    };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Horizon explorer" }),
      h("span", { class: "demo-hint", text: "Drag P along the floor, or focus it and use the arrow keys." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Show in the slice", [
      { value: "truth", label: "Ground truth rays" },
      { value: "ssao", label: "SSAO samples" },
      { value: "gtao", label: "GTAO horizons" }
    ], state.method, function (v) { state.method = v; drawSlice(); }));
    controls.appendChild(HB.slider("hx-radius", "Radius", {
      min: 1, max: 6, step: 0.1, value: state.radius,
      format: function (v) { return (v * M_PER_UNIT).toFixed(2) + " m"; }
    }, function (v) { state.radius = v; drawAll(); }));
    controls.appendChild(HB.segmented("SSAO samples", [
      { value: 4, label: "4" }, { value: 8, label: "8" }, { value: 16, label: "16" }, { value: 32, label: "32" }
    ], state.ssaoCount, function (v) { state.ssaoCount = v; drawAll(); }));
    controls.appendChild(HB.segmented("GTAO steps per side", [
      { value: 2, label: "2" }, { value: 4, label: "4" }, { value: 8, label: "8" }, { value: 16, label: "16" }
    ], state.gtaoSteps, function (v) { state.gtaoSteps = v; drawAll(); }));
    var depthBox = h("input", { type: "checkbox", id: "hx-depth", checked: state.showDepth });
    depthBox.addEventListener("change", function () { state.showDepth = depthBox.checked; drawSlice(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Overlay" }),
      h("div", { class: "checks" }, [h("label", { for: "hx-depth" }, [depthBox, "What the depth buffer sees"])])
    ]));
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "group",
      "aria-label": "Side view of a floor with a wall, a table, a crate and, past the right screen edge, a pillar. Below it, a plot of sky visibility along the floor for ground truth, GTAO and SSAO."
    });
    stage.appendChild(svg);
    root.appendChild(stage);

    var defs = svgEl("defs", null, svg);
    var pat = svgEl("pattern", { id: "hx-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "s-pix", "stroke-width": 1.4 }, pat);

    var layerStatic = svgEl("g", null, svg);
    var layerDepth = svgEl("g", null, svg);
    var layerGeo = svgEl("g", null, svg);
    var layerMethod = svgEl("g", null, svg);
    var layerPlot = svgEl("g", null, svg);
    var layerMarker = svgEl("g", null, svg);
    var handle = svgEl("g", { "aria-label": "Point P", "aria-valuemin": SCREEN.x0, "aria-valuemax": SCREEN.x1 }, svg);
    var handleRing = svgEl("circle", { r: 13, class: "f-acc-soft s-acc handle-ring" }, handle);
    var handleDot = svgEl("circle", { r: 6, class: "f-acc" }, handle);
    var handleLabel = svgEl("text", { class: "t-acc t-strong mid", text: "P" }, handle);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    /* Off-screen zones, plot frame and legend never change. */
    (function drawStatic() {
      svgEl("rect", { x: sx(WORLD.x0), y: 16, width: sx(SCREEN.x0) - sx(WORLD.x0), height: 260, class: "f-sunken" }, layerStatic);
      svgEl("rect", { x: sx(SCREEN.x1), y: 16, width: sx(WORLD.x1) - sx(SCREEN.x1), height: 260, class: "f-sunken" }, layerStatic);
      svgEl("line", { x1: sx(SCREEN.x0), y1: 16, x2: sx(SCREEN.x0), y2: 276, class: "s-strong dash" }, layerStatic);
      svgEl("line", { x1: sx(SCREEN.x1), y1: 16, x2: sx(SCREEN.x1), y2: 276, class: "s-strong dash" }, layerStatic);
      svgEl("text", { x: sx(SCREEN.x1) + 6, y: 30, class: "t-caps", text: "OFF SCREEN" }, layerStatic);
      svgEl("text", { x: sx(SCREEN.x0) + 6, y: 30, class: "t-caps", text: "SCREEN EDGE" }, layerStatic);
      svgEl("text", { x: sx(SCREEN.x1) - 6, y: 30, class: "t-caps end", text: "SCREEN EDGE" }, layerStatic);

      svgEl("text", { x: sx(SCREEN.x0), y: PLOT.top - 12, class: "t-caps", text: "SKY VISIBILITY ALONG THE FLOOR" }, layerStatic);
      svgEl("line", { x1: sx(SCREEN.x0), y1: py(1), x2: sx(SCREEN.x1), y2: py(1), class: "s-line" }, layerStatic);
      svgEl("line", { x1: sx(SCREEN.x0), y1: py(0.5), x2: sx(SCREEN.x1), y2: py(0.5), class: "s-line" }, layerStatic);
      svgEl("line", { x1: sx(SCREEN.x0), y1: py(0), x2: sx(SCREEN.x1), y2: py(0), class: "s-strong" }, layerStatic);
      svgEl("text", { x: sx(SCREEN.x0) - 6, y: py(1) + 4, class: "t-mono t-muted t-small end", text: "1" }, layerStatic);
      svgEl("text", { x: sx(SCREEN.x0) - 6, y: py(0.5) + 4, class: "t-mono t-muted t-small end", text: "0.5" }, layerStatic);
      svgEl("text", { x: sx(SCREEN.x0) - 6, y: py(0) + 4, class: "t-mono t-muted t-small end", text: "0" }, layerStatic);

      var lx = sx(SCREEN.x1) + 8;
      svgEl("line", { x1: lx, y1: PLOT.top + 10, x2: lx + 22, y2: PLOT.top + 10, class: "s-ink w2" }, layerStatic);
      svgEl("text", { x: lx + 28, y: PLOT.top + 14, class: "t-small", text: "ground truth" }, layerStatic);
      svgEl("line", { x1: lx, y1: PLOT.top + 32, x2: lx + 22, y2: PLOT.top + 32, class: "s-acc w2" }, layerStatic);
      svgEl("text", { x: lx + 28, y: PLOT.top + 36, class: "t-small t-acc", text: "GTAO" }, layerStatic);
      svgEl("line", { x1: lx, y1: PLOT.top + 54, x2: lx + 22, y2: PLOT.top + 54, class: "s-pix" }, layerStatic);
      svgEl("text", { x: lx + 28, y: PLOT.top + 58, class: "t-small t-pix", text: "SSAO" }, layerStatic);
    })();

    function drawGeometry() {
      HB.svg.clear(layerDepth);
      HB.svg.clear(layerGeo);
      if (state.showDepth) {
        // Depth buffer view: solid from the top surface down, on screen only.
        var pts = [sx(SCREEN.x0) + "," + sy(WORLD.y0)];
        for (var x = SCREEN.x0; x <= SCREEN.x1 + 1e-9; x += 0.05) {
          pts.push(sx(x) + "," + sy(depthHeight(x)));
        }
        pts.push(sx(SCREEN.x1) + "," + sy(WORLD.y0));
        svgEl("polygon", { points: pts.join(" "), class: "f-pix-soft" }, layerDepth);
        // The gap under the table, which the depth buffer believes is solid.
        svgEl("rect", { x: sx(8.5), y: sy(2.0), width: 4 * SCALE, height: 2.0 * SCALE, fill: "url(#hx-hatch)" }, layerDepth);
        svgEl("text", { x: sx(10.5), y: sy(1.0) + 4, class: "t-small t-pix t-strong mid", text: "depth buffer: solid" }, layerDepth);
        svgEl("text", { x: sx(10.5), y: sy(1.0) + 19, class: "t-small t-pix mid", text: "really: open" }, layerDepth);
      }
      BOXES.forEach(function (b) {
        var x0 = Math.max(b.x0, WORLD.x0);
        var x1 = Math.min(b.x1, WORLD.x1);
        var y0 = Math.max(b.y0, WORLD.y0);
        svgEl("rect", {
          x: sx(x0), y: sy(b.y1), width: (x1 - x0) * SCALE, height: (b.y1 - y0) * SCALE,
          class: b.name === "floor" ? "f-solid" : "f-solid s-ink"
        }, layerGeo);
      });
      svgEl("line", { x1: sx(WORLD.x0), y1: sy(0), x2: sx(WORLD.x1), y2: sy(0), class: "s-ink" }, layerGeo);
      svgEl("text", { x: sx(0.8), y: sy(3), class: "t-small t-muted mid", text: "wall" }, layerGeo);
      svgEl("text", { x: sx(10.5), y: sy(2.4) - 6, class: "t-small t-muted mid", text: "table top" }, layerGeo);
      svgEl("text", { x: sx(16.25), y: sy(0.8) + 4, class: "t-small t-muted mid", text: "crate" }, layerGeo);
      svgEl("text", { x: sx(21.3), y: sy(3), class: "t-small t-muted mid", text: "pillar" }, layerGeo);
    }

    function pointY() {
      return depthHeight(state.x);
    }

    function drawSlice() {
      drawGeometry();
      HB.svg.clear(layerMethod);
      var px0 = state.x;
      var py0 = pointY();
      var R = state.radius;
      var cx = sx(px0);
      var cy = sy(py0);
      var rr = R * SCALE;

      // Radius: the half circle that bounds every method.
      svgEl("path", { d: "M" + (cx - rr) + "," + cy + " A" + rr + "," + rr + " 0 0 1 " + (cx + rr) + "," + cy, class: "s-muted dot-dash" }, layerMethod);

      if (state.method === "truth") {
        var gt = groundTruth(px0, py0, R, 36, true);
        gt.rays.forEach(function (ray) {
          var ex = cx + ray.dx * ray.t * SCALE;
          var ey = cy - ray.dy * ray.t * SCALE;
          svgEl("line", { x1: cx, y1: cy, x2: ex, y2: ey, class: ray.blocked ? "s-muted" : "s-acc" }, layerMethod);
          if (ray.blocked) svgEl("circle", { cx: ex, cy: ey, r: 2.2, class: "f-pix" }, layerMethod);
        });
      } else if (state.method === "ssao") {
        var ss = ssao(px0, py0, R, state.ssaoCount, seedFor(px0), true);
        ss.samples.forEach(function (s) {
          svgEl("circle", {
            cx: sx(s.x), cy: sy(s.y), r: 4,
            class: s.occ ? "f-pix" : s.offscreen ? "f-surface s-muted" : "f-surface s-acc w15"
          }, layerMethod);
        });
      } else {
        var g = gtao(px0, py0, R, state.gtaoSteps, true);
        g.samples.forEach(function (s) {
          if (s.y === null) return;
          svgEl("circle", { cx: sx(s.x), cy: sy(s.y), r: 2.6, class: "f-muted" }, layerMethod);
        });
        // Visible arc between the two horizons.
        var ar = Math.min(rr, 90);
        var aRight = g.right;
        var aLeft = Math.PI - g.left;
        var x1 = cx + ar * Math.cos(aRight);
        var y1 = cy - ar * Math.sin(aRight);
        var x2 = cx + ar * Math.cos(aLeft);
        var y2 = cy - ar * Math.sin(aLeft);
        svgEl("path", { d: "M" + cx + "," + cy + " L" + x1 + "," + y1 + " A" + ar + "," + ar + " 0 0 0 " + x2 + "," + y2 + " Z", class: "f-acc-soft", "fill-opacity": 0.8 }, layerMethod);
        svgEl("path", { d: "M" + x1 + "," + y1 + " A" + ar + "," + ar + " 0 0 0 " + x2 + "," + y2, class: "s-acc w3" }, layerMethod);
        [["right", 1], ["left", -1]].forEach(function (pair, i) {
          var elev = i === 0 ? g.right : g.left;
          var dir = pair[1];
          var ex = cx + dir * rr * Math.cos(elev);
          var ey = cy - rr * Math.sin(elev);
          svgEl("line", { x1: cx, y1: cy, x2: ex, y2: ey, class: "s-acc w15 dash" }, layerMethod);
          var hitPt = g.hit[i === 0 ? 1 : 0];
          if (hitPt) svgEl("circle", { cx: sx(hitPt.x), cy: sy(hitPt.y), r: 4.5, class: "f-acc" }, layerMethod);
          var deg = Math.round((elev * 180) / Math.PI);
          if (deg === 0) return; // nothing rises on this side: no horizon to label
          svgEl("text", {
            x: ex + dir * 6, y: ey - 4, class: "t-small t-acc " + (dir > 0 ? "" : "end"),
            text: "horizon " + deg + "°"
          }, layerMethod);
        });
      }

      handle.setAttribute("transform", "translate(" + cx + "," + cy + ")");
      handleLabel.setAttribute("y", -18);
      drawMarker();
      drawReadout();
    }

    /* SSAO rotates its pattern per pixel; use the x position as the pixel. */
    function seedFor(x) {
      return 9001 + Math.round(x * 10) * 7919;
    }

    var curves = null;

    function computeCurves() {
      var pts = { truth: [], gtao: [], ssao: [] };
      for (var x = SCREEN.x0 + 0.05; x <= SCREEN.x1 - 0.05 + 1e-9; x += 0.1) {
        var y = depthHeight(x);
        pts.truth.push([x, groundTruth(x, y, state.radius, 128, false).v]);
        pts.gtao.push([x, gtao(x, y, state.radius, state.gtaoSteps, false).v]);
        pts.ssao.push([x, ssao(x, y, state.radius, state.ssaoCount, seedFor(x), false).v]);
      }
      return pts;
    }

    function drawPlot() {
      HB.svg.clear(layerPlot);
      curves = computeCurves();
      function line(list, cls) {
        var d = list.map(function (p, i) { return (i ? "L" : "M") + sx(p[0]).toFixed(1) + "," + py(p[1]).toFixed(1); }).join(" ");
        svgEl("path", { d: d, class: cls }, layerPlot);
      }
      line(curves.ssao, "s-pix");
      line(curves.truth, "s-ink w2");
      line(curves.gtao, "s-acc w2");
    }

    function drawMarker() {
      HB.svg.clear(layerMarker);
      var x = sx(state.x);
      svgEl("line", { x1: x, y1: PLOT.top - 4, x2: x, y2: PLOT.bottom, class: "s-acc dot-dash" }, layerMarker);
    }

    function drawReadout() {
      var y = pointY();
      var gt = groundTruth(state.x, y, state.radius, 256, false).v;
      var g = gtao(state.x, y, state.radius, state.gtaoSteps, false).v;
      var s = ssao(state.x, y, state.radius, state.ssaoCount, seedFor(state.x), false).v;
      function cell(label, value, cls) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v " + (cls || ""), text: value })]);
      }
      function diff(v) {
        var d = v - gt;
        return (d >= 0 ? "+" : "−") + Math.abs(d).toFixed(2);
      }
      readout.replaceChildren(
        cell("P is at", (state.x * M_PER_UNIT).toFixed(2) + " m"),
        cell("Ground truth", gt.toFixed(2)),
        cell("GTAO", g.toFixed(2) + " (" + diff(g) + ")"),
        cell("SSAO", s.toFixed(2) + " (" + diff(s) + ")")
      );
      handle.setAttribute("aria-valuenow", state.x.toFixed(1));
      handle.setAttribute("aria-valuetext", "P at " + (state.x * M_PER_UNIT).toFixed(2) + " metres. Ground truth " + gt.toFixed(2) + ", GTAO " + g.toFixed(2) + ", SSAO " + s.toFixed(2));
    }

    function drawAll() {
      drawPlot();
      drawSlice();
    }

    function moveTo(x) {
      state.x = Math.min(SCREEN.x1 - 0.05, Math.max(SCREEN.x0 + 0.05, x));
      drawSlice();
    }

    HB.draggable(svg, handle, {
      onDrag: function (pt) { moveTo(fromSx(pt.x)); },
      onKey: function (dir, big) { moveTo(state.x + dir * (big ? 1 : 0.1)); }
    });

    drawAll();
    log.debug("ready");
  }

  HB.demos.register("horizon-explorer", init);
})();

/*
 * shadow-bias-bench.js: chapter 7.4's interactive.
 *
 * A side view (x right, y up, metres) of a floor sloping up at 8°, a box
 * resting on it and a thin board standing in it, lit by a directional light
 * 38° above the horizon from the left. Everything is exact 2D geometry:
 * the scene is three convex polygons.
 *
 * The shadow map is one row of R texels across the light's view. Texel i
 * stores the depth (distance along the light direction) of the first
 * surface its centre ray hits. That row is drawn at the top, and the stored
 * depths are drawn in the scene as a staircase of short steps, one per
 * texel, each as wide as the texel.
 *
 * Every lit-facing surface is sampled every 2 cm. For each sample the
 * shadow test runs exactly as a shader would:
 *   1. normal offset: move the point along its normal by k × texel size
 *   2. project it into the light: texel coordinate u, depth z
 *   3. bias: subtract constant + slope × texel × tan θ from z, where θ is
 *      the angle between the normal and the light (the depth slope across
 *      one texel), capped at tan θ = 10
 *   4. lit when the biased depth is not behind the stored depth.
 * With PCF on, the test runs at three texel offsets (−1, 0, +1), each with
 * linear (bilinear in 2D) weighting between the two nearest texels, and the
 * results are averaged.
 *
 * Ground truth is an exact ray cast from each sample towards the light.
 * The readouts compare the two: acne is lit surface reported as shadowed,
 * missing shadow is shadowed surface reported as lit.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("shadow-bias-bench");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- Scene ---------- */

  var DEG = Math.PI / 180;
  var ELEV = 38 * DEG;                                  // light elevation
  var D = [Math.cos(ELEV), -Math.sin(ELEV)];            // direction light travels
  var L = [-D[0], -D[1]];                                // towards the light
  var U = [Math.sin(ELEV), Math.cos(ELEV)];             // across the light's view
  var SLOPE = 8 * DEG;
  var TS = Math.tan(SLOPE);
  function floorY(x) { return TS * x; }

  function rotRect(cx, baseY, w, hgt, ang) {
    // Rectangle standing on (cx, baseY), rotated by ang about that point.
    var c = Math.cos(ang), s = Math.sin(ang);
    var local = [[-w / 2, -0.3], [w / 2, -0.3], [w / 2, hgt], [-w / 2, hgt]];
    return local.map(function (p) { return [cx + p[0] * c - p[1] * s, baseY + p[0] * s + p[1] * c]; });
  }

  var FLOOR = [[-0.6, -1.2], [11.2, -1.2], [11.2, floorY(11.2)], [-0.6, floorY(-0.6)]];   // counter-clockwise, like the others
  var BOX = rotRect(3.1, floorY(3.1), 1.4, 1.2, SLOPE);
  var BOARD = [[7.47, floorY(7.47) - 0.3], [7.53, floorY(7.53) - 0.3], [7.53, floorY(7.5) + 1.5], [7.47, floorY(7.5) + 1.5]];
  var POLYS = [
    { name: "floor", pts: FLOOR },
    { name: "box", pts: BOX },
    { name: "board", pts: BOARD }
  ];

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }

  /* Nearest hit of the ray o + t·dir (t > tMin) with any polygon. */
  function castRay(o, dir, tMin) {
    var best = Infinity;
    POLYS.forEach(function (poly) {
      var p = poly.pts;
      for (var i = 0; i < p.length; i++) {
        var a = p[i], b = p[(i + 1) % p.length];
        var ex = b[0] - a[0], ey = b[1] - a[1];
        var den = dir[0] * ey - dir[1] * ex;
        if (Math.abs(den) < 1e-12) continue;
        var t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;
        var s = ((a[0] - o[0]) * dir[1] - (a[1] - o[1]) * dir[0]) / den;
        if (t > tMin && s >= 0 && s <= 1 && t < best) best = t;
      }
    });
    return best;
  }

  /* Surface samples on every edge that faces up or towards the light,
     every 2 cm, with outward normals. Polygons are counter-clockwise. */
  var SAMPLES = [];
  (function sample() {
    POLYS.forEach(function (poly) {
      var p = poly.pts;
      for (var i = 0; i < p.length; i++) {
        var a = p[i], b = p[(i + 1) % p.length];
        var ex = b[0] - a[0], ey = b[1] - a[1];
        var len = Math.hypot(ex, ey);
        var n = [ey / len, -ex / len];
        if (n[1] < -0.2) continue;                     // bottoms are never seen
        var steps = Math.max(1, Math.round(len / 0.02));
        for (var k = 0; k < steps; k++) {
          var t = (k + 0.5) / steps;
          var q = [a[0] + ex * t, a[1] + ey * t];
          // Skip points buried inside another polygon (the floor under the
          // box, the board's buried part).
          if (inside(q, poly)) continue;
          SAMPLES.push({ p: q, n: n, poly: poly.name, isFloor: poly.name === "floor" && n[1] > 0.5 });
        }
      }
    });
  })();
  function inside(q, self) {
    return POLYS.some(function (poly) {
      if (poly === self) return false;
      var p = poly.pts, c = true;
      for (var i = 0; i < p.length; i++) {
        var a = p[i], b = p[(i + 1) % p.length];
        if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) < -1e-9) { c = false; break; }
      }
      return c;
    });
  }
  // Ground truth for each sample: facing the light and nothing in the way.
  SAMPLES.forEach(function (s) {
    s.NoL = dot(s.n, L);
    var o = [s.p[0] + s.n[0] * 1e-3, s.p[1] + s.n[1] * 1e-3];
    s.truth = s.NoL > 0 && castRay(o, L, 1e-6) === Infinity ? 1 : 0;
  });

  // The light's view covers the scene's u range with a small margin.
  var U_MIN = Infinity, U_MAX = -Infinity;
  POLYS.forEach(function (poly) {
    poly.pts.forEach(function (q) {
      if (q[1] < -0.5) return;
      var u = dot(q, U);
      U_MIN = Math.min(U_MIN, u); U_MAX = Math.max(U_MAX, u);
    });
  });
  U_MIN -= 0.2; U_MAX += 0.2;
  var Z_FAR = 40;

  /* Builds the shadow map: stored depth per texel centre. */
  function buildMap(R) {
    var hsz = (U_MAX - U_MIN) / R;
    var depth = new Float64Array(R);
    for (var i = 0; i < R; i++) {
      var u = U_MIN + (i + 0.5) * hsz;
      // Start far back along -D and march towards the scene.
      var o = [u * U[0] - 20 * D[0], u * U[1] - 20 * D[1]];
      var t = castRay(o, D, 0);
      depth[i] = t === Infinity ? Z_FAR : dot([o[0] + D[0] * t, o[1] + D[1] * t], D);
    }
    return { R: R, h: hsz, depth: depth };
  }

  /* One comparison at texel coordinate tc (in texels, 0..R), depth z. */
  function compare(map, tc, z) {
    var i = Math.floor(tc);
    if (i < 0 || i >= map.R) return 1;
    return z <= map.depth[i] + 1e-6 ? 1 : 0;
  }
  /* Linear PCF between the two nearest texel centres. */
  function compareLinear(map, tc, z) {
    var x = tc - 0.5;
    var i = Math.floor(x);
    var f = x - i;
    return compare(map, i + 0.5, z) * (1 - f) + compare(map, i + 1.5, z) * f;
  }

  function shadowTest(map, s, st) {
    if (s.NoL <= 0) return 0;
    var off = st.normal * map.h;
    var q = [s.p[0] + s.n[0] * off, s.p[1] + s.n[1] * off];
    var tc = (dot(q, U) - U_MIN) / map.h;
    var tanT = Math.min(Math.sqrt(Math.max(0, 1 - s.NoL * s.NoL)) / s.NoL, 10);
    var z = dot(q, D) - (st.bias / 100 + st.slope * map.h * tanT);
    if (!st.pcf) return compare(map, tc, z);
    return (compareLinear(map, tc - 1, z) + compareLinear(map, tc, z) + compareLinear(map, tc + 1, z)) / 3;
  }

  /* ---------- Drawing ---------- */

  var VW = 820, VH = 476;
  var WX0 = -0.6, WX1 = 11.2, WY0 = -0.45, WY1 = 3.25;
  var SX0 = 24, SX1 = 796, SY0 = 368, SY1 = 92;
  var K = (SX1 - SX0) / (WX1 - WX0);
  function sx(x) { return SX0 + (x - WX0) * K; }
  function sy(y) { return SY0 - (y - WY0) * K; }
  function polyPts(p) { return p.map(function (q) { return sx(q[0]).toFixed(1) + "," + sy(q[1]).toFixed(1); }).join(" "); }

  var PRESETS = {
    acne: { bias: 0, slope: 0, normal: 0, res: 64, pcf: false },
    peter: { bias: 35, slope: 0, normal: 0, res: 64, pcf: false },
    good: { bias: 1, slope: 1, normal: 0.4, res: 64, pcf: false },
    low: { bias: 1, slope: 1, normal: 0.4, res: 16, pcf: false },
    pcf: { bias: 1, slope: 1, normal: 0.4, res: 64, pcf: true }
  };

  function init(root) {
    var state = { bias: 1, slope: 0, normal: 0, res: 64, pcf: false };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Shadow bias bench" }),
      h("span", { class: "demo-hint", text: "Move the bias sliders and the resolution, or start from one of the set-ups." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    var presetSeg = HB.segmented("Try", [
      { value: "acne", label: "Acne" },
      { value: "peter", label: "Peter-panning" },
      { value: "good", label: "Balanced" },
      { value: "low", label: "Low resolution" },
      { value: "pcf", label: "With PCF" }
    ], "", function (v) { applyPreset(PRESETS[v]); });
    controls.appendChild(presetSeg);
    var biasC = HB.slider("sb-bias", "Constant bias", { min: 0, max: 40, step: 0.5, value: state.bias, format: function (v) { return v.toFixed(1) + " cm"; } }, function (v) { state.bias = v; draw(); });
    var slopeC = HB.slider("sb-slope", "Slope bias, texels × tan θ", { min: 0, max: 3, step: 0.1, value: state.slope, format: function (v) { return v.toFixed(1); } }, function (v) { state.slope = v; draw(); });
    var normalC = HB.slider("sb-normal", "Normal offset", { min: 0, max: 2, step: 0.05, value: state.normal, format: function (v) { return v.toFixed(2) + " texels"; } }, function (v) { state.normal = v; draw(); });
    controls.appendChild(biasC);
    controls.appendChild(slopeC);
    controls.appendChild(normalC);
    var resSeg = HB.segmented("Shadow map resolution", [16, 32, 64, 128, 256].map(function (r) { return { value: r, label: String(r) }; }), state.res, function (v) { state.res = v; draw(); });
    controls.appendChild(resSeg);
    var pcfBox = h("input", { type: "checkbox", id: "sb-pcf" });
    pcfBox.addEventListener("change", function () { state.pcf = pcfBox.checked; draw(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Filtering" }),
      h("div", { class: "checks" }, [h("label", { for: "sb-pcf" }, [pcfBox, "PCF, 3 taps"])])
    ]));
    root.appendChild(controls);

    function setSlider(ctrl, v) {
      var input = ctrl.querySelector("input");
      input.value = String(v);
      input.dispatchEvent(new Event("input"));
    }
    function applyPreset(p) {
      setSlider(biasC, p.bias);
      setSlider(slopeC, p.slope);
      setSlider(normalC, p.normal);
      state.res = p.res;
      resSeg.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", b.textContent === String(p.res) ? "true" : "false"); });
      pcfBox.checked = p.pcf;
      state.pcf = p.pcf;
      draw();
    }

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", { class: "dg is-wide", viewBox: "0 0 " + VW + " " + VH, role: "img", "aria-label": "Side view of the shadow test" });
    stage.appendChild(svg);
    root.appendChild(stage);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);
    var note = h("p", { class: "demo-hint" });
    root.appendChild(note);

    var defs = svgEl("defs", null, svg);
    var mk = svgEl("marker", { id: "sbb-arr", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" }, defs);
    svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: "f-lit" }, mk);
    var clip = svgEl("clipPath", { id: "sbb-clip" }, defs);
    svgEl("rect", { x: SX0, y: SY1 - 10, width: SX1 - SX0, height: SY0 - SY1 + 10 }, clip);

    var layerMap = svgEl("g", null, svg);
    var sceneG = svgEl("g", { "clip-path": "url(#sbb-clip)" }, svg);
    var layerRays = svgEl("g", null, sceneG);
    var layerGeo = svgEl("g", null, sceneG);
    var layerSteps = svgEl("g", null, sceneG);
    var layerResult = svgEl("g", null, sceneG);
    var layerRibbon = svgEl("g", null, svg);

    /* Static parts: labels, light arrows, geometry. */
    svgEl("text", { x: SX0, y: 16, class: "t-caps", text: "THE SHADOW MAP · ONE ROW OF DEPTHS SEEN FROM THE LIGHT, NEAR DARK, FAR LIGHT" }, svg);
    svgEl("rect", { x: SX0, y: SY1 - 10, width: SX1 - SX0, height: SY0 - SY1 + 10, class: "f-sunken" }, layerRays);
    for (var a = 0; a < 4; a++) {
      var ax = sx(-0.2 + a * 0.55), ay = sy(3.1);
      svgEl("line", { x1: ax, y1: ay, x2: ax + D[0] * 34, y2: ay - D[1] * 34, class: "s-lit w2", "marker-end": "url(#sbb-arr)" }, svg);
    }
    svgEl("text", { x: sx(2.1), y: sy(3.0), class: "t-small t-lit t-strong", text: "sunlight, 38° up" }, svg);
    POLYS.forEach(function (poly) {
      svgEl("polygon", { points: polyPts(poly.pts), class: poly.name === "floor" ? "f-solid" : "f-surface s-strong" }, layerGeo);
    });
    svgEl("text", { x: sx(3.1), y: sy(floorY(3.1) + 0.55), class: "t-small t-muted mid", text: "box" }, layerGeo);
    svgEl("text", { x: sx(7.62), y: sy(floorY(7.5) + 1.62), class: "t-small t-muted", text: "thin board" }, layerGeo);
    svgEl("text", { x: SX0, y: 392, class: "t-caps", text: "THE FLOOR AS THE CAMERA SEES IT FROM ABOVE" }, svg);
    svgEl("text", { x: SX1, y: 392, class: "t-caps end", text: "LEFT TO RIGHT, SAME SCALE" }, svg);
    var lg = 456;
    svgEl("line", { x1: SX0, y1: lg, x2: SX0 + 22, y2: lg, class: "s-acc w2" }, svg);
    svgEl("text", { x: SX0 + 28, y: lg + 4, class: "t-small", text: "stored depth, one step per texel" }, svg);
    svgEl("line", { x1: 250, y1: lg, x2: 272, y2: lg, class: "s-pix w2 dash" }, svg);
    svgEl("text", { x: 278, y: lg + 4, class: "t-small", text: "after constant bias" }, svg);
    svgEl("line", { x1: 420, y1: lg, x2: 442, y2: lg, class: "s-muted", "stroke-width": 5.5 }, svg);
    svgEl("line", { x1: 420, y1: lg, x2: 442, y2: lg, class: "s-lit w3" }, svg);
    svgEl("text", { x: 448, y: lg + 4, class: "t-small", text: "lit" }, svg);
    svgEl("line", { x1: 486, y1: lg, x2: 508, y2: lg, class: "s-muted", "stroke-width": 5.5 }, svg);
    svgEl("line", { x1: 486, y1: lg, x2: 508, y2: lg, class: "s-shade w3" }, svg);
    svgEl("text", { x: 514, y: lg + 4, class: "t-small", text: "in shadow (the test's answer)" }, svg);

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function draw() {
      var map = buildMap(state.res);
      var R = map.R;

      // The shadow map row: one cell per texel, shaded by depth.
      HB.svg.clear(layerMap);
      var zMin = Infinity, zMax = -Infinity;
      for (var i = 0; i < R; i++) { if (map.depth[i] < Z_FAR) { zMin = Math.min(zMin, map.depth[i]); zMax = Math.max(zMax, map.depth[i]); } }
      var cw = (SX1 - SX0) / R;
      svgEl("rect", { x: SX0, y: 26, width: SX1 - SX0, height: 22, class: "f-buf-lo" }, layerMap);
      for (i = 0; i < R; i++) {
        var v = map.depth[i] >= Z_FAR ? 1 : 0.1 + 0.8 * (map.depth[i] - zMin) / Math.max(zMax - zMin, 1e-6);
        svgEl("rect", { x: SX0 + i * cw, y: 26, width: cw + 0.3, height: 22, class: "f-buf-hi", "fill-opacity": v.toFixed(2) }, layerMap);
      }
      if (R <= 64) for (i = 1; i < R; i++) svgEl("line", { x1: SX0 + i * cw, y1: 26, x2: SX0 + i * cw, y2: 48, class: "s-shade", "stroke-opacity": 0.35 }, layerMap);
      svgEl("text", { x: SX0, y: 64, class: "t-small t-muted", text: R + " texels across the light's view · each " + Math.round(map.h * 100) + " cm wide" }, layerMap);

      // Stored depths as steps in the scene, and a few of their rays.
      HB.svg.clear(layerSteps);
      HB.svg.clear(layerRays);
      svgEl("rect", { x: SX0, y: SY1 - 10, width: SX1 - SX0, height: SY0 - SY1 + 10, class: "f-sunken" }, layerRays);
      var every = Math.max(1, Math.round(R / 48));
      var stepD = "", biasD = "";
      var cb = state.bias / 100;
      for (i = 0; i < R; i++) {
        var z = map.depth[i];
        if (z >= Z_FAR) continue;
        var u0 = U_MIN + i * map.h, u1 = u0 + map.h;
        var p0 = [u0 * U[0] + z * D[0], u0 * U[1] + z * D[1]];
        var p1 = [u1 * U[0] + z * D[0], u1 * U[1] + z * D[1]];
        stepD += "M" + sx(p0[0]).toFixed(1) + "," + sy(p0[1]).toFixed(1) + " L" + sx(p1[0]).toFixed(1) + "," + sy(p1[1]).toFixed(1) + " ";
        if (cb > 0) {
          var q0 = [p0[0] + D[0] * cb, p0[1] + D[1] * cb], q1 = [p1[0] + D[0] * cb, p1[1] + D[1] * cb];
          biasD += "M" + sx(q0[0]).toFixed(1) + "," + sy(q0[1]).toFixed(1) + " L" + sx(q1[0]).toFixed(1) + "," + sy(q1[1]).toFixed(1) + " ";
        }
        if (i % every === 0) {
          var c = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
          svgEl("line", { x1: sx(c[0] - D[0] * 6), y1: sy(c[1] - D[1] * 6), x2: sx(c[0]), y2: sy(c[1]), class: "s-lit", "stroke-opacity": 0.2 }, layerRays);
        }
      }
      svgEl("path", { d: stepD, class: "s-acc w2" }, layerSteps);
      if (biasD) svgEl("path", { d: biasD, class: "s-pix w15 dash" }, layerSteps);

      // Shadow test on every sample; draw results as a strip on each surface.
      HB.svg.clear(layerResult);
      var litD = "", shadeRuns = [];
      var acne = 0, litTotal = 0, miss = 0, shadowTotal = 0;
      var floorRow = [];
      var boardBase = 7.53, firstShadowRight = null;
      SAMPLES.forEach(function (s) {
        var r = shadowTest(map, s, state);
        s.r = r;
        if (s.NoL > 0) {
          if (s.truth) { litTotal++; if (r < 0.5) acne++; }
          else { shadowTotal++; if (r >= 0.5) miss++; }
        }
        if (s.isFloor) {
          floorRow.push(s);
          // The nearest shadowed floor point to the right of the board's foot.
          if (s.p[0] > boardBase && r < 0.5 && s.p[0] < boardBase + 2 && (firstShadowRight === null || s.p[0] < firstShadowRight)) firstShadowRight = s.p[0];
        }
      });
      // Strip just outside each surface: lit amber underneath, shade on top
      // with opacity = 1 − result.
      SAMPLES.forEach(function (s) {
        var o = 0.045;
        var a0 = [s.p[0] + s.n[0] * o, s.p[1] + s.n[1] * o];
        var t = [-s.n[1] * 0.0105, s.n[0] * 0.0105];
        var x1 = sx(a0[0] - t[0]), y1 = sy(a0[1] - t[1]), x2 = sx(a0[0] + t[0]), y2 = sy(a0[1] + t[1]);
        litD += "M" + x1.toFixed(1) + "," + y1.toFixed(1) + "L" + x2.toFixed(1) + "," + y2.toFixed(1);
        var dark = 1 - s.r;
        if (dark > 0.02) shadeRuns.push({ d: "M" + x1.toFixed(1) + "," + y1.toFixed(1) + "L" + x2.toFixed(1) + "," + y2.toFixed(1), o: Math.round(dark * 4) / 4 });
      });
      // A muted halo under the strip keeps the dark "in shadow" marks
      // visible against the dark background of the dark theme.
      svgEl("path", { d: litD, class: "s-muted", "stroke-width": 5.5 }, layerResult);
      svgEl("path", { d: litD, class: "s-lit w3" }, layerResult);
      [0.25, 0.5, 0.75, 1].forEach(function (lvl) {
        var d = shadeRuns.filter(function (q) { return q.o === lvl; }).map(function (q) { return q.d; }).join("");
        if (d) svgEl("path", { d: d, class: "s-shade w3", "stroke-opacity": lvl }, layerResult);
      });

      // Ribbon: the floor seen from above, left to right.
      HB.svg.clear(layerRibbon);
      var RY = 402, RH = 26;
      svgEl("rect", { x: SX0, y: RY, width: SX1 - SX0, height: RH, class: "f-buf-lo" }, layerRibbon);
      floorRow.sort(function (p, q) { return p.p[0] - q.p[0]; });
      var runStart = null, runVal = null;
      function flush(xEnd) {
        if (runStart === null) return;
        svgEl("rect", { x: sx(runStart), y: RY, width: Math.max(0.6, sx(xEnd) - sx(runStart)), height: RH, class: "f-buf-hi", "fill-opacity": (0.12 + 0.7 * runVal).toFixed(2) }, layerRibbon);
      }
      floorRow.forEach(function (s, k) {
        var val = Math.round(s.r * 4) / 4;
        var x0 = s.p[0] - 0.01;
        var gap = k > 0 && s.p[0] - floorRow[k - 1].p[0] > 0.05;
        if (runStart === null || val !== runVal || gap) {
          flush(k > 0 ? floorRow[k - 1].p[0] + 0.01 : x0);
          runStart = x0; runVal = val;
        }
      });
      if (floorRow.length) flush(floorRow[floorRow.length - 1].p[0] + 0.01);
      svgEl("rect", { x: SX0, y: RY, width: SX1 - SX0, height: RH, class: "s-strong" }, layerRibbon);
      // Mark the footprints of the box and the board.
      [[BOX[0][0], BOX[1][0], "box"], [7.47, 7.53, ""]].forEach(function (f) {
        svgEl("rect", { x: sx(f[0]), y: RY - 3, width: Math.max(2, sx(f[1]) - sx(f[0])), height: RH + 6, class: "f-surface s-strong" }, layerRibbon);
        if (f[2]) svgEl("text", { x: (sx(f[0]) + sx(f[1])) / 2, y: RY + 17, class: "t-small t-muted mid", text: f[2] }, layerRibbon);
      });

      // Readouts.
      var trueStart = boardBase;
      var gapCm = firstShadowRight === null ? null : Math.max(0, (firstShadowRight - trueStart) * 100);
      readout.replaceChildren(
        cell("Texel size", Math.round(map.h * 100) + " cm"),
        cell("Lit surface shown in shadow", (litTotal ? (100 * acne) / litTotal : 0).toFixed(0) + "%"),
        cell("Shadow shown as lit", (shadowTotal ? (100 * miss) / shadowTotal : 0).toFixed(0) + "%"),
        cell("Gap before the board's shadow", gapCm === null ? "no shadow" : Math.round(gapCm) + " cm")
      );
      var acnePct = litTotal ? acne / litTotal : 0;
      var missPct = shadowTotal ? miss / shadowTotal : 0;
      var msg;
      if (acnePct > 0.08) {
        msg = "Shadow acne: the floor and the box shade themselves in stripes. Each texel stores one depth for its whole width, so on a slope half of every texel's footprint lies behind the stored step. Add bias.";
      } else if (state.res <= 16) {
        msg = "Low resolution: each texel is " + Math.round(map.h * 100) + " cm wide, so every shadow edge snaps to a texel boundary. Slope bias and normal offset are measured in texels, so they grow too" +
          (gapCm === null ? ", and the thin board's shadow disappears." : ", and the board's shadow now starts " + Math.round(gapCm) + " cm from its foot.");
      } else if (gapCm !== null && gapCm > 8) {
        msg = "Peter-panning: so much bias that the thin board's shadow starts " + Math.round(gapCm) + " cm away from its foot, and the board seems to float. The thick box hides it much longer: its shadow comes from surfaces far above the floor.";
      } else if (gapCm === null) {
        msg = "The thin board casts no shadow at all: the bias or normal offset is larger than the gap between the board and the floor behind it.";
      } else if (state.pcf) {
        msg = "PCF: each test is repeated at neighbouring texels and averaged, so edges fade over about two texels instead of snapping. It softens edges; it does not remove acne or peter-panning.";
      } else if (missPct > 0.08) {
        msg = "Too much offset: parts of real shadows are now reported as lit, light leaking where the test is pushed past the caster.";
      } else {
        msg = "Balanced: a small constant bias, a slope bias for the tilted floor and a little normal offset remove the acne without detaching the board's shadow.";
      }
      note.textContent = msg;
      svg.setAttribute("aria-label", "Side view of a sloping floor, a box and a thin board under sunlight, with a " + R + "-texel shadow map. " +
        Math.round(acnePct * 100) + "% of lit surface is wrongly shadowed and " + Math.round(missPct * 100) + "% of shadowed surface wrongly lit.");
    }

    draw();
    log.debug("ready", SAMPLES.length, "samples");
  }

  HB.demos.register("shadow-bias-bench", init);
})();

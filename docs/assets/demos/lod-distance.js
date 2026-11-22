/*
 * lod-distance.js: chapter 4.5's interactive.
 *
 * A boulder 2 m tall stands in front of a camera with a 60° vertical field of
 * view, rendering to a 1920 × 1080 screen. The reader drags the boulder along
 * a distance axis (log scale, 2 m to 250 m). Its height on screen follows
 *
 *   screen height (px) = 1080 × 2 m / (2 × distance × tan 30°)
 *
 * and the LOD level follows that height as a fraction of the screen:
 *
 *   LOD0  ≥ 50 %     13,824 triangles
 *   LOD1  ≥ 25 %      3,456
 *   LOD2  ≥ 12.5 %      864
 *   LOD3  ≥ 6.25 %      216
 *   impostor ≥ 1 %        2   (a picture of LOD0 on a card)
 *   culled   below 1 %    0
 *
 * Each level has a quarter of the triangles of the one before and takes over
 * when the screen height halves, so pixels per triangle stays in a band
 * (about 18 to 72 with this shape) instead of collapsing as the boulder
 * shrinks. "LOD bias" divides the thresholds, like Unity's LOD Bias and
 * Godot's lod_bias: 2 keeps detail twice as far away.
 *
 * Every level is the same procedural shape sampled on a coarser hexagonal
 * grid of triangles (6 K² triangles for K rings), shaded with a fixed light,
 * so the magnified view shows real facets and real triangle edges. The
 * triangle counts in the readout are the counts drawn.
 *
 * Transitions: "Pop" swaps levels at the threshold. "Dithered fade" draws
 * both levels for the first 15 % of the next range, each through
 * complementary halves of a 4 × 4 ordered-dither pattern, as engines do with
 * a screen-space dither; the readout counts both levels' triangles.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("lod-distance");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- The setup the numbers come from ---------- */

  var OBJECT_M = 2;                         // boulder height in metres
  var FOV_V = (60 * Math.PI) / 180;         // vertical field of view
  var SCREEN = { w: 1920, h: 1080 };
  var D_MIN = 2;
  var D_MAX = 250;
  var RINGS = [48, 24, 12, 6];              // hex rings per mesh LOD
  var THRESH = [0.5, 0.25, 0.125, 0.0625, 0.01];
  var FADE_WIDTH = 0.15;                    // fraction of the threshold
  var LEVEL_NAMES = ["LOD0", "LOD1", "LOD2", "LOD3", "Impostor", "Culled"];
  var IMPOSTOR = 4;
  var CULLED = 5;
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function screenFraction(d) {
    return OBJECT_M / (2 * d * Math.tan(FOV_V / 2));
  }

  /* ---------- The boulder ---------- */

  /* Outline radius as a sum of a few seeded harmonics, so the boulder has
     the same lumpy silhouette every time the page loads. */
  var HARM = (function () {
    var rand = HB.rng(4501);
    var list = [];
    for (var k = 2; k <= 9; k++) {
      list.push({ k: k, a: (0.045 + 0.05 * rand()) / Math.sqrt(k - 1), p: rand() * Math.PI * 2 });
    }
    return list;
  })();

  function outlineRaw(theta) {
    var r = 1;
    for (var i = 0; i < HARM.length; i++) r += HARM[i].a * Math.cos(HARM[i].k * theta + HARM[i].p);
    var x = 1.0 * r * Math.cos(theta);
    var y = r * Math.sin(theta);
    // Flatten the underside so it sits on the ground.
    if (y < -0.7) y = -0.7 + (y + 0.7) * 0.25;
    return [x, y];
  }

  /* Normalise so the boulder is exactly 1 unit tall, bottom at y = 0. */
  var NORM = (function () {
    var lo = Infinity;
    var hi = -Infinity;
    for (var i = 0; i < 2048; i++) {
      var p = outlineRaw((i / 2048) * Math.PI * 2);
      lo = Math.min(lo, p[1]);
      hi = Math.max(hi, p[1]);
    }
    return { bottom: lo, height: hi - lo };
  })();

  /* Distance from the centre of a unit hexagon (corners at 0°, 60°, ...) to
     its edge, along angle theta. */
  function hexEdge(theta) {
    var sector = Math.PI / 3;
    var a = ((theta % sector) + sector) % sector;
    return Math.cos(Math.PI / 6) / Math.cos(a - Math.PI / 6);
  }

  /* Small bumps on the surface, for shading only. */
  function bump(x, y) {
    return 0.035 * Math.sin(7.1 * x + 1.3) * Math.cos(6.3 * y - 0.4) +
      0.018 * Math.sin(11.3 * x + 2.0) * Math.sin(9.7 * y + 0.7);
  }

  var LIGHT = (function () {
    var l = [-0.45, 0.55, 0.7];
    var n = Math.hypot(l[0], l[1], l[2]);
    return [l[0] / n, l[1] / n, l[2] / n];
  })();

  /*
   * Builds one LOD: a hexagonal disk of K rings (6 K² triangles, every one
   * equilateral before mapping), pushed out so its rim follows the outline.
   * Returns 2D points in units of the boulder's height (y up, 0 at the
   * bottom), triangle index triples, a shade per triangle and the rim.
   */
  function buildLod(K) {
    var pts = [[0, 0]];
    var ring = [[0]];
    for (var k = 1; k <= K; k++) {
      var ids = [];
      for (var s = 0; s < 6; s++) {
        var a0 = (s * Math.PI) / 3;
        var a1 = ((s + 1) * Math.PI) / 3;
        for (var i = 0; i < k; i++) {
          var t = i / k;
          var hx = (k / K) * (Math.cos(a0) * (1 - t) + Math.cos(a1) * t);
          var hy = (k / K) * (Math.sin(a0) * (1 - t) + Math.sin(a1) * t);
          ids.push(pts.length);
          pts.push([hx, hy]);
        }
      }
      ring.push(ids);
    }
    // Map every lattice point from the hexagon onto the boulder.
    var verts = pts.map(function (p) {
      var len = Math.hypot(p[0], p[1]);
      if (len < 1e-9) return { x: 0, y: -NORM.bottom / NORM.height, z: 0.55 + bump(0, 0) };
      var theta = Math.atan2(p[1], p[0]);
      var rho = Math.min(1, len / hexEdge(theta));
      var o = outlineRaw(theta);
      var x = rho * o[0];
      var y = rho * o[1];
      return {
        x: x / NORM.height,
        y: (y - NORM.bottom) / NORM.height,
        z: 0.55 * Math.sqrt(Math.max(0, 1 - rho * rho)) + bump(x, y)
      };
    });
    var tris = [];
    for (var kk = 1; kk <= K; kk++) {
      var outer = ring[kk];
      var inner = ring[kk - 1];
      for (var ss = 0; ss < 6; ss++) {
        for (var ii = 0; ii < kk; ii++) {
          var a = outer[ss * kk + ii];
          var b = outer[(ss * kk + ii + 1) % outer.length];
          var c0 = kk === 1 ? inner[0] : inner[(ss * (kk - 1) + ii) % inner.length];
          tris.push([a, b, c0]);
          if (ii < kk - 1) {
            var c1 = inner[(ss * (kk - 1) + ii + 1) % inner.length];
            tris.push([b, c1, c0]);
          }
        }
      }
    }
    var shade = tris.map(function (tri) {
      var A = verts[tri[0]];
      var B = verts[tri[1]];
      var C = verts[tri[2]];
      var ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
      var vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
      var nx = uy * vz - uz * vy;
      var ny = uz * vx - ux * vz;
      var nz = ux * vy - uy * vx;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      var n = Math.hypot(nx, ny, nz) || 1;
      var lit = Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / n);
      return lit;
    });
    var rim = ring[K].map(function (id) { return verts[id]; });
    return { K: K, verts: verts, tris: tris, shade: shade, rim: rim };
  }

  /* Area of the silhouette, in units of height², for pixels covered. */
  function rimArea(rim) {
    var a = 0;
    for (var i = 0; i < rim.length; i++) {
      var p = rim[i];
      var q = rim[(i + 1) % rim.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  /* ---------- Drawing constants ---------- */

  var VIEW = { w: 820, h: 452 };
  var AXIS = { x0: 80, x1: 780, y: 66 };
  var MAG = { x: 20, y: 128, w: 300, h: 310, cx: 170, base: 412, size: 236 };
  var SCR = { x: 350, y: 166 };
  var SCR_SCALE = 450 / SCREEN.w;           // viewBox units per screen pixel
  SCR.w = SCREEN.w * SCR_SCALE;
  SCR.h = SCREEN.h * SCR_SCALE;

  function axisX(d) {
    return AXIS.x0 + ((AXIS.x1 - AXIS.x0) * Math.log(d / D_MIN)) / Math.log(D_MAX / D_MIN);
  }
  function axisD(x) {
    var t = (x - AXIS.x0) / (AXIS.x1 - AXIS.x0);
    return D_MIN * Math.exp(t * Math.log(D_MAX / D_MIN));
  }

  function fmtPx(v) {
    if (v >= 100) return HB.fmt.int(v);
    if (v >= 10) return String(Math.round(v));
    if (v >= 1) return v.toFixed(1);
    return v.toFixed(2);
  }
  function fmtDist(d) {
    return (d < 100 ? d.toFixed(1) : String(Math.round(d))) + " m";
  }

  /* Path data for a set of triangles, in magnified-view units. */
  function triPath(lod, list) {
    var s = MAG.size;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = lod.tris[list[i]];
      var a = lod.verts[t[0]], b = lod.verts[t[1]], c = lod.verts[t[2]];
      out.push("M" + (a.x * s).toFixed(1) + " " + (-a.y * s).toFixed(1) +
        "L" + (b.x * s).toFixed(1) + " " + (-b.y * s).toFixed(1) +
        "L" + (c.x * s).toFixed(1) + " " + (-c.y * s).toFixed(1) + "Z");
    }
    return out.join("");
  }

  function edgePath(lod) {
    var s = MAG.size;
    var seen = {};
    var out = [];
    lod.tris.forEach(function (t) {
      for (var e = 0; e < 3; e++) {
        var i = t[e];
        var j = t[(e + 1) % 3];
        var key = i < j ? i + "_" + j : j + "_" + i;
        if (seen[key]) continue;
        seen[key] = true;
        var a = lod.verts[i], b = lod.verts[j];
        out.push("M" + (a.x * s).toFixed(1) + " " + (-a.y * s).toFixed(1) + "L" + (b.x * s).toFixed(1) + " " + (-b.y * s).toFixed(1));
      }
    });
    return out.join("");
  }

  function rimPoints(rim, scale) {
    return rim.map(function (p) { return (p.x * scale).toFixed(1) + "," + (-p.y * scale).toFixed(1); }).join(" ");
  }

  var instance = 0;

  function init(root) {
    instance += 1;
    var uid = "lodd" + instance + "-";
    var lods = RINGS.map(buildLod);
    var fill = rimArea(lods[0].rim);         // silhouette area / height²
    var triCounts = lods.map(function (l) { return l.tris.length; }).concat([2, 0]);

    var state = { d: 24, mode: "pop", bias: 1, force: false, last: null, level: null, raf: 0 };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "LOD over distance" }),
      h("span", { class: "demo-hint", text: "Drag the boulder along the distance axis, or focus it and use the arrow keys (Shift for bigger steps)." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Switching", [
      { value: "pop", label: "Pop" },
      { value: "fade", label: "Dithered fade" }
    ], state.mode, function (v) { state.mode = v; request(); }));
    controls.appendChild(HB.segmented("LOD bias", [
      { value: 0.5, label: "0.5" }, { value: 1, label: "1" }, { value: 2, label: "2" }
    ], state.bias, function (v) { state.bias = v; drawBands(); request(); }));
    var forceBox = h("input", { type: "checkbox", id: uid + "force" });
    forceBox.addEventListener("change", function () { state.force = forceBox.checked; drawBands(); request(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Compare" }),
      h("div", { class: "checks" }, [h("label", { for: uid + "force" }, [forceBox, "No LOD: always draw LOD0"])])
    ]));
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "group",
      "aria-label": "A distance axis from 2 to 250 metres with the bands where each LOD is used, a draggable boulder on it, a magnified view of the boulder's current triangles with a grid of screen pixels, and the boulder at its true size on a 1920 by 1080 screen."
    });
    stage.appendChild(svg);
    root.appendChild(stage);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    /* ---------- Masks, patterns and clips ---------- */

    var defs = svgEl("defs", null, svg);
    // Two complementary dither patterns and the masks that use them.
    var patA = svgEl("pattern", { id: uid + "patA", patternUnits: "userSpaceOnUse", width: 12, height: 12 }, defs);
    var patB = svgEl("pattern", { id: uid + "patB", patternUnits: "userSpaceOnUse", width: 12, height: 12 }, defs);
    ["A", "B"].forEach(function (k) {
      var m = svgEl("mask", { id: uid + "mask" + k, maskUnits: "userSpaceOnUse", x: MAG.x, y: MAG.y, width: MAG.w, height: MAG.h, style: "mask-type:alpha" }, defs);
      svgEl("rect", { x: MAG.x, y: MAG.y, width: MAG.w, height: MAG.h, fill: "url(#" + uid + "pat" + k + ")" }, m);
    });
    var magClip = svgEl("clipPath", { id: uid + "magclip" }, defs);
    svgEl("rect", { x: MAG.x, y: MAG.y + 22, width: MAG.w, height: MAG.h - 22 }, magClip);
    var scrClip = svgEl("clipPath", { id: uid + "scrclip" }, defs);
    svgEl("rect", { x: SCR.x, y: SCR.y, width: SCR.w, height: SCR.h }, scrClip);

    function setPattern(pat, cell, t, incoming) {
      HB.svg.clear(pat);
      pat.setAttribute("width", cell * 4);
      pat.setAttribute("height", cell * 4);
      pat.setAttribute("x", MAG.x);
      pat.setAttribute("y", MAG.y);
      for (var i = 0; i < 16; i++) {
        var on = BAYER[i] < t * 16;
        if (on !== incoming) continue;
        svgEl("rect", { x: (i % 4) * cell, y: Math.floor(i / 4) * cell, width: cell, height: cell, class: "f-ink" }, pat);
      }
    }

    /* ---------- Static parts ---------- */

    var layerStatic = svgEl("g", null, svg);
    var layerBands = svgEl("g", null, svg);
    var layerMag = svgEl("g", { "clip-path": "url(#" + uid + "magclip)" }, svg);
    var layerGrid = svgEl("g", { "clip-path": "url(#" + uid + "magclip)" }, svg);
    var layerMagText = svgEl("g", null, svg);
    var layerScr = svgEl("g", { "clip-path": "url(#" + uid + "scrclip)" }, svg);
    var layerScrText = svgEl("g", null, svg);

    /* Each mesh level is built once, as real elements, and shown or hidden.
       (Content cloned by <use> does not pick up the diagram classes.) */
    var BUCKETS = 14;
    var magT = "translate(" + MAG.cx + "," + MAG.base + ")";
    // The outer group carries display and the dither mask (masks use the
    // coordinates of the element they are on, so it stays untransformed).
    var groups = lods.map(function (lod, n) {
      var outer = svgEl("g", { display: "none" }, layerMag);
      var g = svgEl("g", { transform: magT }, outer);
      var fillG = svgEl("g", null, g);
      svgEl("polygon", { points: rimPoints(lod.rim, MAG.size), class: "f-buf-hi" }, fillG);
      var buckets = [];
      for (var b = 0; b <= BUCKETS; b++) buckets.push([]);
      lod.shade.forEach(function (lit, i) {
        buckets[Math.round(0.6 * Math.pow(1 - lit, 1.3) * BUCKETS)].push(i);
      });
      buckets.forEach(function (list, k) {
        if (!list.length || k === 0) return;
        svgEl("path", { d: triPath(lod, list), class: "f-shade", "fill-opacity": (k / BUCKETS).toFixed(3) }, fillG);
      });
      var widths = [0.3, 0.5, 0.8, 1.1];
      var opac = [0.45, 0.6, 0.75, 0.85];
      svgEl("path", { d: edgePath(lod), class: "s-geo", "stroke-width": widths[n], "stroke-opacity": opac[n] }, g);
      return { g: outer, fill: fillG };
    });
    // The impostor: a copy of LOD0's shading on one two-triangle card.
    (function () {
      var outer = svgEl("g", { display: "none" }, layerMag);
      var g = svgEl("g", { transform: magT }, outer);
      g.appendChild(groups[0].fill.cloneNode(true));
      var minX = Infinity, maxX = -Infinity;
      lods[0].rim.forEach(function (p) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); });
      var sz = MAG.size;
      var x0 = minX * sz - 6, x1 = maxX * sz + 6, y0 = -sz - 6, y1 = 4;
      svgEl("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "s-geo w15 dash" }, g);
      svgEl("line", { x1: x0, y1: y1, x2: x1, y2: y0, class: "s-geo w15 dash" }, g);
      groups.push({ g: outer });
    })();

    (function drawStatic() {
      svgEl("text", { x: 20, y: 22, class: "t-caps", text: "SIDE VIEW · DISTANCE FROM THE CAMERA (LOG SCALE)" }, layerStatic);
      // Camera.
      svgEl("rect", { x: 22, y: AXIS.y - 20, width: 26, height: 18, rx: 3, class: "f-ink" }, layerStatic);
      svgEl("polygon", { points: "48," + (AXIS.y - 16) + " 60," + (AXIS.y - 22) + " 60," + AXIS.y + " 48," + (AXIS.y - 6), class: "f-ink" }, layerStatic);
      svgEl("text", { x: 36, y: AXIS.y + 16, class: "t-small t-muted mid", text: "camera" }, layerStatic);
      svgEl("line", { x1: 64, y1: AXIS.y, x2: 800, y2: AXIS.y, class: "s-ink" }, layerStatic);
      [2, 5, 10, 20, 50, 100, 200].forEach(function (d) {
        var x = axisX(d);
        svgEl("line", { x1: x, y1: AXIS.y, x2: x, y2: AXIS.y + 5, class: "s-ink" }, layerStatic);
        svgEl("text", { x: x, y: AXIS.y + 17, class: "t-mono t-small t-muted mid", text: d + " m" }, layerStatic);
      });

      svgEl("rect", { x: MAG.x, y: MAG.y, width: MAG.w, height: MAG.h, rx: 6, class: "f-sunken s-strong" }, layerStatic);
      svgEl("text", { x: MAG.x + 12, y: MAG.y + 16, class: "t-caps", text: "MAGNIFIED" }, layerStatic);
      svgEl("rect", { x: SCR.x, y: SCR.y, width: SCR.w, height: SCR.h, class: "f-sunken s-strong" }, layerStatic);
      svgEl("text", { x: SCR.x, y: MAG.y + 16, class: "t-caps", text: "ON A 1920 × 1080 SCREEN, TO SCALE" }, layerStatic);
    })();

    /* LOD bands under the axis, for the current bias. */
    function drawBands() {
      HB.svg.clear(layerBands);
      var edges = [D_MIN];
      var labels = [];
      if (state.force) {
        edges.push(D_MAX);
        labels.push(0);
      } else {
        THRESH.forEach(function (t, i) {
          var d = OBJECT_M / (2 * Math.tan(FOV_V / 2) * (t / state.bias));
          edges.push(Math.min(D_MAX, Math.max(D_MIN, d)));
          labels.push(i);
        });
        edges.push(D_MAX);
        labels.push(CULLED);
      }
      var y = AXIS.y + 26;
      var opac = [1, 0.7, 0.45, 0.25];
      for (var i = 0; i < labels.length; i++) {
        var x0 = axisX(edges[i]);
        var x1 = axisX(edges[i + 1]);
        if (x1 - x0 < 0.5) continue;
        var lvl = labels[i];
        var cls = lvl < IMPOSTOR ? "f-acc" : lvl === IMPOSTOR ? "f-acc-soft s-acc dash" : "f-sunken s-strong";
        var r = svgEl("rect", { x: x0, y: y, width: x1 - x0, height: 16, class: cls }, layerBands);
        if (lvl < IMPOSTOR) r.setAttribute("fill-opacity", opac[lvl]);
        if (x1 - x0 > 34) {
          svgEl("text", {
            x: (x0 + x1) / 2, y: y + 12, class: "t-small mid " + (lvl < 2 ? "t-on-acc t-strong" : ""),
            text: state.force ? "LOD0 everywhere" : (lvl === IMPOSTOR ? "impostor" : lvl === CULLED ? "culled" : LEVEL_NAMES[lvl])
          }, layerBands);
        }
      }
    }

    /* ---------- Boulder handle on the axis ---------- */

    var handle = svgEl("g", { "aria-label": "Boulder distance", "aria-valuemin": D_MIN, "aria-valuemax": D_MAX }, svg);
    svgEl("circle", { r: 17, cy: -11, class: "f-acc-soft s-acc handle-ring" }, handle);
    svgEl("polygon", { points: rimPoints(lods[3].rim, 22), class: "f-solid s-ink" }, handle);

    HB.draggable(svg, handle, {
      onDrag: function (pt) { moveTo(axisD(pt.x)); },
      onKey: function (dir, big) { moveTo(state.d * Math.pow(big ? 1.2 : 1.03, dir)); }
    });

    function moveTo(d) {
      state.d = Math.min(D_MAX, Math.max(D_MIN, d));
      request();
    }

    /* Redraws at most once per animation frame while dragging. */
    function request() {
      if (state.raf) return;
      if (!window.requestAnimationFrame) { update(); return; }
      state.raf = window.requestAnimationFrame(function () { state.raf = 0; update(); });
    }

    /* Which level(s) to draw, and how far through a fade. */
    function pick(f) {
      if (state.force) return { a: 0, b: null, t: 0 };
      for (var i = 0; i < THRESH.length; i++) {
        var T = THRESH[i] / state.bias;
        if (f >= T) {
          // Inside the fade zone at the top of this range: still fading in
          // from the previous level.
          if (state.mode === "fade" && i > 0) {
            var Tp = THRESH[i - 1] / state.bias;
            var t = (Tp - f) / (FADE_WIDTH * Tp);
            if (t < 1) return { a: i - 1, b: i, t: Math.max(0, t) };
          }
          return { a: i, b: null, t: 0 };
        }
      }
      if (state.mode === "fade") {
        var Tl = THRESH[THRESH.length - 1] / state.bias;
        var tl = (Tl - f) / (FADE_WIDTH * Tl);
        if (tl < 1) return { a: IMPOSTOR, b: CULLED, t: Math.max(0, tl) };
      }
      return { a: CULLED, b: null, t: 0 };
    }

    /* Shows level a (and b during a fade), each through its dither mask. */
    function showLevels(a, b) {
      groups.forEach(function (grp, n) {
        var on = n === a || n === b;
        grp.g.setAttribute("display", on ? "inline" : "none");
        if (b === null || !on) grp.g.removeAttribute("mask");
        else grp.g.setAttribute("mask", "url(#" + uid + "mask" + (n === a ? "A" : "B") + ")");
      });
    }

    function update() {
      var f = screenFraction(state.d);
      var px = f * SCREEN.h;
      var sel = pick(f);
      var shown = sel.b === null ? sel.a : (sel.t < 0.5 ? sel.a : sel.b);
      var key = sel.a + ":" + sel.b;
      if (state.level !== null && state.level !== key) {
        var prev = state.level.split(":");
        var from = prev[1] !== "null" ? Number(prev[1]) : Number(prev[0]);
        var to = sel.b !== null ? sel.b : sel.a;
        if (from !== to) state.last = { from: from, to: to, d: state.d };
      }
      state.level = key;

      // Magnified view.
      var cell = Math.max(3, MAG.size / px);
      if (sel.b !== null) {
        setPattern(patA, cell, sel.t, false);
        setPattern(patB, cell, sel.t, true);
      }
      // While fading out to nothing, level a is masked and there is no b.
      var fadeTo = sel.b === null ? null : (sel.b === CULLED ? -1 : sel.b);
      showLevels(sel.a === CULLED ? null : sel.a, fadeTo);

      // Grid of real screen pixels, when they are big enough to draw.
      HB.svg.clear(layerGrid);
      var step = MAG.size / px;
      if (step >= 3) {
        var d = [];
        var top = MAG.y + 22;
        for (var gx = MAG.cx; gx <= MAG.x + MAG.w; gx += step) d.push("M" + gx.toFixed(2) + " " + top + "V" + (MAG.y + MAG.h));
        for (gx = MAG.cx - step; gx >= MAG.x; gx -= step) d.push("M" + gx.toFixed(2) + " " + top + "V" + (MAG.y + MAG.h));
        for (var gy = MAG.base; gy >= top; gy -= step) d.push("M" + MAG.x + " " + gy.toFixed(2) + "H" + (MAG.x + MAG.w));
        for (gy = MAG.base + step; gy <= MAG.y + MAG.h; gy += step) d.push("M" + MAG.x + " " + gy.toFixed(2) + "H" + (MAG.x + MAG.w));
        svgEl("path", { d: d.join(""), class: "s-pix", "stroke-width": step > 8 ? 0.9 : 0.5, "stroke-opacity": step > 8 ? 0.75 : 0.45 }, layerGrid);
      }

      // Labels in the magnified view.
      HB.svg.clear(layerMagText);
      var tris = triCounts[sel.a] + (sel.b !== null ? triCounts[sel.b] : 0);
      var title = sel.b !== null
        ? LEVEL_NAMES[sel.a] + " → " + LEVEL_NAMES[sel.b] + " · fading " + Math.round(sel.t * 100) + "%"
        : LEVEL_NAMES[sel.a] + (sel.a === CULLED ? " · nothing drawn" : " · " + HB.fmt.int(tris) + " triangles");
      svgEl("text", { x: MAG.x + MAG.w - 12, y: MAG.y + 16, class: "t-small t-acc t-strong end", text: title }, layerMagText);
      svgEl("text", {
        x: MAG.x + 12, y: MAG.y + MAG.h - 10, class: "t-small t-pix",
        text: step >= 3 ? "rose grid: one square per screen pixel" : "screen pixels too small to draw here"
      }, layerMagText);
      if (state.last) {
        svgEl("text", {
          x: MAG.x + 12, y: MAG.y + 34, class: "t-small t-muted",
          text: "last switch: " + LEVEL_NAMES[state.last.from] + " → " + LEVEL_NAMES[state.last.to] + " at " + fmtDist(state.last.d)
        }, layerMagText);
      }

      // True size on screen: the current level's outline at its real size.
      HB.svg.clear(layerScr);
      HB.svg.clear(layerScrText);
      var hUnits = px * SCR_SCALE;
      var base = SCR.y + SCR.h * 0.5 + hUnits / 2;
      var cx = SCR.x + SCR.w / 2;
      svgEl("line", { x1: SCR.x, y1: base, x2: SCR.x + SCR.w, y2: base, class: "s-line" }, layerScr);
      if (shown !== CULLED) {
        var rimLod = lods[shown >= IMPOSTOR ? 0 : shown];
        var pts = rimLod.rim.map(function (p) { return (cx + p.x * hUnits).toFixed(2) + "," + (base - p.y * hUnits).toFixed(2); }).join(" ");
        svgEl("polygon", { points: pts, class: "f-buf-hi s-ink", "stroke-width": 0.6 }, layerScr);
      }
      if (shown !== CULLED && hUnits > 2) {
        var bx = Math.min(SCR.x + SCR.w - 40, cx + hUnits * 0.75 + 10);
        svgEl("path", { d: "M" + (bx - 3) + "," + (base - hUnits) + "H" + (bx + 3) + "M" + bx + "," + (base - hUnits) + "V" + base + "M" + (bx - 3) + "," + base + "H" + (bx + 3), class: "s-acc" }, layerScrText);
        svgEl("text", { x: bx + 7, y: base - hUnits / 2 + 4, class: "t-small t-acc t-strong", text: Math.round(px) + " px" }, layerScrText);
      }
      svgEl("text", { x: SCR.x, y: SCR.y + SCR.h + 18, class: "t-small t-muted", text: "Boulder 2 m tall · camera field of view 60° vertical · 1 viewBox unit ≈ 4.3 px" }, layerScrText);

      // Handle position.
      handle.setAttribute("transform", "translate(" + axisX(state.d).toFixed(1) + "," + AXIS.y + ")");

      // Readout.
      var covered = fill * px * px;
      var ppt = tris > 0 ? covered / tris : 0;
      var lod0ppt = covered / triCounts[0];
      function cellEl(label, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
      }
      readout.replaceChildren(
        cellEl("Distance", fmtDist(state.d)),
        cellEl("Height on screen", Math.round(px) + " px (" + (f * 100).toFixed(f < 0.1 ? 1 : 0) + "%)"),
        cellEl("Drawing", sel.b !== null ? LEVEL_NAMES[sel.a] + " + " + LEVEL_NAMES[sel.b] : LEVEL_NAMES[sel.a]),
        cellEl("Triangles", HB.fmt.int(tris)),
        cellEl("Pixels per triangle", tris > 0 ? fmtPx(ppt) : "–"),
        cellEl("With LOD0 instead", fmtPx(lod0ppt))
      );
      handle.setAttribute("aria-valuenow", state.d.toFixed(1));
      handle.setAttribute("aria-valuetext", "Boulder at " + fmtDist(state.d) + ", " + Math.round(px) + " pixels tall, drawing " + (sel.b !== null ? LEVEL_NAMES[sel.a] + " and " + LEVEL_NAMES[sel.b] : LEVEL_NAMES[sel.a]));
    }

    drawBands();
    update();
    log.debug("ready", { fill: fill.toFixed(3), tris: triCounts.join(",") });
  }

  HB.demos.register("lod-distance", init);
})();

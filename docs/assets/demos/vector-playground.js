/*
 * vector-playground.js: chapter 3.3's interactive.
 *
 * Two arrows share an origin on a 2D grid. N (teal) stands for a surface
 * normal and L (amber) for the direction towards a light, but they are just
 * two vectors: drag either tip, or focus it and turn it with the arrow keys.
 *
 * The readout shows both lengths, the dot product N·L, the angle between
 * them and the clamped brightness max(0, N̂·L̂) that a diffuse surface would
 * get. The right-hand column turns that number into pictures:
 *
 *   Lit patch      the plot rotated so N points straight up. A beam of
 *                  fixed width arrives from L and spreads over a footprint
 *                  1 / cos θ wide: the same light over more surface, so each
 *                  part of it is dimmer. This is why N·L is "how directly
 *                  the light hits".
 *   Brightness     the same number on a dark-to-white scale. Rendered pixel
 *                  colours use the buffer tokens, which do not change with
 *                  the theme, because they stand for image content.
 *   Cross product  optional. In 2D the cross product of (ax, ay, 0) and
 *                  (bx, by, 0) is (0, 0, ax·by − ay·bx): it sticks straight
 *                  out of the page. The tilted view lays the plot down like
 *                  a floor so that arrow can be drawn, with the parallelogram
 *                  whose area equals its length.
 *
 * Convention: x right, y up, z towards the reader (right-handed), so a
 * positive cross product points out of the screen.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("vector-playground");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Layout (viewBox units) ---------- */

  var VIEW = { w: 860, h: 420 };
  var PLOT = { x0: 8, y0: 8, x1: 460, y1: 412 };
  var ORIGIN = { x: 234, y: 266 };
  var S = 56; // pixels per unit
  var MAX_LEN = 3.6;
  var MIN_LEN = 0.3;

  var PATCH = { x0: 476, y0: 8, x1: 852, y1: 214, cx: 664, cy: 146, half: 100, thick: 12 };
  var BAR = { x0: 476, y0: 222, x1: 852, y1: 268 };
  var CROSS = { x0: 476, y0: 276, x1: 852, y1: 412, cx: 596, cy: 352, k: 24 };

  function toPx(v) {
    return { x: ORIGIN.x + v.x * S, y: ORIGIN.y - v.y * S };
  }
  function fromPx(p) {
    return { x: (p.x - ORIGIN.x) / S, y: (ORIGIN.y - p.y) / S };
  }

  /* ---------- Vector maths (the chapter's subject, kept explicit) ---------- */

  function len(v) { return Math.sqrt(v.x * v.x + v.y * v.y); }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function cross(a, b) { return a.x * b.y - a.y * b.x; } // z of the 3D cross
  function scale(v, s) { return { x: v.x * s, y: v.y * s }; }
  function unit(v) {
    var l = len(v);
    return l > 1e-9 ? scale(v, 1 / l) : { x: 0, y: 0 };
  }
  function angleOf(v) { return Math.atan2(v.y, v.x); }
  function fromAngle(a, l) { return { x: Math.cos(a) * l, y: Math.sin(a) * l }; }
  /* Fixed decimals with a true minus sign, and no "-0.00". */
  function fmt(n, d) {
    var s = Number(n).toFixed(d === undefined ? 2 : d);
    if (Number(s) === 0) return s.replace("-", "");
    return s.charAt(0) === "-" ? "\u2212" + s.slice(1) : s;
  }

  /* Keep a dragged tip inside the plot and within sensible lengths. */
  function clampVec(v) {
    var l = len(v);
    if (l < 1e-6) v = { x: 0, y: MIN_LEN };
    else if (l < MIN_LEN) v = scale(v, MIN_LEN / l);
    else if (l > MAX_LEN) v = scale(v, MAX_LEN / l);
    var p = toPx(v);
    var m = 14;
    p.x = Math.min(PLOT.x1 - m, Math.max(PLOT.x0 + m, p.x));
    p.y = Math.min(PLOT.y1 - m, Math.max(PLOT.y0 + m, p.y));
    var back = fromPx(p);
    return len(back) < MIN_LEN ? scale(unit(back), MIN_LEN) : back;
  }

  function init(root) {
    // Opens with N straight up (length 2) and L 45° to the right (length
    // 2.12): L's shadow on N is 1.5, so N·L = 2 × 1.5 = 3, brightness 0.71.
    var state = {
      n: { x: 0, y: 2 },
      l: { x: 1.5, y: 1.5 },
      normalise: false,
      projection: true,
      cross: false
    };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Vector playground" }),
      h("span", { class: "demo-hint", text: "Drag the tips of N and L, or focus one and turn it with the arrow keys." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    function checkbox(id, label, key) {
      var box = h("input", { type: "checkbox", id: id, checked: state[key] });
      box.addEventListener("change", function () {
        state[key] = box.checked;
        if (key === "normalise" && box.checked) {
          state.n = unit(state.n);
          state.l = unit(state.l);
        }
        draw();
      });
      return h("label", { for: id }, [box, label]);
    }
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Show" }),
      h("div", { class: "checks" }, [
        checkbox("vp-norm", "Normalise both (length 1)", "normalise"),
        checkbox("vp-proj", "L's shadow on N", "projection"),
        checkbox("vp-cross", "Cross product N × L", "cross")
      ])
    ]));
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "group",
      "aria-label": "A grid with two arrows from one origin: N, a surface normal, and L, the direction towards a light. Beside it, the surface patch lit by L, a brightness scale and, optionally, the cross product drawn in a tilted view."
    });
    stage.appendChild(svg);
    root.appendChild(stage);

    var defs = svgEl("defs", null, svg);
    [["vp-arr-geo", "f-geo"], ["vp-arr-lit", "f-lit"], ["vp-arr-acc", "f-acc"]].forEach(function (m) {
      var mk = svgEl("marker", { id: m[0], viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
      svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: m[1] }, mk);
    });
    var clipPatch = svgEl("clipPath", { id: "vp-clip-patch" }, defs);
    svgEl("rect", { x: PATCH.x0 + 1, y: PATCH.y0 + 1, width: PATCH.x1 - PATCH.x0 - 2, height: PATCH.y1 - PATCH.y0 - 2, rx: 7 }, clipPatch);

    var layerGrid = svgEl("g", null, svg);
    var layerPlot = svgEl("g", null, svg);
    var layerPatch = svgEl("g", null, svg);
    var layerBar = svgEl("g", null, svg);
    var layerCross = svgEl("g", null, svg);

    /* Draggable tips: N (teal) and L (amber). */
    function makeHandle(name, cls) {
      var g = svgEl("g", { "aria-label": name === "n" ? "Tip of N, the surface normal" : "Tip of L, the direction to the light", "aria-valuemin": 0, "aria-valuemax": 359 }, svg);
      svgEl("circle", { r: 13, class: cls + " handle-ring" }, g);
      return g;
    }
    var handleN = makeHandle("n", "f-geo-soft s-geo");
    var handleL = makeHandle("l", "f-lit-soft s-lit");

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    /* ---------- Static parts: grid, axes, panel frames ---------- */

    (function drawStatic() {
      svgEl("rect", { x: PLOT.x0, y: PLOT.y0, width: PLOT.x1 - PLOT.x0, height: PLOT.y1 - PLOT.y0, rx: 8, class: "f-bg s-line" }, layerGrid);
      for (var gx = -4; gx <= 4; gx++) {
        var px = ORIGIN.x + gx * S;
        if (px <= PLOT.x0 || px >= PLOT.x1) continue;
        svgEl("line", { x1: px, y1: PLOT.y0 + 1, x2: px, y2: PLOT.y1 - 1, class: gx === 0 ? "s-strong" : "s-line" }, layerGrid);
      }
      for (var gy = -2; gy <= 4; gy++) {
        var py = ORIGIN.y - gy * S;
        if (py <= PLOT.y0 || py >= PLOT.y1) continue;
        svgEl("line", { x1: PLOT.x0 + 1, y1: py, x2: PLOT.x1 - 1, y2: py, class: gy === 0 ? "s-strong" : "s-line" }, layerGrid);
      }
      svgEl("text", { x: PLOT.x1 - 10, y: ORIGIN.y - 6, class: "t-mono t-muted end", text: "x" }, layerGrid);
      svgEl("text", { x: ORIGIN.x + 8, y: PLOT.y0 + 16, class: "t-mono t-muted", text: "y" }, layerGrid);
      svgEl("text", { x: ORIGIN.x + S + 3, y: ORIGIN.y + 14, class: "t-mono t-muted t-small", text: "1" }, layerGrid);
      // The unit circle: every normalised vector ends on it.
      svgEl("circle", { cx: ORIGIN.x, cy: ORIGIN.y, r: S, class: "s-muted dot-dash" }, layerGrid);
      svgEl("text", { x: ORIGIN.x - S * 0.74 - 4, y: ORIGIN.y - S * 0.74 - 6, class: "t-small t-muted end", text: "length 1" }, layerGrid);

      svgEl("rect", { x: PATCH.x0, y: PATCH.y0, width: PATCH.x1 - PATCH.x0, height: PATCH.y1 - PATCH.y0, rx: 8, class: "f-bg s-line" }, layerGrid);
      svgEl("text", { x: PATCH.x0 + 12, y: PATCH.y0 + 20, class: "t-caps", text: "THE PATCH, TURNED SO N POINTS UP" }, layerGrid);
      svgEl("rect", { x: BAR.x0, y: BAR.y0, width: BAR.x1 - BAR.x0, height: BAR.y1 - BAR.y0, rx: 8, class: "f-bg s-line" }, layerGrid);
      svgEl("text", { x: BAR.x0 + 12, y: BAR.y0 + 18, class: "t-caps", text: "BRIGHTNESS = max(0, N̂ · L̂)" }, layerGrid);
      svgEl("rect", { x: CROSS.x0, y: CROSS.y0, width: CROSS.x1 - CROSS.x0, height: CROSS.y1 - CROSS.y0, rx: 8, class: "f-bg s-line" }, layerGrid);
      svgEl("text", { x: CROSS.x0 + 12, y: CROSS.y0 + 20, class: "t-caps", text: "CROSS PRODUCT, PLOT TILTED BACK" }, layerGrid);
    })();

    /* ---------- The plot ---------- */

    function arrow(v, cls, marker, layer) {
      var p = toPx(v);
      svgEl("line", { x1: ORIGIN.x, y1: ORIGIN.y, x2: p.x, y2: p.y, class: cls + " w3 round", "marker-end": "url(#" + marker + ")" }, layer);
    }

    function label(v, text, cls) {
      var u = unit(v);
      var p = toPx(scale(u, len(v) + 0.42));
      svgEl("text", { x: p.x, y: p.y + 5, class: "t-head mid " + cls, text: text }, layerPlot);
    }

    function drawPlot() {
      HB.svg.clear(layerPlot);
      var n = state.n;
      var l = state.l;
      var nu = unit(n);
      var lu = unit(l);

      // The surface the normal belongs to: a line at right angles to N,
      // with ticks on its back side like a ground symbol.
      var t = { x: -nu.y, y: nu.x };
      var a = toPx(scale(t, -1.7));
      var b = toPx(scale(t, 1.7));
      svgEl("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "s-muted w3 round" }, layerPlot);
      for (var i = -3; i <= 3; i++) {
        var base = scale(t, i * 0.5);
        var p0 = toPx(base);
        var p1 = toPx({ x: base.x - nu.x * 0.22 - t.x * 0.16, y: base.y - nu.y * 0.22 - t.y * 0.16 });
        svgEl("line", { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, class: "s-muted" }, layerPlot);
      }
      var sl = toPx({ x: t.x * 1.95 + nu.x * 0.22, y: t.y * 1.95 + nu.y * 0.22 });
      svgEl("text", { x: sl.x, y: sl.y + 4, class: "t-small t-muted mid", text: "surface" }, layerPlot);

      // Angle arc between N and L.
      var an = angleOf(n);
      var al = angleOf(l);
      var d = al - an;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      var r = 30;
      var s0 = { x: ORIGIN.x + r * Math.cos(an), y: ORIGIN.y - r * Math.sin(an) };
      var s1 = { x: ORIGIN.x + r * Math.cos(an + d), y: ORIGIN.y - r * Math.sin(an + d) };
      svgEl("path", { d: "M" + s0.x + "," + s0.y + " A" + r + "," + r + " 0 0 " + (d > 0 ? 0 : 1) + " " + s1.x + "," + s1.y, class: "s-acc w2" }, layerPlot);
      var mid = an + d / 2;
      var deg = Math.round(Math.abs(d) * 180 / Math.PI);
      svgEl("text", { x: ORIGIN.x + (r + 18) * Math.cos(mid), y: ORIGIN.y - (r + 18) * Math.sin(mid) + 4, class: "t-small t-acc t-strong mid", text: deg + "°" }, layerPlot);

      // L's shadow on N: the projection of L onto the line of N.
      if (state.projection) {
        var shadow = dot(l, nu); // signed length along N
        var foot = scale(nu, shadow);
        var fp = toPx(foot);
        var lp = toPx(l);
        if (shadow < 0) {
          // Behind the surface: extend N's line backwards to reach the foot.
          svgEl("line", { x1: ORIGIN.x, y1: ORIGIN.y, x2: fp.x, y2: fp.y, class: "s-muted dash" }, layerPlot);
        }
        svgEl("line", { x1: lp.x, y1: lp.y, x2: fp.x, y2: fp.y, class: "s-muted dash" }, layerPlot);
        svgEl("line", { x1: ORIGIN.x, y1: ORIGIN.y, x2: fp.x, y2: fp.y, class: "s-acc round", "stroke-width": 7, "stroke-opacity": 0.45 }, layerPlot);
        svgEl("circle", { cx: fp.x, cy: fp.y, r: 3.5, class: "f-acc" }, layerPlot);
        // Label on the far side of N from L, so it does not sit on the dashed line.
        var side = cross(n, l) > 0 ? 1 : -1;
        var off = { x: fp.x + side * nu.y * 16, y: fp.y + side * nu.x * 16 };
        svgEl("text", {
          x: off.x, y: off.y + 4, class: "t-small t-acc " + (side * nu.y > 0.2 ? "" : side * nu.y < -0.2 ? "end" : "mid"),
          text: "shadow " + fmt(shadow)
        }, layerPlot);
      }

      // Where each arrow would end if normalised.
      if (!state.normalise) {
        [[nu, "f-geo"], [lu, "f-lit"]].forEach(function (pair) {
          var q = toPx(pair[0]);
          svgEl("circle", { cx: q.x, cy: q.y, r: 3, class: pair[1] }, layerPlot);
        });
      }

      arrow(n, "s-geo", "vp-arr-geo", layerPlot);
      arrow(l, "s-lit", "vp-arr-lit", layerPlot);
      label(n, "N", "t-geo");
      label(l, "L", "t-lit");

      // The cross product, seen head-on: a dot means "out of the screen",
      // a cross means "into it".
      if (state.cross) {
        var z = cross(n, l);
        var cx = ORIGIN.x;
        var cy = ORIGIN.y;
        svgEl("circle", { cx: cx, cy: cy, r: 10, class: "f-surface s-acc w2" }, layerPlot);
        if (z > 1e-6) svgEl("circle", { cx: cx, cy: cy, r: 3.2, class: "f-acc" }, layerPlot);
        else if (z < -1e-6) svgEl("path", { d: "M" + (cx - 5) + "," + (cy - 5) + " L" + (cx + 5) + "," + (cy + 5) + " M" + (cx + 5) + "," + (cy - 5) + " L" + (cx - 5) + "," + (cy + 5), class: "s-acc w2" }, layerPlot);
      } else {
        svgEl("circle", { cx: ORIGIN.x, cy: ORIGIN.y, r: 3.5, class: "f-ink" }, layerPlot);
      }

      var pn = toPx(n);
      var pl = toPx(l);
      handleN.setAttribute("transform", "translate(" + pn.x + "," + pn.y + ")");
      handleL.setAttribute("transform", "translate(" + pl.x + "," + pl.y + ")");
    }

    /* ---------- The lit patch ---------- */

    function drawPatch() {
      HB.svg.clear(layerPatch);
      var nu = unit(state.n);
      var lu = unit(state.l);
      var c = dot(nu, lu); // cos θ
      var sinS = cross(nu, lu); // sin of the signed angle from N to L
      var bright = Math.max(0, c);
      var cx = PATCH.cx;
      var cy = PATCH.cy;
      // In the patch's frame N is (0, 1); L is N turned by the same angle.
      var ldir = { x: -sinS, y: c };
      var g = svgEl("g", { "clip-path": "url(#vp-clip-patch)" }, layerPatch);

      var W = 72; // beam width, perpendicular to the rays
      var RAY = 124;
      var front = c > 0;
      var cc = Math.max(Math.abs(c), 0.06);
      var foot = (W / 2) / cc; // half the footprint along the surface
      var yHit = front ? cy : cy + PATCH.thick;
      // Beam: the band between its two edge rays. Both run parallel to L and
      // land 2 × foot apart on the surface, which is W apart across the beam.
      var hitL = { x: cx - foot, y: yHit };
      var hitR = { x: cx + foot, y: yHit };
      // Light from behind arrives from below: keep those rays clear of the note.
      if (!front) RAY = Math.min(RAY, (PATCH.y1 - 28 - yHit) / Math.max(-ldir.y, 0.05));
      var startL = { x: hitL.x + ldir.x * RAY, y: hitL.y - ldir.y * RAY };
      var startR = { x: hitR.x + ldir.x * RAY, y: hitR.y - ldir.y * RAY };
      svgEl("polygon", {
        points: [startL, hitL, hitR, startR].map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" "),
        class: "f-lit-soft", "fill-opacity": 0.8
      }, g);
      for (var i = 0; i <= 4; i++) {
        var hx = hitL.x + (hitR.x - hitL.x) * (i / 4);
        svgEl("line", {
          x1: hx + ldir.x * RAY, y1: yHit - ldir.y * RAY, x2: hx, y2: yHit,
          class: "s-lit w15", "marker-end": "url(#vp-arr-lit)"
        }, g);
      }

      // The patch itself, shaded like a rendered surface.
      svgEl("rect", { x: cx - PATCH.half, y: cy, width: PATCH.half * 2, height: PATCH.thick, class: "f-buf-lo" }, g);
      svgEl("rect", { x: cx - PATCH.half, y: cy, width: PATCH.half * 2, height: PATCH.thick, class: "f-buf-hi", "fill-opacity": bright }, g);
      svgEl("rect", { x: cx - PATCH.half, y: cy, width: PATCH.half * 2, height: PATCH.thick, class: "s-strong" }, g);
      if (front) {
        var fl = Math.max(cx - PATCH.half, Math.min(hitL.x, hitR.x));
        var fr = Math.min(cx + PATCH.half, Math.max(hitL.x, hitR.x));
        svgEl("line", { x1: fl, y1: cy + PATCH.thick + 6, x2: fr, y2: cy + PATCH.thick + 6, class: "s-lit w2" }, g);
      }
      svgEl("line", { x1: cx, y1: cy, x2: cx, y2: cy - 66, class: "s-geo w3 round", "marker-end": "url(#vp-arr-geo)" }, g);
      svgEl("text", { x: cx - 10, y: cy - 60, class: "t-head t-geo end", text: "N" }, g);
      var lx = cx + ldir.x * (RAY - 6) + (ldir.x >= 0 ? 12 : -12);
      var ly = cy - ldir.y * (RAY - 6);
      svgEl("text", { x: lx, y: Math.max(PATCH.y0 + 36, Math.min(PATCH.y1 - 30, ly)), class: "t-head t-lit " + (ldir.x >= 0 ? "" : "end"), text: "L" }, g);

      var note;
      if (!front) note = "Light arrives from behind: N·L < 0, so the surface gets none.";
      else if (c > 0.995) note = "Straight on: the beam covers the least surface.";
      else note = "The beam spreads over " + fmt(1 / c) + "× the surface, so each part gets " + fmt(c) + " of the light.";
      svgEl("text", { x: PATCH.x0 + 12, y: PATCH.y1 - 10, class: "t-small t-muted", text: note }, layerPatch);
    }

    /* ---------- Brightness bar ---------- */

    function drawBar() {
      HB.svg.clear(layerBar);
      var nu = unit(state.n);
      var lu = unit(state.l);
      var bright = Math.max(0, dot(nu, lu));
      var x0 = BAR.x0 + 12;
      var x1 = BAR.x1 - 64;
      var y = BAR.y0 + 29;
      var steps = 24;
      for (var i = 0; i < steps; i++) {
        var w = (x1 - x0) / steps;
        svgEl("rect", { x: x0 + i * w, y: y, width: w + 0.4, height: 12, class: "f-buf-lo" }, layerBar);
        svgEl("rect", { x: x0 + i * w, y: y, width: w + 0.4, height: 12, class: "f-buf-hi", "fill-opacity": (i + 0.5) / steps }, layerBar);
      }
      svgEl("rect", { x: x0, y: y, width: x1 - x0, height: 12, class: "s-strong" }, layerBar);
      var mx = x0 + bright * (x1 - x0);
      svgEl("path", { d: "M" + mx + "," + (y - 2) + " l-5,-7 h10 Z", class: "f-acc" }, layerBar);
      svgEl("line", { x1: mx, y1: y - 2, x2: mx, y2: y + 14, class: "s-acc w2" }, layerBar);
      svgEl("text", { x: BAR.x1 - 12, y: y + 11, class: "t-head end", text: fmt(bright) }, layerBar);
    }

    /* ---------- Cross product, tilted view ---------- */

    // The plot laid back like a floor: x to the right, y into the page
    // (drawn up and to the right, foreshortened), z straight up.
    function tilt(x, y, z) {
      return { x: CROSS.cx + CROSS.k * (x + 0.5 * y), y: CROSS.cy - CROSS.k * (0.42 * y) - z };
    }

    function drawCross() {
      HB.svg.clear(layerCross);
      if (!state.cross) {
        svgEl("text", { x: CROSS.x0 + 12, y: CROSS.y0 + 52, class: "t-small t-muted", text: "Tick “Cross product N × L” to see the arrow" }, layerCross);
        svgEl("text", { x: CROSS.x0 + 12, y: CROSS.y0 + 68, class: "t-small t-muted", text: "that stands at right angles to both." }, layerCross);
        return;
      }
      var n = state.n;
      var l = state.l;
      var z = cross(n, l);
      // Floor outline.
      var c1 = tilt(-3.2, -1.6, 0), c2 = tilt(3.2, -1.6, 0), c3 = tilt(3.2, 3.6, 0), c4 = tilt(-3.2, 3.6, 0);
      svgEl("polygon", { points: [c1, c2, c3, c4].map(function (p) { return p.x + "," + p.y; }).join(" "), class: "f-sunken s-line" }, layerCross);
      // Parallelogram spanned by N and L: its area is |N × L|.
      var p0 = tilt(0, 0, 0), pn = tilt(n.x, n.y, 0), pnl = tilt(n.x + l.x, n.y + l.y, 0), pl = tilt(l.x, l.y, 0);
      svgEl("polygon", { points: [p0, pn, pnl, pl].map(function (p) { return p.x + "," + p.y; }).join(" "), class: "f-acc-soft s-acc", "fill-opacity": 0.85 }, layerCross);
      svgEl("line", { x1: p0.x, y1: p0.y, x2: pn.x, y2: pn.y, class: "s-geo w2", "marker-end": "url(#vp-arr-geo)" }, layerCross);
      svgEl("line", { x1: p0.x, y1: p0.y, x2: pl.x, y2: pl.y, class: "s-lit w2", "marker-end": "url(#vp-arr-lit)" }, layerCross);
      // The cross arrow: drawn at 6 px per unit of area, capped to fit.
      var hpx = Math.max(-46, Math.min(46, z * 6));
      if (Math.abs(hpx) > 2) {
        svgEl("line", { x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y - hpx, class: "s-acc w3", "marker-end": "url(#vp-arr-acc)" }, layerCross);
      }
      svgEl("text", { x: p0.x - 8, y: p0.y - hpx + (hpx >= 0 ? 4 : 0), class: "t-small t-acc t-strong end", text: "N × L" }, layerCross);
      var where = Math.abs(z) < 1e-3 ? "zero: N and L are parallel" : z > 0 ? "out of the screen, towards you" : "into the screen, away from you";
      svgEl("text", { x: CROSS.x1 - 12, y: CROSS.y1 - 26, class: "t-small end", text: "length " + fmt(Math.abs(z)) + " = shaded area" }, layerCross);
      svgEl("text", { x: CROSS.x1 - 12, y: CROSS.y1 - 10, class: "t-small t-muted end", text: where }, layerCross);
    }

    /* ---------- Readout ---------- */

    function drawReadout() {
      var n = state.n;
      var l = state.l;
      var nu = unit(n);
      var lu = unit(l);
      var c = dot(nu, lu);
      var deg = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
      function cell(lbl, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: lbl }), h("span", { class: "v", text: value })]);
      }
      var cells = [
        cell("Length of N", fmt(len(n))),
        cell("Length of L", fmt(len(l))),
        cell("N · L", fmt(dot(n, l))),
        cell("Angle", Math.round(deg) + "°"),
        cell("Brightness", fmt(Math.max(0, c)))
      ];
      if (state.cross) cells.push(cell("N × L", fmt(cross(n, l))));
      readout.replaceChildren.apply(readout, cells);
      [["n", handleN, "N"], ["l", handleL, "L"]].forEach(function (t) {
        var v = state[t[0]];
        var a = Math.round(((angleOf(v) * 180 / Math.PI) + 360) % 360);
        t[1].setAttribute("aria-valuenow", a);
        t[1].setAttribute("aria-valuetext", t[2] + " points at " + a + " degrees with length " + fmt(len(v)) + ". N·L is " + fmt(dot(n, l)) + ", angle " + Math.round(deg) + " degrees.");
      });
    }

    function draw() {
      drawPlot();
      drawPatch();
      drawBar();
      drawCross();
      drawReadout();
    }

    function setVec(key, v) {
      v = clampVec(v);
      if (state.normalise) v = unit(v);
      state[key] = v;
      draw();
    }

    [["n", handleN], ["l", handleL]].forEach(function (pair) {
      var key = pair[0];
      HB.draggable(svg, pair[1], {
        onDrag: function (pt) { setVec(key, fromPx(pt)); },
        onKey: function (dir, big) {
          // Arrow keys turn the arrow; Shift turns it faster.
          var v = state[key];
          var a = angleOf(v) + dir * (big ? 15 : 5) * Math.PI / 180;
          setVec(key, fromAngle(a, len(v)));
        }
      });
    });

    draw();
    log.debug("ready");
  }

  HB.demos.register("vector-playground", init);
})();

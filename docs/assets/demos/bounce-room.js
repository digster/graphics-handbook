/*
 * bounce-room.js: chapter 8.1's interactive.
 *
 * A 2D cross-section of a room, 8 m wide and 4 m high, lit only by sunlight
 * that enters through a window in the left wall at 30° above the horizon and
 * lands on the middle of the floor. A crate stands in the dark corner under
 * the window, and the right wall can be painted red. The light is solved with radiosity in "flatland":
 *
 *   - Every wall, the floor, the ceiling and the crate's sides are cut into
 *     25 cm patches. Each patch has an albedo (RGB) and reflects diffusely.
 *   - The window's patches reflect nothing: light that reaches them leaves.
 *   - Direct light: each patch's share of the sunbeam, E_i, tested with
 *     rays back to the window. Its reflected direct light is B0_i = rho_i E_i.
 *   - Form factors: F_ij, the share of light leaving patch i that lands on
 *     patch j, from the 2D (flatland) differential form factor
 *     cos(a_i) cos(a_j) / (2 r), integrated with 6 × 6 sample pairs per patch
 *     pair and a visibility test against the crate. Each row is then scaled
 *     to sum to 1, because the room is closed (light that "escapes" goes
 *     into the window patches).
 *   - Bounce n: B_n = rho ∘ (F · B_{n-1}). Showing k bounces sums B_0 to B_k.
 *     "Many" sums until a bounce adds less than a millionth of the direct.
 *
 * Inside the room each cell is shaded by the bounced light reaching that
 * spot from all directions (its fluence: the radiance of every patch it can
 * see, times the angle that patch covers). Read it as "how brightly a small
 * grey ball placed here would be lit by bounced light". Light reaching the
 * ball off a wall has bounced once more than the wall's own light, so with
 * k bounces the ball sees the walls' light from bounces 0 to k - 1. The
 * sunbeam itself is drawn as an amber overlay.
 *
 * Drawing uses diagram classes only: a buffer-dark base, a buffer-light
 * layer whose opacity is the brightness, and a red (paint-red) layer for red light,
 * so the picture is the same in both themes. Exposed as HB.bounceRoom so the
 * chapter's static figure uses exactly the same solution.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("bounce-room");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- Room model (metres, x right, y up) ---------- */

  var W = 8, H = 4, PATCH = 0.25;
  var WIN = [2.0, 3.5];                     // window opening in the left wall
  var CRATE = { x0: 0.5, x1: 1.5, h: 1.0 };
  var SUN_EL = 30 * Math.PI / 180;
  var D = [Math.cos(SUN_EL), -Math.sin(SUN_EL)];   // direction light travels
  var TO_SUN = [-D[0], -D[1]];
  var S = 1;                                 // sun irradiance across the beam
  var ALB = {
    white: [0.8, 0.8, 0.8],
    floor: [0.5, 0.5, 0.5],
    crate: [0.5, 0.5, 0.5],
    red: [0.75, 0.12, 0.08],
    window: [0, 0, 0]
  };
  var NS = 6;                                // samples per patch for form factors
  var LUMA = [0.2126, 0.7152, 0.0722];

  function lum(c) { return c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]; }

  /* Patches: endpoints a, b, inward normal n, kind. */
  function buildPatches() {
    var list = [];
    function strip(x0, y0, x1, y1, n, kind, skip) {
      var len = Math.hypot(x1 - x0, y1 - y0), count = Math.round(len / PATCH);
      for (var k = 0; k < count; k++) {
        var a = [x0 + (x1 - x0) * k / count, y0 + (y1 - y0) * k / count];
        var b = [x0 + (x1 - x0) * (k + 1) / count, y0 + (y1 - y0) * (k + 1) / count];
        var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (skip && skip(mid)) continue;
        list.push({ a: a, b: b, n: n, kind: typeof kind === "function" ? kind(mid) : kind, len: len / count, mid: mid });
      }
    }
    strip(0, 0, W, 0, [0, 1], "floor", function (m) { return m[0] > CRATE.x0 && m[0] < CRATE.x1; });
    strip(0, H, W, H, [0, -1], "ceiling");
    strip(0, 0, 0, H, [1, 0], function (m) { return m[1] > WIN[0] && m[1] < WIN[1] ? "window" : "left"; });
    strip(W, 0, W, H, [-1, 0], "right");
    strip(CRATE.x0, 0, CRATE.x0, CRATE.h, [-1, 0], "crate");
    strip(CRATE.x0, CRATE.h, CRATE.x1, CRATE.h, [0, 1], "crate");
    strip(CRATE.x1, 0, CRATE.x1, CRATE.h, [1, 0], "crate");
    return list;
  }

  /* Does the open segment p->q pass through the crate's interior? */
  function blocked(p, q) {
    var e = 1e-7;
    var x0 = CRATE.x0 + e, x1 = CRATE.x1 - e, y0 = e, y1 = CRATE.h - e;
    var t0 = 0, t1 = 1, dx = q[0] - p[0], dy = q[1] - p[1];
    var ps = [-dx, dx, -dy, dy], qs = [p[0] - x0, x1 - p[0], p[1] - y0, y1 - p[1]];
    for (var i = 0; i < 4; i++) {
      if (Math.abs(ps[i]) < 1e-12) { if (qs[i] < 0) return false; continue; }
      var r = qs[i] / ps[i];
      if (ps[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t1 - t0 > 1e-9;
  }

  /* Is point p in the sunbeam? Trace towards the sun to the left wall. */
  function inBeam(p) {
    var t = p[0] / D[0];
    var y = p[1] + t * TO_SUN[1];
    if (y < WIN[0] || y > WIN[1] || y > H) return false;
    return !blocked(p, [0, y]);
  }

  function samplePoint(pt, k, n) {
    var f = (k + 0.5) / n;
    return [pt.a[0] + (pt.b[0] - pt.a[0]) * f, pt.a[1] + (pt.b[1] - pt.a[1]) * f];
  }

  function solve(redWall) {
    var P = buildPatches();
    var N = P.length;
    P.forEach(function (pt) {
      pt.rho = ALB[pt.kind === "window" ? "window" : pt.kind === "right" ? (redWall ? "red" : "white") : pt.kind === "floor" ? "floor" : pt.kind === "crate" ? "crate" : "white"];
    });
    // Direct irradiance from the sun.
    P.forEach(function (pt) {
      var c = pt.n[0] * TO_SUN[0] + pt.n[1] * TO_SUN[1];
      var lit = 0;
      if (c > 0) for (var k = 0; k < 16; k++) if (inBeam(samplePoint(pt, k, 16))) lit++;
      pt.E = c > 0 ? S * c * lit / 16 : 0;
    });
    // Form factors.
    var F = new Float64Array(N * N);
    for (var i = 0; i < N; i++) {
      var pi = P[i], row = 0;
      for (var j = 0; j < N; j++) {
        if (i === j) continue;
        var pj = P[j], sum = 0;
        for (var a = 0; a < NS; a++) {
          var p = samplePoint(pi, a, NS);
          for (var b = 0; b < NS; b++) {
            var q = samplePoint(pj, b, NS);
            var dx = q[0] - p[0], dy = q[1] - p[1], r = Math.hypot(dx, dy);
            if (r < 1e-9) continue;
            var ci = (pi.n[0] * dx + pi.n[1] * dy) / r, cj = -(pj.n[0] * dx + pj.n[1] * dy) / r;
            if (ci <= 0 || cj <= 0) continue;
            if (blocked(p, q)) continue;
            sum += ci * cj / (2 * r) * (pj.len / NS);
          }
        }
        F[i * N + j] = sum / NS;
        row += F[i * N + j];
      }
      if (row > 0) for (j = 0; j < N; j++) F[i * N + j] /= row;
    }
    // Bounces.
    var bounces = [];
    var B0 = P.map(function (pt) { return [pt.rho[0] * pt.E, pt.rho[1] * pt.E, pt.rho[2] * pt.E]; });
    bounces.push(B0);
    var power = function (B) { var s = 0; for (var k = 0; k < N; k++) s += lum(B[k]) * P[k].len; return s; };
    var p0 = power(B0);
    var prev = B0;
    for (var n = 1; n < 400; n++) {
      var next = [];
      for (i = 0; i < N; i++) {
        var acc = [0, 0, 0];
        for (j = 0; j < N; j++) {
          var f = F[i * N + j];
          if (f === 0) continue;
          acc[0] += f * prev[j][0]; acc[1] += f * prev[j][1]; acc[2] += f * prev[j][2];
        }
        next.push([acc[0] * P[i].rho[0], acc[1] * P[i].rho[1], acc[2] * P[i].rho[2]]);
      }
      bounces.push(next);
      prev = next;
      if (power(next) < 1e-6 * p0) break;
    }
    var shares = bounces.map(function (B) { return power(B) / p0; });
    return { patches: P, bounces: bounces, shares: shares };
  }

  /* Radiosity after k bounces (k = Infinity for all of them). */
  function total(sol, k) {
    var N = sol.patches.length, out = [];
    for (var i = 0; i < N; i++) out.push([0, 0, 0]);
    var last = Math.min(k, sol.bounces.length - 1);
    for (var n = 0; n <= last; n++) {
      for (i = 0; i < N; i++) { var b = sol.bounces[n][i]; out[i][0] += b[0]; out[i][1] += b[1]; out[i][2] += b[2]; }
    }
    return out;
  }

  /* Light reaching each interior point: fluence from every visible patch
     (radiance B/2 in flatland, times the angle it covers), plus the sun. */
  function fieldWeights(patches, nx, ny) {
    var cells = [];
    for (var yy = 0; yy < ny; yy++) {
      for (var xx = 0; xx < nx; xx++) {
        var p = [(xx + 0.5) * W / nx, (yy + 0.5) * H / ny];
        if (p[0] > CRATE.x0 && p[0] < CRATE.x1 && p[1] < CRATE.h) { cells.push(null); continue; }
        var w = new Float64Array(patches.length);
        patches.forEach(function (pt, j) {
          var s = 0;
          for (var b = 0; b < 4; b++) {
            var q = samplePoint(pt, b, 4);
            var dx = p[0] - q[0], dy = p[1] - q[1], r = Math.hypot(dx, dy);
            var c = (pt.n[0] * dx + pt.n[1] * dy) / r;
            if (c <= 0 || blocked(p, q)) continue;
            s += c / r * (pt.len / 4);
          }
          w[j] = s / 2;          // radiance = B / 2 in flatland
        });
        cells.push({ w: w, sun: inBeam(p) ? S : 0, x: xx, y: yy });
      }
    }
    return cells;
  }

  function fieldAt(cell, B) {
    var c = [0, 0, 0];
    for (var j = 0; j < B.length; j++) {
      var wj = cell.w[j];
      if (wj === 0) continue;
      c[0] += wj * B[j][0]; c[1] += wj * B[j][1]; c[2] += wj * B[j][2];
    }
    return c;
  }

  /* Display: exposure, then a gentle curve. Returns the opacity of the
     light layer (a) and of the red layer (b) over the dark base. */
  var EXPO = { patch: 3.2, field: 0.75 };
  function tone(v, e) { return Math.pow(1 - Math.exp(-e * v), 1 / 2.2); }
  function layers(c, e) {
    var r = tone(c[0], e), g = tone(c[1], e), b2 = tone(c[2], e);
    var grey = Math.min(g, b2);
    var rose = Math.max(0, r - grey);
    var bOp = Math.min(1, rose / 0.55);
    var aOp = bOp >= 0.999 ? 0 : Math.max(0, Math.min(1, (grey - 0.18 * bOp) / (1 - bOp)));
    return { a: aOp, b: bOp };
  }

  HB.bounceRoom = {
    W: W, H: H, WIN: WIN, CRATE: CRATE, SUN_EL: SUN_EL, inBeam: inBeam,
    solve: solve, total: total, fieldWeights: fieldWeights, fieldAt: fieldAt, layers: layers, EXPO: EXPO, lum: lum
  };

  /* ---------- Interactive ---------- */

  var VW = 820, VH = 380;
  var K = 60, OX = 74, OY = 292;            // px per metre; room origin
  var NX = 48, NY = 24;                     // interior cells
  var STEPS = [{ value: 0, label: "0" }, { value: 1, label: "1" }, { value: 2, label: "2" }, { value: 4, label: "4" }, { value: Infinity, label: "Many" }];

  function sx(x) { return OX + x * K; }
  function sy(y) { return OY - y * K; }

  function init(root) {
    var state = { k: 1, red: true };
    var cache = {};
    function solution() {
      var key = state.red ? "red" : "white";
      if (!cache[key]) cache[key] = solve(state.red);
      return cache[key];
    }
    var t0 = performance.now();
    var sol0 = solution();
    var cells = fieldWeights(sol0.patches, NX, NY);   // geometry is the same for both colours

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Bounce room" }),
      h("span", { class: "demo-hint", text: "Add bounces one at a time and watch the room fill with light." })
    ]));
    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Bounces of light", STEPS, state.k, function (v) { state.k = v; draw(); }));
    var redBox = h("input", { type: "checkbox", id: "br-red", checked: true });
    redBox.addEventListener("change", function () { state.red = redBox.checked; draw(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Right wall" }),
      h("div", { class: "checks" }, [h("label", { for: "br-red" }, [redBox, "Painted red"])])
    ]));
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", { class: "dg is-wide", viewBox: "0 0 " + VW + " " + VH, role: "img", "aria-label": "Cross-section of a room lit by sunlight through a window" });
    stage.appendChild(svg);
    root.appendChild(stage);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);
    var note = h("p", { class: "demo-hint" });
    root.appendChild(note);

    /* Static scaffolding. */
    var defs = svgEl("defs", null, svg);
    var blur = svgEl("filter", { id: "br-blur", x: "-5%", y: "-5%", width: "110%", height: "110%" }, defs);
    svgEl("feGaussianBlur", { stdDeviation: 4 }, blur);
    var clip = svgEl("clipPath", { id: "br-clip" }, defs);
    svgEl("rect", { x: sx(0), y: sy(H), width: W * K, height: H * K }, clip);
    var mk = svgEl("marker", { id: "br-arr", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" }, defs);
    svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: "f-lit" }, mk);

    svgEl("text", { x: 4, y: 20, class: "t-caps", text: "THE ROOM IN CROSS-SECTION · 8 M × 4 M · SUNLIGHT ONLY" }, svg);
    svgEl("rect", { x: sx(0) - 12, y: sy(H) - 12, width: W * K + 24, height: H * K + 24, class: "f-buf-lo" }, svg);
    var layerField = svgEl("g", { "clip-path": "url(#br-clip)" }, svg);
    var layerField2 = svgEl("g", { filter: "url(#br-blur)" }, layerField);
    // The sunbeam, as an amber overlay from the window to the floor.
    var beam = [[0, WIN[0]], [0, WIN[1]]];
    [WIN[1], WIN[0]].forEach(function (yw) {
      var t = Math.min(W / D[0], yw / -D[1]);
      beam.push([D[0] * t, yw + D[1] * t]);
    });
    svgEl("polygon", { points: beam.map(function (q) { return sx(q[0]).toFixed(1) + "," + sy(q[1]).toFixed(1); }).join(" "), class: "f-lit", "fill-opacity": 0.22 }, layerField);
    var layerPatches = svgEl("g", null, svg);
    var layerOver = svgEl("g", null, svg);
    var layerChart = svgEl("g", null, svg);

    // Sun arrows entering the window from outside.
    for (var s = 0; s < 3; s++) {
      var y0 = WIN[0] + 0.25 + s * 0.5;
      var start = [-1.05, y0 + 1.05 * Math.tan(SUN_EL)];
      svgEl("line", { x1: sx(start[0]), y1: sy(start[1]), x2: sx(-0.15), y2: sy(y0 + 0.15 * Math.tan(SUN_EL)), class: "s-lit w2", "marker-end": "url(#br-arr)" }, layerOver);
    }
    svgEl("text", { x: 4, y: sy(WIN[0]) + 4, class: "t-small t-lit t-strong", text: "sun, 30° up" }, layerOver);
    // Beam edges, faint.
    [WIN[0], WIN[1]].forEach(function (yw) {
      var t = Math.min(W / D[0], yw / -D[1]);
      svgEl("line", { x1: sx(0), y1: sy(yw), x2: sx(D[0] * t), y2: sy(yw + D[1] * t), class: "s-lit dash", "stroke-opacity": 0.55 }, layerOver);
    });
    svgEl("text", { x: 4, y: sy(WIN[0]) + 20, class: "t-small t-muted", text: "window" }, layerOver);
    svgEl("text", { x: sx(W) + 18, y: sy(H / 2) - 6, class: "t-small t-muted", text: "right" }, layerOver);
    svgEl("text", { x: sx(W) + 18, y: sy(H / 2) + 8, class: "t-small t-muted", text: "wall" }, layerOver);
    svgEl("text", { x: sx((CRATE.x0 + CRATE.x1) / 2), y: sy(CRATE.h / 2) + 4, class: "t-small t-muted mid", text: "crate" }, layerOver);
    svgEl("text", { x: sx(0), y: OY + 30, class: "t-small t-muted", text: "Inside: how brightly bounced light alone would light a small grey ball at each spot; amber: the sunbeam." }, layerOver);
    svgEl("text", { x: sx(0), y: OY + 46, class: "t-small t-muted", text: "Walls, floor, ceiling and crate: the light each 25 cm patch sends back out." }, layerOver);

    /* Chart. */
    var CX0 = 636, CX1 = 806, CY0 = 292, CY1 = 74;
    svgEl("text", { x: CX0 - 10, y: 20, class: "t-caps", text: "LIGHT ADDED BY EACH BOUNCE" }, svg);
    svgEl("text", { x: CX0 - 10, y: 36, class: "t-small t-muted", text: "% of the direct light reflected" }, svg);

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }
    function pct(v) { return v >= 0.995 ? Math.round(v * 100) + "%" : v >= 0.1 ? Math.round(v * 100) + "%" : (v * 100).toFixed(1) + "%"; }

    function draw() {
      var sol = solution();
      var k = state.k;
      var B = total(sol, k);
      var P = sol.patches;
      // A ball lit by a wall's light sees one bounce more than the wall.
      var Bf = k === 0 ? null : total(sol, k === Infinity ? Infinity : k - 1);

      /* Interior field. */
      HB.svg.clear(layerField2);
      var cw = W * K / NX, chh = H * K / NY;
      if (Bf) cells.forEach(function (c) {
        if (!c) return;
        var L = layers(fieldAt(c, Bf), EXPO.field);
        var x = sx(c.x * W / NX), y = sy((c.y + 1) * H / NY);
        if (L.a > 0.01) svgEl("rect", { x: x.toFixed(1), y: y.toFixed(1), width: (cw + 0.6).toFixed(1), height: (chh + 0.6).toFixed(1), class: "f-buf-hi", "fill-opacity": L.a.toFixed(2) }, layerField2);
        if (L.b > 0.02) svgEl("rect", { x: x.toFixed(1), y: y.toFixed(1), width: (cw + 0.6).toFixed(1), height: (chh + 0.6).toFixed(1), class: "f-paint-red", "fill-opacity": L.b.toFixed(2) }, layerField2);
      });

      /* Patches, drawn as bands just outside the interior (inside, for the crate). */
      HB.svg.clear(layerPatches);
      svgEl("rect", { x: sx(CRATE.x0), y: sy(CRATE.h), width: (CRATE.x1 - CRATE.x0) * K, height: CRATE.h * K, class: "f-buf-lo" }, layerPatches);
      P.forEach(function (pt, i) {
        // The band sits behind the surface, opposite its normal: outside
        // the room for walls, inside the crate for the crate's sides.
        var t = 9;
        var x0 = Math.min(pt.a[0], pt.b[0]), x1 = Math.max(pt.a[0], pt.b[0]), y0 = Math.min(pt.a[1], pt.b[1]), y1 = Math.max(pt.a[1], pt.b[1]);
        var r;
        if (pt.n[1] > 0) r = { x: sx(x0), y: sy(y0), w: (x1 - x0) * K, h: t };
        else if (pt.n[1] < 0) r = { x: sx(x0), y: sy(y0) - t, w: (x1 - x0) * K, h: t };
        else if (pt.n[0] > 0) r = { x: sx(x0) - t, y: sy(y1), w: t, h: (y1 - y0) * K };
        else r = { x: sx(x0), y: sy(y1), w: t, h: (y1 - y0) * K };
        if (pt.kind === "window") {
          svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h, class: "f-surface" }, layerPatches);
          return;
        }
        var L = layers(B[i], EXPO.patch);
        svgEl("rect", { x: r.x.toFixed(1), y: r.y.toFixed(1), width: (r.w + 0.4).toFixed(1), height: (r.h + 0.4).toFixed(1), class: "f-buf-lo" }, layerPatches);
        if (L.a > 0.01) svgEl("rect", { x: r.x.toFixed(1), y: r.y.toFixed(1), width: (r.w + 0.4).toFixed(1), height: (r.h + 0.4).toFixed(1), class: "f-buf-hi", "fill-opacity": L.a.toFixed(2) }, layerPatches);
        if (L.b > 0.02) svgEl("rect", { x: r.x.toFixed(1), y: r.y.toFixed(1), width: (r.w + 0.4).toFixed(1), height: (r.h + 0.4).toFixed(1), class: "f-paint-red", "fill-opacity": L.b.toFixed(2) }, layerPatches);
      });
      svgEl("rect", { x: sx(0) - 9, y: sy(H) - 9, width: W * K + 18, height: H * K + 18, class: "s-strong" }, layerPatches);

      /* Chart: bars for bounces 1 to 8, then the rest together. */
      HB.svg.clear(layerChart);
      var shares = sol.shares;
      var rest = 0;
      for (var n = 9; n < shares.length; n++) rest += shares[n];
      var bars = [];
      for (n = 1; n <= 8; n++) bars.push({ label: String(n), v: shares[n] || 0, on: n <= k });
      bars.push({ label: "9+", v: rest, on: k === Infinity });
      var vmax = Math.max.apply(null, bars.map(function (b) { return b.v; })) * 1.1;
      var bw = (CX1 - CX0) / bars.length;
      svgEl("line", { x1: CX0, y1: CY0, x2: CX1, y2: CY0, class: "s-strong" }, layerChart);
      bars.forEach(function (b, i) {
        var hh = (CY0 - CY1) * b.v / vmax;
        var x = CX0 + i * bw + 2;
        svgEl("rect", { x: x.toFixed(1), y: (CY0 - hh).toFixed(1), width: (bw - 4).toFixed(1), height: Math.max(0.5, hh).toFixed(1), class: b.on ? "f-acc s-acc" : "f-surface s-acc dash" }, layerChart);
        svgEl("text", { x: (x + (bw - 4) / 2).toFixed(1), y: CY0 + 14, class: "t-small t-muted mid", text: b.label }, layerChart);
        if (i < 4 || i === 8) svgEl("text", { x: (x + (bw - 4) / 2).toFixed(1), y: (CY0 - hh - 5).toFixed(1), class: "t-small mid " + (b.on ? "t-acc t-strong" : "t-muted"), text: Math.round(b.v * 100) + "" }, layerChart);
      });
      svgEl("text", { x: (CX0 + CX1) / 2, y: CY0 + 30, class: "t-small t-muted mid", text: "bounce" }, layerChart);
      svgEl("text", { x: CX0 - 10, y: CY0 + 52, class: "t-small t-muted", text: "Filled: included in the picture." }, layerChart);

      /* Readouts. */
      var shownK = k === Infinity ? shares.length - 1 : k;
      var sumShown = 0, sumAll = 0;
      for (n = 0; n < shares.length; n++) { sumAll += shares[n]; if (n <= shownK) sumShown += shares[n]; }
      // The crate's dark left face, against its final light.
      var Bfinal = total(sol, Infinity);
      var face = 0, faceFinal = 0;
      P.forEach(function (pt, i) {
        if (pt.kind === "crate" && pt.n[0] < 0) { face += HB.bounceRoom.lum(B[i]); faceFinal += HB.bounceRoom.lum(Bfinal[i]); }
      });
      readout.replaceChildren(
        cell("Bounces shown", k === Infinity ? "all (" + (shares.length - 1) + ")" : String(k)),
        cell(k === 0 ? "Direct light only" : k === Infinity ? "The last bounces add" : "Bounce " + k + " adds", k === 0 ? "100%" : k === Infinity ? "< 0.1%" : pct(shares[k] || 0) + " of direct"),
        cell("Total light vs direct", (sumShown).toFixed(2) + "×"),
        cell("Crate's shaded side", faceFinal > 0 ? Math.round(100 * face / faceFinal) + "% of final" : "0%")
      );
      var msg;
      if (k === 0) msg = "Direct light only: the sunbeam lands on the floor and the foot of the right wall, and everything the sun does not reach is black. Real rooms never look like this; that darkness is what the bounces fill.";
      else if (k === 1) msg = "One bounce: the sunlit floor now lights the ceiling, the walls and the crate's near side. This single bounce adds " + pct(shares[1]) + " of the direct light, more than any later one." + (state.red ? " The red wall, lit by the floor, glows red." : "");
      else if (k === 2) msg = "Two bounces: light that already bounced once bounces again. " + (state.red ? "Red light from the right wall now tints the floor and ceiling next to it: colour bleeding." : "With a white wall the extra light is neutral.") + " The crate's shaded side reaches " + Math.round(100 * face / faceFinal) + "% of its final brightness.";
      else if (k === 4) msg = "Four bounces: each one adds less, because every surface absorbs part of what reaches it and some light leaves through the window. The bars shrink by roughly the same factor each time.";
      else msg = "All bounces: " + (shares.length - 1) + " were summed before one added less than a millionth of the direct light. In total the room holds " + sumAll.toFixed(2) + " times the direct light, and the first two bounces did most of the work.";
      note.textContent = msg;
      svg.setAttribute("aria-label", "Cross-section of a room lit by the sun through a window, with " + (k === Infinity ? "all" : k) + " bounces of light. Total light is " + sumShown.toFixed(2) + " times the direct light." + (state.red ? " The right wall is red." : ""));
    }

    draw();
    log.debug("ready in", Math.round(performance.now() - t0), "ms,", sol0.patches.length, "patches,", sol0.shares.length, "bounces");
  }

  HB.demos.register("bounce-room", init);
})();

/*
 * triangle-rasterizer.js: chapter 5.3's interactive.
 *
 * Part 1, the pixel grid. One triangle over a 16 x 12 grid of pixels. The
 * reader drags its corners A, B and C. A pixel is covered when its centre
 * (the sample point) is inside all three edges; centres that land exactly on
 * an edge follow the Direct3D top-left rule. Covered pixels are filled with
 * the three corner colours blended by the barycentric weights at the centre.
 * A probe pixel (hover, tap, or the focusable outline) reports its weights,
 * so the reader can see that "inside" means "no weight below zero".
 * An optional overlay groups pixels into the 2 x 2 quads that pixel shaders
 * run in, and the readout counts how many shader lanes the triangle starts.
 *
 * Part 2, the textured floor. A square with an 8 x 8 checkerboard, tilted
 * away from the camera and drawn as two triangles. "Perspective-correct"
 * maps each check through the true projection; "Affine" blends UVs with
 * screen-space weights inside each triangle, as early consoles did, which
 * bends the checks at the diagonal. Both are exact vector drawings: every
 * check is a polygon, clipped against the diagonal for the affine case.
 *
 * Colour blending without literal colours: each covered pixel stacks three
 * rects filled with the theme classes f-geo, f-lit and f-pix. With opacities
 * 1, wB / (wA + wB) and wC, "over" compositing gives exactly
 * wA * A + wB * B + wC * C, so the blend follows the theme for free.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("triangle-rasterizer");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Grid geometry (pixel units, y down) ---------- */

  var GW = 16;
  var GH = 12;
  var CELL = 36;
  var OX = 34; // grid origin inside the SVG, leaves room for axis labels
  var OY = 26;
  var SNAP = 8; // corners snap to 1/8 pixel, like a coarse fixed-point grid
  var CORNER_CLASS = ["f-geo", "f-lit", "f-pix"];
  var NAMES = ["A", "B", "C"];

  var PRESETS = {
    large: [[2.25, 10.5], [14.5, 8.25], [6.75, 1.25]],
    thin: [[1.25, 10.25], [14.75, 2.125], [14.875, 3.25]],
    tiny: [[7.25, 6.25], [9.125, 6.625], [7.875, 7.875]]
  };

  function snap(v) {
    return Math.round(v * SNAP) / SNAP;
  }

  /* Edge function: twice the signed area of (a, b, p). Positive when p is on
     the inside of edge a -> b for a triangle wound with positive area. */
  function edge(a, b, p) {
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  }

  /* Top-left rule for an edge a -> b of a triangle with positive area in
     y-down screen space: a top edge is horizontal and runs left to right;
     a left edge runs upwards (dy < 0). */
  function isTopLeft(a, b) {
    var dy = b[1] - a[1];
    var dx = b[0] - a[0];
    return (dy === 0 && dx > 0) || dy < 0;
  }

  /*
   * Rasterizes the triangle at every pixel centre. Works in integer units
   * (1/16 pixel) so on-edge cases are exact and the fill rule is testable.
   * Returns per-pixel coverage and weights, plus totals.
   */
  function rasterize(P) {
    var S = 16;
    var v = P.map(function (q) { return [Math.round(q[0] * S), Math.round(q[1] * S)]; });
    var area2 = edge(v[0], v[1], v[2]);
    // Orient so the coverage test always looks for positive edge values.
    var o = area2 < 0 ? [v[0], v[2], v[1]] : [v[0], v[1], v[2]];
    var tl = [isTopLeft(o[1], o[2]), isTopLeft(o[2], o[0]), isTopLeft(o[0], o[1])];
    var cells = [];
    var covered = 0;
    var quads = {};
    for (var y = 0; y < GH; y++) {
      for (var x = 0; x < GW; x++) {
        var p = [x * S + S / 2, y * S + S / 2];
        var e = [edge(o[1], o[2], p), edge(o[2], o[0], p), edge(o[0], o[1], p)];
        var inside = area2 !== 0;
        for (var k = 0; k < 3 && inside; k++) {
          if (e[k] < 0 || (e[k] === 0 && !tl[k])) inside = false;
        }
        // Weights in A, B, C order (independent of the orientation swap).
        var w = area2 === 0 ? [NaN, NaN, NaN] : [
          edge(v[1], v[2], p) / area2,
          edge(v[2], v[0], p) / area2,
          edge(v[0], v[1], p) / area2
        ];
        cells.push({ x: x, y: y, inside: inside, w: w });
        if (inside) {
          covered++;
          quads[(x >> 1) + "," + (y >> 1)] = true;
        }
      }
    }
    return { cells: cells, covered: covered, quads: Object.keys(quads), area: Math.abs(area2) / (2 * S * S) };
  }

  /* ---------- Perspective panel maths ---------- */

  var FLOOR = { w: 640, h: 250, top: 18, bottom: 214, checks: 8, dist: 1.7 };

  /* Corners of the unit square (u, v) in camera space, tilted by angle t
     about the horizontal axis; v = 0 is the near edge. */
  function floorPoint(u, v, t) {
    var x = (u - 0.5) * 2;
    var y = (v - 0.5) * 2 * Math.cos(t);
    var z = FLOOR.dist + (v - 0.5) * 2 * Math.sin(t);
    return { x: x / z, y: -y / z, z: z };
  }

  function floorFit(t) {
    var pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(function (q) { return floorPoint(q[0], q[1], t); });
    var minX = Math.min.apply(null, pts.map(function (p) { return p.x; }));
    var maxX = Math.max.apply(null, pts.map(function (p) { return p.x; }));
    var minY = Math.min.apply(null, pts.map(function (p) { return p.y; }));
    var maxY = Math.max.apply(null, pts.map(function (p) { return p.y; }));
    var scale = Math.min(400 / (maxX - minX), (FLOOR.bottom - FLOOR.top) / (maxY - minY));
    var cx = 216;
    var cy = (FLOOR.top + FLOOR.bottom) / 2;
    return function (p) {
      return [cx + (p.x - (minX + maxX) / 2) * scale, cy + (p.y - (minY + maxY) / 2) * scale];
    };
  }

  /* Sutherland-Hodgman against the half-plane sign * (u - v) >= 0. */
  function clipDiagonal(poly, sign) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i];
      var b = poly[(i + 1) % poly.length];
      var da = sign * (a[0] - a[1]);
      var db = sign * (b[0] - b[1]);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        var t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }

  function init(root) {
    var state = {
      P: PRESETS.large.map(function (q) { return q.slice(); }),
      probe: [7, 7],
      fill: "blend",
      centres: true,
      quads: false,
      interp: "affine",
      tilt: 62
    };
    var dragging = false;

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Triangle rasterizer" }),
      h("span", { class: "demo-hint", text: "Drag the corners A, B and C, or focus one and use the arrow keys (Shift for whole pixels). Point at a pixel to read its weights." })
    ]));

    /* ---------- Controls ---------- */

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Triangle", [
      { value: "large", label: "Large" },
      { value: "thin", label: "Thin sliver" },
      { value: "tiny", label: "Tiny" }
    ], "large", function (v) {
      state.P = PRESETS[v].map(function (q) { return q.slice(); });
      drawGrid();
    }));
    controls.appendChild(HB.segmented("Covered pixels show", [
      { value: "blend", label: "Blended corner colours" },
      { value: "coverage", label: "Coverage only" }
    ], state.fill, function (v) { state.fill = v; drawGrid(); }));
    var centreBox = h("input", { type: "checkbox", id: "tr-centres", checked: state.centres });
    var quadBox = h("input", { type: "checkbox", id: "tr-quads", checked: state.quads });
    centreBox.addEventListener("change", function () { state.centres = centreBox.checked; drawGrid(); });
    quadBox.addEventListener("change", function () { state.quads = quadBox.checked; drawGrid(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Overlays" }),
      h("div", { class: "checks" }, [
        h("label", { for: "tr-centres" }, [centreBox, "Pixel centres"]),
        h("label", { for: "tr-quads" }, [quadBox, "2×2 quads"])
      ])
    ]));
    root.appendChild(controls);

    /* ---------- Grid SVG ---------- */

    var stage = h("div", { class: "demo-stage" });
    var VW = OX + GW * CELL + 12;
    var VH = OY + GH * CELL + 12;
    // Plain "dg" (no minimum width) so the whole grid fits a phone screen and
    // every corner stays reachable without scrolling sideways.
    var svg = svgEl("svg", {
      class: "dg",
      viewBox: "0 0 " + VW + " " + VH,
      role: "group",
      "aria-label": "A 16 by 12 pixel grid with a triangle whose corners A, B and C can be dragged. Covered pixels are filled with a blend of the corner colours."
    });
    stage.appendChild(svg);
    root.appendChild(stage);

    var layerAxes = svgEl("g", null, svg);
    var layerCells = svgEl("g", null, svg);
    var layerQuads = svgEl("g", null, svg);
    var layerCentres = svgEl("g", null, svg);
    var layerTri = svgEl("g", null, svg);
    var probe = svgEl("g", { "aria-label": "Probe pixel" }, svg);
    var probeRect = svgEl("rect", { width: CELL, height: CELL, class: "s-acc w3 handle-ring", rx: 2 }, probe);
    svgEl("rect", { width: CELL, height: CELL, class: "f-none", "pointer-events": "all" }, probe);
    var handles = [];

    // Axis labels: pixel numbers along the top and the left.
    for (var gx = 0; gx < GW; gx++) {
      svgEl("text", { x: OX + gx * CELL + CELL / 2, y: OY - 9, class: "t-mono t-muted t-small mid", text: gx }, layerAxes);
    }
    for (var gy = 0; gy < GH; gy++) {
      svgEl("text", { x: OX - 8, y: OY + gy * CELL + CELL / 2 + 4, class: "t-mono t-muted t-small end", text: gy }, layerAxes);
    }

    // One group per pixel: base, three colour layers, coverage fill.
    var cellNodes = [];
    for (var cy = 0; cy < GH; cy++) {
      for (var cx = 0; cx < GW; cx++) {
        var x0 = OX + cx * CELL;
        var y0 = OY + cy * CELL;
        var g = svgEl("g", null, layerCells);
        var base = svgEl("rect", { x: x0, y: y0, width: CELL, height: CELL, class: "f-surface s-line" }, g);
        var colour = svgEl("g", null, g);
        var layers = CORNER_CLASS.map(function (cls) {
          return svgEl("rect", { x: x0 + 0.5, y: y0 + 0.5, width: CELL - 1, height: CELL - 1, class: cls }, colour);
        });
        var cov = svgEl("rect", { x: x0 + 0.5, y: y0 + 0.5, width: CELL - 1, height: CELL - 1, class: "f-acc-soft" }, g);
        var dot = svgEl("circle", { cx: x0 + CELL / 2, cy: y0 + CELL / 2, r: 2.4 }, layerCentres);
        cellNodes.push({ base: base, colour: colour, layers: layers, cov: cov, dot: dot });
      }
    }

    var triPath = svgEl("polygon", { class: "s-ink w2 round" }, layerTri);

    NAMES.forEach(function (name, i) {
      var hg = svgEl("g", { "aria-label": "Corner " + name }, svg);
      svgEl("circle", { r: 14, class: "f-surface s-ink w15 handle-ring", "fill-opacity": 0.85 }, hg);
      svgEl("circle", { r: 7, class: CORNER_CLASS[i] }, hg);
      var label = svgEl("text", { class: "t-head mid", text: name }, hg);
      HB.draggable(svg, hg, {
        onDrag: function (pt) {
          moveCorner(i, (pt.x - OX) / CELL, (pt.y - OY) / CELL);
        }
      });
      hg.addEventListener("pointerdown", function () { dragging = true; });
      hg.addEventListener("pointerup", function () { dragging = false; });
      hg.addEventListener("pointercancel", function () { dragging = false; });
      hg.addEventListener("keydown", function (event) {
        var step = event.shiftKey ? 1 : 0.25;
        var d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
        if (!d) return;
        event.preventDefault();
        moveCorner(i, state.P[i][0] + d[0], state.P[i][1] + d[1]);
      });
      handles.push({ g: hg, label: label });
    });

    function moveCorner(i, x, y) {
      state.P[i] = [snap(Math.min(GW, Math.max(0, x))), snap(Math.min(GH, Math.max(0, y)))];
      drawGrid();
    }

    /* The probe follows the pointer, a tap, or the arrow keys. */
    function setProbe(x, y) {
      var px = Math.min(GW - 1, Math.max(0, Math.floor(x)));
      var py = Math.min(GH - 1, Math.max(0, Math.floor(y)));
      if (px === state.probe[0] && py === state.probe[1]) return;
      state.probe = [px, py];
      drawProbe();
    }
    function pointerCell(event) {
      var pt = HB.svg.toLocal(svg, event.clientX, event.clientY);
      return [(pt.x - OX) / CELL, (pt.y - OY) / CELL];
    }
    svg.addEventListener("pointermove", function (event) {
      if (dragging || event.pointerType === "touch") return;
      var c = pointerCell(event);
      if (c[0] < 0 || c[1] < 0 || c[0] >= GW || c[1] >= GH) return;
      setProbe(c[0], c[1]);
    });
    layerCells.addEventListener("pointerdown", function (event) {
      var c = pointerCell(event);
      setProbe(c[0], c[1]);
    });
    probe.setAttribute("tabindex", "0");
    probe.setAttribute("role", "button");
    probe.classList.add("handle");
    probe.addEventListener("keydown", function (event) {
      var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!d) return;
      event.preventDefault();
      setProbe(state.probe[0] + d[0] + 0.5, state.probe[1] + d[1] + 0.5);
    });

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    var last = null;

    function drawGrid() {
      var r = rasterize(state.P);
      last = r;
      r.cells.forEach(function (c, i) {
        var n = cellNodes[i];
        var blend = c.inside && state.fill === "blend";
        n.colour.setAttribute("display", blend ? "inline" : "none");
        n.cov.setAttribute("display", c.inside && state.fill === "coverage" ? "inline" : "none");
        if (blend) {
          var wa = Math.max(0, c.w[0]);
          var wb = Math.max(0, c.w[1]);
          var wc = Math.max(0, c.w[2]);
          n.layers[1].setAttribute("fill-opacity", (wa + wb > 0 ? wb / (wa + wb) : 0).toFixed(3));
          n.layers[2].setAttribute("fill-opacity", wc.toFixed(3));
        }
        n.dot.setAttribute("display", state.centres ? "inline" : "none");
        n.dot.setAttribute("class", c.inside ? (state.fill === "blend" ? "f-surface s-ink" : "f-acc") : "f-strong");
      });

      HB.svg.clear(layerQuads);
      if (state.quads) {
        for (var qx = 0; qx <= GW; qx += 2) {
          svgEl("line", { x1: OX + qx * CELL, y1: OY, x2: OX + qx * CELL, y2: OY + GH * CELL, class: "s-strong w15" }, layerQuads);
        }
        for (var qy = 0; qy <= GH; qy += 2) {
          svgEl("line", { x1: OX, y1: OY + qy * CELL, x2: OX + GW * CELL, y2: OY + qy * CELL, class: "s-strong w15" }, layerQuads);
        }
        r.quads.forEach(function (key) {
          var q = key.split(",").map(Number);
          svgEl("rect", { x: OX + q[0] * 2 * CELL + 2, y: OY + q[1] * 2 * CELL + 2, width: 2 * CELL - 4, height: 2 * CELL - 4, rx: 3, class: "s-acc w2 dash" }, layerQuads);
        });
      }

      var pts = state.P.map(function (q) { return (OX + q[0] * CELL).toFixed(1) + "," + (OY + q[1] * CELL).toFixed(1); });
      triPath.setAttribute("points", pts.join(" "));

      // Labels sit outside the triangle, pushed away from its centre.
      var mx = (state.P[0][0] + state.P[1][0] + state.P[2][0]) / 3;
      var my = (state.P[0][1] + state.P[1][1] + state.P[2][1]) / 3;
      handles.forEach(function (hd, i) {
        var px = OX + state.P[i][0] * CELL;
        var py = OY + state.P[i][1] * CELL;
        hd.g.setAttribute("transform", "translate(" + px.toFixed(1) + "," + py.toFixed(1) + ")");
        var dx = state.P[i][0] - mx;
        var dy = state.P[i][1] - my;
        var len = Math.hypot(dx, dy) || 1;
        hd.label.setAttribute("x", ((dx / len) * 26).toFixed(1));
        hd.label.setAttribute("y", ((dy / len) * 26 + 5).toFixed(1));
        hd.g.setAttribute("aria-valuetext", "Corner " + NAMES[i] + " at x " + state.P[i][0] + ", y " + state.P[i][1] + " pixels");
        hd.g.setAttribute("aria-valuenow", state.P[i][0]);
      });
      drawProbe();
    }

    function fmtW(w) {
      if (!isFinite(w)) return "–";
      return (w < 0 ? "−" : "") + Math.abs(w).toFixed(2);
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function drawProbe() {
      if (!last) return;
      var px = state.probe[0];
      var py = state.probe[1];
      probe.setAttribute("transform", "translate(" + (OX + px * CELL) + "," + (OY + py * CELL) + ")");
      var c = last.cells[py * GW + px];
      var status;
      if (!isFinite(c.w[0])) status = "no area: nothing drawn";
      else if (c.inside) status = "inside";
      else {
        var neg = [];
        c.w.forEach(function (w, i) { if (w < 0) neg.push(NAMES[i]); });
        status = neg.length ? "outside: " + neg.join(" and ") + " below 0" : "on an edge the fill rule gives away";
      }
      var lanes = last.quads.length * 4;
      readout.replaceChildren(
        cell("Covered pixels", HB.fmt.int(last.covered)),
        cell("Triangle area", last.area.toFixed(1) + " pixels"),
        cell("2×2 quads · shader lanes", last.quads.length + " · " + lanes + (lanes ? " (" + Math.round((100 * last.covered) / lanes) + "% useful)" : "")),
        cell("Pixel (" + px + ", " + py + ") weights A · B · C", fmtW(c.w[0]) + " · " + fmtW(c.w[1]) + " · " + fmtW(c.w[2])),
        cell("That pixel is", status)
      );
      probe.setAttribute("aria-label", "Probe pixel " + px + ", " + py + ": " + status);
    }

    /* ---------- Perspective panel ---------- */

    var floorHead = h("div", { class: "demo-head" }, [
      h("span", { class: "demo-title", text: "The same blend on a tilted, textured square" }),
      h("span", { class: "demo-hint", text: "Two triangles share the dashed diagonal. Switch the interpolation and tilt the square." })
    ]);
    var floorControls = h("div", { class: "demo-controls" });
    floorControls.appendChild(HB.segmented("Interpolation", [
      { value: "correct", label: "Perspective-correct" },
      { value: "affine", label: "Affine (screen-space)" }
    ], state.interp, function (v) { state.interp = v; drawFloor(); }));
    floorControls.appendChild(HB.slider("tr-tilt", "Tilt away from the camera", {
      min: 0, max: 72, step: 1, value: state.tilt,
      format: function (v) { return v + "°"; }
    }, function (v) { state.tilt = v; drawFloor(); }));
    root.appendChild(floorHead);
    root.appendChild(floorControls);

    var floorStage = h("div", { class: "demo-stage" });
    var fsvg = svgEl("svg", {
      class: "dg is-mid",
      viewBox: "0 0 " + FLOOR.w + " " + FLOOR.h,
      role: "img",
      "aria-label": "A square with a checkerboard texture, tilted away from the camera and drawn as two triangles."
    });
    floorStage.appendChild(fsvg);
    root.appendChild(floorStage);
    var floorLayer = svgEl("g", null, fsvg);
    var floorNote = svgEl("g", null, fsvg);
    var floorReadout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(floorReadout);

    function drawFloor() {
      var t = (state.tilt * Math.PI) / 180;
      var toScreen = floorFit(t);
      function S(u, v) { return toScreen(floorPoint(u, v, t)); }
      var s00 = S(0, 0), s10 = S(1, 0), s11 = S(1, 1), s01 = S(0, 1);
      /* Affine maps from UV straight to the screen, one per triangle:
         triangle 1 is (0,0) (1,0) (1,1), where u >= v; triangle 2 is
         (0,0) (1,1) (0,1), where v >= u. Inside each, screen position is a
         linear blend of the corners, which is what affine interpolation
         assumes. */
      function affineT(q, tri) {
        var u = q[0], v = q[1];
        if (tri === 1) return [s00[0] + u * (s10[0] - s00[0]) + v * (s11[0] - s10[0]), s00[1] + u * (s10[1] - s00[1]) + v * (s11[1] - s10[1])];
        return [s00[0] + u * (s11[0] - s01[0]) + v * (s01[0] - s00[0]), s00[1] + u * (s11[1] - s01[1]) + v * (s01[1] - s00[1])];
      }
      HB.svg.clear(floorLayer);
      HB.svg.clear(floorNote);
      var outline = [s00, s10, s11, s01].map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
      svgEl("polygon", { points: outline, class: "f-surface" }, floorLayer);
      var n = FLOOR.checks;
      for (var j = 0; j < n; j++) {
        for (var i = 0; i < n; i++) {
          if ((i + j) % 2) continue;
          var sq = [[i / n, j / n], [(i + 1) / n, j / n], [(i + 1) / n, (j + 1) / n], [i / n, (j + 1) / n]];
          var polys;
          if (state.interp === "correct") {
            polys = [sq.map(function (q) { return S(q[0], q[1]); })];
          } else {
            // Split the check at the diagonal and map each piece with the
            // affine map of the triangle it lies in.
            polys = [];
            [[1, 1], [-1, 2]].forEach(function (side) {
              var piece = clipDiagonal(sq, side[0]);
              if (piece.length > 2) polys.push(piece.map(function (q) { return affineT(q, side[1]); }));
            });
          }
          polys.forEach(function (pl) {
            svgEl("polygon", { points: pl.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "), class: "f-acc" }, floorLayer);
          });
        }
      }
      svgEl("polygon", { points: outline, class: "s-strong w15" }, floorLayer);
      svgEl("line", { x1: s00[0], y1: s00[1], x2: s11[0], y2: s11[1], class: "s-ink w15 dash" }, floorLayer);

      // Where does the screen-space middle of the diagonal land in the texture?
      var zNear = floorPoint(0, 0, t).z;
      var zFar = floorPoint(1, 1, t).z;
      var correct = (0.5 / zFar) / (0.5 / zNear + 0.5 / zFar);
      var mid = [(s00[0] + s11[0]) / 2, (s00[1] + s11[1]) / 2];
      svgEl("circle", { cx: mid[0], cy: mid[1], r: 5, class: "f-surface s-ink w2" }, floorNote);

      var lx = 452;
      svgEl("text", { x: lx, y: 52, class: "t-caps", text: "THE RINGED POINT" }, floorNote);
      svgEl("text", { x: lx, y: 74, class: "t-small", text: "Halfway along the diagonal" }, floorNote);
      svgEl("text", { x: lx, y: 89, class: "t-small", text: "on screen." }, floorNote);
      var affineOn = state.interp === "affine";
      svgEl("text", { x: lx, y: 118, class: "t-small t-muted", text: "Affine reads the texture at" }, floorNote);
      svgEl("text", { x: lx, y: 135, class: "t-mono t-strong" + (affineOn ? " t-pix" : ""), text: "u, v = 0.50, 0.50" }, floorNote);
      svgEl("text", { x: lx, y: 164, class: "t-small t-muted", text: "Perspective-correct reads" }, floorNote);
      svgEl("text", { x: lx, y: 181, class: "t-mono t-strong" + (affineOn ? "" : " t-acc"), text: "u, v = " + correct.toFixed(2) + ", " + correct.toFixed(2) }, floorNote);
      svgEl("text", { x: lx, y: 208, class: "t-small t-muted", text: "which is the true surface point." }, floorNote);

      floorReadout.replaceChildren(
        cell("Interpolation", state.interp === "correct" ? "Perspective-correct" : "Affine"),
        cell("Far edge depth ÷ near edge depth", (zFar / zNear).toFixed(2) + "×"),
        cell("Texture error at the ringed point", !affineOn || state.tilt === 0 ? "none" : "off by " + ((0.5 - correct) * 100).toFixed(0) + "% of the texture")
      );
      fsvg.setAttribute("aria-label", "A checkerboard square tilted " + state.tilt + " degrees, drawn with " + (state.interp === "correct" ? "perspective-correct" : "affine") + " interpolation. At the middle of the diagonal, affine reads 0.50 while the true value is " + correct.toFixed(2) + ".");
    }

    drawGrid();
    drawFloor();
    log.debug("ready");
  }

  HB.demos.register("triangle-rasterizer", init);
})();

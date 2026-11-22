/*
 * two-bone-arm.js: chapter 4.6's interactive.
 *
 * A 2D arm: a strip of 33 × 5 vertices over two bones, the upper arm from
 * the shoulder (x = 0) to the elbow (x = 1) and the forearm from the elbow
 * to the wrist (x = 2). The strip is 0.4 units thick. Every vertex has one
 * weight w for the forearm and 1 − w for the upper arm, so the two always
 * sum to 1. Three weight-painting presets set w along the arm:
 *
 *   Rigid       w jumps from 0 to 1 at the elbow
 *   Smooth      w eases from 0 to 1 between x = 0.8 and 1.2 (smoothstep)
 *   Too smooth  w eases from 0 to 1 between x = 0.2 and 1.8
 *
 * Two motions:
 *   Bend   the forearm rotates by θ about the elbow, in the drawing plane.
 *   Twist  the forearm rotates by φ about its own length. The arm is then
 *          drawn as a tube seen from the side, with stripes painted around it.
 *
 * Two ways to blend the bones' transforms:
 *   Linear blend skinning   p' = (1 − w) p + w R p   (average the positions)
 *   Dual quaternion         rotate p by the blended rotation. For two
 *                           rotations about the same pivot this is a single
 *                           rotation by ψ = 2 atan2(w sin(θ/2), 1 − w + w cos(θ/2)),
 *                           so distances to the pivot are kept.
 *
 * Linear blending moves a half-and-half vertex to the midpoint of where the
 * two bones would carry it, which lies inside the arc: a bend of θ leaves the
 * joint cos(θ/2) of its thickness, and a 180° twist collapses it to nothing
 * (the candy-wrapper artefact). The readout measures exactly that.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("two-bone-arm");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- The arm ---------- */

  var COLS = 33;                 // x = 0, 1/16, ..., 2
  var ROWS = 5;                  // y = -0.2, -0.1, 0, 0.1, 0.2
  var HALF = 0.2;                // half thickness
  var ELBOW = { x: 1, y: 0 };
  var ELBOW_COL = 16;
  var STRIPES = 12;              // painted lines around the tube, 30° apart

  function colX(i) { return (2 * i) / (COLS - 1); }
  function rowY(j) { return -HALF + (2 * HALF * j) / (ROWS - 1); }

  function smoothstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  var PRESETS = {
    rigid: function (x) { return x >= ELBOW.x - 1e-9 ? 1 : 0; },
    smooth: function (x) { return smoothstep(0.8, 1.2, x); },
    loose: function (x) { return smoothstep(0.2, 1.8, x); }
  };

  /* Angle of the dual-quaternion blend of "no rotation" and "rotation by a",
     with weight w on the second. */
  function dqAngle(w, a) {
    return 2 * Math.atan2(w * Math.sin(a / 2), 1 - w + w * Math.cos(a / 2));
  }

  /* Bend: where vertex (x, y) with forearm weight w ends up. */
  function bendPoint(x, y, w, theta, method) {
    var dx = x - ELBOW.x;
    var dy = y - ELBOW.y;
    if (method === "dq") {
      var a = dqAngle(w, theta);
      return [ELBOW.x + dx * Math.cos(a) - dy * Math.sin(a), ELBOW.y + dx * Math.sin(a) + dy * Math.cos(a)];
    }
    var rx = ELBOW.x + dx * Math.cos(theta) - dy * Math.sin(theta);
    var ry = ELBOW.y + dx * Math.sin(theta) + dy * Math.cos(theta);
    return [(1 - w) * x + w * rx, (1 - w) * y + w * ry];
  }

  /* Twist: a point at angle alpha around the tube, as (y, z). */
  function twistPoint(alpha, w, phi, method) {
    if (method === "dq") {
      var a = alpha + dqAngle(w, phi);
      return [HALF * Math.cos(a), HALF * Math.sin(a)];
    }
    return [
      HALF * ((1 - w) * Math.cos(alpha) + w * Math.cos(alpha + phi)),
      HALF * ((1 - w) * Math.sin(alpha) + w * Math.sin(alpha + phi))
    ];
  }

  /* Radius of the tube at weight w after a twist of phi. */
  function twistRadius(w, phi, method) {
    if (method === "dq") return HALF;
    return HALF * Math.sqrt((1 - w) * (1 - w) + w * w + 2 * w * (1 - w) * Math.cos(phi));
  }

  /* ---------- Drawing ---------- */

  var VIEW = { w: 820, h: 400 };
  var S = 200;                                   // viewBox units per arm unit
  var ORIGIN = { bend: { x: 70, y: 330 }, twist: { x: 70, y: 190 } };
  var PANEL = { x: 600, y: 20, w: 200 };

  function toSvg(mode, p) {
    var o = ORIGIN[mode];
    return [o.x + p[0] * S, o.y - p[1] * S];
  }
  function fromSvg(mode, pt) {
    var o = ORIGIN[mode];
    return [(pt.x - o.x) / S, (o.y - pt.y) / S];
  }

  function triArea(a, b, c) {
    return ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  var instance = 0;

  function init(root) {
    instance += 1;
    var uid = "tba" + instance + "-";
    var state = { mode: "bend", bend: 110, twist: 150, preset: "smooth", method: "lbs", heat: true };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Two-bone arm" }),
      h("span", { class: "demo-hint", text: "Bend with the slider or drag the wrist; switch the weights and watch the elbow." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Motion", [
      { value: "bend", label: "Bend elbow" },
      { value: "twist", label: "Twist forearm" }
    ], state.mode, function (v) { state.mode = v; syncSlider(); draw(); }));
    var slider = HB.slider(uid + "angle", "Angle", {
      min: 0, max: 150, step: 1, value: state.bend,
      format: function (v) { return Math.round(v) + "°"; }
    }, function (v) { state[state.mode] = v; draw(); });
    controls.appendChild(slider);
    var sliderInput = slider.querySelector("input");
    var sliderOut = slider.querySelector("output");
    controls.appendChild(HB.segmented("Weights", [
      { value: "rigid", label: "Rigid" },
      { value: "smooth", label: "Smooth" },
      { value: "loose", label: "Too smooth" }
    ], state.preset, function (v) { state.preset = v; draw(); }));
    controls.appendChild(HB.segmented("Blending", [
      { value: "lbs", label: "Linear" },
      { value: "dq", label: "Dual quaternion" }
    ], state.method, function (v) { state.method = v; draw(); }));
    var heatBox = h("input", { type: "checkbox", id: uid + "heat", checked: state.heat });
    heatBox.addEventListener("change", function () { state.heat = heatBox.checked; draw(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "View" }),
      h("div", { class: "checks" }, [h("label", { for: uid + "heat" }, [heatBox, "Weight heat view"])])
    ]));
    root.appendChild(controls);

    function syncSlider() {
      sliderInput.max = state.mode === "bend" ? 150 : 180;
      sliderInput.value = state[state.mode];
      sliderOut.textContent = Math.round(state[state.mode]) + "°";
    }

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "group",
      "aria-label": "A strip of triangles over two bones, an upper arm and a forearm, deformed by the elbow angle or the forearm twist, with each vertex shaded by how much the forearm moves it."
    });
    stage.appendChild(svg);
    root.appendChild(stage);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    var defs = svgEl("defs", null, svg);
    var grad = svgEl("linearGradient", { id: uid + "heatgrad", x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
    svgEl("stop", { offset: 0, class: "stop-acc", "stop-opacity": 0 }, grad);
    svgEl("stop", { offset: 1, class: "stop-acc", "stop-opacity": 0.9 }, grad);

    var layerGhost = svgEl("g", null, svg);
    var layerMesh = svgEl("g", null, svg);
    var layerBones = svgEl("g", null, svg);
    var layerPanel = svgEl("g", null, svg);
    var handle = svgEl("g", { "aria-label": "Wrist: elbow angle", "aria-valuemin": 0, "aria-valuemax": 150 }, svg);
    svgEl("circle", { r: 13, class: "f-acc-soft s-acc handle-ring" }, handle);
    svgEl("circle", { r: 5, class: "f-acc" }, handle);

    HB.draggable(svg, handle, {
      onDrag: function (pt) {
        if (state.mode !== "bend") return;
        var p = fromSvg("bend", pt);
        var a = (Math.atan2(p[1] - ELBOW.y, p[0] - ELBOW.x) * 180) / Math.PI;
        if (a < -90) a += 360;
        state.bend = Math.min(150, Math.max(0, a));
        syncSlider();
        draw();
      },
      onKey: function (dir, big) {
        var max = state.mode === "bend" ? 150 : 180;
        state[state.mode] = Math.min(max, Math.max(0, state[state.mode] + dir * (big ? 10 : 2)));
        syncSlider();
        draw();
      }
    });

    /* The right-hand panel: heat legend and the elbow vertex's weights. */
    function drawPanel(wElbow) {
      HB.svg.clear(layerPanel);
      var x = PANEL.x;
      var y = PANEL.y;
      svgEl("text", { x: x, y: y + 12, class: "t-caps", text: "FOREARM WEIGHT" }, layerPanel);
      svgEl("rect", { x: x, y: y + 22, width: PANEL.w, height: 12, class: "f-surface s-strong" }, layerPanel);
      svgEl("rect", { x: x, y: y + 22, width: PANEL.w, height: 12, fill: "url(#" + uid + "heatgrad)" }, layerPanel);
      svgEl("text", { x: x, y: y + 48, class: "t-small t-muted", text: "0: upper arm only" }, layerPanel);
      svgEl("text", { x: x + PANEL.w, y: y + 48, class: "t-small t-muted end", text: "1: forearm only" }, layerPanel);

      var by = y + 84;
      svgEl("text", { x: x, y: by, class: "t-caps", text: "RINGED VERTEX, TOP OF ELBOW" }, layerPanel);
      var up = 1 - wElbow;
      var bw = PANEL.w;
      svgEl("rect", { x: x, y: by + 10, width: bw, height: 22, class: "f-surface s-strong" }, layerPanel);
      if (up > 0) svgEl("rect", { x: x, y: by + 10, width: bw * up, height: 22, class: "f-solid s-strong" }, layerPanel);
      if (wElbow > 0) svgEl("rect", { x: x + bw * up, y: by + 10, width: bw * wElbow, height: 22, class: "f-acc-soft s-acc" }, layerPanel);
      svgEl("text", { x: x, y: by + 48, class: "t-small", text: "upper arm " + up.toFixed(2) }, layerPanel);
      svgEl("text", { x: x + bw, y: by + 48, class: "t-small t-acc end", text: "forearm " + wElbow.toFixed(2) }, layerPanel);
      svgEl("text", { x: x, y: by + 66, class: "t-small t-muted", text: "The two weights always add up to 1." }, layerPanel);

      var ny = by + 104;
      var lines = state.method === "lbs"
        ? ["Linear blending averages the two", "positions each bone would give the", "vertex. Halfway between two points", "on an arc lies inside the arc."]
        : ["Dual quaternions blend the bones'", "rotations instead, then rotate the", "vertex about the joint, so it keeps", "its distance from the joint."];
      svgEl("text", { x: x, y: ny, class: "t-caps", text: state.method === "lbs" ? "LINEAR BLEND SKINNING" : "DUAL QUATERNION SKINNING" }, layerPanel);
      lines.forEach(function (t, i) {
        svgEl("text", { x: x, y: ny + 18 + i * 15, class: "t-small t-muted", text: t }, layerPanel);
      });
    }

    function heatOpacity(w) { return (0.08 + 0.82 * w).toFixed(3); }

    function drawBend(weights, theta) {
      var mode = "bend";
      HB.svg.clear(layerGhost);
      HB.svg.clear(layerMesh);
      HB.svg.clear(layerBones);
      // Rest pose, dashed.
      var r0 = toSvg(mode, [0, -HALF]);
      var r1 = toSvg(mode, [2, HALF]);
      svgEl("rect", { x: r0[0], y: r1[1], width: r1[0] - r0[0], height: r0[1] - r1[1], class: "s-muted dash" }, layerGhost);
      svgEl("text", { x: r1[0] + 8, y: r0[1] - 2, class: "t-small t-muted", text: "rest pose" }, layerGhost);

      // Deformed vertices.
      var P = [];
      for (var i = 0; i < COLS; i++) {
        P.push([]);
        for (var j = 0; j < ROWS; j++) P[i].push(bendPoint(colX(i), rowY(j), weights[i], theta, state.method));
      }
      var restArea = 0;
      var area = 0;
      var folded = 0;
      var stretch = 1;
      var cells = [];
      for (i = 0; i < COLS - 1; i++) {
        for (j = 0; j < ROWS - 1; j++) {
          var quads = [[[i, j], [i + 1, j], [i + 1, j + 1]], [[i, j], [i + 1, j + 1], [i, j + 1]]];
          quads.forEach(function (q) {
            var a = P[q[0][0]][q[0][1]];
            var b = P[q[1][0]][q[1][1]];
            var c = P[q[2][0]][q[2][1]];
            var ra = [colX(q[0][0]), rowY(q[0][1])];
            var rb = [colX(q[1][0]), rowY(q[1][1])];
            var rc = [colX(q[2][0]), rowY(q[2][1])];
            var A = triArea(a, b, c);
            var A0 = triArea(ra, rb, rc);
            restArea += A0;
            area += A;
            if (A < 0) folded++;
            stretch = Math.max(stretch, dist(a, b) / dist(ra, rb), dist(b, c) / dist(rb, rc), dist(c, a) / dist(rc, ra));
            var wAvg = (weights[q[0][0]] + weights[q[1][0]] + weights[q[2][0]]) / 3;
            cells.push({ pts: [a, b, c], folded: A < 0, w: wAvg });
          });
        }
      }
      // Fill, then edges, then folded triangles on top so they show.
      var base = [];
      var heatGroups = {};
      cells.forEach(function (cell) {
        var d = cell.pts.map(function (p, k) { var s = toSvg(mode, p); return (k ? "L" : "M") + s[0].toFixed(1) + " " + s[1].toFixed(1); }).join("") + "Z";
        base.push(d);
        var key = Math.round(cell.w * 20);
        (heatGroups[key] = heatGroups[key] || []).push(d);
      });
      svgEl("path", { d: base.join(""), class: state.heat ? "f-surface" : "f-solid" }, layerMesh);
      if (state.heat) {
        Object.keys(heatGroups).forEach(function (key) {
          svgEl("path", { d: heatGroups[key].join(""), class: "f-acc", "fill-opacity": heatOpacity(Number(key) / 20) }, layerMesh);
        });
      }
      svgEl("path", { d: base.join(""), class: "s-strong", "stroke-width": 0.7 }, layerMesh);
      var bad = cells.filter(function (c) { return c.folded; }).map(function (cell) {
        return cell.pts.map(function (p, k) { var s = toSvg(mode, p); return (k ? "L" : "M") + s[0].toFixed(1) + " " + s[1].toFixed(1); }).join("") + "Z";
      });
      if (bad.length) svgEl("path", { d: bad.join(""), class: "f-pix-soft s-pix", "fill-opacity": 0.8 }, layerMesh);
      if (state.heat) {
        for (i = 0; i < COLS; i++) {
          for (j = 0; j < ROWS; j++) {
            var s = toSvg(mode, P[i][j]);
            svgEl("circle", { cx: s[0].toFixed(1), cy: s[1].toFixed(1), r: 2.1, class: "f-acc s-strong", "fill-opacity": heatOpacity(weights[i]), "stroke-width": 0.5 }, layerMesh);
          }
        }
      }
      var ev = toSvg(mode, P[ELBOW_COL][ROWS - 1]);
      svgEl("circle", { cx: ev[0], cy: ev[1], r: 6.5, class: "s-ink w2" }, layerMesh);

      // Bones.
      var sh = toSvg(mode, [0, 0]);
      var el = toSvg(mode, [ELBOW.x, ELBOW.y]);
      var wr = toSvg(mode, [ELBOW.x + Math.cos(theta), ELBOW.y + Math.sin(theta)]);
      svgEl("polyline", { points: sh.join(",") + " " + el.join(",") + " " + wr.join(","), class: "s-ink w3 round" }, layerBones);
      [sh, el].forEach(function (p) { svgEl("circle", { cx: p[0], cy: p[1], r: 5, class: "f-surface s-ink w2" }, layerBones); });
      svgEl("text", { x: (sh[0] + el[0]) / 2, y: sh[1] + 58, class: "t-small t-muted mid", text: "upper arm bone" }, layerBones);
      // Forearm label beside the forearm, on the outside of the bend.
      var lab = toSvg(mode, [ELBOW.x + 0.6 * Math.cos(theta) + 0.36 * Math.sin(theta), ELBOW.y + 0.6 * Math.sin(theta) - 0.36 * Math.cos(theta)]);
      svgEl("text", { x: lab[0], y: lab[1] + 4, class: "t-small t-acc", text: "forearm bone" }, layerBones);
      handle.setAttribute("transform", "translate(" + wr[0].toFixed(1) + "," + wr[1].toFixed(1) + ")");
      handle.removeAttribute("display");

      // Thickness of each cross-section, relative to rest.
      var thin = Infinity;
      for (i = 0; i < COLS; i++) thin = Math.min(thin, dist(P[i][0], P[i][ROWS - 1]) / (2 * HALF));
      return { thin: thin, kept: area / restArea, folded: folded, stretch: stretch };
    }

    function drawTwist(weights, phi) {
      var mode = "twist";
      HB.svg.clear(layerGhost);
      HB.svg.clear(layerMesh);
      HB.svg.clear(layerBones);
      handle.setAttribute("display", "none");
      var r0 = toSvg(mode, [0, -HALF]);
      var r1 = toSvg(mode, [2, HALF]);
      svgEl("rect", { x: r0[0], y: r1[1], width: r1[0] - r0[0], height: r0[1] - r1[1], class: "s-muted dash" }, layerGhost);
      svgEl("text", { x: r0[0], y: r1[1] - 8, class: "t-small t-muted", text: "dashed: rest pose" }, layerGhost);
      svgEl("text", { x: r0[0], y: r1[1] - 54, class: "t-caps", text: "THE ARM AS A TUBE, SEEN FROM THE SIDE" }, layerGhost);

      var radii = [];
      for (var i = 0; i < COLS; i++) radii.push(twistRadius(weights[i], phi, state.method));
      // Silhouette, filled by column strips so the heat view can colour it.
      var outline = [];
      for (i = 0; i < COLS; i++) outline.push(toSvg(mode, [colX(i), radii[i]]));
      for (i = COLS - 1; i >= 0; i--) outline.push(toSvg(mode, [colX(i), -radii[i]]));
      svgEl("polygon", { points: outline.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "), class: state.heat ? "f-surface" : "f-solid" }, layerMesh);
      if (state.heat) {
        for (i = 0; i < COLS - 1; i++) {
          var a = toSvg(mode, [colX(i), radii[i]]);
          var b = toSvg(mode, [colX(i + 1), radii[i + 1]]);
          var c = toSvg(mode, [colX(i + 1), -radii[i + 1]]);
          var d = toSvg(mode, [colX(i), -radii[i]]);
          svgEl("polygon", { points: [a, b, c, d].map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "), class: "f-acc", "fill-opacity": heatOpacity((weights[i] + weights[i + 1]) / 2) }, layerMesh);
        }
      }
      // Stripes painted around the tube; only the half facing us is drawn.
      for (var k = 0; k < STRIPES; k++) {
        var alpha = (k / STRIPES) * Math.PI * 2;
        var seg = [];
        var segs = [];
        for (i = 0; i < COLS; i++) {
          var yz = twistPoint(alpha, weights[i], phi, state.method);
          if (yz[1] >= -1e-6) seg.push(toSvg(mode, [colX(i), yz[0]]));
          else if (seg.length) { segs.push(seg); seg = []; }
        }
        if (seg.length) segs.push(seg);
        segs.forEach(function (sg) {
          if (sg.length < 2) return;
          svgEl("polyline", { points: sg.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "), class: k === 3 ? "s-ink w2" : "s-ink", "stroke-opacity": k === 3 ? 0.9 : 0.45 }, layerMesh);
        });
      }
      svgEl("polygon", { points: outline.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "), class: "s-strong" }, layerMesh);
      var ev = toSvg(mode, [colX(ELBOW_COL), radii[ELBOW_COL]]);
      svgEl("circle", { cx: ev[0], cy: ev[1], r: 6.5, class: "s-ink w2" }, layerMesh);

      // Bones along the axis, and an arrow showing the twist at the wrist.
      var sh = toSvg(mode, [0, 0]);
      var el = toSvg(mode, [1, 0]);
      var wr = toSvg(mode, [2, 0]);
      svgEl("line", { x1: sh[0], y1: sh[1], x2: wr[0], y2: wr[1], class: "s-ink w3 round", "stroke-opacity": 0.35 }, layerBones);
      [sh, el].forEach(function (p) { svgEl("circle", { cx: p[0], cy: p[1], r: 5, class: "f-surface s-ink w2" }, layerBones); });
      var cx = wr[0] + 34;
      var ry = HALF * S;
      var end = Math.min(phi, Math.PI * 0.999);
      var steps = 24;
      var arc = [];
      for (var t = 0; t <= steps; t++) {
        var ang = (t / steps) * end;
        arc.push((cx + 12 * Math.sin(ang)).toFixed(1) + "," + (wr[1] - ry * Math.cos(ang)).toFixed(1));
      }
      if (phi > 0.02) svgEl("polyline", { points: arc.join(" "), class: "s-acc w2" }, layerBones);
      svgEl("text", { x: cx + 18, y: wr[1] + 4, class: "t-small t-acc t-strong", text: Math.round((phi * 180) / Math.PI) + "° twist" }, layerBones);
      svgEl("text", { x: (sh[0] + el[0]) / 2, y: sh[1] + ry + 30, class: "t-small t-muted mid", text: "upper arm: not twisted" }, layerBones);
      svgEl("text", { x: (el[0] + wr[0]) / 2, y: sh[1] + ry + 30, class: "t-small t-acc mid", text: "forearm: twisted" }, layerBones);

      var thin = Infinity;
      var vol = 0;
      var vol0 = 0;
      for (i = 0; i < COLS - 1; i++) {
        thin = Math.min(thin, radii[i] / HALF);
        vol += (radii[i] * radii[i] + radii[i + 1] * radii[i + 1]) / 2;
        vol0 += HALF * HALF;
      }
      thin = Math.min(thin, radii[COLS - 1] / HALF);
      return { thin: thin, kept: vol / vol0 };
    }

    function draw() {
      var fn = PRESETS[state.preset];
      var weights = [];
      for (var i = 0; i < COLS; i++) weights.push(fn(colX(i)));
      var angle = (state[state.mode] * Math.PI) / 180;
      var res = state.mode === "bend" ? drawBend(weights, angle) : drawTwist(weights, angle);
      drawPanel(weights[ELBOW_COL]);
      function cell(label, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
      }
      var cells = [
        cell(state.mode === "bend" ? "Elbow angle" : "Twist", Math.round(state[state.mode]) + "°"),
        cell("Thinnest point", Math.round(res.thin * 100) + "% of rest"),
        cell(state.mode === "bend" ? "Area kept" : "Volume kept", Math.round(res.kept * 100) + "%")
      ];
      if (state.mode === "bend") {
        cells.push(cell("Folded triangles", String(res.folded)));
        cells.push(cell("Worst stretch", "×" + res.stretch.toFixed(1)));
      }
      readout.replaceChildren.apply(readout, cells);
      handle.setAttribute("aria-valuenow", String(Math.round(state.bend)));
      handle.setAttribute("aria-valuetext", "Elbow bent " + Math.round(state.bend) + " degrees; thinnest point " + Math.round(res.thin * 100) + " percent of rest");
    }

    syncSlider();
    draw();
    log.debug("ready");
  }

  HB.demos.register("two-bone-arm", init);
})();

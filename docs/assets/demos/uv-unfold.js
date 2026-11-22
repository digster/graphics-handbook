/*
 * uv-unfold.js: chapter 6.1's interactive.
 *
 * A 1 m cube wearing a 1024 × 1024 texture is unwrapped in five steps:
 *
 *   0 the textured cube          seen from above, front and right
 *   1 choose the seams           the cut edges light up
 *   2 unfold                     the five side faces swing open on their
 *                                hinges until all six lie in one plane
 *   3 flatten                    the camera turns to look straight down,
 *                                so the picture is now a 2D layout
 *   4 pack into the texture      each face flies onto its UV island in the
 *                                texture square on the right
 *
 * The unfolding is real 3D: every face is a unit square rotated about its
 * hinge edge, projected with an orthographic camera. Each face's texture is
 * drawn once in texture-grid coordinates inside an SVG group whose matrix
 * maps that grid onto the face, so the same labelled checker is visibly
 * squeezed or stretched by whatever UV layout is chosen.
 *
 * Three layouts:
 *   one      one island, the classic cross: 7 seams, 37.5% of the texture
 *   packed   six square islands: 12 seams, 66.7% of the texture
 *   uneven   six islands of careless sizes: densities from 171 to 512
 *            texels per metre and two faces stretched 2 : 1
 *
 * Texture grid: 12 × 12 checker cells, so one cell is 1024 / 12 texels.
 * Face-local coordinates (s, t) run right and down as the face lies in the
 * flat cross seen from above.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("uv-unfold");
  var svgEl = HB.svg.el;
  var h = HB.html;

  var TEX = 1024; // texels per side of the texture
  var GRID = 12; // checker cells per side
  var CUBE_M = 1; // cube edge, metres
  /* Texture-grid drawing units per cell. Text is drawn in these units and
     scaled by the face matrix; keeping font sizes well above 1 avoids
     browsers' minimum font size rules for tiny SVG text. */
  var U = 10;
  var DEG = Math.PI / 180;

  /* Face names, their place in the flat cross (column, row) and the label
     painted on them. "Base" rather than "bottom" keeps labels short. */
  var FACES = [
    { id: "T", name: "TOP" },
    { id: "F", name: "FRONT" },
    { id: "D", name: "BASE" },
    { id: "B", name: "BACK" },
    { id: "L", name: "LEFT" },
    { id: "R", name: "RIGHT" }
  ];

  /* UV islands in texture-grid cells: x, y (from the top-left of the image),
     width, height. "unused" marks where to write the label on empty space. */
  var LAYOUTS = {
    one: {
      label: "One island",
      islands: { B: [3, 0, 3, 3], L: [0, 3, 3, 3], T: [3, 3, 3, 3], R: [6, 3, 3, 3], F: [3, 6, 3, 3], D: [3, 9, 3, 3] },
      seams: 7,
      unused: [10.5, 6]
    },
    packed: {
      label: "Six islands, packed",
      islands: { T: [0, 0, 4, 4], F: [4, 0, 4, 4], R: [8, 0, 4, 4], B: [0, 4, 4, 4], L: [4, 4, 4, 4], D: [8, 4, 4, 4] },
      seams: 12,
      unused: [6, 10]
    },
    uneven: {
      label: "Six islands, uneven",
      islands: { T: [0, 0, 6, 6], F: [6, 0, 6, 3], B: [6, 3, 3, 3], L: [9, 3, 3, 3], R: [0, 6, 3, 6], D: [3, 6, 2, 2] },
      seams: 12,
      unused: [8.5, 9.2]
    }
  };

  /* Edges that stay joined (hinges) in the one-island cross, per face.
     Edge names: t0 = top, s1 = right, t1 = bottom, s0 = left. */
  var HINGES = {
    T: ["t0", "s1", "t1", "s0"],
    F: ["t0", "t1"],
    D: ["t0"],
    B: ["t1"],
    L: ["s1"],
    R: ["s0"]
  };

  /* Camera and fold for each step. phi: 0 folded, 90 flat. land: 0 in the
     scene, 1 on the texture. S: pixels per metre in the scene. */
  var STEPS = [
    { title: "The textured cube", phi: 0, yaw: 35, pitch: 27, S: 132, land: 0, seams: false,
      text: "Each face shows the part of the texture its UVs point at. The square on the right is the whole texture; the outlines are the UV islands." },
    { title: "Choose the seams", phi: 0, yaw: 35, pitch: 27, S: 132, land: 0, seams: true,
      text: "A closed box cannot lie flat, so the surface is cut along seams. The blue edges are cut; every other edge stays joined." },
    { title: "Unfold", phi: 90, yaw: 25, pitch: 52, S: 84, land: 0, seams: true,
      text: "The faces swing open on the edges that stayed joined until the whole surface lies in one plane." },
    { title: "Flatten", phi: 90, yaw: 0, pitch: 90, S: 80, land: 0, seams: true,
      text: "Seen from straight above, the unfolded surface is a flat shape. Every corner now has a 2D position: its UV." },
    { title: "Pack into the texture", phi: 90, yaw: 0, pitch: 90, S: 80, land: 1, seams: true,
      text: "The flat pieces are placed in the 0 to 1 square of the texture, and the cube on the left wears the result. Switch layouts to compare: island size decides how many texels each face gets." }
  ];

  /* ---------- Small vector helpers ---------- */

  function v3(x, y, z) { return [x, y, z]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return scale(a, 1 / l); }

  /* ---------- The folding cube ---------- */

  /* Position on face `id` at local (s, t), for fold angle phi (radians).
     The top face stays put; the others turn about their hinge edge. The
     base hangs off the front face, so it turns twice as far. */
  function facePoint(id, s, t, phi) {
    var c = Math.cos(phi);
    var sn = Math.sin(phi);
    var u;
    switch (id) {
      case "T":
        return v3(-0.5 + s, 0.5, -0.5 + t);
      case "F":
        return v3(-0.5 + s, 0.5 - t * c, 0.5 + t * sn);
      case "D": {
        var hinge = v3(-0.5 + s, 0.5 - c, 0.5 + sn);
        var a = 2 * phi - Math.PI / 2;
        return add(hinge, v3(0, -t * Math.cos(a), t * Math.sin(a)));
      }
      case "B":
        u = 1 - t;
        return v3(-0.5 + s, 0.5 - u * c, -0.5 - u * sn);
      case "L":
        u = 1 - s;
        return v3(-0.5 - u * sn, 0.5 - u * c, -0.5 + t);
      default: // "R"
        return v3(0.5 + s * sn, 0.5 - s * c, -0.5 + t);
    }
  }

  /* Orthographic camera from yaw and pitch (degrees). Returns the screen
     right and up vectors and the direction towards the viewer. */
  function camera(yaw, pitch) {
    var a = yaw * DEG;
    var p = pitch * DEG;
    return {
      right: v3(Math.cos(a), 0, -Math.sin(a)),
      up: v3(-Math.sin(a) * Math.sin(p), Math.cos(p), -Math.cos(a) * Math.sin(p)),
      view: v3(Math.sin(a) * Math.cos(p), Math.sin(p), Math.cos(a) * Math.cos(p))
    };
  }

  /* ---------- Layout numbers ---------- */

  function texelsPerMetre(cells) {
    return (cells * TEX) / GRID / CUBE_M;
  }

  function stats(layoutId) {
    var L = LAYOUTS[layoutId];
    var used = 0;
    var dens = [];
    var stretched = 0;
    FACES.forEach(function (f) {
      var r = L.islands[f.id];
      used += r[2] * r[3];
      dens.push(texelsPerMetre(r[2]), texelsPerMetre(r[3]));
      if (r[2] !== r[3]) stretched++;
    });
    return {
      seams: L.seams,
      used: used / (GRID * GRID),
      min: Math.min.apply(null, dens),
      max: Math.max.apply(null, dens),
      stretched: stretched
    };
  }

  /* ---------- Init ---------- */

  var VIEW = { w: 900, h: 440 };
  var SCENE = { x: 240, y: 226 };
  var SQ = { x: 528, y: 52, size: 348 };
  var CELL = SQ.size / GRID;

  function init(root) {
    var state = { step: 0, layout: "one", density: false };
    var anim = null;
    var cur = Object.assign({}, STEPS[0]); // the camera/fold values on screen

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "UV unfold" }),
      h("span", { class: "demo-hint", text: "A 1 m cube with a 1024 × 1024 texture. Step through the unwrap, then try another layout." })
    ]));

    /* Controls */
    var controls = h("div", { class: "demo-controls" });
    var backBtn = h("button", { type: "button", class: "btn", text: "← Back" });
    var nextBtn = h("button", { type: "button", class: "btn is-primary", text: "Next →" });
    var stepLabel = h("span", { class: "value", "aria-live": "polite" });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Step" }),
      h("div", { style: "display:flex;gap:.5rem;align-items:center;flex-wrap:wrap" }, [backBtn, nextBtn, stepLabel])
    ]));
    controls.appendChild(HB.segmented("UV layout", [
      { value: "one", label: LAYOUTS.one.label },
      { value: "packed", label: LAYOUTS.packed.label },
      { value: "uneven", label: LAYOUTS.uneven.label }
    ], state.layout, function (v) { state.layout = v; draw(); }));
    var densBox = h("input", { type: "checkbox", id: "uvu-density" });
    densBox.addEventListener("change", function () { state.density = densBox.checked; draw(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "View" }),
      h("div", { class: "checks" }, [h("label", { for: "uvu-density" }, [densBox, "Texel density"])])
    ]));
    root.appendChild(controls);

    /* Stage */
    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "img",
      "aria-label": "A cube with a labelled checker texture on the left, and the whole texture with its UV islands on the right."
    });
    stage.appendChild(svg);
    root.appendChild(stage);
    var caption = h("p", { class: "demo-hint", "aria-live": "polite" });
    root.appendChild(caption);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    var layerTex = svgEl("g", null, svg);
    var layerScene = svgEl("g", null, svg);
    var layerTop = svgEl("g", null, svg);

    /* Fixed labels */
    svgEl("text", { x: 20, y: 26, class: "t-caps", text: "THE MESH · A 1 M CUBE" }, layerTop);
    svgEl("text", { x: SQ.x, y: 26, class: "t-caps", text: "THE TEXTURE · 1024 × 1024 TEXELS" }, layerTop);
    svgEl("text", { x: SQ.x - 8, y: SQ.y + SQ.size + 4, class: "t-mono t-muted t-small end", text: "0" }, layerTop);
    svgEl("text", { x: SQ.x + SQ.size, y: SQ.y + SQ.size + 18, class: "t-mono t-muted t-small mid", text: "1" }, layerTop);
    svgEl("text", { x: SQ.x - 8, y: SQ.y + 4, class: "t-mono t-muted t-small end", text: "1" }, layerTop);
    svgEl("text", { x: SQ.x + SQ.size / 2, y: SQ.y + SQ.size + 18, class: "t-small t-muted mid", text: "U →" }, layerTop);
    svgEl("text", { x: SQ.x - 12, y: SQ.y + SQ.size / 2, class: "t-small t-muted end", text: "V ↑" }, layerTop);

    /* Paint one island's texture content into `g`, in texture-grid units.
       Checker cells, then the face label; in density view a flat fill whose
       strength follows the texel density, with the number. */
    function paintIsland(g, face, rect, strength) {
      var x = rect[0] * U;
      var y = rect[1] * U;
      var w = rect[2] * U;
      var hh = rect[3] * U;
      if (state.density) {
        var dx = texelsPerMetre(rect[2]);
        var dy = texelsPerMetre(rect[3]);
        var mean = Math.sqrt(dx * dy);
        svgEl("rect", { x: x, y: y, width: w, height: hh, class: "f-surface" }, g);
        svgEl("rect", { x: x, y: y, width: w, height: hh, class: "f-acc", "fill-opacity": (0.1 + 0.6 * (mean / 512)) * strength }, g);
        var txt = dx === dy ? String(Math.round(dx)) : Math.round(dx) + "×" + Math.round(dy);
        var fs = Math.min(Math.min(w, hh) * 0.26, (w * 0.8) / (0.6 * txt.length));
        svgEl("text", { x: x + w / 2, y: y + hh / 2, class: "t-strong mid", style: "font-size:" + fs.toFixed(2) + "px", text: txt }, g);
        svgEl("text", { x: x + w / 2, y: y + hh / 2 + Math.min(w, hh) * 0.2, class: "t-muted mid", style: "font-size:" + (Math.min(w, hh) * 0.13).toFixed(2) + "px", text: "texels/m" }, g);
        return;
      }
      svgEl("rect", { x: x, y: y, width: w, height: hh, class: "f-surface" }, g);
      for (var j = rect[1]; j < rect[1] + rect[3]; j++) {
        for (var i = rect[0]; i < rect[0] + rect[2]; i++) {
          if ((i + j) % 2 === 0) {
            svgEl("rect", { x: i * U, y: j * U, width: U, height: U, class: "f-acc", "fill-opacity": 0.3 * strength }, g);
          }
        }
      }
      // Fit the label inside the island: about 0.66 em per capital letter.
      var size = Math.min(Math.min(w, hh) * 0.24, (w * 0.78) / (0.66 * face.name.length));
      svgEl("text", { x: x + w / 2, y: y + hh / 2 + size * 0.36, class: "t-acc t-strong mid", style: "font-size:" + size.toFixed(2) + "px", "fill-opacity": strength, text: face.name }, g);
    }

    /* The texture square: faint checker everywhere, the islands on top. */
    function drawTexture() {
      HB.svg.clear(layerTex);
      var L = LAYOUTS[state.layout];
      svgEl("rect", { x: SQ.x, y: SQ.y, width: SQ.size, height: SQ.size, class: "f-surface s-strong" }, layerTex);
      var g = svgEl("g", { transform: "translate(" + SQ.x + "," + SQ.y + ") scale(" + CELL / U + ")" }, layerTex);
      for (var j = 0; j < GRID; j++) {
        for (var i = 0; i < GRID; i++) {
          if ((i + j) % 2 === 0) svgEl("rect", { x: i * U, y: j * U, width: U, height: U, class: "f-acc", "fill-opacity": 0.08 }, g);
        }
      }
      FACES.forEach(function (f) { paintIsland(g, f, L.islands[f.id], 0.75); });
      FACES.forEach(function (f) {
        var r = L.islands[f.id];
        svgEl("rect", { x: r[0] * U, y: r[1] * U, width: r[2] * U, height: r[3] * U, class: "s-acc w15", "vector-effect": "non-scaling-stroke" }, g);
      });
      svgEl("text", { x: SQ.x + L.unused[0] * CELL, y: SQ.y + L.unused[1] * CELL, class: "t-small t-muted mid", text: "unused" }, layerTex);
    }

    /* Screen-space affine map of a face: origin and the images of its s and
       t axes, in the scene (folded or flat) and on its island. */
    function sceneAffine(id, p, cam, target) {
      function proj(P) {
        var q = sub(P, target);
        return [SCENE.x + p.S * dot(q, cam.right), SCENE.y - p.S * dot(q, cam.up)];
      }
      var phi = p.phi * DEG;
      var o = proj(facePoint(id, 0, 0, phi));
      var es = proj(facePoint(id, 1, 0, phi));
      var et = proj(facePoint(id, 0, 1, phi));
      return { o: o, es: [es[0] - o[0], es[1] - o[1]], et: [et[0] - o[0], et[1] - o[1]] };
    }

    function islandAffine(rect) {
      return {
        o: [SQ.x + rect[0] * CELL, SQ.y + rect[1] * CELL],
        es: [rect[2] * CELL, 0],
        et: [0, rect[3] * CELL]
      };
    }

    function mixAffine(a, b, t) {
      return {
        o: [lerp(a.o[0], b.o[0], t), lerp(a.o[1], b.o[1], t)],
        es: [lerp(a.es[0], b.es[0], t), lerp(a.es[1], b.es[1], t)],
        et: [lerp(a.et[0], b.et[0], t), lerp(a.et[1], b.et[1], t)]
      };
    }

    function at(A, s, t) {
      return [A.o[0] + s * A.es[0] + t * A.et[0], A.o[1] + s * A.es[1] + t * A.et[1]];
    }

    function pts(list) {
      return list.map(function (q) { return q[0].toFixed(2) + "," + q[1].toFixed(2); }).join(" ");
    }

    var EDGES = {
      t0: [[0, 0], [1, 0]],
      s1: [[1, 0], [1, 1]],
      t1: [[0, 1], [1, 1]],
      s0: [[0, 0], [0, 1]]
    };
    var LIGHT = norm(v3(0.45, 0.85, 0.5));

    function drawScene(p) {
      HB.svg.clear(layerScene);
      if (p.land > 0) {
        // While the pieces fly onto the texture, the cube folds back up on
        // the left, so a layout change shows its effect on the mesh.
        var ghost = svgEl("g", { opacity: p.land.toFixed(3) }, layerScene);
        drawFaces(STEPS[0], ghost);
      }
      drawFaces(p, layerScene);
    }

    function drawFaces(p, layer) {
      var L = LAYOUTS[state.layout];
      var cam = camera(p.yaw, p.pitch);
      var k = p.phi / 90;
      var target = v3(0, 0.5 * k, 0.5 * k); // centre of the cube, then of the cross
      var phi = p.phi * DEG;

      var list = FACES.map(function (f) {
        var P0 = facePoint(f.id, 0, 0, phi);
        var Ps = facePoint(f.id, 1, 0, phi);
        var Pt = facePoint(f.id, 0, 1, phi);
        var n = norm(cross(sub(Pt, P0), sub(Ps, P0))); // outward normal
        var centre = facePoint(f.id, 0.5, 0.5, phi);
        var A = sceneAffine(f.id, p, cam, target);
        if (p.land > 0) A = mixAffine(A, islandAffine(L.islands[f.id]), p.land);
        return { f: f, n: n, depth: dot(centre, cam.view), A: A, front: dot(n, cam.view) > 1e-6 || p.land > 0 };
      });
      list.sort(function (a, b) { return a.depth - b.depth; });

      list.forEach(function (item) {
        var A = item.A;
        var corners = [at(A, 0, 0), at(A, 1, 0), at(A, 1, 1), at(A, 0, 1)];
        var poly = pts(corners);
        var shadeAmt = p.land > 0 ? 0 : 0.32 * (1 - Math.max(0, dot(item.n, LIGHT)));
        if (!item.front) {
          // The inside of the box: plain card.
          svgEl("polygon", { points: poly, class: "f-sunken s-strong", "stroke-linejoin": "round" }, layer);
          svgEl("polygon", { points: poly, class: "f-shade", "fill-opacity": 0.12 + shadeAmt }, layer);
        } else {
          var r = L.islands[item.f.id];
          // grid units -> face (s, t) -> screen, as one SVG matrix
          var a = A.es[0] / (r[2] * U);
          var b = A.es[1] / (r[2] * U);
          var c = A.et[0] / (r[3] * U);
          var d = A.et[1] / (r[3] * U);
          var e = A.o[0] - a * r[0] * U - c * r[1] * U;
          var f = A.o[1] - b * r[0] * U - d * r[1] * U;
          if (Math.abs(a * d - b * c) > 1e-3) {
            var g = svgEl("g", { transform: "matrix(" + [a, b, c, d, e, f].map(function (n) { return n.toFixed(5); }).join(" ") + ")" }, layer);
            paintIsland(g, item.f, r, 1);
          }
          if (shadeAmt > 0.005) svgEl("polygon", { points: poly, class: "f-shade", "fill-opacity": shadeAmt }, layer);
          svgEl("polygon", { points: poly, class: "s-strong", "stroke-linejoin": "round" }, layer);
        }
        if (p.seams) {
          var hinges = state.layout === "one" ? HINGES[item.f.id] : [];
          Object.keys(EDGES).forEach(function (name) {
            if (hinges.indexOf(name) > -1) return;
            var e0 = at(A, EDGES[name][0][0], EDGES[name][0][1]);
            var e1 = at(A, EDGES[name][1][0], EDGES[name][1][1]);
            svgEl("line", { x1: e0[0], y1: e0[1], x2: e1[0], y2: e1[1], class: "s-acc w3 round" }, layer);
          });
        }
      });
    }

    function drawText() {
      var st = STEPS[state.step];
      stepLabel.textContent = "Step " + (state.step + 1) + " of " + STEPS.length + ": " + st.title;
      caption.textContent = st.text;
      backBtn.disabled = state.step === 0;
      nextBtn.disabled = state.step === STEPS.length - 1;
      var s = stats(state.layout);
      function cell(label, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
      }
      var density = s.min === s.max ? Math.round(s.min) + " on every face" : Math.round(s.min) + " to " + Math.round(s.max);
      readout.replaceChildren(
        cell("Seams cut", s.seams + " of 12 edges"),
        cell("Texture used", (s.used * 100).toFixed(1) + "%"),
        cell("Texels per metre", density),
        cell("Stretched faces", s.stretched ? s.stretched + ", at 2 : 1" : "none")
      );
      svg.setAttribute("aria-label", "Step " + (state.step + 1) + ", " + st.title + ". Layout: " + LAYOUTS[state.layout].label +
        ". " + s.seams + " seams, " + (s.used * 100).toFixed(1) + " percent of the texture used, " + density + " texels per metre.");
    }

    function draw() {
      drawTexture();
      drawScene(cur);
      drawText();
    }

    function ease(t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    function goTo(step) {
      step = Math.max(0, Math.min(STEPS.length - 1, step));
      if (step === state.step) return;
      var from = Object.assign({}, cur);
      var to = STEPS[step];
      state.step = step;
      drawText();
      if (anim) { cancelAnimationFrame(anim); anim = null; }
      if (HB.demos.reducedMotion()) {
        cur = Object.assign({}, to);
        draw();
        return;
      }
      var start = null;
      var DURATION = 900;
      var keys = ["phi", "yaw", "pitch", "S", "land"];
      function frame(ts) {
        if (start === null) start = ts;
        var t = Math.min(1, (ts - start) / DURATION);
        var e = ease(t);
        keys.forEach(function (key) { cur[key] = lerp(from[key], to[key], e); });
        cur.seams = to.seams || (from.seams && t < 1);
        drawScene(cur);
        if (t < 1) anim = requestAnimationFrame(frame);
        else { anim = null; cur = Object.assign({}, to); drawScene(cur); }
      }
      anim = requestAnimationFrame(frame);
    }

    backBtn.addEventListener("click", function () { goTo(state.step - 1); });
    nextBtn.addEventListener("click", function () { goTo(state.step + 1); });

    draw();
    log.debug("ready");
  }

  HB.demos.register("uv-unfold", init);
})();

/*
 * pipeline-stepper.js: chapter 5.1's interactive.
 *
 * One triangle is carried through the six steps of the graphics pipeline,
 * one click per step:
 *
 *   0 vertex fetch       input assembler reads 3 indices and 3 vertex rows
 *   1 vertex shader      your code: one run per vertex, clip-space output
 *   2 assembly + clip    fixed: divide by w, map to pixels, facing, clipping
 *   3 rasterization      fixed: which pixel centres the triangle covers
 *   4 pixel shader       your code: one run per covered pixel, a colour out
 *   5 depth and blend    fixed: depth test against a wall drawn earlier
 *
 * The screen is a tiny 16 x 10 pixels so every pixel is visible. All the
 * numbers are computed, not drawn by hand:
 *   - clip space comes from each corner's screen position, depth and w
 *     (depth = f / (f - n) * (1 - n / w), near 1, far 10, as in Direct3D);
 *   - coverage tests pixel centres against the triangle's three edges;
 *   - depth is interpolated linearly on screen, the UV perspective-correctly;
 *   - the pixel shader samples a 4 x 4 checker texture at that UV.
 *
 * Three cases: the triangle on screen, crossing the right edge (only the part
 * on screen is rasterized), and seen from behind (anticlockwise on screen is
 * front-facing here, so it is culled at assembly and nothing follows).
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("pipeline-stepper");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- The tiny screen and the scene ---------- */

  var SW = 16;
  var SH = 10;
  var CELL = 22;
  var GX = 104; // screen origin in the SVG
  var GY = 92;
  var VIEW = { w: 560, h: 340 };
  var NEAR = 1;
  var FAR = 10;
  // A wall drawn by an earlier draw call: these pixels already hold depth 0.80.
  var WALL = { x0: 10, x1: 16, y0: 2, y1: 10, depth: 0.8 };

  // The three vertex-buffer rows. Object-space positions are what the
  // artist built; screen positions are where the vertex shader sends them.
  var ROWS = [
    { name: "A", obj: [-1.0, 0.0, 0.0], uv: [0, 0], w: 2.0 },
    { name: "B", obj: [1.0, 0.0, 0.0], uv: [1, 0], w: 6.0 },
    { name: "C", obj: [-0.4, 1.2, 0.0], uv: [0, 1], w: 3.0 }
  ];
  var CASES = {
    inside: [[2.3, 8.7], [14.6, 6.4], [6.8, 1.3]],
    edge: [[2.3, 8.7], [19.4, 5.9], [6.8, 1.3]],
    // Seen from behind: the same corners appear mirrored, so they run the
    // other way round on screen.
    away: [[13.7, 8.7], [1.4, 6.4], [9.2, 1.3]]
  };

  var STAGES = [
    { short: "Fetch", name: "Vertex fetch", unit: "Input assembler", prog: false },
    { short: "Vertex", name: "Vertex shader", unit: "Your vertex shader", prog: true },
    { short: "Assemble", name: "Primitive assembly and clipping", unit: "Fixed hardware", prog: false },
    { short: "Rasterize", name: "Rasterization", unit: "Rasterizer", prog: false },
    { short: "Pixel", name: "Pixel shader", unit: "Your pixel shader", prog: true },
    { short: "Merge", name: "Depth test and blend", unit: "Output merger", prog: false }
  ];

  function depthFromW(w) {
    return (FAR / (FAR - NEAR)) * (1 - NEAR / w);
  }

  function fmt(n, d) {
    var s = Number(n).toFixed(d === undefined ? 2 : d);
    if (Number(s) === 0) s = s.replace("-", "");
    return s.charAt(0) === "-" ? "−" + s.slice(1) : s;
  }

  /* ---------- The maths for one case ---------- */

  function compute(caseName) {
    var screen = CASES[caseName];
    var verts = ROWS.map(function (row, i) {
      var sx = screen[i][0];
      var sy = screen[i][1];
      var depth = depthFromW(row.w);
      var ndc = { x: (sx / SW) * 2 - 1, y: 1 - (sy / SH) * 2, z: depth };
      return {
        name: row.name, obj: row.obj, uv: row.uv, w: row.w, sx: sx, sy: sy, depth: depth,
        clip: { x: ndc.x * row.w, y: ndc.y * row.w, z: ndc.z * row.w, w: row.w }
      };
    });
    var a = verts[0], b = verts[1], c = verts[2];
    // Twice the signed area. With y pointing down, a negative value means
    // the corners run anticlockwise on screen: front-facing in this demo.
    var area = (b.sx - a.sx) * (c.sy - a.sy) - (b.sy - a.sy) * (c.sx - a.sx);
    var front = area < 0;
    var offscreen = verts.some(function (v) { return v.sx < 0 || v.sx > SW || v.sy < 0 || v.sy > SH; });

    var pixels = [];
    if (front) {
      for (var j = 0; j < SH; j++) {
        for (var i = 0; i < SW; i++) {
          var px = i + 0.5;
          var py = j + 0.5;
          // Barycentric weights from the three edge functions.
          var wa = ((b.sx - px) * (c.sy - py) - (b.sy - py) * (c.sx - px)) / area;
          var wb = ((c.sx - px) * (a.sy - py) - (c.sy - py) * (a.sx - px)) / area;
          var wc = 1 - wa - wb;
          if (wa < 0 || wb < 0 || wc < 0) continue;
          var depth = wa * a.depth + wb * b.depth + wc * c.depth;
          // Perspective-correct UV: interpolate uv / w and 1 / w, then divide.
          var iw = wa / a.w + wb / b.w + wc / c.w;
          var u = (wa * a.uv[0] / a.w + wb * b.uv[0] / b.w + wc * c.uv[0] / c.w) / iw;
          var v = (wa * a.uv[1] / a.w + wb * b.uv[1] / b.w + wc * c.uv[1] / c.w) / iw;
          var dark = (Math.floor(Math.min(u, 0.999) * 4) + Math.floor(Math.min(v, 0.999) * 4)) % 2 === 0;
          var inWall = i >= WALL.x0 && i < WALL.x1 && j >= WALL.y0 && j < WALL.y1;
          pixels.push({ i: i, j: j, depth: depth, u: u, v: v, dark: dark, pass: !inWall || depth < WALL.depth });
        }
      }
    }
    var passed = pixels.filter(function (p) { return p.pass; }).length;
    return { verts: verts, front: front, offscreen: offscreen, pixels: pixels, passed: passed };
  }

  /* ---------- Small drawing helpers ---------- */

  function gx(x) { return GX + x * CELL; }
  function gy(y) { return GY + y * CELL; }

  function init(root) {
    var state = { stage: 0, kase: "inside", blend: false };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Pipeline stepper" }),
      h("span", { class: "demo-hint", text: "Send one triangle through the GPU, one stage per click." })
    ]));

    /* Controls */
    var controls = h("div", { class: "demo-controls" });
    var backBtn = h("button", { type: "button", class: "btn", text: "← Back" });
    var nextBtn = h("button", { type: "button", class: "btn is-primary", text: "" });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Step" }),
      h("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap" }, [backBtn, nextBtn])
    ]));
    var stageSeg = HB.segmented("Stage", STAGES.map(function (s, i) {
      return { value: i, label: (i + 1) + " " + s.short };
    }), state.stage, function (v) { state.stage = v; render(); });
    controls.appendChild(stageSeg);
    controls.appendChild(HB.segmented("Triangle", [
      { value: "inside", label: "On screen" },
      { value: "edge", label: "Crosses the edge" },
      { value: "away", label: "Faces away" }
    ], state.kase, function (v) { state.kase = v; render(); }));
    controls.appendChild(HB.segmented("Output merger", [
      { value: false, label: "Replace" },
      { value: true, label: "Blend 50%" }
    ], state.blend, function (v) { state.blend = v; render(); }));
    root.appendChild(controls);

    /* Explanation beside the picture on wide screens. */
    var panels = h("div", { class: "demo-panels is-split" });
    var textPanel = h("div", { class: "demo-panel", "aria-live": "polite" });
    var picPanel = h("div", { class: "demo-panel" });
    panels.appendChild(textPanel);
    panels.appendChild(picPanel);
    root.appendChild(panels);

    var stageWrap = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-mid",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "img",
      "aria-label": "The six stages of the pipeline across the top, and below them the triangle as it looks after the current stage."
    });
    stageWrap.appendChild(svg);
    picPanel.appendChild(stageWrap);

    var defs = svgEl("defs", null, svg);
    var mk = svgEl("marker", { id: "ps-arr", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
    svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: "f-muted" }, mk);
    var mka = svgEl("marker", { id: "ps-arr-a", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
    svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: "f-acc" }, mka);
    var clip = svgEl("clipPath", { id: "ps-clip-screen" }, defs);
    svgEl("rect", { x: gx(0), y: gy(0), width: SW * CELL, height: SH * CELL }, clip);

    var layerStrip = svgEl("g", null, svg);
    var layerPic = svgEl("g", null, svg);

    var readout = h("div", { class: "demo-readout" });
    root.appendChild(readout);

    /* ---------- The stage strip ---------- */

    function drawStrip() {
      HB.svg.clear(layerStrip);
      var w = 84;
      var gap = 6;
      var x0 = (VIEW.w - (6 * w + 5 * gap)) / 2;
      STAGES.forEach(function (s, i) {
        var x = x0 + i * (w + gap);
        var cur = i === state.stage;
        var cls = cur ? (s.prog ? "f-acc-soft s-acc w2" : "f-sunken s-ink w2") : s.prog ? "f-acc-soft s-acc" : "f-surface s-strong";
        svgEl("rect", { x: x, y: 8, width: w, height: 48, rx: 6, class: cls, "stroke-dasharray": i > state.stage ? "3 3" : null }, layerStrip);
        svgEl("text", { x: x + w / 2, y: 28, class: "mid t-small t-strong" + (s.prog ? " t-acc" : ""), text: (i + 1) + " " + s.short }, layerStrip);
        svgEl("text", { x: x + w / 2, y: 44, class: "mid t-small " + (s.prog ? "t-acc" : "t-muted"), text: s.prog ? "your shader" : "fixed" }, layerStrip);
        if (i < 5) {
          svgEl("line", { x1: x + w + 0.5, y1: 32, x2: x + w + gap - 0.5, y2: 32, class: "s-muted" }, layerStrip);
        }
      });
    }

    /* ---------- The picture for each stage ---------- */

    function drawGrid(parent, faint) {
      for (var i = 0; i <= SW; i++) {
        svgEl("line", { x1: gx(i), y1: gy(0), x2: gx(i), y2: gy(SH), class: "s-line" }, parent);
      }
      for (var j = 0; j <= SH; j++) {
        svgEl("line", { x1: gx(0), y1: gy(j), x2: gx(SW), y2: gy(j), class: "s-line" }, parent);
      }
      svgEl("rect", { x: gx(0), y: gy(0), width: SW * CELL, height: SH * CELL, class: faint ? "s-strong" : "s-ink" }, parent);
      svgEl("text", { x: gx(0), y: gy(0) - 8, class: "t-caps", text: "THE SCREEN · 16 × 10 PIXELS" }, parent);
    }

    function triPoints(r) {
      return r.verts.map(function (v) { return gx(v.sx).toFixed(1) + "," + gy(v.sy).toFixed(1); }).join(" ");
    }

    function drawCorners(parent, r, labels) {
      r.verts.forEach(function (v) {
        svgEl("circle", { cx: gx(v.sx), cy: gy(v.sy), r: 5, class: "f-acc" }, parent);
        if (!labels) return;
        var dx = v.name === "B" ? 10 : -10;
        var anchor = v.name === "B" ? "" : " end";
        if (v.name === "C") { dx = 10; anchor = ""; }
        svgEl("text", { x: gx(v.sx) + dx, y: gy(v.sy) - 8, class: "t-mono t-small t-strong" + anchor, text: v.name + "  w " + fmt(v.w, 1) }, parent);
      });
    }

    function pixelRect(parent, p, cls, extra) {
      var attrs = { x: gx(p.i) + 1, y: gy(p.j) + 1, width: CELL - 2, height: CELL - 2, class: cls };
      if (extra) Object.keys(extra).forEach(function (k) { attrs[k] = extra[k]; });
      return svgEl("rect", attrs, parent);
    }

    function drawFetch(r) {
      var g = layerPic;
      svgEl("text", { x: 40, y: 92, class: "t-caps", text: "INDEX BUFFER" }, g);
      var tops = [];
      [0, 1, 2].forEach(function (k) {
        var y = 104 + k * 44;
        svgEl("rect", { x: 40, y: y, width: 44, height: 32, class: "f-surface s-strong" }, g);
        svgEl("text", { x: 62, y: y + 21, class: "t-mono t-strong mid", text: String(k) }, g);
        tops.push(y + 16);
      });
      svgEl("text", { x: 190, y: 92, class: "t-caps", text: "VERTEX BUFFER · OBJECT SPACE" }, g);
      var cols = [{ x: 206, t: "#" }, { x: 296, t: "position" }, { x: 420, t: "uv" }];
      cols.forEach(function (c) { svgEl("text", { x: c.x, y: 116, class: "t-small t-muted mid", text: c.t }, g); });
      r.verts.forEach(function (v, k) {
        var y = 124 + k * 40;
        svgEl("rect", { x: 190, y: y, width: 270, height: 32, class: "f-geo-soft s-strong" }, g);
        svgEl("text", { x: 206, y: y + 21, class: "t-mono mid", text: String(k) }, g);
        svgEl("text", { x: 296, y: y + 21, class: "t-mono mid", text: v.obj.map(function (n) { return fmt(n, 1); }).join(", ") }, g);
        svgEl("text", { x: 420, y: y + 21, class: "t-mono mid", text: v.uv.join(", ") }, g);
        svgEl("text", { x: 472, y: y + 21, class: "t-strong", text: v.name }, g);
        svgEl("line", { x1: 86, y1: tops[k], x2: 186, y2: y + 16, class: "s-acc w15", "marker-end": "url(#ps-arr-a)" }, g);
      });
      svgEl("text", { x: 40, y: 272, class: "t-small", text: "The draw call asks for 3 indices. The input assembler follows each one to its row." }, g);
      svgEl("text", { x: 40, y: 290, class: "t-small t-muted", text: "Positions are still in the model's own space: nothing has moved yet." }, g);
    }

    function drawVertex(r) {
      drawGrid(layerPic, true);
      if (r.offscreen) {
        svgEl("text", { x: gx(SW) + 6, y: gy(0) + 14, class: "t-small t-muted", text: "off" }, layerPic);
        svgEl("text", { x: gx(SW) + 6, y: gy(0) + 28, class: "t-small t-muted", text: "screen" }, layerPic);
      }
      drawCorners(layerPic, r, true);
      svgEl("text", { x: gx(0), y: gy(SH) + 22, class: "t-small", text: "3 runs of the vertex shader: each corner now has a clip-space position." }, layerPic);
      svgEl("text", { x: gx(0), y: gy(SH) + 38, class: "t-small t-muted", text: "They are still three separate points: no triangle exists yet." }, layerPic);
    }

    function drawAssembly(r) {
      drawGrid(layerPic, true);
      if (!r.front) {
        svgEl("polygon", { points: triPoints(r), class: "f-pix-soft s-pix w2 dash", "fill-opacity": 0.6 }, layerPic);
        drawCorners(layerPic, r, false);
        var cx = (r.verts[0].sx + r.verts[1].sx + r.verts[2].sx) / 3;
        var cy = (r.verts[0].sy + r.verts[1].sy + r.verts[2].sy) / 3;
        svgEl("text", { x: gx(cx), y: gy(cy) + 4, class: "t-strong t-pix mid", text: "culled: faces away" }, layerPic);
        svgEl("text", { x: gx(0), y: gy(SH) + 22, class: "t-small", text: "A → B → C runs clockwise on screen, so this is the back of the triangle." }, layerPic);
        svgEl("text", { x: gx(0), y: gy(SH) + 38, class: "t-small t-muted", text: "It is dropped here. No pixel is touched and no pixel shader runs for it." }, layerPic);
        return;
      }
      if (r.offscreen) {
        svgEl("polygon", { points: triPoints(r), class: "s-acc dash" }, layerPic);
        var inside = svgEl("g", { "clip-path": "url(#ps-clip-screen)" }, layerPic);
        svgEl("polygon", { points: triPoints(r), class: "f-acc-soft s-acc w2" }, inside);
      } else {
        svgEl("polygon", { points: triPoints(r), class: "f-acc-soft s-acc w2" }, layerPic);
      }
      drawCorners(layerPic, r, false);
      r.verts.forEach(function (v) {
        var dx = v.name === "A" ? -10 : 10;
        svgEl("text", { x: gx(v.sx) + dx, y: gy(v.sy) - 8, class: "t-mono t-small t-strong" + (v.name === "A" ? " end" : ""), text: v.name }, layerPic);
      });
      svgEl("text", { x: gx(0), y: gy(SH) + 22, class: "t-small", text: "Divided by w and mapped to pixels, the three corners now make one triangle." }, layerPic);
      svgEl("text", { x: gx(0), y: gy(SH) + 38, class: "t-small t-muted", text: r.offscreen ? "Only the part inside the screen goes on; the dashed part is never drawn." : "It faces the camera and lies wholly on screen, so it goes on unchanged." }, layerPic);
    }

    function nothingLeft() {
      drawGrid(layerPic, true);
      svgEl("text", { x: gx(SW / 2), y: gy(SH / 2) + 4, class: "t-strong t-muted mid", text: "nothing to do: the triangle was culled" }, layerPic);
    }

    function drawRaster(r) {
      if (!r.front) { nothingLeft(); return; }
      drawGrid(layerPic, true);
      r.pixels.forEach(function (p) { pixelRect(layerPic, p, "f-acc-soft s-acc"); });
      var outline = svgEl("g", { "clip-path": r.offscreen ? "url(#ps-clip-screen)" : null }, layerPic);
      svgEl("polygon", { points: triPoints(r), class: "s-ink w15" }, outline);
      r.pixels.forEach(function (p) {
        svgEl("circle", { cx: gx(p.i + 0.5), cy: gy(p.j + 0.5), r: 2, class: "f-acc" }, layerPic);
      });
      svgEl("text", { x: gx(0), y: gy(SH) + 22, class: "t-small", text: r.pixels.length + " pixel centres fall inside the triangle, so it covers " + r.pixels.length + " pixels." }, layerPic);
      svgEl("text", { x: gx(0), y: gy(SH) + 38, class: "t-small t-muted", text: "Each gets its own UV and depth, blended from the three corners." }, layerPic);
    }

    function drawPixel(r) {
      if (!r.front) { nothingLeft(); return; }
      drawGrid(layerPic, true);
      r.pixels.forEach(function (p) { pixelRect(layerPic, p, p.dark ? "f-acc" : "f-acc-soft s-acc"); });
      svgEl("text", { x: gx(0), y: gy(SH) + 22, class: "t-small", text: r.pixels.length + " runs of the pixel shader, against 3 of the vertex shader." }, layerPic);
      svgEl("text", { x: gx(0), y: gy(SH) + 38, class: "t-small t-muted", text: "Each reads a checker texture at its UV and returns a colour." }, layerPic);
    }

    function drawMerge(r) {
      drawGrid(layerPic, true);
      // What the frame already holds: cleared pixels and a wall at depth 0.80.
      for (var j = WALL.y0; j < WALL.y1; j++) {
        for (var i = WALL.x0; i < WALL.x1; i++) pixelRect(layerPic, { i: i, j: j }, "f-strong", { "fill-opacity": 0.75 });
      }
      svgEl("text", { x: gx((WALL.x0 + WALL.x1) / 2), y: gy(WALL.y0) + 16, class: "t-small t-strong mid", text: "wall, depth 0.80" }, layerPic);
      if (!r.front) {
        svgEl("text", { x: gx(5), y: gy(SH / 2) + 4, class: "t-strong t-muted mid", text: "nothing new to merge" }, layerPic);
        return;
      }
      r.pixels.forEach(function (p) {
        if (!p.pass) {
          svgEl("path", {
            d: "M" + (gx(p.i) + 6) + "," + (gy(p.j) + 6) + " l10,10 M" + (gx(p.i) + 16) + "," + (gy(p.j) + 6) + " l-10,10",
            class: "s-pix w15"
          }, layerPic);
          return;
        }
        pixelRect(layerPic, p, p.dark ? "f-acc" : "f-acc-soft s-acc", state.blend ? { "fill-opacity": 0.5 } : null);
      });
      var hidden = r.pixels.length - r.passed;
      svgEl("text", { x: gx(0), y: gy(SH) + 22, class: "t-small", text: r.passed + " pixels are nearer than what is there and are " + (state.blend ? "blended in." : "written.") }, layerPic);
      svgEl("text", { x: gx(0), y: gy(SH) + 38, class: "t-small t-pix", text: hidden + " lie behind the wall (×) and are thrown away after being shaded." }, layerPic);
    }

    /* ---------- Text panel and readout ---------- */

    function explain(st, r) {
      var n = r.pixels.length;
      switch (st) {
        case 0:
          return "The draw call asks for 3 indices. The input assembler reads them from the index buffer, fetches the three rows they point to from the vertex buffer, and decodes each row with the vertex layout. Fixed hardware: you choose its settings, not its code.";
        case 1:
          return "Your vertex shader runs once per vertex, 3 times here. Each run sees one vertex and the constants shared by the whole draw, such as the object's matrices, and returns a clip-space position (x, y, z, w) plus values for the pixel shader, here the UV.";
        case 2:
          if (!r.front) return "Primitive assembly joins the three outputs into a triangle and divides by w to find its corners on screen. They run clockwise, so we are looking at the triangle's back. Backface culling drops it here, before any pixel work.";
          return "Primitive assembly joins the three outputs into a triangle, divides by w and maps the corners to pixel positions. It checks the triangle faces the camera and deals with any part outside the view." + (r.offscreen ? " Corner B is off the right edge, so only the part on screen goes on." : "");
        case 3:
          if (!r.front) return "Nothing reaches the rasterizer. A culled triangle costs its 3 vertex shader runs and nothing more.";
          return "The rasterizer finds every pixel whose centre lies inside the triangle: " + n + " here. For each, it blends the corners' outputs by how near the pixel is to each corner, so every pixel gets its own UV and depth.";
        case 4:
          if (!r.front) return "No pixels, so the pixel shader never runs for this triangle.";
          return "Your pixel shader runs once per covered pixel: " + n + " times, against 3 vertex shader runs. Each run gets its pixel's blended UV, reads a texture there and returns a colour. This is usually where most of a frame's GPU time goes.";
        default:
          if (!r.front) return "The frame keeps what it had: the wall drawn earlier.";
          return "The output merger compares each pixel's depth with the depth already stored there. A wall drawn earlier sits at depth 0.80. " + r.passed + " pixels are nearer and are " + (state.blend ? "mixed 50 : 50 with the colour already there" : "written over it") + "; " + (n - r.passed) + " are behind it and discarded, after the pixel shader already paid for them.";
      }
    }

    function ioRows(st, r) {
      var n = r.pixels.length;
      var none = "nothing (culled)";
      return [
        [["In", "3 indices, the vertex buffer, the layout"], ["Out", "3 vertices: position and UV"]],
        [["In", "1 vertex + the draw's constants"], ["Out", "clip-space position + UV"]],
        [["In", "3 shaded vertices"], ["Out", r.front ? "1 triangle in pixel positions" : none]],
        [["In", r.front ? "1 triangle" : none], ["Out", r.front ? n + " pixels, each with UV and depth" : none]],
        [["In", r.front ? "1 pixel's UV + a texture" : none], ["Out", r.front ? "1 colour per pixel, " + n + " in all" : none]],
        [["In", r.front ? n + " colours + depths, the frame so far" : none], ["Out", r.front ? r.passed + " pixels changed in the image" : "the image unchanged"]]
      ][st];
    }

    function clipTable(r) {
      return h("table", { class: "byte-table" }, [
        h("thead", null, [h("tr", null, ["Corner", "x", "y", "z", "w"].map(function (t) { return h("th", { scope: "col", text: t }); }))]),
        h("tbody", null, r.verts.map(function (v) {
          return h("tr", null, [
            h("td", { text: v.name }),
            h("td", { text: fmt(v.clip.x) }),
            h("td", { text: fmt(v.clip.y) }),
            h("td", { text: fmt(v.clip.z) }),
            h("td", { text: fmt(v.clip.w, 1) })
          ]);
        }))
      ]);
    }

    function drawText(r) {
      var st = state.stage;
      var s = STAGES[st];
      var io = ioRows(st, r);
      var kids = [
        h("p", { class: "label", text: "Stage " + (st + 1) + " of 6 · " + (s.prog ? "your code" : "fixed hardware") }),
        h("p", null, [h("strong", { text: s.name + ". " }), explain(st, r)]),
        h("table", { class: "byte-table" }, [
          h("tbody", null, io.map(function (row) {
            return h("tr", null, [h("td", { text: row[0] }), h("td", { text: row[1], style: "text-align:left;white-space:normal" })]);
          }))
        ])
      ];
      if (st === 1) kids.push(h("div", { class: "table-scroll" }, [clipTable(r)]));
      textPanel.replaceChildren.apply(textPanel, kids);

      function cell(label, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
      }
      readout.replaceChildren(
        cell("Now", (st + 1) + " · " + s.unit),
        cell("Vertex shader runs", "3"),
        cell("Triangles kept", r.front ? "1" : "0"),
        cell("Pixel shader runs", String(r.pixels.length)),
        cell("Pixels written", String(r.passed))
      );
      backBtn.disabled = st === 0;
      nextBtn.disabled = st === 5;
      nextBtn.textContent = st === 5 ? "In the frame" : "Next: " + STAGES[st + 1].short + " →";
      stageSeg.querySelectorAll("button").forEach(function (b, i) {
        b.setAttribute("aria-pressed", i === st ? "true" : "false");
      });
      svg.setAttribute("aria-label", "Stage " + (st + 1) + ", " + s.name + ". " + explain(st, r));
    }

    function render() {
      var r = compute(state.kase);
      drawStrip();
      HB.svg.clear(layerPic);
      [drawFetch, drawVertex, drawAssembly, drawRaster, drawPixel, drawMerge][state.stage](r);
      drawText(r);
      log.debug("stage", state.stage, state.kase, "covered", r.pixels.length, "written", r.passed);
    }

    function goTo(st) {
      state.stage = Math.max(0, Math.min(5, st));
      render();
    }
    backBtn.addEventListener("click", function () { goTo(state.stage - 1); });
    nextBtn.addEventListener("click", function () { goTo(state.stage + 1); });

    render();
    log.debug("ready");
  }

  HB.demos.register("pipeline-stepper", init);
})();

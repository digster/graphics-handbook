/*
 * transparency-sorter.js: chapter 5.5's interactive.
 *
 * A camera looks straight at a striped opaque wall with coloured glass panes
 * in front of it. The reader chooses the order the panes are drawn in and
 * whether they write depth, and sees three images side by side:
 *
 *   What the GPU draws   a per-pixel simulation of the real pipeline: the
 *                        opaque wall (and a post) first, writing depth, then
 *                        each pane in the chosen order, depth-tested against
 *                        the depth buffer and alpha-blended over the colour
 *                        already there ("over": c = a·src + (1 − a)·dst).
 *   Correct              for every pixel, the glass in front of the opaque
 *                        surface sorted far to near and blended in that
 *                        order: what a perfect order-independent method gives.
 *   Depth buffer         the depth left after the frame, as distance
 *                        (near dark, far light).
 *
 * Two scenes: three separate panes at different distances (one order is
 * right), and two panes that cross each other (no order is right, because
 * each pane is in front of the other on one side of the crossing line).
 *
 * The camera is orthographic so screen x and y equal scene x and y and depth
 * is plain distance; that keeps the top-down map honest. The pane colours are
 * the book's theme hues, read from CSS tokens, so the canvases are redrawn on
 * "hb:themechange". Blending is done on the stored 0..1 values, which is
 * enough to show ordering; real renderers blend in linear light (chapter 3.2).
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("transparency-sorter");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- Scene (screen x, y run 0..1; z is metres from the camera) ---------- */

  var WALL_Z = 10;
  var ALPHA = 0.5;       // glass body
  var EDGE_ALPHA = 0.9;  // the pane's thin frame, so its outline stays visible

  var SCENES = {
    stack: {
      label: "Three panes",
      panes: [
        { id: "rose", name: "Rose", token: "pix", stroke: "s-pix", x0: 0.10, x1: 0.55, y0: 0.15, y1: 0.70, z0: 3, z1: 3 },
        { id: "amber", name: "Amber", token: "lit", stroke: "s-lit", x0: 0.30, x1: 0.75, y0: 0.30, y1: 0.88, z0: 5, z1: 5 },
        { id: "teal", name: "Teal", token: "geo", stroke: "s-geo", x0: 0.45, x1: 0.90, y0: 0.08, y1: 0.60, z0: 7, z1: 7 }
      ],
      // An opaque post between the amber and teal panes: depth testing hides
      // the teal pane behind it whatever the glass order.
      post: { x0: 0.62, x1: 0.70, z: 6 }
    },
    cross: {
      label: "Two panes cross",
      panes: [
        { id: "rose", name: "Rose", token: "pix", stroke: "s-pix", x0: 0.08, x1: 0.72, y0: 0.14, y1: 0.74, z0: 2, z1: 7 },
        { id: "teal", name: "Teal", token: "geo", stroke: "s-geo", x0: 0.28, x1: 0.92, y0: 0.28, y1: 0.88, z0: 8, z1: 2 }
      ],
      post: null
    }
  };

  function paneZ(p, u) {
    return p.z0 + (p.z1 - p.z0) * (u - p.x0) / (p.x1 - p.x0);
  }
  function centreZ(p) {
    return (p.z0 + p.z1) / 2;
  }
  function covers(p, u, v) {
    return u >= p.x0 && u <= p.x1 && v >= p.y0 && v <= p.y1;
  }

  /* ---------- Colours ---------- */

  /* "#B92F58" or "rgb(…)" -> [r, g, b] in 0..1. */
  function parseColour(text) {
    var s = (text || "").trim();
    if (s.charAt(0) === "#") {
      var hex = s.slice(1);
      if (hex.length === 3) hex = hex.replace(/./g, function (c) { return c + c; });
      var n = parseInt(hex.slice(0, 6), 16);
      if (!isNaN(n)) return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
    var m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var parts = m[1].split(",").map(function (x) { return parseFloat(x) / 255; });
      if (parts.length >= 3) return parts.slice(0, 3);
    }
    return [0.5, 0.5, 0.5];
  }

  function readPalette() {
    var tokens = ["pix", "lit", "geo", "accent", "sunken", "line-strong", "muted", "ink", "buffer-hi", "buffer-lo"];
    var pal = {};
    tokens.forEach(function (t) { pal[t] = parseColour(HB.demos.color(t)); });
    return pal;
  }

  /* ---------- Rendering ---------- */

  var CW = 300;
  var CH = 200;

  /* Opaque pass: the striped wall, and the post if the scene has one. */
  function opaqueAt(scene, pal, u) {
    if (scene.post && u >= scene.post.x0 && u <= scene.post.x1) return { c: pal.muted, z: scene.post.z };
    var stripe = Math.floor(u * 14) % 2 === 0;
    return { c: stripe ? pal.sunken : pal["line-strong"], z: WALL_Z };
  }

  function blendOver(dst, src, a) {
    return [a * src[0] + (1 - a) * dst[0], a * src[1] + (1 - a) * dst[1], a * src[2] + (1 - a) * dst[2]];
  }

  /*
   * Renders all three views into Float32 RGB arrays.
   * Returns { gpu, ref, depth, glass, wrong, wrongCount, glassCount }.
   */
  function renderAll(scene, order, depthWrite, pal) {
    var n = CW * CH;
    var gpu = new Float32Array(n * 3);
    var ref = new Float32Array(n * 3);
    var depth = new Float32Array(n);
    var wrong = new Uint8Array(n);
    var glassCount = 0;
    var wrongCount = 0;
    var edgeU = 1.5 / CW;
    var edgeV = 1.5 / CH;
    var panes = scene.panes;

    for (var py = 0; py < CH; py++) {
      var v = (py + 0.5) / CH;
      for (var px = 0; px < CW; px++) {
        var u = (px + 0.5) / CW;
        var p = py * CW + px;
        var op = opaqueAt(scene, pal, u);

        // Glass fragments at this pixel, with their depth and alpha.
        var frags = [];
        for (var i = 0; i < panes.length; i++) {
          var pane = panes[i];
          if (!covers(pane, u, v)) continue;
          var edge = u - pane.x0 < edgeU || pane.x1 - u < edgeU || v - pane.y0 < edgeV || pane.y1 - v < edgeV;
          frags.push({ i: i, z: paneZ(pane, u), a: edge ? EDGE_ALPHA : ALPHA, c: pal[pane.token] });
        }

        // What the GPU does: depth buffer starts at the opaque surface, then
        // each pane in draw order is depth-tested and blended.
        var c = op.c;
        var d = op.z;
        for (var k = 0; k < order.length; k++) {
          for (var f = 0; f < frags.length; f++) {
            if (frags[f].i !== order[k]) continue;
            if (frags[f].z < d) {
              c = blendOver(c, frags[f].c, frags[f].a);
              if (depthWrite) d = frags[f].z;
            }
          }
        }

        // Correct: visible glass sorted far to near, per pixel.
        var r = op.c;
        var vis = frags.filter(function (fr) { return fr.z < op.z; }).sort(function (a, b) { return b.z - a.z; });
        for (f = 0; f < vis.length; f++) r = blendOver(r, vis[f].c, vis[f].a);

        gpu[p * 3] = c[0]; gpu[p * 3 + 1] = c[1]; gpu[p * 3 + 2] = c[2];
        ref[p * 3] = r[0]; ref[p * 3 + 1] = r[1]; ref[p * 3 + 2] = r[2];
        depth[p] = d;

        if (frags.length) {
          glassCount++;
          var diff = Math.max(Math.abs(c[0] - r[0]), Math.abs(c[1] - r[1]), Math.abs(c[2] - r[2]));
          if (diff > 3 / 255) {
            wrong[p] = 1;
            wrongCount++;
          }
        }
      }
    }
    return { gpu: gpu, ref: ref, depth: depth, wrong: wrong, wrongCount: wrongCount, glassCount: glassCount };
  }

  function paint(canvas, rgb, mark, ink) {
    var ctx = canvas.getContext("2d");
    var img = ctx.createImageData(CW, CH);
    for (var p = 0; p < CW * CH; p++) {
      var r = rgb[p * 3];
      var g = rgb[p * 3 + 1];
      var b = rgb[p * 3 + 2];
      if (mark && mark[p]) {
        // Hatch wrong pixels with diagonal ink lines so they read in both themes.
        var x = p % CW;
        var y = (p - x) / CW;
        if ((x + y) % 6 < 2) { r = ink[0]; g = ink[1]; b = ink[2]; }
      }
      img.data[p * 4] = Math.round(255 * r);
      img.data[p * 4 + 1] = Math.round(255 * g);
      img.data[p * 4 + 2] = Math.round(255 * b);
      img.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function paintDepth(canvas, depth, pal) {
    var rgb = new Float32Array(CW * CH * 3);
    var lo = pal["buffer-lo"];
    var hi = pal["buffer-hi"];
    for (var p = 0; p < CW * CH; p++) {
      var t = Math.min(1, depth[p] / WALL_Z);
      for (var k = 0; k < 3; k++) rgb[p * 3 + k] = lo[k] + (hi[k] - lo[k]) * t;
    }
    paint(canvas, rgb, null, null);
  }

  /* ---------- Order helpers ---------- */

  /* Indices sorted by centre distance: what an engine's per-object sort does. */
  function sortedOrder(scene, backToFront) {
    var idx = scene.panes.map(function (p, i) { return i; });
    idx.sort(function (a, b) {
      var d = centreZ(scene.panes[b]) - centreZ(scene.panes[a]);
      return backToFront ? d : -d;
    });
    return idx;
  }

  function sameOrder(a, b) {
    return a.length === b.length && a.every(function (x, i) { return x === b[i]; });
  }

  function overlaps(a, b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  }

  /* True if some pane is drawn after a nearer pane it overlaps. */
  function farAfterNear(scene, order) {
    for (var i = 0; i < order.length; i++) {
      for (var j = i + 1; j < order.length; j++) {
        var first = scene.panes[order[i]];
        var later = scene.panes[order[j]];
        if (overlaps(first, later) && centreZ(later) > centreZ(first)) return true;
      }
    }
    return false;
  }

  /* ---------- Init ---------- */

  function init(root) {
    var state = { scene: "stack", order: null, depthWrite: false, mark: true };
    state.order = sortedOrder(SCENES.stack, false); // opens front to back: wrong on purpose
    var pal = readPalette();

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Transparency sorter" }),
      h("span", { class: "demo-hint", text: "Change the draw order or let the glass write depth, and compare the GPU's result with the correct one." })
    ]));

    /* Controls */
    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Scene", [
      { value: "stack", label: SCENES.stack.label },
      { value: "cross", label: SCENES.cross.label }
    ], state.scene, function (v) {
      state.scene = v;
      state.order = sortedOrder(SCENES[v], false);
      draw();
    }));

    var presetGroup = h("div", { class: "seg", role: "group", "aria-label": "Sort the draw list" });
    var btnBack = h("button", { type: "button", "aria-pressed": "false", text: "Back to front" });
    var btnFront = h("button", { type: "button", "aria-pressed": "false", text: "Front to back" });
    btnBack.addEventListener("click", function () { state.order = sortedOrder(SCENES[state.scene], true); draw(); });
    btnFront.addEventListener("click", function () { state.order = sortedOrder(SCENES[state.scene], false); draw(); });
    presetGroup.appendChild(btnBack);
    presetGroup.appendChild(btnFront);
    controls.appendChild(h("div", { class: "control" }, [h("span", { class: "label", text: "Sort the glass" }), presetGroup]));

    var writeBox = h("input", { type: "checkbox", id: "ts-write", checked: state.depthWrite });
    writeBox.addEventListener("change", function () { state.depthWrite = writeBox.checked; draw(); });
    var markBox = h("input", { type: "checkbox", id: "ts-mark", checked: state.mark });
    markBox.addEventListener("change", function () { state.mark = markBox.checked; draw(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Settings" }),
      h("div", { class: "checks" }, [
        h("label", { for: "ts-write" }, [writeBox, "Glass writes depth"]),
        h("label", { for: "ts-mark" }, [markBox, "Hatch wrong pixels"])
      ])
    ]));
    root.appendChild(controls);

    /* Draw list and top-down map */
    var list = h("ol", { style: "list-style:none;margin:0;padding:0;display:grid;gap:.4rem" });
    var listPanel = h("div", { class: "demo-panel" }, [
      h("span", { class: "label", text: "Draw list, after the opaque pass" }),
      list,
      h("p", { class: "demo-hint", text: "The striped wall and the grey post are opaque. They are drawn first and write depth." })
    ]);

    var map = svgEl("svg", {
      class: "dg",
      viewBox: "0 0 460 262",
      role: "img",
      style: "min-width:420px",
      "aria-label": "Top-down map of the scene."
    });
    var mapPanel = h("div", { class: "demo-panel" }, [h("span", { class: "label", text: "Seen from above" }), h("div", { class: "demo-stage" }, [map])]);
    root.appendChild(h("div", { class: "demo-panels is-split" }, [listPanel, mapPanel]));

    /* Three views */
    var canvasStyle = "display:block;width:100%;height:auto;aspect-ratio:3/2;border:1px solid var(--line-strong);border-radius:6px";
    function view(title) {
      var cv = h("canvas", { width: CW, height: CH, style: canvasStyle, role: "img", "aria-label": title });
      return { cv: cv, el: h("div", { class: "demo-panel" }, [h("span", { class: "label", text: title }), cv]) };
    }
    var vGpu = view("What the GPU draws");
    var vRef = view("Correct, sorted per pixel");
    var vDepth = view("Depth buffer afterwards");
    root.appendChild(h("div", { style: "display:grid;gap:var(--sp-4);grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))" }, [vGpu.el, vRef.el, vDepth.el]));

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);
    var note = h("p", { class: "demo-hint" });
    root.appendChild(note);

    /* Map geometry: screen x across, distance up the page. */
    function mx(u) { return 52 + u * 360; }
    function mz(z) { return 226 - z * 19; }

    function drawMap(scene) {
      HB.svg.clear(map);
      svgEl("text", { x: 14, y: mz(WALL_Z) + 4, class: "t-mono t-muted t-small", text: "10 m" }, map);
      [0, 2, 4, 6, 8].forEach(function (z) {
        svgEl("line", { x1: 44, y1: mz(z), x2: 48, y2: mz(z), class: "s-muted" }, map);
        svgEl("text", { x: 40, y: mz(z) + 4, class: "t-mono t-muted t-small end", text: z + " m" }, map);
      });
      // Orthographic view volume: straight sides.
      svgEl("line", { x1: mx(0), y1: mz(0), x2: mx(0), y2: mz(WALL_Z), class: "s-strong dash" }, map);
      svgEl("line", { x1: mx(1), y1: mz(0), x2: mx(1), y2: mz(WALL_Z), class: "s-strong dash" }, map);
      // Wall.
      svgEl("rect", { x: mx(0), y: mz(WALL_Z) - 8, width: 360, height: 8, class: "f-strong" }, map);
      svgEl("text", { x: mx(0.5), y: mz(WALL_Z) - 13, class: "t-small t-muted mid", text: "striped wall (opaque)" }, map);
      // Post.
      if (scene.post) {
        svgEl("rect", { x: mx(scene.post.x0), y: mz(scene.post.z) - 4, width: (scene.post.x1 - scene.post.x0) * 360, height: 8, class: "f-muted" }, map);
        svgEl("text", { x: mx(scene.post.x1) + 6, y: mz(scene.post.z) + 4, class: "t-small t-muted", text: "post" }, map);
      }
      // Camera.
      svgEl("rect", { x: mx(0.5) - 18, y: mz(0) + 6, width: 36, height: 14, rx: 3, class: "f-ink" }, map);
      svgEl("text", { x: mx(0.5) + 26, y: mz(0) + 17, class: "t-small t-muted", text: "camera, looking up the page" }, map);
      // Panes, with their place in the draw list.
      scene.panes.forEach(function (p, i) {
        svgEl("line", { x1: mx(p.x0), y1: mz(p.z0), x2: mx(p.x1), y2: mz(p.z1), class: p.stroke + " round", "stroke-width": 5 }, map);
        var slot = state.order.indexOf(i) + 1;
        var bx = mx(p.x0) - 14;
        var by = mz(p.z0);
        svgEl("circle", { cx: bx, cy: by, r: 9, class: "f-surface " + p.stroke + " w15" }, map);
        svgEl("text", { x: bx, y: by + 4, class: "t-mono t-small t-strong mid", text: String(slot) }, map);
      });
      map.setAttribute("aria-label", "Top-down map. The camera is at the bottom and the striped wall 10 metres away at the top. " +
        scene.panes.map(function (p, i) {
          var where = p.z0 === p.z1 ? p.z0 + " metres away" : "slanting from " + p.z0 + " to " + p.z1 + " metres";
          return p.name + " pane " + where + ", drawn " + ordinal(state.order.indexOf(i) + 1);
        }).join(". ") + ".");
    }

    function ordinal(n) {
      return ["first", "second", "third", "fourth"][n - 1] || String(n);
    }

    function move(slot, dir) {
      var to = slot + dir;
      if (to < 0 || to >= state.order.length) return;
      var o = state.order.slice();
      var t = o[slot];
      o[slot] = o[to];
      o[to] = t;
      state.order = o;
      draw();
      // The list is rebuilt, so put focus back on the moved pane's button
      // (or its other button at the end of the list) for keyboard users.
      var same = list.querySelector('[data-pane="' + t + '"][data-dir="' + dir + '"]');
      var other = list.querySelector('[data-pane="' + t + '"][data-dir="' + -dir + '"]');
      if (same && !same.disabled) same.focus();
      else if (other) other.focus();
    }

    function drawList(scene) {
      list.replaceChildren();
      state.order.forEach(function (pi, slot) {
        var p = scene.panes[pi];
        var where = p.z0 === p.z1 ? p.z0 + " m" : p.z0 + " to " + p.z1 + " m";
        var up = h("button", { type: "button", class: "btn", "data-pane": pi, "data-dir": -1, "aria-label": "Draw the " + p.name.toLowerCase() + " pane earlier", text: "↑", style: "min-height:30px;padding:0 .6rem" });
        var down = h("button", { type: "button", class: "btn", "data-pane": pi, "data-dir": 1, "aria-label": "Draw the " + p.name.toLowerCase() + " pane later", text: "↓", style: "min-height:30px;padding:0 .6rem" });
        up.disabled = slot === 0;
        down.disabled = slot === state.order.length - 1;
        up.addEventListener("click", function () { move(slot, -1); });
        down.addEventListener("click", function () { move(slot, 1); });
        list.appendChild(h("li", { style: "display:flex;align-items:center;gap:.6rem;padding:.35rem .5rem;border:1px solid var(--line);border-radius:8px;background:var(--surface)" }, [
          h("span", { style: "font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);min-width:1.2rem", text: String(slot + 1) }),
          h("span", { style: "width:.9rem;height:.9rem;border-radius:3px;flex:none;background:var(--" + p.token + ")" }),
          h("span", { style: "flex:1;font-size:var(--fs-sm)" }, [p.name + " pane ", h("span", { style: "color:var(--muted)", text: where })]),
          up, down
        ]));
      });
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function draw() {
      var scene = SCENES[state.scene];
      var res = renderAll(scene, state.order, state.depthWrite, pal);
      paint(vGpu.cv, res.gpu, state.mark ? res.wrong : null, pal.ink);
      paint(vRef.cv, res.ref, null, null);
      paintDepth(vDepth.cv, res.depth, pal);

      var b2f = sameOrder(state.order, sortedOrder(scene, true));
      var f2b = sameOrder(state.order, sortedOrder(scene, false));
      btnBack.setAttribute("aria-pressed", b2f ? "true" : "false");
      btnFront.setAttribute("aria-pressed", f2b ? "true" : "false");
      drawList(scene);
      drawMap(scene);

      var pct = res.glassCount ? (100 * res.wrongCount) / res.glassCount : 0;
      var orderText = b2f ? "Back to front" : f2b ? "Front to back" : "Mixed";
      readout.replaceChildren(
        cell("Draw order", orderText),
        cell("Glass writes depth", state.depthWrite ? "On" : "Off"),
        cell("Wrong pixels", res.wrongCount ? Math.max(1, Math.round(pct)) + "% of the glass" : "None")
      );

      var msg;
      if (state.scene === "cross") {
        msg = "No order is right here. Each pane is nearer on one side of the crossing line, but the GPU blends whichever is drawn second over the other everywhere.";
        if (state.depthWrite) msg += " With depth writes on, the part of the second pane behind the first also fails the depth test and disappears.";
      } else if (!res.wrongCount) {
        msg = "Correct. Each pane is blended over everything behind it, which is already in the picture." +
          (state.depthWrite ? " Depth writes make no difference in this order, because every pane is nearer than the last." : "");
      } else if (state.depthWrite && farAfterNear(scene, state.order)) {
        msg = "Wrong. A pane drawn after a nearer pane fails the depth test where they overlap, so it vanishes behind the glass.";
      } else {
        msg = "Wrong. A far pane drawn after a near one is blended on top of it, so it looks nearer than it is.";
      }
      if (scene.post) msg += " The teal pane stays hidden behind the post in every order: the depth test against opaque surfaces still works.";
      note.textContent = msg;

      vGpu.cv.setAttribute("aria-label", "What the GPU draws. " + orderText + ", depth writes " + (state.depthWrite ? "on" : "off") + ". " +
        (res.wrongCount ? Math.max(1, Math.round(pct)) + " percent of the glass differs from the correct picture." : "It matches the correct picture."));
    }

    document.addEventListener("hb:themechange", function () {
      pal = readPalette();
      draw();
    });

    draw();
    log.debug("ready");
  }

  HB.demos.register("transparency-sorter", init);
})();

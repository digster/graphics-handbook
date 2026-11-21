/*
 * mesh-views.js: chapter 4.1's interactive.
 *
 * Shows one small mesh five ways, the way modelling tools and frame-capture
 * mesh viewers do: wireframe, normals as arrows, UVs (a checker texture plus
 * the flat UV layout beside it), vertex colours, and plainly shaded. Two
 * meshes are offered: a crate (hard edges, 8 corners) and a low-poly rock
 * (smooth, 42 corners). The Normals control switches between hard edges
 * (each face keeps its own normals) and smooth (one averaged normal per
 * corner), and the readout counts how many vertices that costs.
 *
 * The 3D view is a tiny software rasteriser on a canvas, because blending
 * normals, UVs and colours across each triangle is per-pixel work. It reads
 * its colours from the theme tokens and redraws on "hb:themechange". The UV
 * layout is SVG built with diagram classes, so it themes itself.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("mesh-views");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Small vector helpers ---------- */

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* ---------- Meshes ----------
   * Each mesh: pos (unique corner positions), tris (corner indices, counter-
   * clockwise seen from outside), uv (per triangle corner: tris[t][k] -> uv[t][k]),
   * mask (per position, 0..1, the painted vertex colour). */

  function crate() {
    var pos = [];
    var index = {};
    function p(x, y, z) {
      var k = x + "," + y + "," + z;
      if (!(k in index)) { index[k] = pos.length; pos.push([x, y, z]); }
      return index[k];
    }
    // Cross-shaped UV layout: left, front, right, back in the middle row,
    // top above front, bottom below front. Cells are 0.25 wide.
    var faces = [
      { c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], uv: function (q) { return [0.25 + 0.125 * (q[0] + 1), 0.375 + 0.125 * (q[1] + 1)]; } },
      { c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], uv: function (q) { return [0.5 + 0.125 * (1 - q[2]), 0.375 + 0.125 * (q[1] + 1)]; } },
      { c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], uv: function (q) { return [0.75 + 0.125 * (1 - q[0]), 0.375 + 0.125 * (q[1] + 1)]; } },
      { c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], uv: function (q) { return [0.125 * (q[2] + 1), 0.375 + 0.125 * (q[1] + 1)]; } },
      { c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], uv: function (q) { return [0.25 + 0.125 * (q[0] + 1), 0.625 + 0.125 * (1 - q[2])]; } },
      { c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], uv: function (q) { return [0.25 + 0.125 * (q[0] + 1), 0.125 + 0.125 * (q[2] + 1)]; } }
    ];
    var tris = [];
    var uv = [];
    faces.forEach(function (f) {
      var ids = f.c.map(function (q) { return p(q[0], q[1], q[2]); });
      var uvs = f.c.map(f.uv);
      tris.push([ids[0], ids[1], ids[2]], [ids[0], ids[2], ids[3]]);
      uv.push([uvs[0], uvs[1], uvs[2]], [uvs[0], uvs[2], uvs[3]]);
    });
    var mask = pos.map(function (q) { return q[1] < 0 ? 1 : 0; });
    return { name: "Crate", pos: pos, tris: tris, uv: uv, mask: mask, size: 2.25, maskLabel: "dirt" };
  }

  function rock() {
    // Icosahedron, subdivided once: 42 corners, 80 triangles.
    var t = (1 + Math.sqrt(5)) / 2;
    var pos = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
    var tris = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    var mid = {};
    function midpoint(a, b) {
      var k = a < b ? a + "_" + b : b + "_" + a;
      if (!(k in mid)) { mid[k] = pos.length; pos.push(norm(scale(add(pos[a], pos[b]), 0.5))); }
      return mid[k];
    }
    var fine = [];
    tris.forEach(function (tr) {
      var a = midpoint(tr[0], tr[1]), b = midpoint(tr[1], tr[2]), c = midpoint(tr[2], tr[0]);
      fine.push([tr[0], a, c], [tr[1], b, a], [tr[2], c, b], [a, b, c]);
    });
    // Seeded bumps, then squash a little so it reads as a rock.
    var rnd = HB.rng(7);
    pos = pos.map(function (q) {
      var r = 0.86 + 0.26 * rnd();
      return [q[0] * r * 1.08, q[1] * r * 0.78, q[2] * r];
    });
    // Make every triangle counter-clockwise seen from outside.
    fine = fine.map(function (tr) {
      var n = cross(sub(pos[tr[1]], pos[tr[0]]), sub(pos[tr[2]], pos[tr[0]]));
      var c = scale(add(add(pos[tr[0]], pos[tr[1]]), pos[tr[2]]), 1 / 3);
      return dot(n, c) < 0 ? [tr[0], tr[2], tr[1]] : tr;
    });
    // Cylindrical UVs with a seam where u wraps from 1 back to 0.
    var raw = pos.map(function (q) {
      var u = 0.5 + Math.atan2(q[2], q[0]) / (2 * Math.PI);
      var v = 0.5 + Math.asin(Math.max(-1, Math.min(1, q[1] / Math.hypot(q[0], q[1], q[2])))) / Math.PI;
      return [u, v];
    });
    var maxU = 1;
    var uv = fine.map(function (tr) {
      var us = tr.map(function (i) { return raw[i][0]; });
      var wrap = Math.max.apply(null, us) - Math.min.apply(null, us) > 0.5;
      return tr.map(function (i) {
        var u = raw[i][0];
        if (wrap && u < 0.5) u += 1;
        if (u > maxU) maxU = u;
        return [u, raw[i][1]];
      });
    });
    uv = uv.map(function (tri) { return tri.map(function (q) { return [q[0] / maxU, q[1]]; }); });
    var mesh = { name: "Rock", pos: pos, tris: fine, uv: uv, size: 1.45, maskLabel: "moss" };
    var smooth = smoothNormals(mesh);
    mesh.mask = smooth.map(function (n) { return clamp01((n[1] - 0.3) / 0.45); });
    return mesh;
  }

  function faceNormal(mesh, t) {
    var tr = mesh.tris[t];
    return norm(cross(sub(mesh.pos[tr[1]], mesh.pos[tr[0]]), sub(mesh.pos[tr[2]], mesh.pos[tr[0]])));
  }

  /* Area-weighted average of the faces around each corner. */
  function smoothNormals(mesh) {
    var acc = mesh.pos.map(function () { return [0, 0, 0]; });
    mesh.tris.forEach(function (tr) {
      var n = cross(sub(mesh.pos[tr[1]], mesh.pos[tr[0]]), sub(mesh.pos[tr[2]], mesh.pos[tr[0]]));
      tr.forEach(function (i) { acc[i] = add(acc[i], n); });
    });
    return acc.map(norm);
  }

  /* Vertices the GPU would store: one per unique (corner, normal, uv). */
  function countVertices(mesh, hard) {
    var seen = {};
    var n = 0;
    mesh.tris.forEach(function (tr, t) {
      var fn = hard ? faceNormal(mesh, t).map(function (v) { return v.toFixed(3); }).join(",") : "";
      tr.forEach(function (i, k) {
        var key = i + "|" + fn + "|" + mesh.uv[t][k][0].toFixed(4) + "," + mesh.uv[t][k][1].toFixed(4);
        if (!seen[key]) { seen[key] = true; n++; }
      });
    });
    return n;
  }

  /* Edges whose two triangles disagree about the UVs at the shared corners. */
  function seamEdges(mesh) {
    var edges = {};
    mesh.tris.forEach(function (tr, t) {
      for (var k = 0; k < 3; k++) {
        var a = tr[k], b = tr[(k + 1) % 3];
        var key = a < b ? a + "_" + b : b + "_" + a;
        var uva = mesh.uv[t][k], uvb = mesh.uv[t][(k + 1) % 3];
        var sig = a < b ? [uva, uvb] : [uvb, uva];
        (edges[key] = edges[key] || { a: a, b: b, sides: [] }).sides.push({ t: t, sig: sig });
      }
    });
    var seams = [];
    Object.keys(edges).forEach(function (key) {
      var e = edges[key];
      if (e.sides.length < 2) { seams.push(e); return; }
      var s0 = e.sides[0].sig, s1 = e.sides[1].sig;
      var same = Math.abs(s0[0][0] - s1[0][0]) < 1e-4 && Math.abs(s0[0][1] - s1[0][1]) < 1e-4 &&
        Math.abs(s0[1][0] - s1[1][0]) < 1e-4 && Math.abs(s0[1][1] - s1[1][1]) < 1e-4;
      if (!same) seams.push(e);
    });
    return seams;
  }

  /* ---------- Colours from the theme ---------- */

  function rgb(token) {
    var v = HB.demos.color(token) || "#888888";
    var m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) {
      var n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    var r = /rgba?\(([^)]+)\)/.exec(v);
    if (r) return r[1].split(",").slice(0, 3).map(function (s) { return Number(s.trim()); });
    return [136, 136, 136];
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function css(c, alpha) { return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + (alpha === undefined ? 1 : alpha) + ")"; }

  /* ---------- Demo ---------- */

  var VIEWS = [
    { value: "wire", label: "Wire" },
    { value: "normals", label: "Normals" },
    { value: "uv", label: "UVs" },
    { value: "colour", label: "Colour" },
    { value: "shaded", label: "Shaded" }
  ];

  function init(root) {
    var meshes = { crate: crate(), rock: rock() };
    var state = { mesh: "crate", view: "normals", hard: true, yaw: 35 };
    var pal = null;

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Mesh views" }),
      h("span", { class: "demo-hint", text: "Drag the model or use the Turn slider to rotate it." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Mesh", [{ value: "crate", label: "Crate" }, { value: "rock", label: "Rock" }], state.mesh, function (v) {
      state.mesh = v;
      state.hard = v === "crate";
      syncHard();
      render();
    }));
    var viewControl = HB.segmented("View", VIEWS, state.view, function (v) { state.view = v; render(); });
    // Five buttons are close to a phone's width: let them wrap rather than clip.
    viewControl.querySelector(".seg").style.flexWrap = "wrap";
    controls.appendChild(viewControl);
    var hardControl = HB.segmented("Normals", [{ value: "hard", label: "Hard edges" }, { value: "soft", label: "Smooth" }], "hard", function (v) {
      state.hard = v === "hard";
      render();
    });
    controls.appendChild(hardControl);
    var turn = HB.slider("mv-turn", "Turn", { min: 0, max: 359, step: 1, value: state.yaw, format: function (v) { return v + "°"; } }, function (v) {
      state.yaw = v;
      schedule();
    });
    controls.appendChild(turn);
    root.appendChild(controls);
    var turnInput = turn.querySelector("input");
    var turnOut = turn.querySelector("output");

    function syncHard() {
      hardControl.querySelectorAll("button").forEach(function (b) {
        var on = (b.textContent === "Hard edges") === state.hard;
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    var panels = h("div", { class: "demo-panels is-split" });
    var uvPanel = h("div", { class: "demo-panel" });
    var viewPanel = h("div", { class: "demo-panel" });
    panels.append(uvPanel, viewPanel);
    root.appendChild(panels);

    var uvSvg = svgEl("svg", { class: "dg", viewBox: "0 0 240 250", role: "img", "aria-label": "UV layout" });
    uvPanel.append(h("span", { class: "label", text: "UV layout" }), uvSvg);

    var canvas = h("canvas", { role: "img", style: "display:block;width:100%;border-radius:8px;touch-action:none;cursor:grab" });
    viewPanel.append(h("span", { class: "label", text: "3D view" }), canvas);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    var note = h("p", { class: "demo-hint" });
    root.append(readout, note);

    /* ---------- Projection ---------- */

    function camera() {
      var y = (state.yaw * Math.PI) / 180;
      var p = (24 * Math.PI) / 180;
      return {
        right: [Math.cos(y), 0, -Math.sin(y)],
        up: [-Math.sin(y) * Math.sin(p), Math.cos(p), -Math.cos(y) * Math.sin(p)],
        fwd: [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)]
      };
    }

    /* ---------- 3D view ---------- */

    var W = 0, H = 0, ctx = null, image = null, zbuf = null;

    function layout() {
      var cssW = Math.max(240, Math.round(canvas.parentNode.clientWidth || 480));
      var cssH = Math.round(cssW * 0.72);
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.round(cssW * dpr), hh = Math.round(cssH * dpr);
      if (w === W && hh === H) return;
      W = w; H = hh;
      canvas.width = W;
      canvas.height = H;
      canvas.style.height = cssH + "px";
      ctx = canvas.getContext("2d");
      image = ctx.createImageData(W, H);
      zbuf = new Float32Array(W * H);
    }

    function drawView() {
      if (!ctx) return;
      var mesh = meshes[state.mesh];
      var cam = camera();
      var s = (Math.min(W, H) * 0.5) / mesh.size;
      var cx = W / 2, cy = H / 2 + H * 0.03;
      var smooth = smoothNormals(mesh);
      var L = norm([-0.45, 0.6, 0.66]); // light in view space: upper left, towards the viewer

      function view(p) { return [dot(p, cam.right), dot(p, cam.up), dot(p, cam.fwd)]; }
      function screen(v) { return [cx + v[0] * s, cy - v[1] * s]; }

      var render = state.view === "shaded" || state.view === "colour";
      var bg = render ? pal.bufLo : pal.sunken;
      var data = image.data;
      for (var i = 0; i < W * H; i++) {
        data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255;
        zbuf[i] = -1e9;
      }

      var vpos = mesh.pos.map(view);
      var tris = mesh.tris.map(function (tr, t) {
        var a = vpos[tr[0]], b = vpos[tr[1]], c = vpos[tr[2]];
        var front = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
        var fn = faceNormal(mesh, t);
        var nrm = tr.map(function (i) { return view(state.hard ? fn : smooth[i]); });
        return { tr: tr, t: t, front: front, v: [a, b, c], scr: [screen(a), screen(b), screen(c)], nrm: nrm, fn: view(fn) };
      });

      // Rasterise front faces: interpolate normal, uv and mask per pixel.
      tris.forEach(function (T) {
        if (!T.front) return;
        var p0 = T.scr[0], p1 = T.scr[1], p2 = T.scr[2];
        var area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
        if (Math.abs(area) < 1e-6) return;
        var minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
        var maxX = Math.min(W - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
        var minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
        var maxY = Math.min(H - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
        var uv = mesh.uv[T.t];
        var mk = T.tr.map(function (i) { return mesh.mask[i]; });
        for (var y = minY; y <= maxY; y++) {
          for (var x = minX; x <= maxX; x++) {
            var px = x + 0.5, py = y + 0.5;
            var w0 = ((p1[0] - px) * (p2[1] - py) - (p1[1] - py) * (p2[0] - px)) / area;
            var w1 = ((p2[0] - px) * (p0[1] - py) - (p2[1] - py) * (p0[0] - px)) / area;
            var w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            var z = w0 * T.v[0][2] + w1 * T.v[1][2] + w2 * T.v[2][2];
            var idx = y * W + x;
            if (z <= zbuf[idx]) continue;
            zbuf[idx] = z;
            var n = norm([
              w0 * T.nrm[0][0] + w1 * T.nrm[1][0] + w2 * T.nrm[2][0],
              w0 * T.nrm[0][1] + w1 * T.nrm[1][1] + w2 * T.nrm[2][1],
              w0 * T.nrm[0][2] + w1 * T.nrm[1][2] + w2 * T.nrm[2][2]
            ]);
            var lit = Math.max(0, dot(n, L));
            var col;
            if (state.view === "shaded") {
              col = mix(pal.shade, pal.bufHi, 0.16 + 0.84 * lit);
            } else if (state.view === "colour") {
              var m = w0 * mk[0] + w1 * mk[1] + w2 * mk[2];
              col = mix(pal.shade, mix(pal.bufHi, pal.geo, m), 0.35 + 0.65 * lit);
            } else if (state.view === "uv") {
              var u = w0 * uv[0][0] + w1 * uv[1][0] + w2 * uv[2][0];
              var v = w0 * uv[0][1] + w1 * uv[1][1] + w2 * uv[2][1];
              var check = (Math.floor(u * 16) + Math.floor(v * 16)) % 2 === 0;
              col = mix(pal.sunken, check ? pal.surface : pal.lineStrong, 0.45 + 0.55 * lit);
            } else {
              col = mix(pal.sunken, pal.faceHi, 0.3 + 0.7 * lit);
            }
            var o = idx * 4;
            data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2];
          }
        }
      });
      ctx.putImageData(image, 0, 0);

      var lw = Math.max(1, Math.min(W, H) / 360);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      function edge(a, b, colour, width, dash) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        ctx.setLineDash(dash || []);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }

      if (state.view === "wire") {
        tris.forEach(function (T) {
          if (T.front) return;
          for (var k = 0; k < 3; k++) edge(T.scr[k], T.scr[(k + 1) % 3], css(pal.muted, 0.55), lw, [4 * lw, 4 * lw]);
        });
        tris.forEach(function (T) {
          if (!T.front) return;
          for (var k = 0; k < 3; k++) edge(T.scr[k], T.scr[(k + 1) % 3], css(pal.ink), lw * 1.4);
        });
      } else {
        // Faint triangle edges so the mesh structure stays readable.
        tris.forEach(function (T) {
          if (!T.front) return;
          for (var k = 0; k < 3; k++) edge(T.scr[k], T.scr[(k + 1) % 3], css(render ? pal.bufLo : pal.ink, render ? 0.22 : 0.18), lw);
        });
      }

      if (state.view === "uv") {
        var frontTri = {};
        tris.forEach(function (T) { frontTri[T.t] = T.front; });
        seamEdges(mesh).forEach(function (e) {
          var visible = e.sides.some(function (sd) { return frontTri[sd.t]; });
          if (!visible) return;
          edge(screen(vpos[e.a]), screen(vpos[e.b]), css(pal.accent), lw * 3);
        });
      }

      if (state.view === "normals" || state.view === "wire" || state.view === "colour") {
        var dotSeen = {};
        tris.forEach(function (T) {
          if (!T.front) return;
          T.tr.forEach(function (i, k) {
            if (dotSeen[i]) return;
            dotSeen[i] = true;
            var p = T.scr[k];
            ctx.beginPath();
            ctx.arc(p[0], p[1], lw * (state.view === "colour" ? 4.2 : 2.6), 0, Math.PI * 2);
            if (state.view === "colour") {
              ctx.fillStyle = css(mix(pal.bufHi, pal.geo, mesh.mask[i]));
              ctx.fill();
              ctx.strokeStyle = css(pal.bufLo);
              ctx.lineWidth = lw;
              ctx.setLineDash([]);
              ctx.stroke();
            } else {
              ctx.fillStyle = css(pal.ink);
              ctx.fill();
            }
          });
        });
      }

      if (state.view === "normals") {
        var len = (state.mesh === "crate" ? 0.55 : 0.32) * s;
        var drawn = {};
        tris.forEach(function (T) {
          if (!T.front) return;
          var centre = scale(add(add(T.v[0], T.v[1]), T.v[2]), 1 / 3);
          T.tr.forEach(function (i, k) {
            // One arrow per stored vertex: per corner and face with hard
            // edges, per corner when smooth.
            var key = state.hard ? i + "_" + T.fn.map(function (v) { return v.toFixed(2); }).join(",") : String(i);
            if (drawn[key]) return;
            drawn[key] = true;
            // Hard edges: the normals meeting at one corner belong to
            // different faces, so each starts slightly inside its own face.
            var from = state.hard ? add(T.v[k], scale(sub(centre, T.v[k]), 0.16)) : T.v[k];
            var n = T.nrm[k];
            var a = screen(from);
            var b = screen(add(from, scale(n, len / s)));
            edge(a, b, css(pal.accent), lw * 2);
            var ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
            var hs = lw * 6;
            ctx.fillStyle = css(pal.accent);
            ctx.beginPath();
            ctx.moveTo(b[0], b[1]);
            ctx.lineTo(b[0] - hs * Math.cos(ang - 0.45), b[1] - hs * Math.sin(ang - 0.45));
            ctx.lineTo(b[0] - hs * Math.cos(ang + 0.45), b[1] - hs * Math.sin(ang + 0.45));
            ctx.closePath();
            ctx.fill();
          });
        });
      }
      ctx.setLineDash([]);
    }

    /* ---------- UV layout ---------- */

    function drawUV() {
      var mesh = meshes[state.mesh];
      HB.svg.clear(uvSvg);
      var x0 = 30, y0 = 10, size = 200;
      function ux(u) { return (x0 + u * size).toFixed(1); }
      function vy(v) { return (y0 + (1 - v) * size).toFixed(1); }
      svgEl("rect", { class: "f-sunken s-strong", x: x0, y: y0, width: size, height: size }, uvSvg);
      mesh.uv.forEach(function (tri) {
        svgEl("polygon", { class: "f-surface s-line", points: tri.map(function (q) { return ux(q[0]) + "," + vy(q[1]); }).join(" ") }, uvSvg);
      });
      // Seam edges: draw each side of each seam where it lies in the layout.
      seamEdges(mesh).forEach(function (e) {
        e.sides.forEach(function (sd) {
          var sig = sd.sig;
          svgEl("line", { class: "s-acc w2", x1: ux(sig[0][0]), y1: vy(sig[0][1]), x2: ux(sig[1][0]), y2: vy(sig[1][1]) }, uvSvg);
        });
      });
      svgEl("text", { class: "t-small t-muted", x: x0, y: y0 + size + 16, text: "U →" }, uvSvg);
      svgEl("text", { class: "t-small t-muted end", x: x0 - 6, y: y0 + 10, text: "V ↑" }, uvSvg);
      svgEl("text", { class: "t-small t-acc end", x: x0 + size, y: y0 + size + 16, text: "blue: seams" }, uvSvg);
    }

    /* ---------- Readout ---------- */

    function renderReadout() {
      var mesh = meshes[state.mesh];
      var verts = countVertices(mesh, state.hard);
      readout.replaceChildren(
        h("span", { class: "r" }, [h("span", { class: "label", text: "Triangles" }), h("span", { class: "v", text: String(mesh.tris.length) })]),
        h("span", { class: "r" }, [h("span", { class: "label", text: "Corners" }), h("span", { class: "v", text: String(mesh.pos.length) })]),
        h("span", { class: "r" }, [h("span", { class: "label", text: "Vertices stored" }), h("span", { class: "v", text: String(verts) })]),
        h("span", { class: "r" }, [h("span", { class: "label", text: "Seam edges" }), h("span", { class: "v", text: String(seamEdges(mesh).length) })])
      );
      var why = state.hard
        ? "Hard edges: every face keeps its own normals, so each corner is stored once per face that meets there, and again wherever a UV seam cuts through it."
        : "Smooth: corners share one averaged normal, so only UV seams split them. " + (state.mesh === "crate" ? "Look at the shaded crate: its edges have gone soft and blobby." : "The shading flows across the low-poly surface.");
      var viewNote = {
        wire: "Wireframe: the triangles themselves. Dashed lines are edges on the far side.",
        normals: "Normals: the direction each vertex says the surface faces. Lighting uses these, not the triangles.",
        uv: "UVs: a checker texture shows how the flat layout wraps the surface. Blue lines are seams.",
        colour: "Vertex colour: a " + mesh.maskLabel + " mask painted per corner and blended across each triangle.",
        shaded: "Shaded: simple lighting from the upper left, using the normals."
      }[state.view];
      note.textContent = viewNote + " " + why;
      canvas.setAttribute("aria-label", mesh.name + ", " + state.view + " view, " + (state.hard ? "hard edges" : "smooth normals") + ", turned " + state.yaw + " degrees. " + mesh.tris.length + " triangles, " + mesh.pos.length + " corners, " + verts + " vertices stored.");
    }

    /* ---------- Rendering and events ---------- */

    function render() {
      layout();
      drawView();
      drawUV();
      renderReadout();
      log.debug("render", state.mesh, state.view, state.hard ? "hard" : "smooth", state.yaw);
    }

    var pending = false;
    function schedule() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        drawView();
        renderReadout();
      });
    }

    var dragging = null;
    canvas.addEventListener("pointerdown", function (event) {
      dragging = { x: event.clientX, yaw: state.yaw };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
    });
    canvas.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      var yaw = Math.round(dragging.yaw - (event.clientX - dragging.x) * 0.6);
      state.yaw = ((yaw % 360) + 360) % 360;
      turnInput.value = String(state.yaw);
      turnOut.textContent = state.yaw + "°";
      schedule();
    });
    function stop(event) {
      if (!dragging) return;
      dragging = null;
      canvas.style.cursor = "grab";
      try { canvas.releasePointerCapture(event.pointerId); } catch (err) { /* already released */ }
    }
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);

    function readPalette() {
      pal = {
        ink: rgb("ink"), muted: rgb("muted"), surface: rgb("surface"), sunken: rgb("sunken"),
        lineStrong: rgb("line-strong"), accent: rgb("accent"), geo: rgb("geo"), shade: rgb("shade"),
        bufHi: rgb("buffer-hi"), bufLo: rgb("buffer-lo")
      };
      // Lit faces must be lighter than the background in both themes: white
      // on the light theme's grey, the strong line colour on the dark theme.
      var lum = (0.2126 * pal.sunken[0] + 0.7152 * pal.sunken[1] + 0.0722 * pal.sunken[2]) / 255;
      pal.faceHi = lum < 0.5 ? pal.lineStrong : pal.surface;
    }
    readPalette();
    document.addEventListener("hb:themechange", function () {
      // The new tokens apply on the next style pass.
      window.requestAnimationFrame(function () { readPalette(); render(); });
    });
    if ("ResizeObserver" in window) {
      var lastWidth = 0;
      new ResizeObserver(function () {
        var w = canvas.parentNode.clientWidth;
        if (Math.abs(w - lastWidth) < 2) return;
        lastWidth = w;
        render();
      }).observe(viewPanel);
    }
    render();
  }

  HB.demos.register("mesh-views", init);
})();

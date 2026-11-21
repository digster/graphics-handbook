/*
 * space-stepper.js: chapter 3.4's interactive.
 *
 * One small house is carried through the chain of coordinate spaces, one
 * transform per click:
 *
 *   0 object space   the vertex-buffer numbers, around the house's own origin
 *   1 world space    after the model matrix M (turn 30°, move to 3, 0, -6)
 *   2 view space     after the view matrix V (camera at the origin, looking -Z)
 *   3 clip / NDC     after the projection matrix P and the divide by w
 *   4 screen space   after the viewport transform, in 1920 × 1080 pixels
 *
 * Everything is real 3D maths on 4×4 matrices; the picture of stages 0 to 3
 * is drawn by a fixed "observer" looking at that stage's space from above
 * and to the side, so the current space's axes always look the same and the
 * reader sees what moved. The camera frustum (near 1 m, far 16 m, kept short
 * so it fits) is drawn wherever it exists.
 *
 * Conventions, stated in the UI: Y up, right-handed, metres, the camera
 * looks along -Z in view space (as in Godot and OpenGL), and depth in NDC
 * runs from 0 at the near plane to 1 at the far plane (as in Direct3D,
 * Vulkan and Metal).
 *
 * One corner of the house (front, right, top of the wall) is tracked: its
 * coordinates in every space are listed in a table beside the picture.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("space-stepper");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- 4×4 matrices, row-major, acting on column vectors ---------- */

  function mul(a, b) {
    var r = new Array(16);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
        r[i * 4 + j] = s;
      }
    }
    return r;
  }
  function apply(m, p) {
    var w = p.w === undefined ? 1 : p.w;
    return {
      x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3] * w,
      y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7] * w,
      z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11] * w,
      w: m[12] * p.x + m[13] * p.y + m[14] * p.z + m[15] * w
    };
  }
  function translate(x, y, z) { return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]; }
  function rotateY(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
  }
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
  function norm(a) { var l = Math.sqrt(dot(a, a)); return { x: a.x / l, y: a.y / l, z: a.z / l }; }

  /* Right-handed look-at: the camera's +Z points backwards, so it looks along -Z. */
  function lookAt(eye, target, up) {
    var zA = norm(sub(eye, target));
    var xA = norm(cross(up, zA));
    var yA = cross(zA, xA);
    return {
      m: [xA.x, xA.y, xA.z, -dot(xA, eye), yA.x, yA.y, yA.z, -dot(yA, eye), zA.x, zA.y, zA.z, -dot(zA, eye), 0, 0, 0, 1],
      x: xA, y: yA, z: zA
    };
  }
  /* Depth 0 at the near plane, 1 at the far plane (Direct3D, Vulkan, Metal). */
  function perspective(fovY, aspect, n, f) {
    var t = 1 / Math.tan(fovY / 2);
    return [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, f / (n - f), (n * f) / (n - f), 0, 0, -1, 0];
  }
  function orthographic(w, hgt, n, f) {
    return [2 / w, 0, 0, 0, 0, 2 / hgt, 0, 0, 0, 0, 1 / (n - f), n / (n - f), 0, 0, 0, 1];
  }

  /* ---------- The scene ---------- */

  var HOUSE = [
    { x: -1, y: 0, z: -1 }, { x: 1, y: 0, z: -1 }, { x: 1, y: 0, z: 1 }, { x: -1, y: 0, z: 1 },
    { x: -1, y: 1.6, z: -1 }, { x: 1, y: 1.6, z: -1 }, { x: 1, y: 1.6, z: 1 }, { x: -1, y: 1.6, z: 1 },
    { x: -1, y: 2.6, z: 0 }, { x: 1, y: 2.6, z: 0 }
  ];
  var FACES = [
    { v: [3, 2, 6, 7], cls: "f-geo-soft s-geo" },      // front wall
    { v: [0, 1, 5, 4], cls: "f-geo-soft s-geo" },      // back wall
    { v: [0, 3, 7, 8, 4], cls: "f-geo-soft s-geo" },   // left wall
    { v: [1, 2, 6, 9, 5], cls: "f-geo-soft s-geo" },   // right wall
    { v: [7, 6, 9, 8], cls: "f-surface s-geo" },       // roof, front slope
    { v: [4, 5, 9, 8], cls: "f-surface s-geo" }        // roof, back slope
  ];
  var DOOR = [{ x: -0.3, y: 0, z: 1 }, { x: 0.3, y: 0, z: 1 }, { x: 0.3, y: 1.1, z: 1 }, { x: -0.3, y: 1.1, z: 1 }];
  var TRACK = 6; // front, right, top of the wall

  var MODEL = mul(translate(3, 0, -6), rotateY(Math.PI / 6));
  var EYE = { x: -2, y: 1.7, z: 3 };
  var TARGET = { x: 3, y: 1.2, z: -6 };
  var VIEWM = lookAt(EYE, TARGET, { x: 0, y: 1, z: 0 });
  var NEAR = 1;
  var FAR = 16;
  var ASPECT = 16 / 9;
  var SCREEN = { w: 1920, h: 1080 };
  var TARGET_DIST = Math.sqrt(dot(sub(TARGET, EYE), sub(TARGET, EYE)));

  var STAGES = [
    { key: "object", name: "Object space", applied: "nothing yet", next: "Apply the model matrix M" },
    { key: "world", name: "World space", applied: "the model matrix M", next: "Apply the view matrix V" },
    { key: "view", name: "View space", applied: "the view matrix V", next: "Apply the projection P, then ÷ w" },
    { key: "clip", name: "Clip space, after ÷ w (NDC)", applied: "the projection matrix P and the divide by w", next: "Apply the viewport transform" },
    { key: "screen", name: "Screen space", applied: "the viewport transform", next: "" }
  ];

  /* ---------- Drawing frame ---------- */

  var VIEW = { w: 600, h: 400 };
  var FIT = { x0: 24, y0: 44, x1: 576, y1: 386 };
  var YAW = -35 * Math.PI / 180;
  var PITCH = 26 * Math.PI / 180;

  /* The fixed observer: turn about Y, tilt about X, drop depth (orthographic). */
  function observe(p) {
    var cy = Math.cos(YAW), sy = Math.sin(YAW), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    var x1 = cy * p.x + sy * p.z;
    var z1 = -sy * p.x + cy * p.z;
    return { x: x1, y: -(cp * p.y - sp * z1), d: sp * p.y + cp * z1 };
  }

  function fmt(n, d) {
    var s = Number(n).toFixed(d === undefined ? 2 : d);
    if (Number(s) === 0) return s.replace("-", "");
    return s.charAt(0) === "-" ? "−" + s.slice(1) : s;
  }
  function triple(p, d) { return "(" + fmt(p.x, d) + ", " + fmt(p.y, d) + ", " + fmt(p.z, d) + ")"; }

  function init(root) {
    var state = { stage: 1, persp: true, fov: 50 };
    var anim = null;

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Space stepper" }),
      h("span", { class: "demo-hint", text: "Apply one transform per click and watch the house, the camera and the axes." })
    ]));

    /* Controls */
    var controls = h("div", { class: "demo-controls" });
    var backBtn = h("button", { type: "button", class: "btn", text: "← Back" });
    var nextBtn = h("button", { type: "button", class: "btn is-primary", text: "" });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Step" }),
      h("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap" }, [backBtn, nextBtn])
    ]));
    var stageSeg = HB.segmented("Space", STAGES.map(function (s, i) {
      return { value: i, label: ["Object", "World", "View", "Clip", "Screen"][i] };
    }), state.stage, function (v) { goTo(v); });
    controls.appendChild(stageSeg);
    controls.appendChild(HB.segmented("Projection", [
      { value: true, label: "Perspective" }, { value: false, label: "Orthographic" }
    ], state.persp, function (v) { state.persp = v; render(false); }));
    controls.appendChild(HB.slider("ss-fov", "Vertical field of view", {
      min: 20, max: 100, step: 1, value: state.fov, format: function (v) { return v + "°"; }
    }, function (v) { state.fov = v; render(false); }));
    root.appendChild(controls);

    /* Explanation panel and picture side by side on wide screens. */
    var panels = h("div", { class: "demo-panels is-split" });
    var textPanel = h("div", { class: "demo-panel", "aria-live": "polite" });
    var stagePanel = h("div", { class: "demo-panel" });
    panels.appendChild(textPanel);
    panels.appendChild(stagePanel);
    root.appendChild(panels);

    var stageWrap = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-mid",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "img",
      "aria-label": "A small house drawn in the current coordinate space, with that space's axes and, from world space on, the camera's view frustum."
    });
    stageWrap.appendChild(svg);
    stagePanel.appendChild(stageWrap);

    var defs = svgEl("defs", null, svg);
    [["ss-arr", "f-muted"], ["ss-arr-a", "f-acc"], ["ss-arr-k", "f-ink"]].forEach(function (m) {
      var mk = svgEl("marker", { id: m[0], viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
      svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: m[1] }, mk);
    });
    var clipFrame = svgEl("clipPath", { id: "ss-clip-frame" }, defs);
    svgEl("rect", { x: 6, y: 34, width: VIEW.w - 12, height: VIEW.h - 40 }, clipFrame);
    var clipScreen = svgEl("clipPath", { id: "ss-clip-screen" }, defs);
    var clipRect = svgEl("rect", { x: 0, y: 0, width: 1, height: 1 }, clipScreen);

    var layerBack = svgEl("g", { "clip-path": "url(#ss-clip-frame)" }, svg);
    var layerScene = svgEl("g", null, svg);
    var layerFront = svgEl("g", null, svg);

    // The tracked corner in every space; the current space is highlighted.
    var tableBody = h("tbody");
    root.appendChild(h("div", { class: "table-scroll" }, [
      h("table", { class: "byte-table" }, [
        h("caption", { class: "visually-hidden", text: "The tracked corner of the house in every space" }),
        h("thead", null, [h("tr", null, ["Space", "x", "y", "z", "w", ""].map(function (t) {
          return h("th", { scope: "col", text: t });
        }))]),
        tableBody
      ])
    ]));

    var readout = h("div", { class: "demo-readout" });
    root.appendChild(readout);

    /* ---------- The maths for one state ---------- */

    function projection() {
      var fov = state.fov * Math.PI / 180;
      if (state.persp) return perspective(fov, ASPECT, NEAR, FAR);
      var hgt = 2 * TARGET_DIST * Math.tan(fov / 2); // same framing at the house
      return orthographic(hgt * ASPECT, hgt, NEAR, FAR);
    }

    /* Frustum corners in view space: near rectangle then far rectangle. */
    function frustumView() {
      var fov = state.fov * Math.PI / 180;
      var out = [];
      [NEAR, FAR].forEach(function (d) {
        var hh = state.persp ? d * Math.tan(fov / 2) : TARGET_DIST * Math.tan(fov / 2);
        var hw = hh * ASPECT;
        out.push({ x: -hw, y: -hh, z: -d }, { x: hw, y: -hh, z: -d }, { x: hw, y: hh, z: -d }, { x: -hw, y: hh, z: -d });
      });
      return out;
    }

    function viewToWorld(p) {
      var v = VIEWM;
      return {
        x: EYE.x + p.x * v.x.x + p.y * v.y.x + p.z * v.z.x,
        y: EYE.y + p.x * v.x.y + p.y * v.y.y + p.z * v.z.y,
        z: EYE.z + p.x * v.x.z + p.y * v.y.z + p.z * v.z.z
      };
    }

    /* Every space's coordinates for a list of object-space points. */
    function chain(points) {
      var P = projection();
      return points.map(function (p) {
        var world = apply(MODEL, p);
        var view = apply(VIEWM.m, world);
        var clip = apply(P, view);
        var ndc = { x: clip.x / clip.w, y: clip.y / clip.w, z: clip.z / clip.w };
        var scr = { x: (ndc.x + 1) / 2 * SCREEN.w, y: (1 - ndc.y) / 2 * SCREEN.h, z: ndc.z };
        return { object: p, world: world, view: view, clip: clip, ndc: ndc, screen: scr };
      });
    }

    /* NDC drawn as a 3D box: x and y as they are, depth stretched to 2 and
       pointing away along -Z so it lines up with view space. */
    function ndcTo3D(n) { return { x: n.x, y: n.y, z: -2 * n.z }; }

    /* ---------- Geometry for one stage, in SVG units ---------- */

    function geometry(stage) {
      var houseC = chain(HOUSE);
      var doorC = chain(DOOR);
      var g = { stage: stage, house: [], door: [], frus: null, cam: null, extras: [] };

      if (stage === 4) {
        // Screen: a 16:9 rectangle fitted into the frame.
        var sw = FIT.x1 - FIT.x0 - 40;
        var sh = sw * 9 / 16;
        var ox = FIT.x0 + 20;
        var oy = FIT.y0 + (FIT.y1 - FIT.y0 - sh) / 2 + 6;
        var k = sw / SCREEN.w;
        function sp(c) { return { x: ox + c.screen.x * k, y: oy + c.screen.y * k, d: -c.ndc.z }; }
        g.house = houseC.map(sp);
        g.door = doorC.map(sp);
        g.screenRect = { x: ox, y: oy, w: sw, h: sh, k: k };
        var corners = [{ x: ox, y: oy + sh }, { x: ox + sw, y: oy + sh }, { x: ox + sw, y: oy }, { x: ox, y: oy }];
        g.frus = corners.concat(corners).map(function (c) { return { x: c.x, y: c.y, d: 0 }; });
        g.trackInfo = houseC[TRACK];
        return g;
      }

      var space = ["object", "world", "view", "ndc"][stage];
      function to3(c) { return stage === 3 ? ndcTo3D(c.ndc) : c[space]; }
      var raw = { house: houseC.map(to3), door: doorC.map(to3) };

      // Frustum and camera, from world space on.
      if (stage >= 1) {
        var fv = frustumView();
        if (stage === 1) raw.frus = fv.map(viewToWorld);
        else if (stage === 2) raw.frus = fv;
        else {
          var P = projection();
          raw.frus = fv.map(function (p) {
            var c = apply(P, p);
            return ndcTo3D({ x: c.x / c.w, y: c.y / c.w, z: c.z / c.w });
          });
        }
        raw.cam = stage === 1 ? EYE : stage === 2 ? { x: 0, y: 0, z: 0 } : null;
      }

      // Axes at this space's origin, and a ground grid where it helps.
      var axisLen = stage === 0 ? 1.6 : stage === 3 ? 1.25 : 2.2;
      raw.axes = [
        { to: { x: axisLen, y: 0, z: 0 }, label: stage === 3 ? "x" : "X" },
        { to: { x: 0, y: axisLen, z: 0 }, label: stage === 3 ? "y" : "Y" },
        { to: { x: 0, y: 0, z: stage === 3 ? -axisLen : axisLen }, label: stage === 3 ? "depth" : "Z" }
      ];
      raw.grid = [];
      if (stage <= 2) {
        var lim = stage === 0 ? [-2, 2, -2, 2, 1] : [-4, 7, -9, 4, 1];
        for (var gx = lim[0]; gx <= lim[1]; gx += lim[4]) raw.grid.push([{ x: gx, y: 0, z: lim[2] }, { x: gx, y: 0, z: lim[3] }]);
        for (var gz = lim[2]; gz <= lim[3]; gz += lim[4]) raw.grid.push([{ x: lim[0], y: 0, z: gz }, { x: lim[1], y: 0, z: gz }]);
        if (stage === 2) {
          raw.grid = raw.grid.map(function (seg) {
            return seg.map(function (p) { return apply(VIEWM.m, p); });
          });
        }
      }
      // The house's own axes ride along with it into world space.
      if (stage === 1) {
        raw.localAxes = [{ x: 1.3, y: 0, z: 0 }, { x: 0, y: 1.3, z: 0 }, { x: 0, y: 0, z: 1.3 }].map(function (p) {
          return apply(MODEL, p);
        });
        raw.localOrigin = apply(MODEL, { x: 0, y: 0, z: 0 });
      }

      // Project everything with the observer and fit it into the frame.
      // Fit the picture to the house, camera, axes, grid and near plane. In
      // world and view space the far end of the frustum is allowed to run
      // off the frame (it is clipped), or the house would be a speck.
      var all = [];
      function o(p) { var q = observe(p); all.push(q); return q; }
      function oNoFit(p) { return observe(p); }
      g.house = raw.house.map(o);
      g.door = raw.door.map(o);
      if (raw.frus) {
        g.frus = raw.frus.map(function (p, i) { return stage === 3 || i < 4 ? o(p) : oNoFit(p); });
      }
      if (raw.cam) g.cam = o(raw.cam);
      g.origin = o({ x: 0, y: 0, z: 0 });
      g.axes = raw.axes.map(function (a) { return { to: o(a.to), label: a.label }; });
      g.grid = raw.grid.map(function (seg) { return seg.map(o); });
      if (raw.localAxes) {
        g.localAxes = raw.localAxes.map(o);
        g.localOrigin = o(raw.localOrigin);
      }
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      all.forEach(function (p) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
      var s = Math.min((FIT.x1 - FIT.x0) / (maxX - minX || 1), (FIT.y1 - FIT.y0) / (maxY - minY || 1));
      var cx = (FIT.x0 + FIT.x1) / 2 - s * (minX + maxX) / 2;
      var cy = (FIT.y0 + FIT.y1) / 2 - s * (minY + maxY) / 2;
      function f(p) { return { x: cx + p.x * s, y: cy + p.y * s, d: p.d }; }
      g.house = g.house.map(f);
      g.door = g.door.map(f);
      if (g.frus) g.frus = g.frus.map(f);
      if (g.cam) g.cam = f(g.cam);
      g.origin = f(g.origin);
      g.axes = g.axes.map(function (a) { return { to: f(a.to), label: a.label }; });
      g.grid = g.grid.map(function (seg) { return seg.map(f); });
      if (g.localAxes) {
        g.localAxes = g.localAxes.map(f);
        g.localOrigin = f(g.localOrigin);
      }
      g.trackInfo = houseC[TRACK];
      return g;
    }

    /* ---------- Painting ---------- */

    function pts(list) {
      return list.map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ");
    }

    function paintScene(g, settled) {
      HB.svg.clear(layerBack);
      HB.svg.clear(layerScene);
      HB.svg.clear(layerFront);
      var st = g.stage;

      svgEl("text", { x: 16, y: 24, class: "t-caps", text: STAGES[st].name.toUpperCase() }, layerFront);

      if (settled && g.grid) {
        g.grid.forEach(function (seg) {
          svgEl("line", { x1: seg[0].x, y1: seg[0].y, x2: seg[1].x, y2: seg[1].y, class: "s-line" }, layerBack);
        });
      }

      // Screen rectangle, under the house.
      if (g.screenRect) {
        var r = g.screenRect;
        svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h, class: "f-sunken s-acc w2" }, layerBack);
        clipRect.setAttribute("x", r.x);
        clipRect.setAttribute("y", r.y);
        clipRect.setAttribute("width", r.w);
        clipRect.setAttribute("height", r.h);
      }

      // Frustum: near rectangle filled, far rectangle and side edges outlined.
      if (g.frus && !(g.screenRect && settled)) {
        var n = g.frus.slice(0, 4);
        var fa = g.frus.slice(4, 8);
        svgEl("polygon", { points: pts(fa), class: "s-acc dash" }, layerBack);
        for (var i = 0; i < 4; i++) {
          svgEl("line", { x1: n[i].x, y1: n[i].y, x2: fa[i].x, y2: fa[i].y, class: "s-acc dash" }, layerBack);
        }
        if (g.cam) {
          for (var j = 0; j < 4; j++) {
            svgEl("line", { x1: g.cam.x, y1: g.cam.y, x2: n[j].x, y2: n[j].y, class: "s-acc", "stroke-opacity": 0.5 }, layerBack);
          }
        }
        svgEl("polygon", { points: pts(n), class: "f-acc-soft s-acc", "fill-opacity": 0.7 }, layerBack);
        if (settled) {
          var nl = n[3].y < n[2].y ? n[3] : n[2];
          var fl = fa[2].x > fa[3].x ? fa[2] : fa[3];
          svgEl("text", { x: nl.x, y: nl.y - 6, class: "t-small t-acc mid", text: st === 3 ? "near: depth 0" : "near plane" }, layerFront);
          // The far end may run off the frame in world and view space.
          if (fl.x > 90 && fl.x < VIEW.w - 4 && fl.y > 44 && fl.y < VIEW.h - 4) {
            svgEl("text", { x: fl.x - 4, y: fl.y - 6, class: "t-small t-acc end", text: st === 3 ? "far: depth 1" : "far plane" }, layerFront);
          }
        }
      }

      // Axes of the current space.
      if (settled && g.axes) {
        g.axes.forEach(function (a) {
          svgEl("line", { x1: g.origin.x, y1: g.origin.y, x2: a.to.x, y2: a.to.y, class: "s-ink w15", "marker-end": "url(#ss-arr-k)" }, layerFront);
          var dx = a.to.x - g.origin.x, dy = a.to.y - g.origin.y;
          var l = Math.sqrt(dx * dx + dy * dy) || 1;
          svgEl("text", { x: a.to.x + dx / l * 12, y: a.to.y + dy / l * 12 + 4, class: "t-mono t-small t-strong mid", text: a.label }, layerFront);
        });
        svgEl("circle", { cx: g.origin.x, cy: g.origin.y, r: 3, class: "f-ink" }, layerFront);
      }
      if (settled && g.localAxes) {
        g.localAxes.forEach(function (p) {
          svgEl("line", { x1: g.localOrigin.x, y1: g.localOrigin.y, x2: p.x, y2: p.y, class: "s-muted w15 dash", "marker-end": "url(#ss-arr)" }, layerFront);
        });
      }
      if (settled && g.screenRect) {
        var sr = g.screenRect;
        svgEl("text", { x: sr.x + 4, y: sr.y - 6, class: "t-mono t-small", text: "(0, 0)" }, layerFront);
        svgEl("text", { x: sr.x + sr.w, y: sr.y + sr.h + 16, class: "t-mono t-small end", text: "(1920, 1080)" }, layerFront);
        svgEl("line", { x1: sr.x, y1: sr.y - 20, x2: sr.x + 60, y2: sr.y - 20, class: "s-ink w15", "marker-end": "url(#ss-arr-k)" }, layerFront);
        svgEl("text", { x: sr.x + 66, y: sr.y - 16, class: "t-small", text: "x pixels" }, layerFront);
        svgEl("text", { x: sr.x - 6, y: sr.y + 40, class: "t-small end", text: "y" }, layerFront);
        svgEl("text", { x: sr.x - 6, y: sr.y + 54, class: "t-small end", text: "down" }, layerFront);
      }

      // The house: faces sorted far to near (painter's algorithm).
      var parent = g.screenRect ? svgEl("g", { "clip-path": "url(#ss-clip-screen)" }, layerScene) : layerScene;
      var faces = FACES.map(function (f) {
        var d = 0;
        f.v.forEach(function (k) { d += g.house[k].d; });
        return { f: f, d: d / f.v.length };
      }).sort(function (a, b) { return a.d - b.d; });
      faces.forEach(function (item) {
        var poly = item.f.v.map(function (k) { return g.house[k]; });
        svgEl("polygon", { points: pts(poly), class: item.f.cls + " w15", "stroke-linejoin": "round" }, parent);
        // The door sits on the front wall: draw it right after that wall.
        if (item.f === FACES[0]) svgEl("polygon", { points: pts(g.door), class: "f-geo" }, parent);
      });

      // Camera marker.
      if (g.cam) {
        svgEl("circle", { cx: g.cam.x, cy: g.cam.y, r: 5, class: "f-acc" }, layerFront);
        if (settled) svgEl("text", { x: g.cam.x - 8, y: g.cam.y + 18, class: "t-small t-acc t-strong end", text: "camera" }, layerFront);
      }

      // Tracked corner.
      var tp = g.house[TRACK];
      svgEl("circle", { cx: tp.x, cy: tp.y, r: 7, class: "f-surface s-pix w2" }, layerFront);
      svgEl("circle", { cx: tp.x, cy: tp.y, r: 2.5, class: "f-pix" }, layerFront);
    }

    /* ---------- Text panel, table and readout ---------- */

    function explain(st, c) {
      var depth = c.ndc.z;
      var share = (-c.view.z - NEAR) / (FAR - NEAR);
      switch (st) {
        case 0: return "The house as the artist built it: 2 m wide, its origin in the middle of its floor. These are the numbers stored in the vertex buffer, and every copy of this house shares them.";
        case 1: return "The model matrix M turned the house 30° and moved it to (3, 0, −6). Its own axes, dashed, came with it. Now the house, the camera and everything else are measured from one shared origin.";
        case 2: return "The view matrix V moved and turned the whole world so the camera sits at the origin, looking along −Z. Nothing moved relative to anything else; only the point of view changed.";
        case 3: return state.persp
          ? "P squeezed the frustum into a box, and dividing by w made near things bigger and far things smaller. x and y now run from −1 to 1 and depth from 0 to 1. The corner is " + Math.round(share * 100) + "% of the way from the near plane to the far plane, but its depth is already " + fmt(depth) + "."
          : "With an orthographic projection the frustum was already a box, so P only rescales it: nothing gets smaller with distance, w stays 1, and depth is spread evenly (" + fmt(depth) + " for a corner " + Math.round(share * 100) + "% of the way to the far plane).";
        default: return "The viewport transform stretched NDC over the 1920 × 1080 screen, counting y down from the top. The depth value travels along for the depth test. The house is now a set of pixel positions.";
      }
    }

    function drawText() {
      var st = state.stage;
      var c = chain([HOUSE[TRACK]])[0];
      function row(name, p, w, unit) {
        return [name, fmt(p.x), fmt(p.y), fmt(p.z), w === undefined ? "" : fmt(w), unit];
      }
      var rows = [
        row("Object", c.object, undefined, "m"),
        row("World", c.world, undefined, "m"),
        row("View", c.view, undefined, "m"),
        row("Clip", c.clip, c.clip.w, ""),
        row("NDC", c.ndc, undefined, "after ÷ w"),
        ["Screen", String(Math.round(c.screen.x)), String(Math.round(c.screen.y)), fmt(c.screen.z), "", "px, depth"]
      ];
      // Rows: 0 object, 1 world, 2 view, 3 clip, 4 NDC, 5 screen.
      var hot = [[0], [1], [2], [3, 4], [5]][st];
      var last = hot[hot.length - 1];
      tableBody.replaceChildren.apply(tableBody, rows.map(function (r, i) {
        var cls = hot.indexOf(i) > -1 ? "is-hot" : i > last ? "is-dup" : null;
        return h("tr", { class: cls }, r.map(function (v) { return h("td", { text: v }); }));
      }));
      textPanel.replaceChildren(
        h("p", { class: "label", text: "Step " + (st + 1) + " of 5" }),
        h("p", null, [h("strong", { text: STAGES[st].name + ". " }), explain(st, c)]),
        h("p", { class: "demo-hint", text: "Y up, right-handed, metres; the camera looks along −Z; NDC depth runs 0 to 1. Near 1 m and far 16 m are kept short so the frustum fits." })
      );
      function cell(lbl, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: lbl }), h("span", { class: "v", text: value })]);
      }
      var cur = [c.object, c.world, c.view, c.ndc][st];
      readout.replaceChildren(
        cell("Space", ["Object", "World", "View", "NDC", "Screen"][st]),
        cell("Just applied", ["nothing", "M", "V", "P, ÷ w", "viewport"][st]),
        cell("Tracked corner", st === 4 ? Math.round(c.screen.x) + ", " + Math.round(c.screen.y) + " px" : triple(cur, 2)),
        cell("Depth", st >= 3 ? fmt(c.ndc.z) : "not yet")
      );
      backBtn.disabled = st === 0;
      nextBtn.disabled = st === 4;
      nextBtn.textContent = st === 4 ? "End of the chain" : STAGES[st].next + " →";
      stageSeg.querySelectorAll("button").forEach(function (b, i) {
        b.setAttribute("aria-pressed", i === st ? "true" : "false");
      });
      svg.setAttribute("aria-label", "The house in " + STAGES[st].name.toLowerCase() + ". " + explain(st, c));
    }

    /* ---------- Changing stage, with a short tween ---------- */

    function lerpList(a, b, t) {
      return a.map(function (p, i) {
        var q = b[i];
        return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, d: q.d };
      });
    }

    function render(animateFrom) {
      if (anim) { cancelAnimationFrame(anim); anim = null; }
      var to = geometry(state.stage);
      drawText();
      if (animateFrom === false || animateFrom === undefined || HB.demos.reducedMotion()) {
        paintScene(to, true);
        return;
      }
      var from = geometry(animateFrom);
      var start = null;
      var DURATION = 520;
      function frame(ts) {
        if (start === null) start = ts;
        var t = Math.min(1, (ts - start) / DURATION);
        var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        if (t >= 1) { anim = null; paintScene(to, true); return; }
        var mid = {
          stage: state.stage,
          house: lerpList(from.house, to.house, e),
          door: lerpList(from.door, to.door, e),
          frus: from.frus && to.frus ? lerpList(from.frus, to.frus, e) : null,
          cam: null,
          screenRect: null
        };
        paintScene(mid, false);
        anim = requestAnimationFrame(frame);
      }
      anim = requestAnimationFrame(frame);
    }

    function goTo(st) {
      st = Math.max(0, Math.min(4, st));
      if (st === state.stage) return;
      var from = state.stage;
      state.stage = st;
      render(from);
    }

    backBtn.addEventListener("click", function () { goTo(state.stage - 1); });
    nextBtn.addEventListener("click", function () { goTo(state.stage + 1); });

    render(false);
    log.debug("ready");
  }

  HB.demos.register("space-stepper", init);
})();

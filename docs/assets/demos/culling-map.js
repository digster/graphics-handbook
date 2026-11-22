/*
 * culling-map.js: chapter 4.4's interactive.
 *
 * A top-down map of a small town: buildings (the occluders) and props
 * (trees, crates, barrels, lamps and small litter). A camera with a view
 * cone can be dragged around and turned. Each object runs through three
 * culling stages, cheapest first, and is coloured by its fate:
 *
 *   frustum    its bounding circle lies wholly outside the view wedge
 *              (the 2D frustum: two side planes, a near and a far plane)
 *   size       it would cover fewer pixels on a 1920-pixel-wide screen
 *              than the threshold (distance and small-object culling)
 *   occlusion  tested against a depth pyramid (Hi-Z) built from the
 *              buildings only, exactly as a real engine renders its best
 *              occluders into a small depth buffer first
 *
 * Because the map is 2D, the camera's "screen" is one row of pixels, so the
 * depth buffer is one row of 64 texels and its pyramid halves each level.
 * The strip under the map shows it, with the texels the selected object was
 * tested against.
 *
 * "Actually visible" is ground truth from 720 rays against the real shapes,
 * so the readout can show what each stage wastes or saves. Units: metres.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("culling-map");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- The town (metres, x east, y south) ---------- */

  var WORLD = { w: 128, h: 64 };
  var BUILDINGS = [
    [16, 4, 30, 18], [36, 6, 50, 20], [58, 4, 76, 16], [84, 6, 98, 20], [106, 4, 124, 18],
    [18, 40, 32, 56], [40, 38, 56, 52], [62, 42, 80, 58], [88, 36, 102, 54], [108, 40, 124, 58],
    [90, 24, 98, 32]
  ];
  var PROP_KINDS = [
    { kind: "tree", r: 2.2, n: 24 },
    { kind: "crate", r: 0.6, n: 36 },
    { kind: "barrel", r: 0.45, n: 30 },
    { kind: "lamp post", r: 0.3, n: 20 },
    { kind: "bottle", r: 0.12, n: 40 }
  ];
  var FAR = 90;
  var NEAR = 0.3;
  var SCREEN_PX = 1920;
  var COLUMNS = 64;
  var LEVELS = 5;           // 64, 32, 16, 8, 4 texels
  var TRUTH_RAYS = 720;

  /* ---------- Layout (viewBox units) ---------- */

  var VIEW = { w: 900, h: 692 };
  var MAP = { x: 34, y: 56, s: 6.5 };
  var STRIP = { x0: 130, x1: 866, y0: 524, row: 16, gap: 5 };
  function mx(x) { return MAP.x + x * MAP.s; }
  function my(y) { return MAP.y + y * MAP.s; }
  function fromMx(px) { return (px - MAP.x) / MAP.s; }
  function fromMy(py) { return (py - MAP.y) / MAP.s; }

  var STYLE = {
    visible: "f-acc",
    wasted: "f-surface s-acc w15 dash",
    frustum: "f-line",
    size: "f-lit-soft s-lit",
    occlusion: "f-pix-soft s-pix"
  };

  function insideBuilding(x, y, margin) {
    for (var i = 0; i < BUILDINGS.length; i++) {
      var b = BUILDINGS[i];
      if (x > b[0] - margin && x < b[2] + margin && y > b[1] - margin && y < b[3] + margin) return true;
    }
    return false;
  }

  /* Props scattered at seeded positions in the streets and yards. */
  function makeObjects() {
    var rand = HB.rng(2024);
    var list = [];
    BUILDINGS.forEach(function (b, i) {
      list.push({
        id: "b" + i, kind: "building", building: true, rect: b,
        x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2,
        r: Math.hypot(b[2] - b[0], b[3] - b[1]) / 2
      });
    });
    PROP_KINDS.forEach(function (k) {
      for (var i = 0; i < k.n; i++) {
        var x, y, tries = 0;
        do {
          x = 2 + rand() * (WORLD.w - 4);
          y = 1.5 + rand() * (WORLD.h - 3);
          tries++;
        } while (insideBuilding(x, y, k.r + 0.6) && tries < 200);
        list.push({ id: k.kind + i, kind: k.kind, x: x, y: y, r: k.r });
      }
    });
    return list;
  }

  /* Distance along a ray to a building (slab test), or Infinity. */
  function rayRect(ox, oy, dx, dy, b) {
    var tmin = -Infinity, tmax = Infinity;
    if (Math.abs(dx) < 1e-9) { if (ox < b[0] || ox > b[2]) return Infinity; }
    else {
      var t1 = (b[0] - ox) / dx, t2 = (b[2] - ox) / dx;
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    }
    if (Math.abs(dy) < 1e-9) { if (oy < b[1] || oy > b[3]) return Infinity; }
    else {
      var t3 = (b[1] - oy) / dy, t4 = (b[3] - oy) / dy;
      tmin = Math.max(tmin, Math.min(t3, t4)); tmax = Math.min(tmax, Math.max(t3, t4));
    }
    if (tmax < Math.max(tmin, 0)) return Infinity;
    return Math.max(tmin, 0);
  }

  /* Nearest building along a ray: { t, index }. */
  function castBuildings(ox, oy, a) {
    var dx = Math.cos(a), dy = Math.sin(a);
    var best = { t: Infinity, index: -1 };
    for (var i = 0; i < BUILDINGS.length; i++) {
      var t = rayRect(ox, oy, dx, dy, BUILDINGS[i]);
      if (t < best.t) best = { t: t, index: i };
    }
    return best;
  }

  /* Distance along a ray to a circle, or Infinity. */
  function rayCircle(ox, oy, a, cx, cy, r) {
    var dx = Math.cos(a), dy = Math.sin(a);
    var fx = ox - cx, fy = oy - cy;
    var b = fx * dx + fy * dy;
    var c = fx * fx + fy * fy - r * r;
    var disc = b * b - c;
    if (disc < 0) return Infinity;
    var t = -b - Math.sqrt(disc);
    return t >= 0 ? t : (c < 0 ? 0 : Infinity);
  }

  function wrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /* ---------- One frame of culling ---------- */

  function evaluate(objects, cam, opts) {
    var half = cam.fov / 2;
    var cos = Math.cos, sin = Math.sin;
    // Frustum planes as inward normals through the camera (2D lines).
    var leftN = { x: cos(cam.yaw - half + Math.PI / 2), y: sin(cam.yaw - half + Math.PI / 2) };
    var rightN = { x: cos(cam.yaw + half - Math.PI / 2), y: sin(cam.yaw + half - Math.PI / 2) };
    var fwd = { x: cos(cam.yaw), y: sin(cam.yaw) };

    // The occlusion depth buffer: nearest building per column, then the pyramid.
    // Each texel keeps the FARTHEST depth found across its column (five
    // sub-rays, edges included). Real engines get the same safety by shrinking
    // occluders or rasterising conservatively: an occluder only counts where
    // it covers the whole texel, so nothing visible is ever culled.
    var depth = [];
    for (var c = 0; c < COLUMNS; c++) {
      var far = 0;
      for (var sub = 0; sub <= 4; sub++) {
        var a = cam.yaw - half + ((c + sub / 4) / COLUMNS) * cam.fov;
        far = Math.max(far, Math.min(castBuildings(cam.x, cam.y, a).t, FAR));
      }
      depth.push(far);
    }
    var pyramid = [depth];
    for (var l = 1; l < LEVELS; l++) {
      var prev = pyramid[l - 1], next = [];
      for (var k = 0; k < prev.length / 2; k++) next.push(Math.max(prev[2 * k], prev[2 * k + 1]));
      pyramid.push(next);
    }

    // Ground truth: which objects any of the fine rays reaches first.
    var seen = {};
    for (var ri = 0; ri < TRUTH_RAYS; ri++) {
      var ra = cam.yaw - half + ((ri + 0.5) / TRUTH_RAYS) * cam.fov;
      var hb = castBuildings(cam.x, cam.y, ra);
      var limit = Math.min(hb.t, FAR);
      if (hb.index >= 0 && hb.t <= FAR) seen["b" + hb.index] = true;
      for (var oi = 0; oi < objects.length; oi++) {
        var o = objects[oi];
        if (o.building || seen[o.id]) continue;
        var t = rayCircle(cam.x, cam.y, ra, o.x, o.y, o.r);
        if (t < limit) seen[o.id] = true;
      }
    }

    var counts = { total: objects.length, submitted: 0, visible: 0, wasted: 0, frustum: 0, size: 0, occlusion: 0,
      testsFrustum: 0, testsSize: 0, testsOcclusion: 0 };
    var results = objects.map(function (o) {
      var dx = o.x - cam.x, dy = o.y - cam.y;
      var d = Math.hypot(dx, dy);
      var visible = !!seen[o.id];
      var res = { o: o, d: d, visible: visible, fate: "submitted" };
      // 1. Frustum: outside if wholly behind any plane.
      var outside = (dx * leftN.x + dy * leftN.y) < -o.r || (dx * rightN.x + dy * rightN.y) < -o.r ||
        (dx * fwd.x + dy * fwd.y) < NEAR - o.r || (dx * fwd.x + dy * fwd.y) > FAR + o.r;
      if (opts.frustum) {
        counts.testsFrustum++;
        if (outside) res.fate = "frustum";
      }
      // 2. Size on screen, in pixels across.
      var ang = d > o.r ? 2 * Math.asin(o.r / d) : Math.PI;
      res.px = (ang / cam.fov) * SCREEN_PX;
      if (res.fate === "submitted" && opts.size && !o.building) {
        counts.testsSize++;
        if (res.px < opts.minPx) res.fate = "size";
      }
      // 3. Occlusion against the pyramid (buildings test too: one may hide another).
      if (res.fate === "submitted" && opts.occlusion && d > o.r) {
        counts.testsOcclusion++;
        var centre = Math.atan2(dy, dx);
        var spread = Math.asin(Math.min(1, o.r / d));
        var a0 = wrap(centre - spread - (cam.yaw - half));
        var a1 = wrap(centre + spread - (cam.yaw - half));
        var c0 = Math.floor((a0 / cam.fov) * COLUMNS);
        var c1 = Math.floor((a1 / cam.fov) * COLUMNS);
        c0 = Math.max(0, Math.min(COLUMNS - 1, c0));
        c1 = Math.max(0, Math.min(COLUMNS - 1, c1));
        if (c1 < c0) c1 = c0;
        var span = c1 - c0 + 1;
        var level = Math.min(LEVELS - 1, Math.max(0, Math.ceil(Math.log2(span / 2))));
        var t0 = c0 >> level, t1 = c1 >> level;
        var maxDepth = 0;
        for (var ti = t0; ti <= t1; ti++) maxDepth = Math.max(maxDepth, pyramid[level][ti]);
        res.test = { level: level, t0: t0, t1: t1, maxDepth: maxDepth, near: d - o.r, c0: c0, c1: c1 };
        if (d - o.r > maxDepth) res.fate = "occlusion";
      }
      if (res.fate === "submitted") {
        counts.submitted++;
        if (!visible) counts.wasted++;
      } else {
        counts[res.fate]++;
      }
      if (visible) counts.visible++;
      return res;
    });
    return { results: results, pyramid: pyramid, counts: counts };
  }

  function init(root) {
    var objects = makeObjects();
    var cam = { x: 6, y: 29, yaw: 0.05, fov: (75 * Math.PI) / 180 };
    var opts = { frustum: true, occlusion: true, size: true, minPx: 6 };
    var selected = null;

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Culling map" }),
      h("span", { class: "demo-hint", text: "Drag the camera to move it and the small ring to turn it, or focus either and use the arrow keys. Click an object to see its occlusion test." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    function check(id, label, key) {
      var box = h("input", { type: "checkbox", id: id, checked: opts[key] });
      box.addEventListener("change", function () { opts[key] = box.checked; render(); });
      return h("label", { for: id }, [box, label]);
    }
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Culling stages" }),
      h("div", { class: "checks" }, [
        check("cm-frustum", "Frustum", "frustum"),
        check("cm-size", "Too small on screen", "size"),
        check("cm-occlusion", "Occlusion (Hi-Z)", "occlusion")
      ])
    ]));
    controls.appendChild(HB.slider("cm-fov", "Field of view", {
      min: 40, max: 110, step: 1, value: 75, format: function (v) { return v + "°"; }
    }, function (v) { cam.fov = (v * Math.PI) / 180; render(); }));
    controls.appendChild(HB.slider("cm-minpx", "Cull below", {
      min: 0, max: 24, step: 1, value: opts.minPx, format: function (v) { return v + " px"; }
    }, function (v) { opts.minPx = v; render(); }));
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", { class: "dg is-wide", viewBox: "0 0 " + VIEW.w + " " + VIEW.h, role: "group" });
    stage.appendChild(svg);
    root.appendChild(stage);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    var defs = svgEl("defs", null, svg);
    var clip = svgEl("clipPath", { id: "cm-clip" }, defs);
    svgEl("rect", { x: mx(0), y: my(0), width: WORLD.w * MAP.s, height: WORLD.h * MAP.s }, clip);

    var layerStatic = svgEl("g", null, svg);
    var layerCone = svgEl("g", { "clip-path": "url(#cm-clip)" }, svg);
    var layerObjects = svgEl("g", null, svg);
    var layerSelect = svgEl("g", null, svg);
    var layerStrip = svgEl("g", null, svg);
    var aim = svgEl("g", { "aria-label": "Camera direction" }, svg);
    svgEl("circle", { r: 10, class: "f-surface s-acc w2 handle-ring" }, aim);
    svgEl("circle", { r: 3, class: "f-acc" }, aim);
    var camHandle = svgEl("g", { "aria-label": "Camera position" }, svg);
    svgEl("circle", { r: 13, class: "f-acc-soft s-acc handle-ring" }, camHandle);
    svgEl("circle", { r: 6.5, class: "f-acc" }, camHandle);

    (function drawStatic() {
      svgEl("rect", { x: mx(0), y: my(0), width: WORLD.w * MAP.s, height: WORLD.h * MAP.s, rx: 6, class: "f-sunken s-line" }, layerStatic);
      var lx = 34;
      [["drawn and visible", STYLE.visible], ["sent but not visible", STYLE.wasted], ["culled: outside view", STYLE.frustum],
        ["culled: too small", STYLE.size], ["culled: hidden", STYLE.occlusion]].forEach(function (pair) {
        svgEl("rect", { x: lx, y: 24, width: 13, height: 13, rx: 3, class: pair[1] }, layerStatic);
        svgEl("text", { x: lx + 19, y: 35, class: "t-small", text: pair[0] }, layerStatic);
        lx += 32 + pair[0].length * 6.2;
      });
      // Scale bar: 10 m.
      var sx = mx(WORLD.w) - 10 * MAP.s - 6;
      svgEl("line", { x1: sx, y1: 44, x2: sx + 10 * MAP.s, y2: 44, class: "s-ink w2" }, layerStatic);
      svgEl("text", { x: sx + 5 * MAP.s, y: 38, class: "t-small t-muted mid", text: "10 m" }, layerStatic);
      svgEl("text", { x: 34, y: STRIP.y0 - 14, class: "t-caps", text: "THE OCCLUSION DEPTH BUFFER: NEAREST BUILDING IN EACH COLUMN OF THE VIEW, AND ITS PYRAMID" }, layerStatic);
      for (var l = 0; l < LEVELS; l++) {
        var y = STRIP.y0 + l * (STRIP.row + STRIP.gap);
        svgEl("text", { x: 34, y: y + 12, class: "t-mono t-small t-muted", text: "level " + l + " · " + (COLUMNS >> l) }, layerStatic);
      }
      svgEl("text", { x: STRIP.x0, y: STRIP.y0 + LEVELS * (STRIP.row + STRIP.gap) + 10, class: "t-small t-muted", text: "left of view" }, layerStatic);
      svgEl("text", { x: STRIP.x1, y: STRIP.y0 + LEVELS * (STRIP.row + STRIP.gap) + 10, class: "t-small t-muted end", text: "right of view · dark = near, light = far" }, layerStatic);
    })();

    function drawCone() {
      HB.svg.clear(layerCone);
      var half = cam.fov / 2;
      var pts = [mx(cam.x), my(cam.y)];
      var steps = 24;
      for (var i = 0; i <= steps; i++) {
        var a = cam.yaw - half + (i / steps) * cam.fov;
        pts.push(mx(cam.x + FAR * Math.cos(a) / Math.cos(a - cam.yaw)), my(cam.y + FAR * Math.sin(a) / Math.cos(a - cam.yaw)));
      }
      svgEl("polygon", { points: pts.map(function (v) { return v.toFixed(1); }).join(" "), class: "f-acc-soft", opacity: 0.55 }, layerCone);
      [-half, half].forEach(function (off) {
        var a = cam.yaw + off;
        var len = FAR / Math.cos(off);
        svgEl("line", { x1: mx(cam.x), y1: my(cam.y), x2: mx(cam.x + len * Math.cos(a)), y2: my(cam.y + len * Math.sin(a)), class: "s-acc" }, layerCone);
      });
    }

    function drawObjects(ev) {
      HB.svg.clear(layerObjects);
      ev.results.forEach(function (res) {
        var o = res.o;
        var cls = res.fate === "submitted" ? (res.visible ? STYLE.visible : STYLE.wasted) : STYLE[res.fate];
        var node;
        if (o.building) {
          var b = o.rect;
          node = svgEl("rect", {
            x: mx(b[0]), y: my(b[1]), width: (b[2] - b[0]) * MAP.s, height: (b[3] - b[1]) * MAP.s, rx: 2,
            class: res.fate === "submitted" && res.visible ? "f-acc-soft s-acc w15" : cls
          }, layerObjects);
        } else {
          node = svgEl("circle", { cx: mx(o.x).toFixed(1), cy: my(o.y).toFixed(1), r: Math.max(o.r * MAP.s, 1.8).toFixed(1), class: cls }, layerObjects);
        }
        node.setAttribute("data-id", o.id);
      });
    }

    function drawStrip(ev) {
      HB.svg.clear(layerStrip);
      var width = STRIP.x1 - STRIP.x0;
      ev.pyramid.forEach(function (row, l) {
        var y = STRIP.y0 + l * (STRIP.row + STRIP.gap);
        var w = width / row.length;
        row.forEach(function (dv, i) {
          var x = STRIP.x0 + i * w;
          svgEl("rect", { x: x.toFixed(1), y: y, width: (w + 0.4).toFixed(1), height: STRIP.row, class: "f-buf-lo" }, layerStrip);
          svgEl("rect", { x: x.toFixed(1), y: y, width: (w + 0.4).toFixed(1), height: STRIP.row, class: "f-buf-hi", opacity: (dv / FAR).toFixed(3) }, layerStrip);
        });
      });
      var sel = selected && ev.results.filter(function (r) { return r.o.id === selected; })[0];
      HB.svg.clear(layerSelect);
      var noteY = STRIP.y0 + LEVELS * (STRIP.row + STRIP.gap) + 32;
      if (!sel) {
        svgEl("text", { x: 34, y: noteY, class: "t-small t-muted", text: "Click an object on the map to see how it was tested." }, layerStrip);
        return;
      }
      var o = sel.o;
      // On the map: a ring round the object and its sight lines.
      svgEl("circle", { cx: mx(o.x), cy: my(o.y), r: Math.max(o.r * MAP.s, 2) + 5, class: "s-ink w2" }, layerSelect);
      var name = o.kind.charAt(0).toUpperCase() + o.kind.slice(1);
      var msg;
      if (sel.fate === "frustum") msg = name + " at " + sel.d.toFixed(0) + " m: its bounding circle is wholly outside the view, so the frustum test removes it. No other test runs.";
      else if (sel.fate === "size") msg = name + " at " + sel.d.toFixed(0) + " m: about " + sel.px.toFixed(1) + " pixels across, below the " + opts.minPx + " px threshold, so it is culled before the occlusion test.";
      else if (!sel.test) msg = name + " at " + sel.d.toFixed(0) + " m: no occlusion test ran" + (opts.occlusion ? "." : ", because occlusion culling is off.") + (sel.visible ? " It is visible." : " It is sent to the GPU but nothing of it reaches the screen.");
      else {
        var t = sel.test;
        var hidden = sel.fate === "occlusion";
        var w = (STRIP.x1 - STRIP.x0) / (COLUMNS >> t.level);
        var y = STRIP.y0 + t.level * (STRIP.row + STRIP.gap);
        svgEl("rect", { x: (STRIP.x0 + t.t0 * w).toFixed(1), y: y - 2, width: ((t.t1 - t.t0 + 1) * w).toFixed(1), height: STRIP.row + 4, class: "s-pix w3" }, layerStrip);
        var w0 = (STRIP.x1 - STRIP.x0) / COLUMNS;
        svgEl("rect", { x: (STRIP.x0 + t.c0 * w0).toFixed(1), y: STRIP.y0 - 2, width: ((t.c1 - t.c0 + 1) * w0).toFixed(1), height: STRIP.row + 4, class: "s-ink w15 dash" }, layerStrip);
        msg = name + ": nearest point " + t.near.toFixed(1) + " m. It covers " + (t.c1 - t.c0 + 1) + " columns, so it is tested at level " + t.level +
          ", where the farthest depth in its " + (t.t1 - t.t0 + 1) + (t.t1 === t.t0 ? " texel" : " texels") + " is " + t.maxDepth.toFixed(1) + " m. " +
          (hidden ? "Every occluder there is nearer, so it is hidden." : "It could be in front, so it is drawn.") +
          (!hidden && !sel.visible ? " In fact nothing of it is visible: the test is conservative." : "");
      }
      // Wrap the message into two lines at a word boundary near the middle.
      var words = msg.split(" ");
      var line1 = "", line2 = "";
      words.forEach(function (wd) {
        if ((line1 + " " + wd).length < 118 && !line2) line1 += (line1 ? " " : "") + wd;
        else line2 += (line2 ? " " : "") + wd;
      });
      svgEl("text", { x: 34, y: noteY, class: "t-small", text: line1 }, layerStrip);
      if (line2) svgEl("text", { x: 34, y: noteY + 16, class: "t-small", text: line2 }, layerStrip);
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function render() {
      var ev = evaluate(objects, cam, opts);
      // Default selection: the largest object hidden by occlusion, so the
      // strip shows a test on load.
      if (!selected || !objects.some(function (o) { return o.id === selected; })) {
        var hidden = ev.results.filter(function (r) { return r.fate === "occlusion"; }).sort(function (a, b) { return b.o.r - a.o.r || a.d - b.d; });
        selected = hidden.length ? hidden[0].o.id : null;
      }
      drawCone();
      drawObjects(ev);
      drawStrip(ev);
      camHandle.setAttribute("transform", "translate(" + mx(cam.x).toFixed(1) + "," + my(cam.y).toFixed(1) + ")");
      var ad = 16;
      aim.setAttribute("transform", "translate(" + mx(cam.x + ad * Math.cos(cam.yaw)).toFixed(1) + "," + my(cam.y + ad * Math.sin(cam.yaw)).toFixed(1) + ")");
      var c = ev.counts;
      readout.replaceChildren(
        cell("Objects in the level", HB.fmt.int(c.total)),
        cell("Sent to the GPU", HB.fmt.int(c.submitted)),
        cell("Actually visible", HB.fmt.int(c.visible)),
        cell("Sent but not visible", HB.fmt.int(c.wasted)),
        cell("Culled: view · size · hidden", c.frustum + " · " + c.size + " · " + c.occlusion),
        cell("Culling tests run", HB.fmt.int(c.testsFrustum + c.testsSize + c.testsOcclusion))
      );
      svg.setAttribute("aria-label", "Top-down map of a town with " + c.total + " objects and a camera at " + cam.x.toFixed(0) + ", " + cam.y.toFixed(0) +
        " metres. " + c.submitted + " objects are sent to the GPU, " + c.visible + " are actually visible, " + c.wasted + " are sent but not visible. Culled: " +
        c.frustum + " outside the view, " + c.size + " too small, " + c.occlusion + " hidden behind buildings.");
      var deg = Math.round(((cam.yaw * 180) / Math.PI + 360) % 360);
      camHandle.setAttribute("aria-valuetext", "Camera at " + cam.x.toFixed(0) + " by " + cam.y.toFixed(0) + " metres. " + c.submitted + " objects sent, " + c.visible + " visible.");
      aim.setAttribute("aria-valuetext", "Facing " + deg + " degrees. " + c.submitted + " objects sent, " + c.visible + " visible.");
      root.setAttribute("data-submitted", String(c.submitted));
    }

    function moveTo(x, y) {
      x = Math.max(0.5, Math.min(WORLD.w - 0.5, x));
      y = Math.max(0.5, Math.min(WORLD.h - 0.5, y));
      if (insideBuilding(x, y, 0.4)) return;
      cam.x = x;
      cam.y = y;
      render();
    }

    HB.draggable(svg, camHandle, {
      onDrag: function (pt) { moveTo(fromMx(pt.x), fromMy(pt.y)); },
      onKey: function (dir, big) {
        var step = big ? 5 : 1;
        moveTo(cam.x + dir * step * Math.cos(cam.yaw), cam.y + dir * step * Math.sin(cam.yaw));
      }
    });
    HB.draggable(svg, aim, {
      onDrag: function (pt) {
        var dx = fromMx(pt.x) - cam.x, dy = fromMy(pt.y) - cam.y;
        if (Math.hypot(dx, dy) < 1) return;
        cam.yaw = Math.atan2(dy, dx);
        render();
      },
      onKey: function (dir, big) {
        cam.yaw = wrap(cam.yaw + dir * ((big ? 15 : 3) * Math.PI) / 180);
        render();
      }
    });

    // Click an object to inspect its test.
    layerObjects.addEventListener("click", function (event) {
      var id = event.target && event.target.getAttribute("data-id");
      if (!id) return;
      selected = id;
      render();
    });

    render();
    log.debug("ready", objects.length + " objects");
  }

  HB.demos.register("culling-map", init);
})();

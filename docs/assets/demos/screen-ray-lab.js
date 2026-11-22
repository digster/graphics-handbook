/*
 * screen-ray-lab.js: chapter 8.4's interactive.
 *
 * A side-on slice through a small scene, seen by a game camera on the left
 * that looks slightly down. The camera's depth buffer is a single column of
 * 64 pixels: for each pixel it stores how far away (along the view axis) the
 * first surface on that pixel's ray is. Everything the camera cannot see,
 * behind a surface or outside the frustum, is simply not in it.
 *
 * The reader picks a pixel P on a visible surface and fires either one
 * reflection ray (the camera ray mirrored about the surface normal, as SSR
 * does) or a fan of nine bounce rays over the half circle (as SSGI does).
 * Each ray is marched through the depth buffer, never through the scene:
 *
 *   Linear  fixed steps in the world; each step is projected to the screen
 *           and its depth compared with the stored depth of that pixel.
 *   Hi-Z    a stackless walk of a closest-depth pyramid (each mip texel keeps
 *           the nearest depth of the two below it): while the ray stays in
 *           front of a cell's nearest surface it skips the whole cell and
 *           climbs a level; when it reaches that depth it drops a level.
 *
 * A step that lands behind the stored depth is a hit if it is less than
 * `thickness` behind it (the thickness assumption), otherwise the ray is
 * taken to pass behind the surface and continues. Rays that leave the
 * frustum, or run out of steps, fall back to a probe, the sky or nothing.
 *
 * Every result is compared with the truth: the same ray cast against the real
 * boxes. That is how the readout can say "false hit", "wrong face" or
 * "the screen could have seen it".
 *
 * Units: metres. The tracing core is exposed as HB.screenRayLab so the
 * chapter's static figures (generated offline) and tests use the same maths.
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var log = HB.log && HB.log.scope ? HB.log.scope("screen-ray-lab") : null;
  var DEG = Math.PI / 180;

  /* ---------- Scene (metres, y up) ---------- */

  var PITCH = -12 * DEG;
  var CAM = {
    x: 0, y: 2.4,
    dx: Math.cos(PITCH), dy: Math.sin(PITCH),   // view axis
    sx: -Math.sin(PITCH), sy: Math.cos(PITCH),  // screen "up" axis
    tanHalf: Math.tan(26 * DEG),
    near: 0.1
  };
  var N = 64;          // depth-buffer pixels, bottom of the screen first
  var LEVELS = 5;      // mip 0 (64 texels) to mip 4 (4 texels)
  var BOXES = [
    { id: "floor", name: "the floor", x0: -60, x1: 60, y0: -1, y1: 0, fill: "f-solid" },
    { id: "crate", name: "the crate", x0: 4.2, x1: 5.2, y0: 0, y1: 0.8, fill: "f-strong" },
    { id: "banner", name: "the banner", x0: 6.0, x1: 6.05, y0: 1.5, y1: 2.6, fill: "f-paint-red" },
    { id: "wall", name: "the back wall", x0: 11, x1: 11.6, y0: 0, y1: 4, fill: "f-solid" }
  ];
  var BOX_BY_ID = {};
  BOXES.forEach(function (b) { BOX_BY_ID[b.id] = b; });

  /* Nearest box a ray hits, with the face normal it enters through. */
  function castScene(ox, oy, dx, dy) {
    var best = null;
    for (var i = 0; i < BOXES.length; i++) {
      var b = BOXES[i];
      var tmin = -Infinity, tmax = Infinity, nx = 0, ny = 0;
      if (Math.abs(dx) < 1e-12) {
        if (ox < b.x0 || ox > b.x1) continue;
      } else {
        var t1 = (b.x0 - ox) / dx, t2 = (b.x1 - ox) / dx;
        var tn = Math.min(t1, t2);
        if (tn > tmin) { tmin = tn; nx = dx > 0 ? -1 : 1; ny = 0; }
        tmax = Math.min(tmax, Math.max(t1, t2));
      }
      if (Math.abs(dy) < 1e-12) {
        if (oy < b.y0 || oy > b.y1) continue;
      } else {
        var t3 = (b.y0 - oy) / dy, t4 = (b.y1 - oy) / dy;
        var tn2 = Math.min(t3, t4);
        if (tn2 > tmin) { tmin = tn2; nx = 0; ny = dy > 0 ? -1 : 1; }
        tmax = Math.min(tmax, Math.max(t3, t4));
      }
      if (tmin > 1e-6 && tmin <= tmax && (!best || tmin < best.t)) {
        best = { t: tmin, box: b, nx: nx, ny: ny, x: ox + dx * tmin, y: oy + dy * tmin };
      }
    }
    return best;
  }

  /* World point -> view depth, screen position u in [-1, 1], pixel. */
  function project(x, y) {
    var qx = x - CAM.x, qy = y - CAM.y;
    var z = qx * CAM.dx + qy * CAM.dy;
    var v = qx * CAM.sx + qy * CAM.sy;
    if (z < CAM.near) return { on: false, z: z, u: v >= 0 ? 2 : -2, behind: true };
    var u = v / (z * CAM.tanHalf);
    var on = u >= -1 && u <= 1;
    var pixel = Math.min(N - 1, Math.max(0, Math.floor(((u + 1) / 2) * N)));
    return { on: on, z: z, u: u, pixel: pixel, behind: false };
  }

  /* Direction of the camera ray through screen position u. */
  function rayFor(u) {
    var x = CAM.dx + u * CAM.tanHalf * CAM.sx;
    var y = CAM.dy + u * CAM.tanHalf * CAM.sy;
    var l = Math.hypot(x, y);
    return { x: x / l, y: y / l };
  }
  function uOfEdge(k) { return -1 + (2 * k) / N; }

  /* ---------- The depth buffer and its closest-depth pyramid ---------- */

  var DEPTH = [];   // per pixel: { z, x, y, box, nx, ny } (box null = sky)
  for (var p = 0; p < N; p++) {
    var u = -1 + (2 * p + 1) / N;
    var r = rayFor(u);
    var hit = castScene(CAM.x, CAM.y, r.x, r.y);
    if (hit) {
      DEPTH.push({ z: hit.t * (r.x * CAM.dx + r.y * CAM.dy), x: hit.x, y: hit.y, box: hit.box, nx: hit.nx, ny: hit.ny });
    } else {
      DEPTH.push({ z: Infinity, x: null, y: null, box: null, nx: 0, ny: 0 });
    }
  }
  var PYRAMID = [DEPTH.map(function (d) { return d.z; })];
  for (var L = 1; L < LEVELS; L++) {
    var prev = PYRAMID[L - 1], next = [];
    for (var c = 0; c < prev.length / 2; c++) next.push(Math.min(prev[2 * c], prev[2 * c + 1]));
    PYRAMID.push(next);
  }

  /* The visible surfaces, pixel by pixel: where each pixel's two edge rays
     meet the same face as its centre ray. Drawn as the depth buffer's
     "what the camera saw" line. */
  var EDGE_HITS = [];
  for (var k = 0; k <= N; k++) {
    var er = rayFor(uOfEdge(k));
    EDGE_HITS.push(castScene(CAM.x, CAM.y, er.x, er.y));
  }
  function sameFace(h, d) { return h && d.box && h.box === d.box && h.nx === d.nx && h.ny === d.ny; }
  var SURFACE = [];
  for (var sp = 0; sp < N; sp++) {
    var sd = DEPTH[sp];
    if (!sd.box) continue;
    var a0 = sameFace(EDGE_HITS[sp], sd) ? EDGE_HITS[sp] : sd;
    var b0 = sameFace(EDGE_HITS[sp + 1], sd) ? EDGE_HITS[sp + 1] : sd;
    SURFACE.push({ pixel: sp, x1: a0.x, y1: a0.y, x2: b0.x, y2: b0.y });
  }

  /* ---------- Rays ---------- */

  /* Origin and normal for a pixel: its visible surface, nudged off it. */
  function originFor(pixel) {
    var d = DEPTH[pixel];
    if (!d.box) return null;
    return { x: d.x + d.nx * 0.01, y: d.y + d.ny * 0.01, nx: d.nx, ny: d.ny, pixel: pixel, box: d.box };
  }

  /* The camera ray mirrored about the surface normal: what SSR traces. */
  function mirror(o) {
    var vx = o.x - CAM.x, vy = o.y - CAM.y;
    var l = Math.hypot(vx, vy);
    vx /= l; vy /= l;
    var k = 2 * (vx * o.nx + vy * o.ny);
    return { x: vx - k * o.nx, y: vy - k * o.ny };
  }

  /* Nine directions over the half circle around the normal: SSGI's fan. */
  function fan(o) {
    var out = [];
    var base = Math.atan2(o.ny, o.nx);
    for (var i = 0; i < 9; i++) {
      var a = base + (i - 4) * 18 * DEG;
      out.push({ x: Math.cos(a), y: Math.sin(a) });
    }
    return out;
  }

  function viewDepthAt(o, dir, t) {
    return (o.x + dir.x * t - CAM.x) * CAM.dx + (o.y + dir.y * t - CAM.y) * CAM.dy;
  }

  /* Linear march: fixed world-space steps, one depth read per step. When a
     step lands behind the stored depth after one in front of it, five
     halving steps find the crossing, as production SSR does; the thickness
     test then decides between a hit and passing behind. */
  function marchLinear(o, dir, opts) {
    var samples = [];
    var reads = 0;
    var behind = false;
    var prevT = 0;
    var prevFront = true;
    var home = project(o.x, o.y).pixel;
    function at(t) { return { x: o.x + dir.x * t, y: o.y + dir.y * t }; }
    for (var k = 1; k <= opts.maxSteps; k++) {
      var t = k * opts.step;
      var q = at(t);
      var pr = project(q.x, q.y);
      if (!pr.on) return { result: "offscreen", samples: samples, reads: reads, end: q, behind: behind, visits: visitsOf(samples) };
      if (pr.pixel === home) {
        // Still on the starting pixel: its own surface would stop the ray.
        samples.push({ x: q.x, y: q.y, pixel: pr.pixel, level: 0, state: "front" });
        prevT = t;
        continue;
      }
      reads++;
      var zb = PYRAMID[0][pr.pixel];
      if (pr.z > zb) {
        var hp = pr, hq = q;
        if (prevFront && opts.refine !== false) {
          var lo = prevT, hi = t;
          for (var i = 0; i < 5; i++) {
            var mid = (lo + hi) / 2;
            var qm = at(mid);
            var pm = project(qm.x, qm.y);
            reads++;
            if (pm.on && pm.pixel !== home && pm.z > PYRAMID[0][pm.pixel]) hi = mid; else lo = mid;
          }
          hq = at(hi);
          hp = project(hq.x, hq.y);
        }
        if (hp.z - PYRAMID[0][hp.pixel] <= opts.thickness) {
          samples.push({ x: hq.x, y: hq.y, pixel: hp.pixel, level: 0, state: "hit" });
          return { result: "hit", pixel: hp.pixel, samples: samples, reads: reads, end: hq, behind: behind, visits: visitsOf(samples) };
        }
        samples.push({ x: q.x, y: q.y, pixel: pr.pixel, level: 0, state: "behind" });
        behind = true;
        prevFront = false;
      } else {
        samples.push({ x: q.x, y: q.y, pixel: pr.pixel, level: 0, state: "front" });
        prevFront = true;
      }
      prevT = t;
    }
    return { result: "steps", samples: samples, reads: reads, end: at(opts.maxSteps * opts.step), behind: behind, visits: visitsOf(samples) };
  }

  function visitsOf(samples) {
    return samples.map(function (s) { return { level: 0, cell: s.pixel, state: s.state }; });
  }

  /* t at which the ray reaches screen position u, or null. Solves
     (q0 + t d) . s = u tanHalf (q0 + t d) . view, which is linear in t. */
  function tAtU(o, dir, uTarget) {
    var q0x = o.x - CAM.x, q0y = o.y - CAM.y;
    var k = uTarget * CAM.tanHalf;
    var num = k * (q0x * CAM.dx + q0y * CAM.dy) - (q0x * CAM.sx + q0y * CAM.sy);
    var den = (dir.x * CAM.sx + dir.y * CAM.sy) - k * (dir.x * CAM.dx + dir.y * CAM.dy);
    if (Math.abs(den) < 1e-12) return null;
    return num / den;
  }

  /* Hi-Z march: a stackless walk of the closest-depth pyramid. */
  function marchHiZ(o, dir, opts) {
    var T_MAX = 40;
    var EPS = 1e-4;
    var t = 0.02;
    var level = 0;
    var reads = 0;
    var behind = false;
    var samples = [];
    var visits = [];
    var rd = dir.x * CAM.dx + dir.y * CAM.dy;          // dz/dt
    var z0 = viewDepthAt(o, dir, 0);
    // Start at the edge of the starting pixel, so its own surface is not hit.
    var home = project(o.x, o.y);
    var homeUp = project(o.x + dir.x * 1e-3, o.y + dir.y * 1e-3).u >= home.u;
    var tHome = tAtU(o, dir, uOfEdge(homeUp ? home.pixel + 1 : home.pixel));
    if (tHome !== null && tHome > t) t = tHome + EPS;
    while (reads < opts.maxIter) {
      var x = o.x + dir.x * t, y = o.y + dir.y * t;
      var pr = project(x, y);
      if (!pr.on) return { result: "offscreen", samples: samples, visits: visits, reads: reads, end: { x: x, y: y }, behind: behind };
      if (t > T_MAX) break;
      var cell = pr.pixel >> level;
      var size = 1 << level;
      var zmin = PYRAMID[level][cell];
      // Which screen edge of this cell the ray is heading for.
      var pr2 = project(o.x + dir.x * (t + 1e-3), o.y + dir.y * (t + 1e-3));
      var up = pr2.u >= pr.u;
      var edge = uOfEdge(up ? (cell + 1) * size : cell * size);
      var tExit = tAtU(o, dir, edge);
      if (tExit === null || tExit <= t) tExit = T_MAX + 1;
      reads++;
      var zNow = z0 + rd * t;
      var zExit = z0 + rd * tExit;
      if (zNow < zmin && zExit < zmin) {
        // In front of the nearest surface in the whole cell: skip it.
        samples.push({ x: x, y: y, pixel: pr.pixel, level: level, state: "front" });
        visits.push({ level: level, cell: cell, state: "skip" });
        t = tExit + EPS;
        if (level < LEVELS - 1) level++;
        continue;
      }
      if (zNow < zmin && Math.abs(rd) > 1e-12) {
        // The ray reaches the nearest depth inside this cell: move there.
        t = Math.max(t, (zmin - z0) / rd);
      }
      if (level > 0) {
        visits.push({ level: level, cell: cell, state: "descend" });
        samples.push({ x: x, y: y, pixel: pr.pixel, level: level, state: "front" });
        level--;
        continue;
      }
      // Mip 0: one real pixel. Apply the thickness assumption.
      var hx = o.x + dir.x * t, hy = o.y + dir.y * t;
      var ph = project(hx, hy);
      if (!ph.on) return { result: "offscreen", samples: samples, visits: visits, reads: reads, end: { x: hx, y: hy }, behind: behind };
      var zr = z0 + rd * t;
      var zb = PYRAMID[0][ph.pixel];
      if (ph.pixel !== home.pixel && zr >= zb && zr - zb <= opts.thickness) {
        samples.push({ x: hx, y: hy, pixel: ph.pixel, level: 0, state: "hit" });
        visits.push({ level: 0, cell: ph.pixel, state: "hit" });
        return { result: "hit", pixel: ph.pixel, samples: samples, visits: visits, reads: reads, end: { x: hx, y: hy }, behind: behind };
      }
      behind = behind || zr > zb;
      samples.push({ x: hx, y: hy, pixel: ph.pixel, level: 0, state: zr > zb ? "behind" : "front" });
      visits.push({ level: 0, cell: ph.pixel, state: zr > zb ? "behind" : "front" });
      // Step past this pixel and carry on at mip 0.
      var e0 = uOfEdge(up ? ph.pixel + 1 : ph.pixel);
      var t0 = tAtU(o, dir, e0);
      t = (t0 !== null && t0 > t ? t0 : t + 0.05) + EPS;
    }
    var te = Math.min(t, T_MAX);
    return { result: "steps", samples: samples, visits: visits, reads: reads, end: { x: o.x + dir.x * te, y: o.y + dir.y * te }, behind: behind };
  }

  /* How many pixels the ray crosses before it stops: the reads a march that
     never skips a pixel (a one-pixel stride) would need. */
  function pixelsCrossed(o, dir, thickness) {
    var home = project(o.x, o.y).pixel;
    var last = home, count = 0;
    for (var t = 0.01; t < 30; t += 0.01) {
      var x = o.x + dir.x * t, y = o.y + dir.y * t;
      var pr = project(x, y);
      if (!pr.on) break;
      if (pr.pixel === last) continue;
      last = pr.pixel;
      count++;
      var zb = PYRAMID[0][pr.pixel];
      if (pr.z > zb && pr.z - zb <= thickness) break;
    }
    return count;
  }

  /* The truth: the same ray against the real boxes. */
  function truth(o, dir) {
    var h = castScene(o.x, o.y, dir.x, dir.y);
    if (!h) return null;
    var pr = project(h.x, h.y);
    var visible = false;
    if (pr.on) {
      var vx = h.x - CAM.x, vy = h.y - CAM.y;
      var l = Math.hypot(vx, vy);
      var first = castScene(CAM.x, CAM.y, vx / l, vy / l);
      visible = !!first && first.box === h.box && Math.abs(first.t - l) < 0.02;
    }
    return { x: h.x, y: h.y, box: h.box, nx: h.nx, ny: h.ny, onScreen: pr.on, visible: visible };
  }

  /* Compare a march with the truth. Kinds:
       correct    hit, and the depth buffer's surface there is the true one
       wrongface  hit the right object, but on a face the camera cannot see
       false      the depth buffer stopped the ray where nothing really is
       missed     no hit, though the true hit is visible on screen
       offscreen  the ray left the screen: fallback
       steps      ran out of steps: fallback */
  function classify(march, tr) {
    if (march.result === "hit") {
      var s = DEPTH[march.pixel];
      if (tr && tr.box === s.box && tr.visible && Math.hypot(tr.x - s.x, tr.y - s.y) < 0.4) return "correct";
      if (tr && tr.box === s.box) return "wrongface";
      return "false";
    }
    if (tr && tr.visible) return "missed";
    return march.result === "offscreen" ? "offscreen" : "steps";
  }

  function trace(o, dir, opts) {
    var m = opts.march === "hiz"
      ? marchHiZ(o, dir, { thickness: opts.thickness, maxIter: opts.maxIter || 64 })
      : marchLinear(o, dir, { thickness: opts.thickness, step: opts.step, maxSteps: opts.maxSteps || 48 });
    var tr = truth(o, dir);
    return { march: m, truth: tr, kind: classify(m, tr) };
  }

  HB.screenRayLab = {
    camera: CAM, boxes: BOXES, N: N, levels: LEVELS, depth: DEPTH, pyramid: PYRAMID,
    project: project, rayFor: rayFor, castScene: castScene, originFor: originFor,
    mirror: mirror, fan: fan, marchLinear: marchLinear, marchHiZ: marchHiZ,
    truth: truth, classify: classify, trace: trace, pixelsCrossed: pixelsCrossed, surface: SURFACE
  };

  /* ---------- Drawing ---------- */

  var VIEW = { w: 860, h: 478 };
  var WX0 = -0.6, WX1 = 12.4, WY0 = -0.4, WY1 = 5.0;
  var SC = 56;
  var LEFT = 66, TOP = 14;
  function X(x) { return LEFT + (x - WX0) * SC; }
  function Y(y) { return TOP + (WY1 - y) * SC; }
  function fromSvg(px, py) { return { x: (px - LEFT) / SC + WX0, y: WY1 - (py - TOP) / SC }; }
  var SCENE_BOTTOM = Y(WY0);
  var STRIP = { x: LEFT, w: (WX1 - WX0) * SC, y: SCENE_BOTTOM + 30, h: 22, row: 11, gap: 3 };
  function cellX(level, cell) { return STRIP.x + cell * (STRIP.w / N) * (1 << level); }
  function cellW(level) { return (STRIP.w / N) * (1 << level); }
  function rowY(level) { return level === 0 ? STRIP.y : STRIP.y + STRIP.h + STRIP.gap + (level - 1) * (STRIP.row + STRIP.gap); }
  function rowH(level) { return level === 0 ? STRIP.h : STRIP.row; }
  var Z_SHADE = 13;

  var KIND = {
    correct: { label: "Correct hit", cls: "f-acc", line: "s-acc" },
    wrongface: { label: "Hit, but on a face the camera cannot see", cls: "f-pix", line: "s-pix" },
    "false": { label: "False hit", cls: "f-pix", line: "s-pix" },
    missed: { label: "Missed a surface the screen can see", cls: "f-pix", line: "s-pix" },
    offscreen: { label: "Left the screen", cls: "f-muted", line: "s-muted" },
    steps: { label: "Ran out of steps", cls: "f-muted", line: "s-muted" }
  };
  var FALLBACK = {
    probe: { label: "a reflection probe", fill: "f-lit-soft s-lit" },
    sky: { label: "the sky", fill: "f-paint-sky s-strong" },
    none: { label: "nothing (black)", fill: "f-ink" }
  };

  /* Examples: pixel, ray mode and settings that each show one behaviour. */
  var EXAMPLES = {
    hit: { label: "Clean hit", mode: "reflect", pick: function (o) { return o.box.id === "floor" && o.x < 4.2; } },
    behind: { label: "Behind the banner", mode: "reflect", pick: function (o) { return o.box.id === "floor" && o.x > 7.2 && o.x < 8.2; } },
    thin: { label: "Thick or thin?", mode: "reflect", thickness: 2.5, pick: function (o) { return o.box.id === "crate" && o.y > 0.7 && o.x > 4.7 && o.x < 4.9; } },
    off: { label: "Off screen", mode: "reflect", pick: function (o) { return o.box.id === "banner"; } }
  };
  function pickPixel(fn) {
    var found = [];
    for (var i = 0; i < N; i++) {
      var o = originFor(i);
      if (o && fn(o)) found.push(i);
    }
    return found.length ? found[Math.floor(found.length / 2)] : 20;
  }

  function init(root) {
    var svgEl = HB.svg.el;
    var h = HB.html;
    var state = {
      pixel: pickPixel(EXAMPLES.behind.pick),
      mode: "reflect",
      march: "linear",
      thickness: 0.5,
      step: 0.3,
      fallback: "probe"
    };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Screen ray lab" }),
      h("span", { class: "demo-hint", text: "Drag P to another visible surface, or focus it and use the arrow keys." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    var modeCtl = HB.segmented("Ray", [
      { value: "reflect", label: "Reflection (SSR)" },
      { value: "bounce", label: "Bounce, 9 rays (SSGI)" }
    ], state.mode, function (v) { state.mode = v; draw(); });
    controls.appendChild(modeCtl);
    var marchCtl = HB.segmented("March", [
      { value: "linear", label: "Linear steps" },
      { value: "hiz", label: "Hi-Z" }
    ], state.march, function (v) { state.march = v; syncStep(); draw(); });
    controls.appendChild(marchCtl);
    var thickCtl = HB.slider("srl-thick", "Thickness", {
      min: 0.05, max: 3, step: 0.05, value: state.thickness,
      format: function (v) { return v.toFixed(2) + " m"; }
    }, function (v) { state.thickness = v; draw(); });
    controls.appendChild(thickCtl);
    var stepCtl = HB.slider("srl-step", "Step length (linear)", {
      min: 0.1, max: 1, step: 0.05, value: state.step,
      format: function (v) { return v.toFixed(2) + " m"; }
    }, function (v) { state.step = v; draw(); });
    controls.appendChild(stepCtl);
    controls.appendChild(HB.segmented("Misses use", [
      { value: "probe", label: "Probe" },
      { value: "sky", label: "Sky" },
      { value: "none", label: "Nothing" }
    ], state.fallback, function (v) { state.fallback = v; draw(); }));
    var exampleCtl = HB.segmented("Show me", Object.keys(EXAMPLES).map(function (k) {
      return { value: k, label: EXAMPLES[k].label };
    }), "behind", function (k) { applyExample(k); });
    controls.appendChild(exampleCtl);
    root.appendChild(controls);

    function setPressed(ctl, value, values) {
      var buttons = ctl.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-pressed", values[i] === value ? "true" : "false");
    }
    function setSlider(ctl, value) {
      var input = ctl.querySelector("input");
      input.value = String(value);
      input.dispatchEvent(new Event("input"));
    }
    function syncStep() {
      stepCtl.querySelector("input").disabled = state.march === "hiz";
    }
    function applyExample(k) {
      var ex = EXAMPLES[k];
      state.pixel = pickPixel(ex.pick);
      state.mode = ex.mode;
      setPressed(modeCtl, state.mode, ["reflect", "bounce"]);
      if (ex.thickness !== undefined) setSlider(thickCtl, ex.thickness);
      else setSlider(thickCtl, 0.5);
      draw();
    }
    function clearExample() {
      setPressed(exampleCtl, null, Object.keys(EXAMPLES));
    }

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "group",
      "aria-label": "Side view of a camera on the left looking at a floor, a crate, a thin red banner and a back wall. Below it, the camera's 64-pixel depth buffer and its Hi-Z pyramid. A ray from point P is marched through the depth buffer."
    });
    stage.appendChild(svg);
    root.appendChild(stage);

    var defs = svgEl("defs", null, svg);
    var clip = svgEl("clipPath", { id: "srl-clip" }, defs);
    svgEl("rect", { x: LEFT, y: TOP, width: (WX1 - WX0) * SC, height: (WY1 - WY0) * SC }, clip);
    // The thickness band is only drawn above the floor: below it is solid anyway.
    var clipBand = svgEl("clipPath", { id: "srl-clip-band" }, defs);
    svgEl("rect", { x: LEFT, y: TOP, width: (WX1 - WX0) * SC, height: Y(0) - TOP }, clipBand);
    var mk = svgEl("marker", { id: "srl-arr", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
    svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: "f-acc" }, mk);

    var gScene = svgEl("g", { "clip-path": "url(#srl-clip)" }, svg);
    var gStatic = svgEl("g", null, gScene);
    var gBand = svgEl("g", { "clip-path": "url(#srl-clip-band)" }, gScene);
    var gDepth = svgEl("g", null, gScene);
    var gRays = svgEl("g", null, gScene);
    var gLabels = svgEl("g", null, svg);
    var gStrip = svgEl("g", null, svg);
    var gVisits = svgEl("g", null, svg);
    var handle = svgEl("g", { "aria-label": "Point P", "aria-valuemin": 0, "aria-valuemax": N - 1 }, svg);
    svgEl("circle", { r: 12, class: "f-acc-soft s-acc handle-ring" }, handle);
    svgEl("circle", { r: 5, class: "f-acc" }, handle);
    svgEl("text", { class: "t-acc t-strong mid", y: -17, text: "P" }, handle);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    /* Scene, frustum and depth-buffer strip frames: drawn once. */
    (function drawStatic() {
      var top = rayFor(1), bottom = rayFor(-1);
      var far = 30;
      // Shade outside the frustum: "off screen".
      svgEl("polygon", {
        class: "f-sunken",
        points: [X(CAM.x) + "," + Y(CAM.y), X(CAM.x + top.x * far) + "," + Y(CAM.y + top.y * far), X(WX1 + 5) + "," + Y(WY1 + 5), X(WX0 - 5) + "," + Y(WY1 + 5), X(WX0 - 5) + "," + Y(WY0 - 5), X(CAM.x + bottom.x * far) + "," + Y(CAM.y + bottom.y * far)].join(" ")
      }, gStatic);
      BOXES.forEach(function (b) {
        svgEl("rect", {
          x: X(Math.max(b.x0, WX0 - 1)), y: Y(b.y1),
          width: (Math.min(b.x1, WX1 + 1) - Math.max(b.x0, WX0 - 1)) * SC, height: (b.y1 - Math.max(b.y0, WY0 - 1)) * SC,
          class: b.fill + (b.id === "floor" ? "" : " s-ink")
        }, gStatic);
      });
      svgEl("line", { x1: X(WX0), y1: Y(0), x2: X(WX1), y2: Y(0), class: "s-ink" }, gStatic);
      svgEl("line", { x1: X(CAM.x), y1: Y(CAM.y), x2: X(CAM.x + top.x * far), y2: Y(CAM.y + top.y * far), class: "s-strong dash" }, gStatic);
      svgEl("line", { x1: X(CAM.x), y1: Y(CAM.y), x2: X(CAM.x + bottom.x * far), y2: Y(CAM.y + bottom.y * far), class: "s-strong dash" }, gStatic);
      // Camera body.
      svgEl("polygon", {
        class: "f-ink",
        points: [X(CAM.x) + "," + Y(CAM.y), X(CAM.x - 0.45 * CAM.dx + 0.18 * CAM.sx) + "," + Y(CAM.y - 0.45 * CAM.dy + 0.18 * CAM.sy), X(CAM.x - 0.45 * CAM.dx - 0.18 * CAM.sx) + "," + Y(CAM.y - 0.45 * CAM.dy - 0.18 * CAM.sy)].join(" ")
      }, gStatic);
      // Labels outside the clip.
      svgEl("text", { x: X(0.15), y: Y(2.95), class: "t-small t-muted", text: "camera" }, gLabels);
      svgEl("text", { x: X(4.6), y: Y(4.62), class: "t-caps", text: "OFF SCREEN" }, gLabels);
      svgEl("text", { x: X(0.9), y: Y(-0.25), class: "t-caps", text: "OFF SCREEN" }, gLabels);
      svgEl("text", { x: X(4.7), y: Y(0.35), class: "t-small mid", text: "crate" }, gLabels);
      svgEl("text", { x: X(6.12), y: Y(2.72), class: "t-small t-muted", text: "banner, 5 cm" }, gLabels);
      svgEl("text", { x: X(11.3), y: Y(4.18), class: "t-small t-muted mid", text: "wall" }, gLabels);
      svgEl("rect", { x: LEFT, y: TOP, width: (WX1 - WX0) * SC, height: (WY1 - WY0) * SC, class: "s-strong" }, gLabels);

      // Strip: mip 0 = the depth buffer, then the closest-depth mips.
      svgEl("text", { x: STRIP.x, y: STRIP.y - 9, class: "t-caps", text: "THE DEPTH BUFFER, 64 PIXELS (NEAR IS DARK), AND ITS CLOSEST-DEPTH MIPS" }, gStrip);
      for (var L = 0; L < LEVELS; L++) {
        var row = PYRAMID[L];
        for (var c = 0; c < row.length; c++) {
          var z = row[c];
          svgEl("rect", { x: cellX(L, c), y: rowY(L), width: cellW(L), height: rowH(L), class: "f-buf-hi" }, gStrip);
          if (isFinite(z)) {
            svgEl("rect", { x: cellX(L, c), y: rowY(L), width: cellW(L), height: rowH(L), class: "f-buf-lo", "fill-opacity": (0.92 * Math.max(0, 1 - z / Z_SHADE)).toFixed(3) }, gStrip);
          }
        }
        svgEl("rect", { x: STRIP.x, y: rowY(L), width: STRIP.w, height: rowH(L), class: "s-strong" }, gStrip);
        svgEl("text", { x: STRIP.x - 6, y: rowY(L) + rowH(L) - 2, class: "t-mono t-muted t-small end", text: L === 0 ? "mip 0" : "mip " + L }, gStrip);
      }
      var below = rowY(LEVELS - 1) + STRIP.row + 14;
      svgEl("text", { x: STRIP.x, y: below, class: "t-small t-muted", text: "← bottom of the screen" }, gStrip);
      svgEl("text", { x: STRIP.x + STRIP.w, y: below, class: "t-small t-muted end", text: "top of the screen →" }, gStrip);
      svgEl("text", { x: STRIP.x + STRIP.w / 2, y: below, class: "t-small t-muted mid", text: "outlined cells: depth reads for this ray" }, gStrip);
    })();

    /* Behind every visible surface, a band `thickness` deep: what the
       tracer treats as solid. Beyond it the ray is assumed to pass behind. */
    function drawBand() {
      HB.svg.clear(gBand);
      HB.svg.clear(gDepth);
      for (var p = 0; p < N; p++) {
        var d = DEPTH[p];
        if (!d.box) continue;
        var a = rayFor(uOfEdge(p)), b = rayFor(uOfEdge(p + 1));
        var ka = 1 / (a.x * CAM.dx + a.y * CAM.dy), kb = 1 / (b.x * CAM.dx + b.y * CAM.dy);
        var z1 = d.z, z2 = d.z + state.thickness;
        var pts = [
          [CAM.x + a.x * ka * z1, CAM.y + a.y * ka * z1], [CAM.x + b.x * kb * z1, CAM.y + b.y * kb * z1],
          [CAM.x + b.x * kb * z2, CAM.y + b.y * kb * z2], [CAM.x + a.x * ka * z2, CAM.y + a.y * ka * z2]
        ];
        svgEl("polygon", { class: "f-pix-soft", "fill-opacity": 0.85, points: pts.map(function (q) { return X(q[0]).toFixed(1) + "," + Y(q[1]).toFixed(1); }).join(" ") }, gBand);
      }
      SURFACE.forEach(function (sg) {
        svgEl("line", { x1: X(sg.x1).toFixed(1), y1: Y(sg.y1).toFixed(1), x2: X(sg.x2).toFixed(1), y2: Y(sg.y2).toFixed(1), class: "s-pix w3 round" }, gDepth);
      });
    }

    /* The last point of the segment o -> e that is inside the drawn view
       (shrunk by a small margin), so end markers stay visible. */
    function clipToView(o, e) {
      var m = 0.15;
      var t1 = 1;
      var dx = e.x - o.x, dy = e.y - o.y;
      [[dx, WX1 - m - o.x], [-dx, o.x - (WX0 + m)], [dy, WY1 - m - o.y], [-dy, o.y - (WY0 + m)]].forEach(function (pq) {
        if (pq[0] > 1e-12) t1 = Math.min(t1, pq[1] / pq[0]);
      });
      t1 = Math.max(0, t1);
      return { x: o.x + dx * t1, y: o.y + dy * t1 };
    }

    function drawRay(o, dir, res, showTruth) {
      var m = res.march;
      var k = KIND[res.kind];
      svgEl("line", { x1: X(o.x), y1: Y(o.y), x2: X(m.end.x), y2: Y(m.end.y), class: k.line + " w2" }, gRays);
      if (showTruth && res.truth) {
        svgEl("line", { x1: X(o.x), y1: Y(o.y), x2: X(res.truth.x), y2: Y(res.truth.y), class: "s-ink dot-dash" }, gRays);
        svgEl("circle", { cx: X(res.truth.x), cy: Y(res.truth.y), r: 6, class: "s-ink w15" }, gRays);
      }
      m.samples.forEach(function (s) {
        var r = s.level ? 2.2 + s.level * 0.9 : 2.6;
        var cls = s.state === "behind" ? "f-pix" : s.state === "hit" ? "f-acc" : "f-surface s-acc";
        svgEl("circle", { cx: X(s.x), cy: Y(s.y), r: r, class: cls }, gRays);
      });
      if (m.result === "hit") {
        var d = DEPTH[m.pixel];
        svgEl("circle", { cx: X(m.end.x), cy: Y(m.end.y), r: 6.5, class: d.box.fill + " s-ink w15" }, gRays);
      } else {
        // Fallback marker where the ray leaves the view, kept inside the frame.
        var f = FALLBACK[state.fallback];
        var q = clipToView(o, m.end);
        svgEl("rect", { x: X(q.x) - 6, y: Y(q.y) - 6, width: 12, height: 12, rx: 2, class: f.fill }, gRays);
      }
    }

    function drawVisits(list) {
      HB.svg.clear(gVisits);
      var seen = {};
      list.forEach(function (v) {
        var key = v.level + ":" + v.cell + ":" + v.state;
        if (seen[key]) return;
        seen[key] = true;
        var cls = v.state === "behind" ? "s-pix w2" : v.state === "hit" ? "s-acc w3" : "s-acc w15";
        svgEl("rect", { x: cellX(v.level, v.cell) + 0.8, y: rowY(v.level) + 0.8, width: cellW(v.level) - 1.6, height: rowH(v.level) - 1.6, class: cls }, gVisits);
      });
    }

    function opts() {
      return { march: state.march, thickness: state.thickness, step: state.step, maxSteps: 48, maxIter: 64 };
    }

    function otherReads(o, dir) {
      var lin = marchLinear(o, dir, { thickness: state.thickness, step: state.step, maxSteps: 48 }).reads;
      var hz = marchHiZ(o, dir, { thickness: state.thickness, maxIter: 64 }).reads;
      return { linear: lin, hiz: hz, every: pixelsCrossed(o, dir, state.thickness) };
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function draw() {
      HB.svg.clear(gRays);
      drawBand();
      var o = originFor(state.pixel);
      var allVisits = [];
      var readsLin = 0, readsHiz = 0, readsEvery = 0;
      if (state.mode === "reflect") {
        var dir = mirror(o);
        var res = trace(o, dir, opts());
        drawRay(o, dir, res, true);
        allVisits = res.march.visits;
        var rr = otherReads(o, dir);
        var k = KIND[res.kind];
        var label = k.label;
        if (res.march.behind && (res.kind === "steps" || res.kind === "offscreen")) label = "Passed behind a surface, then " + (res.kind === "steps" ? "ran out of steps" : "left the screen");
        var colour;
        if (res.march.result === "hit") colour = DEPTH[res.march.pixel].box.name + (res.kind === "correct" ? "" : " (wrong)");
        else colour = FALLBACK[state.fallback].label;
        var really = res.truth
          ? res.truth.box.name + (res.truth.visible ? "" : res.truth.onScreen ? ", hidden from the camera" : ", off screen")
          : "nothing: open sky";
        readout.replaceChildren(
          cell("Depth reads: linear / every pixel / Hi-Z", rr.linear + " / " + rr.every + " / " + rr.hiz),
          cell("Result", label),
          cell("Reflection shows", colour),
          cell("The ray really hits", really)
        );
        handle.setAttribute("aria-valuetext", "P on " + o.box.name + ". " + label + ". Reflection shows " + colour + ".");
      } else {
        var counts = { good: 0, bad: 0, fall: 0 };
        fan(o).forEach(function (d2) {
          var r2 = trace(o, d2, opts());
          drawRay(o, d2, r2, false);
          allVisits = allVisits.concat(r2.march.visits);
          var rr2 = otherReads(o, d2);
          readsLin += rr2.linear;
          readsHiz += rr2.hiz;
          readsEvery += rr2.every;
          if (r2.kind === "correct") counts.good++;
          else if (r2.kind === "offscreen" || r2.kind === "steps") counts.fall++;
          else counts.bad++;
        });
        readout.replaceChildren(
          cell("Reads for 9 rays: linear / every pixel / Hi-Z", readsLin + " / " + readsEvery + " / " + readsHiz),
          cell("Correct hits", String(counts.good)),
          cell("Wrong or missed", String(counts.bad)),
          cell("Fell back to " + (state.fallback === "none" ? "nothing" : state.fallback), String(counts.fall))
        );
        handle.setAttribute("aria-valuetext", "P on " + o.box.name + ". " + counts.good + " correct, " + counts.bad + " wrong, " + counts.fall + " fell back.");
      }
      drawVisits(allVisits);
      handle.setAttribute("transform", "translate(" + X(o.x).toFixed(1) + "," + Y(o.y).toFixed(1) + ")");
      handle.setAttribute("aria-valuenow", String(state.pixel));
    }

    function moveTo(pixel, dir) {
      var p2 = Math.max(0, Math.min(N - 1, pixel));
      // Skip sky pixels in the direction of travel.
      while (!DEPTH[p2].box) {
        p2 += dir || 1;
        if (p2 < 0 || p2 >= N) return;
      }
      if (p2 === state.pixel) return;
      state.pixel = p2;
      clearExample();
      draw();
    }

    HB.draggable(svg, handle, {
      onDrag: function (pt) {
        var w = fromSvg(pt.x, pt.y);
        var pr = project(w.x, w.y);
        if (pr.behind) return;
        var target = Math.max(0, Math.min(N - 1, Math.floor(((Math.max(-1, Math.min(1, pr.u)) + 1) / 2) * N)));
        moveTo(target, target >= state.pixel ? 1 : -1);
      },
      onKey: function (dir, big) { moveTo(state.pixel + dir * (big ? 4 : 1), dir); }
    });

    syncStep();
    draw();
    if (log) log.debug("ready");
  }

  if (HB.demos && HB.demos.register) HB.demos.register("screen-ray-lab", init);
})();

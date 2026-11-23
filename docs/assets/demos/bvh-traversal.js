/*
 * bvh-traversal.js: chapter 8.6's interactive.
 *
 * A 2D scene of 40 triangles inside a bounding volume hierarchy (BVH),
 * drawn twice: as nested boxes over the scene, and as the tree those boxes
 * form. The reader drags the start of a ray and its aim point, then steps
 * through the traversal one test at a time.
 *
 * Build: top-down, splitting each node's triangles at the median of their
 * centroids along the longer axis, until a node holds 3 or fewer (a leaf).
 * Real builders choose splits with the surface area heuristic; the median
 * keeps this one easy to follow. Every box is drawn, and tested, slightly
 * enlarged per level so parents and children never share an edge on screen.
 * Enlarging a box only makes the test more conservative, never wrong.
 *
 * Traversal, as GPUs do it for a closest-hit ray:
 *   1. Test the root box. A miss ends everything.
 *   2. Pop a node from a stack. If a closer hit was found since the node was
 *      pushed (its entry distance is beyond the closest hit), skip it.
 *   3. Interior node: test both children's boxes. Push the ones the ray
 *      enters, the farther one first, so the nearer one is visited next.
 *      A child entered beyond the closest hit is skipped at once.
 *   4. Leaf: test the ray against each triangle; keep the closest hit.
 * An any-hit ray (a shadow ray towards a light) has a fixed length and stops
 * at the first triangle it hits, because it only needs a yes or no.
 *
 * Each test is recorded as an event, so the figure can replay any prefix of
 * the traversal: boxes entered, boxes missed (everything inside skipped),
 * boxes skipped as farther than the closest hit, and triangles tested.
 *
 * Exposed as HB.bvhTraversal for tests and offline figure generation.
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var log = HB.log && HB.log.scope ? HB.log.scope("bvh-traversal") : null;

  /* ---------- Scene: 40 triangles in six clusters ---------- */

  var SCENE = { w: 520, h: 370 };   // scene units are SVG pixels
  var LEAF_MAX = 3;

  /* Clusters: centre, spread and triangle count. A seeded generator places
     the triangles, so the scene is the same on every load. */
  var CLUSTERS = [
    { x: 100, y: 272, sx: 42, sy: 32, n: 7 },   // crates, bottom left
    { x: 112, y: 100, sx: 52, sy: 40, n: 7 },   // tree canopy, top left
    { x: 262, y: 192, sx: 28, sy: 52, n: 6 },   // statue, middle
    { x: 408, y: 282, sx: 58, sy: 28, n: 7 },   // barrels, bottom right
    { x: 418, y: 104, sx: 48, sy: 42, n: 7 },   // rocks, top right
    { x: 272, y: 72, sx: 38, sy: 14, n: 6 }     // bird, top middle
  ];

  function makeTriangles() {
    var rand = HB.rng ? HB.rng(8061) : Math.random;
    var tris = [];
    CLUSTERS.forEach(function (c) {
      for (var i = 0; i < c.n; i++) {
        var cx = c.x + (rand() * 2 - 1) * c.sx;
        var cy = c.y + (rand() * 2 - 1) * c.sy;
        var size = 13 + rand() * 13;
        var a0 = rand() * Math.PI * 2;
        var pts = [];
        for (var k = 0; k < 3; k++) {
          var a = a0 + (k * 2 * Math.PI) / 3 + (rand() - 0.5) * 0.9;
          var r = size * (0.7 + rand() * 0.45);
          pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
        }
        tris.push({ id: tris.length, p: pts, cx: (pts[0].x + pts[1].x + pts[2].x) / 3, cy: (pts[0].y + pts[1].y + pts[2].y) / 3 });
      }
    });
    return tris;
  }

  /* ---------- BVH build ---------- */

  function boundsOf(list) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    list.forEach(function (t) {
      t.p.forEach(function (q) {
        if (q.x < b.x0) b.x0 = q.x;
        if (q.y < b.y0) b.y0 = q.y;
        if (q.x > b.x1) b.x1 = q.x;
        if (q.y > b.y1) b.y1 = q.y;
      });
    });
    return b;
  }

  function build(tris) {
    var nodes = [];
    function make(list, depth) {
      var node = { id: nodes.length, depth: depth, tris: null, kids: null, b: boundsOf(list), count: list.length };
      nodes.push(node);
      if (list.length <= LEAF_MAX) {
        node.tris = list.map(function (t) { return t.id; });
        return node;
      }
      // Split at the median centroid along the longer axis of the centroids.
      var cb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      list.forEach(function (t) {
        cb.x0 = Math.min(cb.x0, t.cx); cb.x1 = Math.max(cb.x1, t.cx);
        cb.y0 = Math.min(cb.y0, t.cy); cb.y1 = Math.max(cb.y1, t.cy);
      });
      var axis = cb.x1 - cb.x0 >= cb.y1 - cb.y0 ? "cx" : "cy";
      var sorted = list.slice().sort(function (a, b) { return a[axis] - b[axis] || a.id - b.id; });
      var mid = Math.floor(sorted.length / 2);
      node.kids = [make(sorted.slice(0, mid), depth + 1), make(sorted.slice(mid), depth + 1)];
      return node;
    }
    var root = make(tris, 0);
    // Height above the deepest leaf below, for the drawing pad.
    function height(n) {
      n.height = n.kids ? 1 + Math.max(height(n.kids[0]), height(n.kids[1])) : 0;
      return n.height;
    }
    height(root);
    nodes.forEach(function (n) {
      var pad = 2 + n.height * 3;
      n.box = { x0: n.b.x0 - pad, y0: n.b.y0 - pad, x1: n.b.x1 + pad, y1: n.b.y1 + pad };
    });
    return { root: root, nodes: nodes };
  }

  /* ---------- Intersection tests ---------- */

  /* Slab test: entry distance, or null for a miss within [0, tMax]. */
  function rayBox(o, d, box, tMax) {
    var t0 = 0;
    var t1 = tMax;
    var inv, ta, tb, tmp;
    if (Math.abs(d.x) < 1e-12) {
      if (o.x < box.x0 || o.x > box.x1) return null;
    } else {
      inv = 1 / d.x;
      ta = (box.x0 - o.x) * inv; tb = (box.x1 - o.x) * inv;
      if (ta > tb) { tmp = ta; ta = tb; tb = tmp; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (Math.abs(d.y) < 1e-12) {
      if (o.y < box.y0 || o.y > box.y1) return null;
    } else {
      inv = 1 / d.y;
      ta = (box.y0 - o.y) * inv; tb = (box.y1 - o.y) * inv;
      if (ta > tb) { tmp = ta; ta = tb; tb = tmp; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    return t0 <= t1 ? t0 : null;
  }

  /* Ray against one edge segment: distance along the ray, or Infinity. */
  function raySegment(o, d, a, b) {
    var ex = b.x - a.x;
    var ey = b.y - a.y;
    var den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) return Infinity;
    var ax = a.x - o.x;
    var ay = a.y - o.y;
    var t = (ax * ey - ay * ex) / den;
    var s = (ax * d.y - ay * d.x) / den;
    return t > 1e-6 && s >= 0 && s <= 1 ? t : Infinity;
  }

  /* In 2D a triangle is hit where the ray first crosses one of its edges. */
  function rayTri(o, d, tri, tMax) {
    var t = Math.min(raySegment(o, d, tri.p[0], tri.p[1]), raySegment(o, d, tri.p[1], tri.p[2]), raySegment(o, d, tri.p[2], tri.p[0]));
    return t <= tMax ? t : Infinity;
  }

  /* ---------- Traversal, recorded as events ---------- */

  /*
   * mode "closest": tMax is the scene edge; keep the nearest hit.
   * mode "any":     tMax is the light; stop at the first hit.
   * Returns { events, hit, tHit, boxTests, triTests }.
   */
  function traverse(bvh, tris, o, d, tMax, mode) {
    var events = [];
    var tClosest = tMax;
    var hit = null;
    var rootT = rayBox(o, d, bvh.root.box, tMax);
    events.push({ k: "box", node: bvh.root.id, tIn: rootT, enter: rootT !== null });
    var stack = rootT === null ? [] : [{ node: bvh.root, tIn: rootT }];
    var done = false;
    while (stack.length && !done) {
      var item = stack.pop();
      var node = item.node;
      if (hit && item.tIn > tClosest) {
        events.push({ k: "prune", node: node.id, tIn: item.tIn, tClosest: tClosest });
        continue;
      }
      if (node.tris) {
        for (var i = 0; i < node.tris.length; i++) {
          var tri = tris[node.tris[i]];
          var t = rayTri(o, d, tri, tMax);
          var closer = t < tClosest;
          events.push({ k: "tri", tri: tri.id, node: node.id, t: t, hitTri: t < Infinity, closer: closer });
          if (closer) {
            tClosest = t;
            hit = tri.id;
            if (mode === "any") { done = true; break; }
          }
        }
        continue;
      }
      var tests = node.kids.map(function (kid) {
        var tIn = rayBox(o, d, kid.box, tMax);
        var beyond = tIn !== null && hit !== null && tIn > tClosest;
        events.push({ k: "box", node: kid.id, tIn: tIn, enter: tIn !== null && !beyond, beyond: beyond });
        return { node: kid, tIn: tIn, ok: tIn !== null && !beyond };
      }).filter(function (x) { return x.ok; });
      // Farther child first, so the nearer one comes off the stack next.
      tests.sort(function (a, b) { return b.tIn - a.tIn; });
      tests.forEach(function (x) { stack.push(x); });
    }
    var boxTests = 0;
    var triTests = 0;
    events.forEach(function (e) {
      if (e.k === "box") boxTests++;
      if (e.k === "tri") triTests++;
    });
    return { events: events, hit: hit, tHit: hit === null ? null : tClosest, boxTests: boxTests, triTests: triTests };
  }

  var TRIS = makeTriangles();
  var BVH = build(TRIS);

  HB.bvhTraversal = { scene: SCENE, tris: TRIS, bvh: BVH, traverse: traverse, rayBox: rayBox, rayTri: rayTri };

  /* ---------- The figure ---------- */

  var VIEW = { w: 860, h: 452 };
  var SX = 14;           // scene panel offset in the SVG
  var SY = 34;
  var TREE = { x0: 566, x1: 848, y0: 50, dy: 62 };

  function init(root) {
    var svgEl = HB.svg.el;
    var h = HB.html;
    var reduced = HB.demos.reducedMotion();

    var state = {
      o: { x: 20, y: 350 },          // ray start, scene units
      aim: { x: 220, y: 100 },       // aim point (the light, for a shadow ray)
      mode: "closest",
      step: 0,                       // events shown; set to the end on change
      playing: false,
      visible: true
    };
    var result = null;

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "BVH traversal" }),
      h("span", { class: "demo-hint", text: "Drag the ray's start or its aim point (or focus one and use the arrow keys), then step through the tests." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Ray", [
      { value: "closest", label: "Closest hit (reflection)" },
      { value: "any", label: "Any hit (shadow ray)" }
    ], state.mode, function (v) { state.mode = v; recompute(true); }));

    var restartBtn = h("button", { type: "button", class: "btn", text: "Restart" });
    var stepBtn = h("button", { type: "button", class: "btn is-primary", text: "Step" });
    var endBtn = h("button", { type: "button", class: "btn", text: "Show all" });
    var playBtn = reduced ? null : h("button", { type: "button", class: "btn", "aria-pressed": "false", text: "Play" });
    var stepRow = h("div", { class: "control" }, [
      h("span", { class: "label", text: "Traversal" }),
      h("div", { style: "display:flex;gap:.4rem;flex-wrap:wrap" }, [restartBtn, stepBtn, playBtn, endBtn])
    ]);
    controls.appendChild(stepRow);
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VIEW.w + " " + VIEW.h,
      role: "group",
      "aria-label": "Left: forty triangles in six clusters, wrapped in nested boxes, with a ray crossing the scene. Right: the same boxes as a tree, from the root box at the top to the leaf boxes holding triangles at the bottom."
    });
    stage.appendChild(svg);
    root.appendChild(stage);

    var stepText = h("p", { class: "demo-hint", "aria-live": "polite" });
    root.appendChild(stepText);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    var defs = svgEl("defs", null, svg);
    var clip = svgEl("clipPath", { id: "bvt-clip" }, defs);
    // The clip applies inside the translated scene group, so it starts at 0, 0.
    svgEl("rect", { x: 0, y: 0, width: SCENE.w, height: SCENE.h }, clip);
    var mk = svgEl("marker", { id: "bvt-arr", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs);
    svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: "f-acc" }, mk);

    svgEl("text", { x: SX, y: 22, class: "t-caps", text: "THE SCENE: 40 TRIANGLES INSIDE NESTED BOXES" }, svg);
    svgEl("text", { x: TREE.x0, y: 22, class: "t-caps", text: "THE SAME BOXES AS A TREE" }, svg);
    svgEl("rect", { x: SX, y: SY, width: SCENE.w, height: SCENE.h, class: "f-bg s-strong" }, svg);

    var gScene = svgEl("g", { "clip-path": "url(#bvt-clip)", transform: "translate(" + SX + "," + SY + ")" }, svg);
    var gFill = svgEl("g", null, gScene);
    var gTris = svgEl("g", null, gScene);
    var gBoxes = svgEl("g", null, gScene);
    var gRay = svgEl("g", null, gScene);
    var gTree = svgEl("g", null, svg);
    var gHandles = svgEl("g", { transform: "translate(" + SX + "," + SY + ")" }, svg);

    /* Shapes, built once and restyled each step. */
    var triEls = TRIS.map(function (t) {
      return svgEl("polygon", { points: t.p.map(function (q) { return q.x.toFixed(1) + "," + q.y.toFixed(1); }).join(" ") }, gTris);
    });
    // Parents before children, so leaf boxes draw on top.
    var order = BVH.nodes.slice().sort(function (a, b) { return a.depth - b.depth; });
    var fillEls = {};
    var boxEls = {};
    order.forEach(function (n) {
      fillEls[n.id] = svgEl("rect", { x: n.box.x0, y: n.box.y0, width: n.box.x1 - n.box.x0, height: n.box.y1 - n.box.y0, rx: 3, class: "f-sunken", opacity: 0 }, gFill);
      boxEls[n.id] = svgEl("rect", { x: n.box.x0, y: n.box.y0, width: n.box.x1 - n.box.x0, height: n.box.y1 - n.box.y0, rx: 3 }, gBoxes);
    });

    /* Tree layout: leaves spread evenly in order, parents centred above. */
    var leaves = [];
    (function collect(n) {
      if (n.kids) { collect(n.kids[0]); collect(n.kids[1]); } else leaves.push(n);
    })(BVH.root);
    var maxDepth = 0;
    BVH.nodes.forEach(function (n) { maxDepth = Math.max(maxDepth, n.depth); });
    var dy = Math.min(TREE.dy, (VIEW.h - 96 - TREE.y0) / Math.max(1, maxDepth));
    var leafGap = (TREE.x1 - TREE.x0) / leaves.length;
    leaves.forEach(function (n, i) { n.tx = TREE.x0 + leafGap * (i + 0.5); });
    (function place(n) {
      if (n.kids) { place(n.kids[0]); place(n.kids[1]); n.tx = (n.kids[0].tx + n.kids[1].tx) / 2; }
      n.ty = TREE.y0 + n.depth * dy;
    })(BVH.root);
    var gEdges = svgEl("g", null, gTree);
    BVH.nodes.forEach(function (n) {
      if (!n.kids) return;
      n.kids.forEach(function (k) {
        svgEl("line", { x1: n.tx, y1: n.ty + 6, x2: k.tx, y2: k.ty - 6, class: "s-line" }, gEdges);
      });
    });
    var nodeEls = {};
    var leafTriEls = {};
    var nodeSize = Math.min(14, leafGap - 4);
    BVH.nodes.forEach(function (n) {
      nodeEls[n.id] = svgEl("rect", { x: n.tx - nodeSize / 2, y: n.ty - nodeSize / 2, width: nodeSize, height: nodeSize, rx: 2 }, gTree);
      if (n.tris) {
        // One small mark per triangle under each leaf.
        leafTriEls[n.id] = n.tris.map(function (tid, j) {
          return svgEl("rect", { x: n.tx - 2.5, y: n.ty + 11 + j * 7, width: 5, height: 5, "data-tri": tid }, gTree);
        });
      }
    });
    svgEl("text", { x: BVH.root.tx + 12, y: BVH.root.ty + 4, class: "t-small t-muted", text: "root: the whole scene" }, gTree);
    var lastLeafY = TREE.y0 + maxDepth * dy + 11 + LEAF_MAX * 7;
    svgEl("text", { x: TREE.x0, y: lastLeafY + 14, class: "t-small t-muted", text: "leaves hold 1 to " + LEAF_MAX + " triangles (small squares)" }, gTree);

    /* Legend under the scene. */
    (function legend() {
      var y = SY + SCENE.h + 26;
      var x = SX;
      function item(draw, label, w) {
        draw(x, y - 9);
        svgEl("text", { x: x + 20, y: y, class: "t-small", text: label }, svg);
        x += w;
      }
      item(function (lx, ly) { svgEl("rect", { x: lx, y: ly, width: 14, height: 11, rx: 2, class: "s-acc w2" }, svg); }, "box entered", 104);
      item(function (lx, ly) { svgEl("rect", { x: lx, y: ly, width: 14, height: 11, rx: 2, class: "f-sunken s-muted w15" }, svg); }, "box missed: all inside skipped", 196);
      item(function (lx, ly) { svgEl("rect", { x: lx, y: ly, width: 14, height: 11, rx: 2, class: "f-sunken s-muted dash" }, svg); }, "beyond the closest hit: skipped", 204);
      item(function (lx, ly) { svgEl("polygon", { points: (lx + 7) + "," + ly + " " + (lx + 14) + "," + (ly + 11) + " " + lx + "," + (ly + 11), class: "f-geo-soft s-ink w15" }, svg); }, "triangle tested", 112);
      item(function (lx, ly) { svgEl("polygon", { points: (lx + 7) + "," + ly + " " + (lx + 14) + "," + (ly + 11) + " " + lx + "," + (ly + 11), class: "f-acc" }, svg); }, "closest hit", 90);
    })();

    /* Handles: the ray's start and its aim point. */
    var hStart = svgEl("g", { "aria-label": "Ray start" }, gHandles);
    svgEl("circle", { r: 12, class: "f-acc-soft s-acc handle-ring" }, hStart);
    svgEl("circle", { r: 4.5, class: "f-acc" }, hStart);
    var hAim = svgEl("g", { "aria-label": "Aim point" }, gHandles);
    var aimRing = svgEl("circle", { r: 11, class: "f-surface s-acc w15 handle-ring" }, hAim);
    var aimDot = svgEl("circle", { r: 3.5, class: "f-acc" }, hAim);
    var aimLabel = svgEl("text", { y: -16, class: "t-small t-acc t-strong mid", text: "aim" }, hAim);

    function dirAndLength() {
      var dx = state.aim.x - state.o.x;
      var dyv = state.aim.y - state.o.y;
      var len = Math.hypot(dx, dyv) || 1;
      var d = { x: dx / len, y: dyv / len };
      var tMax;
      if (state.mode === "any") {
        tMax = len;                      // the shadow ray stops at the light
      } else {
        // To the edge of the scene.
        var tx = d.x > 0 ? (SCENE.w - state.o.x) / d.x : d.x < 0 ? -state.o.x / d.x : Infinity;
        var ty = d.y > 0 ? (SCENE.h - state.o.y) / d.y : d.y < 0 ? -state.o.y / d.y : Infinity;
        tMax = Math.min(tx, ty);
      }
      return { d: d, tMax: tMax };
    }

    function recompute(showAll) {
      var r = dirAndLength();
      result = traverse(BVH, TRIS, state.o, r.d, r.tMax, state.mode);
      result.d = r.d;
      result.tMax = r.tMax;
      if (showAll) state.step = result.events.length;
      state.step = Math.min(state.step, result.events.length);
      draw();
    }

    /* Replay the first `state.step` events into per-node and per-triangle states. */
    function replay() {
      var nodeState = {};
      var triState = {};
      var tClosest = result.tMax;
      var closest = null;
      var boxes = 0;
      var trisTested = 0;
      for (var i = 0; i < state.step; i++) {
        var e = result.events[i];
        if (e.k === "box") {
          boxes++;
          nodeState[e.node] = e.enter ? "entered" : e.beyond ? "beyond" : "missed";
        } else if (e.k === "prune") {
          nodeState[e.node] = "pruned";
        } else if (e.k === "tri") {
          trisTested++;
          triState[e.tri] = e.closer ? "hit" : e.hitTri ? "behind" : "tested";
          if (e.closer) {
            if (closest !== null) triState[closest] = "behind";
            closest = e.tri;
            tClosest = e.t;
          }
        }
      }
      return { nodeState: nodeState, triState: triState, closest: closest, tClosest: tClosest, boxes: boxes, tris: trisTested };
    }

    /* Everything under a missed or skipped box was skipped with it. */
    function skippedSet(nodeState) {
      var skipped = {};
      function mark(n) {
        skipped[n.id] = true;
        if (n.kids) { mark(n.kids[0]); mark(n.kids[1]); }
      }
      BVH.nodes.forEach(function (n) {
        var s = nodeState[n.id];
        if (s === "missed" || s === "beyond" || s === "pruned") mark(n);
      });
      return skipped;
    }

    function boxClass(s) {
      if (s === "entered") return "s-acc w2";
      if (s === "missed") return "s-muted w15";
      if (s === "beyond" || s === "pruned") return "s-muted w15 dash";
      return "s-line";
    }

    function describe(e) {
      var n = e && e.node !== undefined ? BVH.nodes[e.node] : null;
      if (!e) return "";
      if (e.k === "box") {
        var what = n.tris ? "leaf box holding " + n.count + " triangle" + (n.count > 1 ? "s" : "") : "box holding " + n.count + " triangles";
        if (e.enter) return "Test " + what + ": the ray enters it, so " + (n.tris ? "its triangles are tested next." : "its two child boxes are tested next.");
        if (e.beyond) return "Test " + what + ": the ray enters it, but farther away than the closest hit so far, so all " + n.count + " are skipped.";
        return "Test " + what + ": the ray misses it, so all " + n.count + " triangles inside are skipped without a single triangle test.";
      }
      if (e.k === "prune") return "Take the next box off the stack: a closer hit was found since it was queued, so its " + n.count + " triangles are skipped.";
      if (e.k === "tri") {
        if (e.closer) return state.mode === "any"
          ? "Test triangle " + e.tri + ": hit. Something blocks the light, so the shadow ray stops here."
          : "Test triangle " + e.tri + ": hit at distance " + Math.round(e.t) + ", the closest so far. Boxes that start beyond it can now be skipped.";
        if (e.hitTri) return "Test triangle " + e.tri + ": hit, but behind the closest hit so far.";
        return "Test triangle " + e.tri + ": missed.";
      }
      return "";
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function draw() {
      var rp = replay();
      var skipped = skippedSet(rp.nodeState);
      var current = state.step > 0 ? result.events[state.step - 1] : null;

      BVH.nodes.forEach(function (n) {
        var s = rp.nodeState[n.id];
        boxEls[n.id].setAttribute("class", boxClass(s));
        fillEls[n.id].setAttribute("opacity", s === "missed" || s === "beyond" || s === "pruned" ? 0.55 : 0);
        var cls = s === "entered" ? "f-acc-soft s-acc w15" : s === "missed" ? "f-sunken s-muted w15" : s === "beyond" || s === "pruned" ? "f-sunken s-muted w15 dash" : skipped[n.id] ? "f-sunken s-line" : "f-surface s-line";
        if (current && current.node === n.id && current.k !== "tri") cls = cls.replace("w15", "").replace("s-line", "s-ink") + " w3";
        nodeEls[n.id].setAttribute("class", cls);
        if (leafTriEls[n.id]) {
          leafTriEls[n.id].forEach(function (el) {
            var ts = rp.triState[Number(el.getAttribute("data-tri"))];
            el.setAttribute("class", ts === "hit" ? "f-acc" : ts ? "f-geo s-ink" : "f-geo-soft");
          });
        }
      });
      TRIS.forEach(function (t, i) {
        var ts = rp.triState[t.id];
        var cls = ts === "hit" ? "f-acc s-acc w15" : ts === "behind" ? "f-acc-soft s-ink w15" : ts === "tested" ? "f-geo-soft s-ink w15" : "f-geo-soft s-geo";
        if (current && current.k === "tri" && current.tri === t.id) cls += " w3";
        triEls[i].setAttribute("class", cls);
        triEls[i].setAttribute("opacity", ts ? 1 : 0.7);
      });

      // The ray: solid up to the closest hit so far, dashed beyond it.
      HB.svg.clear(gRay);
      var o = state.o;
      var d = result.d;
      var tEnd = rp.closest !== null ? rp.tClosest : result.tMax;
      svgEl("line", { x1: o.x, y1: o.y, x2: o.x + d.x * tEnd, y2: o.y + d.y * tEnd, class: "s-acc w2 round" }, gRay);
      if (tEnd < result.tMax) {
        svgEl("line", { x1: o.x + d.x * tEnd, y1: o.y + d.y * tEnd, x2: o.x + d.x * result.tMax, y2: o.y + d.y * result.tMax, class: "s-acc dot-dash" }, gRay);
      }
      if (state.mode === "closest") {
        var ax = o.x + d.x * Math.min(result.tMax, 60);
        var ay = o.y + d.y * Math.min(result.tMax, 60);
        svgEl("line", { x1: o.x, y1: o.y, x2: ax, y2: ay, class: "s-acc w2", "marker-end": "url(#bvt-arr)" }, gRay);
      }
      if (rp.closest !== null) {
        svgEl("circle", { cx: o.x + d.x * tEnd, cy: o.y + d.y * tEnd, r: 5, class: "f-surface s-acc w2" }, gRay);
      }

      hStart.setAttribute("transform", "translate(" + o.x.toFixed(1) + "," + o.y.toFixed(1) + ")");
      hAim.setAttribute("transform", "translate(" + state.aim.x.toFixed(1) + "," + state.aim.y.toFixed(1) + ")");
      var isLight = state.mode === "any";
      aimRing.setAttribute("class", (isLight ? "f-lit-soft s-lit w2" : "f-surface s-acc w15") + " handle-ring");
      aimDot.setAttribute("class", isLight ? "f-lit" : "f-acc");
      aimLabel.setAttribute("class", "t-small t-strong mid " + (isLight ? "t-lit" : "t-acc"));
      aimLabel.textContent = isLight ? "light" : "aim";

      var finished = state.step >= result.events.length;
      var resultText;
      if (!finished) resultText = "step " + state.step + " of " + result.events.length;
      else if (result.hit === null) resultText = isLight ? "nothing in the way: lit" : "missed everything";
      else resultText = isLight ? "blocked: in shadow" : "hit triangle " + result.hit;
      readout.replaceChildren(
        cell("Box tests", String(rp.boxes)),
        cell("Triangle tests", String(rp.tris)),
        cell("Testing every triangle", String(TRIS.length)),
        cell("Result", resultText)
      );
      if (state.step === 0) {
        stepText.textContent = "Press Step to test the first box, the root, which holds the whole scene.";
      } else if (finished) {
        var total = result.boxTests + result.triTests;
        stepText.textContent = (result.hit === null
          ? (isLight ? "Done: no triangle blocks the light." : "Done: the ray left the scene without hitting a triangle.")
          : isLight
            ? "Done: the first hit ends a shadow ray. "
            : "Done: the closest hit is triangle " + result.hit + ". ") +
          " " + result.boxTests + " box tests and " + result.triTests + " triangle tests, " + total + " in all, instead of " + TRIS.length + " triangle tests.";
      } else {
        stepText.textContent = describe(current);
      }
      stepBtn.disabled = finished;
      endBtn.disabled = finished;
      restartBtn.disabled = state.step === 0;
      if (playBtn && finished && state.playing) { state.playing = false; syncPlay(); }
      hStart.setAttribute("aria-valuetext", "Ray start at " + Math.round(o.x) + ", " + Math.round(o.y) + ". " + resultText);
      hAim.setAttribute("aria-valuetext", (isLight ? "Light" : "Aim point") + " at " + Math.round(state.aim.x) + ", " + Math.round(state.aim.y));
    }

    /* ---------- Stepping and playback ---------- */

    var timer = 0;
    function syncPlay() {
      if (!playBtn) return;
      playBtn.textContent = state.playing ? "Pause" : "Play";
      playBtn.setAttribute("aria-pressed", state.playing ? "true" : "false");
    }
    function tick() {
      timer = 0;
      if (!state.playing || !state.visible) return;
      if (state.step < result.events.length) {
        state.step++;
        draw();
      }
      if (state.step >= result.events.length) { state.playing = false; syncPlay(); return; }
      timer = window.setTimeout(tick, 420);
    }
    function schedule() {
      if (state.playing && state.visible && !timer) timer = window.setTimeout(tick, 420);
      else if ((!state.playing || !state.visible) && timer) { window.clearTimeout(timer); timer = 0; }
    }
    function stopPlay() {
      state.playing = false;
      syncPlay();
      schedule();
    }

    restartBtn.addEventListener("click", function () { stopPlay(); state.step = 0; draw(); });
    stepBtn.addEventListener("click", function () { stopPlay(); state.step = Math.min(result.events.length, state.step + 1); draw(); });
    endBtn.addEventListener("click", function () { stopPlay(); state.step = result.events.length; draw(); });
    if (playBtn) {
      playBtn.addEventListener("click", function () {
        if (state.playing) { stopPlay(); return; }
        if (state.step >= result.events.length) state.step = 0;
        state.playing = true;
        syncPlay();
        draw();
        schedule();
      });
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          state.visible = entries[entries.length - 1].isIntersecting;
          schedule();
        }).observe(root);
      }
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) { state.visible = false; schedule(); }
      });
    }

    /* ---------- Dragging ---------- */

    function clampPt(p) {
      return { x: Math.max(6, Math.min(SCENE.w - 6, p.x)), y: Math.max(6, Math.min(SCENE.h - 6, p.y)) };
    }
    function toScene(pt) { return { x: pt.x - SX, y: pt.y - SY }; }
    function moved() {
      stopPlay();
      recompute(true);
    }
    HB.draggable(svg, hStart, {
      onDrag: function (pt) {
        var p = clampPt(toScene(pt));
        if (Math.hypot(p.x - state.aim.x, p.y - state.aim.y) < 20) return;
        state.o = p;
        moved();
      }
    });
    HB.draggable(svg, hAim, {
      onDrag: function (pt) {
        var p = clampPt(toScene(pt));
        if (Math.hypot(p.x - state.o.x, p.y - state.o.y) < 20) return;
        state.aim = p;
        moved();
      }
    });
    /* Arrow keys move a handle in two dimensions; Shift moves further. */
    function keyMove(which) {
      return function (event) {
        var step = event.shiftKey ? 24 : 6;
        var dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        var dyk = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        if (!dx && !dyk) return;
        event.preventDefault();
        var p = clampPt({ x: state[which].x + dx, y: state[which].y + dyk });
        var other = which === "o" ? state.aim : state.o;
        if (Math.hypot(p.x - other.x, p.y - other.y) < 20) return;
        state[which] = p;
        moved();
      };
    }
    hStart.addEventListener("keydown", keyMove("o"));
    hAim.addEventListener("keydown", keyMove("aim"));

    syncPlay();
    recompute(true);
    if (log) log.debug("ready", BVH.nodes.length + " nodes, " + TRIS.length + " triangles");
  }

  if (HB.demos && HB.demos.register) HB.demos.register("bvh-traversal", init);
})();

/*
 * hitch-gallery.js: chapter 11.4's interactive.
 *
 * A frame-time graph of a 60-second play session with five kinds of hitch
 * built in, each with its own signature shape:
 *
 *   shader  shader compilation: single tall frames, uneven heights, only the
 *           first time something new is drawn
 *   gc      garbage collection: equal spikes at a steady rhythm
 *   stream  streaming stall (traversal stutter): short bursts of slow frames
 *           while the player moves fast
 *   load    a synchronous asset load on the game thread: one enormous frame
 *   vram    VRAM over-commit: a plateau of slow frames in one area
 *
 * The reader picks a kind to highlight it, reads its cause, fix and what a
 * capture shows, and toggles to the same session after the fixes. The
 * graph plots frame time against session time, so a 420 ms frame is drawn
 * 420 ms wide, as frame-time tools do. The session is deterministic (seeded
 * random numbers) and every number is illustrative.
 *
 * Statistics in the readout: frames over the 16.7 ms budget, hitches over
 * 50 ms, the worst frame, the 1% low (FrameView's definition from 11.1: the
 * average of the slowest 1% of frames, as a frame rate) and the average fps.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("hitch-gallery");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Model: every number below is illustrative ---------- */

  var BUDGET = 1000 / 60;
  var SESSION_MS = 60000;

  var SHADER = [[4.2, 68], [4.9, 42], [12.6, 95], [31.3, 55], [31.8, 37], [47.5, 120]];
  var GC_TIMES = [3, 9, 15, 21, 27, 33, 39, 45, 51, 57];
  var GC_MS = 11;
  var STREAM = [17.8, 19.9, 22.3, 24.5, 26.4];
  var LOADS = [[36.0, 420], [53.5, 260]];
  var VRAM = [40.0, 44.5];

  var TYPES = [
    {
      id: "shader", label: "Shader compile",
      shape: "Single tall frames of uneven height, each the first time something new is drawn: a muzzle flash, an explosion, a new enemy. They do not come back later in the session.",
      cause: "A pipeline state object is created, and its shaders compiled by the driver, in the middle of a frame (5.6).",
      fix: "Create pipelines before they are needed: Unreal's PSO precaching, Unity's GraphicsStateCollection warm-up, Godot's pipeline precompilation, plus a recorded cache for anything they miss.",
      capture: "The render thread inside a pipeline creation call for tens of milliseconds while the game thread waits for it.",
      after: "Precompiled during loading: no spikes. The work moved to the loading screen."
    },
    {
      id: "gc", label: "Garbage collection",
      shape: "Spikes of the same height at a steady rhythm, every few seconds, whatever the player is doing.",
      cause: "Allocations every frame fill the managed heap until the collector stops the thread to clean it (11.3).",
      fix: "Stop the steady allocations, pool what spawns often, and let incremental collection slice the work that is left.",
      capture: "A garbage collection marker such as GC.Collect filling the long frame on the game thread.",
      after: "Allocations removed and the rest sliced over frames: a bump of under a millisecond."
    },
    {
      id: "stream", label: "Streaming stall",
      shape: "Short bursts of several slow frames, only while the player moves fast, roughly each time they cross into a new part of the world.",
      cause: "Traversal stutter: newly streamed cells are made live on the game thread, creating and registering many objects in a few frames.",
      fix: "Time-slice activation under a per-frame limit, start loading earlier with a longer loading range, and make cells cheaper to bring in.",
      capture: "Cell or level activation, object creation and component registration on the game thread in the slow frames.",
      after: "Activation spread over more frames under a time limit: a slight rise that stays inside the budget."
    },
    {
      id: "load", label: "Load on game thread",
      shape: "One enormous frame, hundreds of milliseconds long, when something big is asked for: a map screen, a boss.",
      cause: "An asset loaded synchronously on the game thread: read, decompressed and created inside one frame.",
      fix: "Request it in the background ahead of time and finish on the game thread in small steps, with a placeholder or a short transition while it arrives.",
      capture: "A synchronous load call on the game thread, with file reads and decompression nested under it.",
      after: "Loaded asynchronously: the asset arrives a moment later and no frame is slow."
    },
    {
      id: "vram", label: "VRAM over-commit",
      shape: "A plateau: every frame slower for as long as the player stays in one area, worst on cards with less memory.",
      cause: "The area needs more GPU memory than the budget, so resources are moved to system memory over PCIe, or the game is paused while memory is shuffled.",
      fix: "Fit the budget: size the texture pool and texture settings to the card's memory and cut unique materials in the area.",
      capture: "Every GPU pass slower with nothing new in it, and memory over budget in the platform's memory counters.",
      after: "Texture pool sized to the card: normal frame times, slightly softer distant textures."
    }
  ];

  function typeById(id) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i];
    return null;
  }

  /* Builds the session: an array of frames { t (start, ms), ms (duration), type }. */
  function build(fixed) {
    var rng = HB.rng(1104);
    var frames = [];
    var t = 0;
    var shaderDone = SHADER.map(function () { return false; });
    var gcDone = GC_TIMES.map(function () { return 0; });
    var streamDone = STREAM.map(function () { return 0; });
    var loadDone = LOADS.map(function () { return 0; });
    /* The largest extra cost applied to a frame decides which kind it counts as. */
    var cur = { add: 0, type: null };
    function bump(extra, kind) {
      if (extra >= cur.add) { cur.add = extra; cur.type = kind; }
    }
    while (t < SESSION_MS) {
      var s = t / 1000;
      var base = 13.6 + (rng() - 0.5) * 1.6;
      cur.add = 0;
      cur.type = null;
      SHADER.forEach(function (ev, i) {
        if (!shaderDone[i] && s >= ev[0]) {
          shaderDone[i] = true;
          if (!fixed) bump(ev[1], "shader");
        }
      });
      GC_TIMES.forEach(function (at, i) {
        if (s >= at && gcDone[i] < (fixed ? 8 : 1)) {
          gcDone[i] += 1;
          bump(fixed ? 0.6 : GC_MS + rng() * 1.5, "gc");
        }
      });
      STREAM.forEach(function (at, i) {
        if (s >= at && streamDone[i] < (fixed ? 14 : 5)) {
          streamDone[i] += 1;
          bump(fixed ? 1.4 : 12 + rng() * 8, "stream");
        }
      });
      LOADS.forEach(function (ev, i) {
        if (s >= ev[0] && loadDone[i] < (fixed ? 10 : 1)) {
          loadDone[i] += 1;
          bump(fixed ? 1.0 : ev[1], "load");
        }
      });
      if (s >= VRAM[0] && s < VRAM[1]) bump(fixed ? 0.01 : 9 + rng() * 7, "vram");
      var ms = base + cur.add;
      frames.push({ t: t, ms: ms, type: cur.type });
      t += ms;
    }
    return frames;
  }

  function stats(frames) {
    var total = 0;
    var over = 0;
    var hitches = 0;
    var worst = 0;
    var sorted = frames.map(function (f) { return f.ms; }).sort(function (a, b) { return b - a; });
    frames.forEach(function (f) {
      total += f.ms;
      if (f.ms > BUDGET) over += 1;
      if (f.ms > 50) hitches += 1;
      if (f.ms > worst) worst = f.ms;
    });
    var n = Math.max(1, Math.ceil(frames.length / 100));
    var slow = 0;
    for (var i = 0; i < n; i++) slow += sorted[i];
    return {
      frames: frames.length,
      over: over,
      hitches: hitches,
      worst: worst,
      low1: 1000 / (slow / n),
      avgFps: frames.length / (total / 1000)
    };
  }

  /* Exposed for tests and for checking the chapter's numbers. */
  HB.hitchGallery = { build: build, stats: stats, types: TYPES, budget: BUDGET };

  /* ---------- Layout (viewBox units) ---------- */

  var W = 760;
  var X0 = 52;
  var X1 = 748;
  var GY0 = 236; // 0 ms
  var GY1 = 72;  // 60 ms
  var YMAX = 60;
  var H = 268;
  var ZW = 420;
  var ZH = 200;

  function gx(ms) { return X0 + (X1 - X0) * ms / SESSION_MS; }
  function gy(ms) { return GY0 - (GY0 - GY1) * Math.min(ms, YMAX) / YMAX; }

  function fmt1(n) { return (Math.round(n * 10) / 10).toFixed(1); }

  /* Groups frames of one kind into events (runs close together in time). */
  function events(frames) {
    var out = [];
    var last = null;
    frames.forEach(function (f, i) {
      if (!f.type) return;
      if (last && last.type === f.type && f.t - last.end < 400) {
        last.end = f.t + f.ms;
        if (f.ms > last.peak) { last.peak = f.ms; last.peakIndex = i; }
        last.count += 1;
      } else {
        last = { type: f.type, start: f.t, end: f.t + f.ms, peak: f.ms, peakIndex: i, count: 1 };
        out.push(last);
      }
    });
    return out;
  }

  /* ---------- Demo ---------- */

  function init(root) {
    var state = { fixed: false, type: "all" };
    var sessions = { before: build(false), after: build(true) };
    var summary = { before: stats(sessions.before), after: stats(sessions.after) };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Hitch gallery" }),
      h("span", { class: "demo-hint", text: "Pick a kind of hitch to highlight its shape and read its cause and fix, or press a marker above a spike. Then compare the session after the fixes. Every number is illustrative." })
    ]));

    var typeButtons = [];
    var controls = h("div", { class: "demo-controls" });
    var sessionCtl = HB.segmented("Session", [{ value: "before", label: "Before fixes" }, { value: "after", label: "After fixes" }], "before", function (v) {
      state.fixed = v === "after";
      render();
    });
    controls.appendChild(sessionCtl);
    var typeCtl = HB.segmented("Highlight", [{ value: "all", label: "All" }].concat(TYPES.map(function (t) { return { value: t.id, label: t.label }; })), "all", function (v) {
      state.type = v;
      render();
    });
    typeButtons = Array.prototype.slice.call(typeCtl.querySelectorAll("button"));
    controls.appendChild(typeCtl);
    root.appendChild(controls);

    function selectType(id) {
      state.type = id;
      var values = ["all"].concat(TYPES.map(function (t) { return t.id; }));
      typeButtons.forEach(function (b, i) { b.setAttribute("aria-pressed", values[i] === id ? "true" : "false"); });
      render();
    }

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", { class: "dg is-wide", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Frame-time graph of a 60-second session" });
    stage.appendChild(svg);
    root.appendChild(stage);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    var panels = h("div", { class: "demo-panels is-split" });
    var info = h("div", { class: "demo-panel" });
    var zoomWrap = h("div", { class: "demo-panel" });
    var zoomStage = h("div", { class: "demo-stage" });
    var zoom = svgEl("svg", { class: "dg", viewBox: "0 0 " + ZW + " " + ZH, role: "img", "aria-label": "Close-up of frames" });
    zoomStage.appendChild(zoom);
    zoomWrap.appendChild(zoomStage);
    panels.append(info, zoomWrap);
    root.appendChild(panels);

    /* ---------- Drawing ---------- */

    function drawGraph(frames, evs) {
      HB.svg.clear(svg);
      var sel = state.type;
      svgEl("text", { x: 0, y: 14, class: "t-caps", text: "FRAME TIME, 60 SECONDS OF PLAY · " + (state.fixed ? "AFTER FIXES" : "BEFORE FIXES") + " · ILLUSTRATIVE" }, svg);

      if (sel === "all" || sel === "vram") {
        svgEl("rect", { x: gx(VRAM[0] * 1000).toFixed(1), y: GY1, width: (gx(VRAM[1] * 1000) - gx(VRAM[0] * 1000)).toFixed(1), height: GY0 - GY1, class: sel === "vram" ? "f-pix-soft" : "f-sunken" }, svg);
      }
      [0, 20, 40, 60].forEach(function (v) {
        svgEl("line", { x1: X0, y1: gy(v), x2: X1, y2: gy(v), class: v === 0 ? "s-strong" : "s-line" }, svg);
        svgEl("text", { x: X0 - 6, y: gy(v) + 4, class: "t-small t-mono t-muted end", text: v + " ms" }, svg);
      });
      for (var sec = 0; sec <= 60; sec += 10) {
        svgEl("line", { x1: gx(sec * 1000), y1: GY0, x2: gx(sec * 1000), y2: GY0 + 5, class: "s-strong" }, svg);
        svgEl("text", { x: gx(sec * 1000), y: GY0 + 18, class: "t-small t-mono t-muted mid", text: sec + " s" }, svg);
      }

      /* Column maximum, so spikes survive the squeeze of 3,600 frames into 700 units. */
      var cols = X1 - X0;
      var colMax = new Array(cols).fill(0);
      frames.forEach(function (f) {
        var c0 = Math.floor(gx(f.t) - X0);
        var c1 = Math.floor(gx(f.t + f.ms) - X0);
        for (var c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++) colMax[c] = Math.max(colMax[c], f.ms);
      });
      var pts = [];
      for (var c = 0; c < cols; c++) {
        pts.push((X0 + c).toFixed(1) + "," + gy(colMax[c]).toFixed(1));
        pts.push((X0 + c + 1).toFixed(1) + "," + gy(colMax[c]).toFixed(1));
      }
      svgEl("polyline", { points: pts.join(" "), class: (sel === "all" ? "s-acc" : "s-muted") + " w15" }, svg);

      if (sel !== "all") {
        frames.forEach(function (f) {
          if (f.type !== sel) return;
          var x = gx(f.t);
          var w = Math.max(1.6, gx(f.t + f.ms) - x);
          svgEl("rect", { x: x.toFixed(1), y: gy(f.ms).toFixed(1), width: w.toFixed(1), height: (GY0 - gy(f.ms)).toFixed(1), class: "f-pix" }, svg);
        });
      }

      svgEl("line", { x1: X0, y1: gy(BUDGET), x2: X1, y2: gy(BUDGET), class: "s-acc dash w15" }, svg);
      svgEl("text", { x: X1, y: 14, class: "t-small t-acc t-strong end", text: "dashed line: 16.7 ms budget" }, svg);

      /* Clipped spikes get their real value printed at the top. */
      evs.forEach(function (ev) {
        if (ev.peak <= YMAX) return;
        var x = gx(frames[ev.peakIndex].t + frames[ev.peakIndex].ms / 2);
        svgEl("text", { x: x.toFixed(1), y: GY1 - 5, class: "t-small t-mono mid" + (sel === "all" || sel === ev.type ? " t-pix t-strong" : " t-muted"), text: Math.round(ev.peak) + " ms" }, svg);
      });

      /* Markers: one per event that crosses the budget, each a button for its kind.
         Markers that would overlap the previous one in a row drop to a second row. */
      var rowEnd = [-Infinity, -Infinity];
      evs.forEach(function (ev) {
        if (ev.peak <= BUDGET + 2) return;
        var t = typeById(ev.type);
        var x = gx((ev.start + ev.end) / 2);
        var row = x - rowEnd[0] >= 19 ? 0 : 1;
        rowEnd[row] = x;
        var cy = row === 0 ? 30 : 49;
        var on = sel === "all" || sel === ev.type;
        var g = svgEl("g", { role: "button", tabindex: "0", "aria-label": t.label + " at " + fmt1(ev.start / 1000) + " s, worst frame " + Math.round(ev.peak) + " ms" }, svg);
        svgEl("circle", { cx: x.toFixed(1), cy: cy, r: 8.5, class: "hit-ring f-surface " + (on ? "s-pix" : "s-line") }, g);
        svgEl("text", { x: x.toFixed(1), y: cy + 4, class: "t-small t-strong mid" + (on ? " t-pix" : " t-muted"), text: String(TYPES.indexOf(t) + 1) }, g);
        svgEl("title", { text: t.label }, g);
        g.addEventListener("click", function () { selectType(ev.type); });
        g.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectType(ev.type); }
        });
      });
      svg.setAttribute("aria-label", "Frame-time graph of a 60-second session " + (state.fixed ? "after" : "before") + " fixes" + (sel === "all" ? "" : ", highlighting " + typeById(sel).label) + ".");
    }

    function drawZoom(frames, evs) {
      HB.svg.clear(zoom);
      var sel = state.type;
      var focus = null;
      evs.forEach(function (ev) {
        if (sel !== "all" && ev.type !== sel) return;
        if (!focus || (sel === "all" ? ev.peak > focus.peak : false)) focus = ev;
      });
      var center = focus ? (focus.start + focus.end) / 2 : SESSION_MS / 2;
      var spanMs = 2500;
      if (focus && focus.type === "vram") spanMs = 6000;
      var a = Math.max(0, center - spanMs / 2);
      var z = a + spanMs;
      var zx0 = 46, zx1 = ZW - 6, zy0 = ZH - 30, zy1 = 34;
      var zmax = 60;
      function zx(t) { return zx0 + (zx1 - zx0) * (t - a) / spanMs; }
      function zy(ms) { return zy0 - (zy0 - zy1) * Math.min(ms, zmax) / zmax; }
      var title = focus ? "CLOSE-UP: " + typeById(focus.type).label.toUpperCase() + " AT " + fmt1(focus.start / 1000) + " s" : "CLOSE-UP";
      svgEl("text", { x: 0, y: 14, class: "t-caps", text: title }, zoom);
      [0, 30, 60].forEach(function (v) {
        svgEl("line", { x1: zx0, y1: zy(v), x2: zx1, y2: zy(v), class: v === 0 ? "s-strong" : "s-line" }, zoom);
        svgEl("text", { x: zx0 - 6, y: zy(v) + 4, class: "t-small t-mono t-muted end", text: v + " ms" }, zoom);
      });
      frames.forEach(function (f) {
        if (f.t + f.ms < a || f.t > z) return;
        var x = Math.max(zx0, zx(f.t));
        var w = Math.max(0.8, Math.min(zx1, zx(f.t + f.ms)) - x - 0.6);
        var hit = focus && f.type === focus.type;
        svgEl("rect", { x: x.toFixed(1), y: zy(f.ms).toFixed(1), width: w.toFixed(1), height: (zy0 - zy(f.ms)).toFixed(1), class: hit ? "f-pix" : "f-acc-soft" }, zoom);
        if (f.ms > zmax) {
          var lx = Math.min(zx1 - 18, Math.max(zx0 + 18, x + w / 2));
          svgEl("text", { x: lx.toFixed(1), y: zy1 - 4, class: "t-small t-mono mid " + (hit ? "t-pix t-strong" : "t-muted"), text: Math.round(f.ms) + " ms" }, zoom);
        }
      });
      svgEl("line", { x1: zx0, y1: zy(BUDGET), x2: zx1, y2: zy(BUDGET), class: "s-acc dash" }, zoom);
      svgEl("text", { x: zx0, y: ZH - 8, class: "t-small t-muted", text: "one bar per frame, as wide as it lasted · " + fmt1(spanMs / 1000) + " s" }, zoom);
      zoom.setAttribute("aria-label", focus ? "Close-up of " + fmt1(spanMs / 1000) + " seconds around " + typeById(focus.type).label + ", worst frame " + Math.round(focus.peak) + " ms." : "Close-up of frames.");
    }

    function drawInfo(evs) {
      var sel = state.type;
      info.replaceChildren();
      if (sel === "all") {
        var total = 0;
        var counts = TYPES.map(function (t) {
          var n = evs.filter(function (ev) { return ev.type === t.id && ev.peak > BUDGET + 2; }).length;
          total += n;
          return t.label + " (" + (TYPES.indexOf(t) + 1) + "): " + n;
        });
        info.append(
          h("p", { class: "label", text: state.fixed ? "After the fixes" : "Five kinds of hitch" }),
          h("p", { class: "demo-hint", text: state.fixed
            ? "The same session with each cause fixed. Only small bumps remain, all under the budget, and the 1% low is close to the average."
            : "Each numbered marker is an event that crossed the budget. Their shapes differ: isolated spikes, a steady rhythm, short bursts, one giant frame and a plateau." }),
          h("p", { class: "demo-hint", text: total ? "Events over budget, by marker number: " + counts.join("; ") + "." : "No event crosses the budget." })
        );
        return;
      }
      var t = typeById(sel);
      function row(label, text) {
        return h("p", { class: "demo-hint" }, [h("strong", { text: label + " " }), text]);
      }
      info.append(
        h("p", { class: "label", text: (TYPES.indexOf(t) + 1) + " · " + t.label }),
        row("Shape:", t.shape),
        row("Cause:", t.cause),
        row("Fix:", t.fix),
        row("In a capture:", t.capture),
        row(state.fixed ? "After the fix:" : "With the fix:", t.after)
      );
    }

    function drawReadout() {
      var s = summary[state.fixed ? "after" : "before"];
      function cell(label, value, cls) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v " + (cls || ""), text: value })]);
      }
      readout.replaceChildren(
        cell("Average", Math.round(s.avgFps) + " fps"),
        cell("1% low", Math.round(s.low1) + " fps"),
        cell("Worst frame", Math.round(s.worst) + " ms"),
        cell("Frames over 16.7 ms", HB.fmt.int(s.over) + " of " + HB.fmt.int(s.frames)),
        cell("Hitches over 50 ms", String(s.hitches))
      );
    }

    function render() {
      var frames = sessions[state.fixed ? "after" : "before"];
      var evs = events(frames);
      drawGraph(frames, evs);
      drawZoom(frames, evs);
      drawInfo(evs);
      drawReadout();
      log.debug("render", state.fixed ? "after" : "before", state.type);
    }

    render();
  }

  HB.demos.register("hitch-gallery", init);
})();

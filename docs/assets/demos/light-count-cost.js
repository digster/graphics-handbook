/*
 * light-count-cost.js: chapter 7.3's interactive.
 *
 * An illustrative cost model, not a measurement. It estimates the GPU time
 * the lighting part of an opaque frame takes as the number of dynamic
 * lights grows, for three ways of organising the work:
 *
 * All three start with a depth pre-pass, so none of them shades hidden
 * pixels; what differs is how lights are matched to pixels.
 *
 *   Forward      one pass; each object is lit by every light whose range
 *                touches the object. Objects are much bigger than a pixel,
 *                so an object meets about OBJ_FACTOR times as many lights
 *                as an average pixel does (capped at every light).
 *   Deferred     classic light volumes: a G-buffer pass (material once per
 *                pixel, G-buffer written), a full-screen pass that starts
 *                the HDR light buffer, then one draw per light over the
 *                pixels its range covers; each such pixel re-reads the
 *                G-buffer and adds into the light buffer (read + write).
 *   Clustered    Forward+: a light-assignment step per screen cluster, then
 *                one forward pass in which each pixel loops over its
 *                cluster's list, which holds a few more lights than really
 *                touch the pixel (LOOSENESS).
 *
 * Every light's range covers a fixed share of the screen (the "light size"
 * control), so the average lights per pixel is lights × share. The machine
 * is a made-up mid-range GPU: ALU_RATE operations per second actually
 * achieved and BW bytes per second of memory bandwidth. All constants are
 * below; the chapter's fold prints the same formulas.
 *
 * Both plot axes are linear, so each path is a straight line whose slope is
 * its cost per extra light. The millisecond axis rescales with resolution
 * and light size; the 16.7 ms line is a 60 fps frame. The slider moves in
 * doublings so small light counts are easy to reach.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("light-count-cost");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- The model ---------- */

  var ALU_RATE = 5e12;        // operations per second actually achieved
  var BW = 400e9;             // bytes per second of memory bandwidth
  var OPS_LIGHT = 150;        // one light at one pixel: attenuation, BRDF, light data
  var OPS_MATERIAL = 100;     // reading textures and building the surface, per shaded pixel
  var OBJ_FACTOR = 8;         // an object meets 8 × as many lights as a pixel
  var GBUF = 20;              // bytes per pixel of G-buffer, depth included (URP's layout)
  var HDR = 8;                // bytes per pixel of RGBA16F light buffer
  var DEPTH = 4;              // bytes per pixel of depth
  var DRAW_COST = 2e-6;       // seconds of fixed GPU overhead per light volume draw
  var PREPASS_FIXED = 0.1e-3; // seconds of geometry work for the depth pre-pass
  var CULL_FIXED = 0.05e-3;   // seconds to build the cluster grid
  var CULL_PER_LIGHT = 0.3e-6;// seconds to assign one light to clusters
  var LOOSENESS = 1.5;        // cluster lists hold 50% more lights than touch the pixel
  var LIST_BYTES = 2;         // bytes of light index read per listed light, after caching
  var FORWARD_LIMIT = 8;      // URP Forward: additional lights per object

  var T_ALU = OPS_LIGHT / ALU_RATE;
  var T_MAT = OPS_MATERIAL / ALU_RATE;

  var RESOLUTIONS = [
    { id: "720", label: "720p", w: 1280, h: 720 },
    { id: "1080", label: "1080p", w: 1920, h: 1080 },
    { id: "1440", label: "1440p", w: 2560, h: 1440 },
    { id: "2160", label: "4K", w: 3840, h: 2160 }
  ];
  var SIZES = [
    { id: "s", label: "Small (1%)", share: 0.01 },
    { id: "m", label: "Medium (3%)", share: 0.03 },
    { id: "l", label: "Large (8%)", share: 0.08 }
  ];

  /* Seconds of GPU time for each path. P pixels, N lights, a = screen share. */
  function prepass(P) {
    return PREPASS_FIXED + (P * DEPTH) / BW;
  }
  function forward(P, N, a) {
    var perPixel = N * Math.min(1, OBJ_FACTOR * a);
    return prepass(P) + P * (T_MAT + perPixel * T_ALU) + (P * HDR) / BW;
  }
  function deferred(P, N, a) {
    var gbuffer = P * T_MAT + (P * GBUF) / BW;
    var start = (P * HDR) / BW;
    var lightPixels = N * a * P;
    var lighting = lightPixels * (T_ALU + (GBUF + 2 * HDR) / BW) + N * DRAW_COST;
    return prepass(P) + gbuffer + start + lighting;
  }
  function clustered(P, N, a) {
    var cull = CULL_FIXED + N * CULL_PER_LIGHT;
    var listed = N * a * LOOSENESS;
    var shade = P * (T_MAT + listed * T_ALU) + (P * listed * LIST_BYTES) / BW + (P * HDR) / BW;
    return prepass(P) + cull + shade;
  }
  /* Bytes the deferred path moves per frame through its G-buffer and light buffer. */
  function deferredTraffic(P, N, a) {
    return P * (GBUF + HDR) + N * a * P * (GBUF + 2 * HDR);
  }

  /* ---------- Plot geometry ---------- */

  var VW = 820;
  var VH = 372;
  var X0 = 64;
  var X1 = 640;
  var Y0 = 316;
  var Y1 = 30;
  var NMAX_LOG = 10;   // the slider runs from 2^0 to 2^10 = 1,024 lights
  var NMAX = 1024;

  function px(n) { return X0 + (n / NMAX) * (X1 - X0); }

  function niceMax(v) {
    var steps = [1, 2, 2.5, 4, 5, 8, 10];
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p;
    return 10 * p;
  }

  var PATHS = [
    { id: "forward", label: "Forward", fn: forward, cls: "s-pix w2", dot: "f-pix", text: "t-pix" },
    { id: "deferred", label: "Deferred", fn: deferred, cls: "s-geo w2", dot: "f-geo", text: "t-geo" },
    { id: "clustered", label: "Clustered (Forward+)", fn: clustered, cls: "s-acc w3", dot: "f-acc", text: "t-acc" }
  ];

  function fmtMs(s) {
    var ms = s * 1000;
    return (ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString()) + " ms";
  }

  /* ---------- The figure ---------- */

  function init(root) {
    var state = { logN: 6, res: "1080", size: "m" };   // 64 lights at 1080p, medium lights

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Light count and cost" }),
      h("span", { class: "demo-hint", text: "An illustrative model with a made-up GPU. Move the light count and resolution and watch the three lines." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.slider("lcc-n", "Dynamic lights in view", {
      min: 0, max: NMAX_LOG, step: 0.1, value: state.logN,
      format: function (v) { return HB.fmt.int(Math.pow(2, v)); }
    }, function (v) { state.logN = v; draw(); }));
    controls.appendChild(HB.segmented("Resolution", RESOLUTIONS.map(function (r) {
      return { value: r.id, label: r.label };
    }), state.res, function (v) { state.res = v; draw(); }));
    controls.appendChild(HB.segmented("Each light covers", SIZES.map(function (s) {
      return { value: s.id, label: s.label };
    }), state.size, function (v) { state.size = v; draw(); }));
    root.appendChild(controls);

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", {
      class: "dg is-wide",
      viewBox: "0 0 " + VW + " " + VH,
      role: "img",
      "aria-label": "Estimated lighting cost in milliseconds against the number of lights, for forward, deferred and clustered rendering."
    });
    stage.appendChild(svg);
    root.appendChild(stage);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);
    var note = h("p", { class: "demo-hint" });
    root.appendChild(note);

    var layerAxes = svgEl("g", null, svg);
    var layerCurves = svgEl("g", null, svg);
    var layerMarks = svgEl("g", null, svg);
    var clip = svgEl("clipPath", { id: "lcc-clip" }, svgEl("defs", null, svg));
    svgEl("rect", { x: X0, y: Y1 - 4, width: X1 - X0 + 2, height: Y0 - Y1 + 4 }, clip);

    /* Static: x axis and legend. */
    [0, 128, 256, 384, 512, 640, 768, 896, 1024].forEach(function (n) {
      svgEl("line", { x1: px(n), y1: Y0, x2: px(n), y2: Y0 + 5, class: "s-strong" }, svg);
      svgEl("text", { x: px(n), y: Y0 + 19, class: "t-mono t-small t-muted mid", text: HB.fmt.int(n) }, svg);
    });
    svgEl("text", { x: (X0 + X1) / 2, y: Y0 + 38, class: "t-small t-muted mid", text: "dynamic lights in view" }, svg);
    var LX = 664;
    svgEl("text", { x: LX, y: 40, class: "t-caps", text: "ESTIMATED GPU TIME" }, svg);
    PATHS.forEach(function (p, i) {
      var y = 64 + i * 24;
      svgEl("line", { x1: LX, y1: y, x2: LX + 24, y2: y, class: p.cls }, svg);
      svgEl("text", { x: LX + 32, y: y + 4, class: "t-small " + p.text + " t-strong", text: p.label }, svg);
    });
    svgEl("line", { x1: LX, y1: 136, x2: LX + 24, y2: 136, class: "s-muted dash" }, svg);
    svgEl("text", { x: LX + 32, y: 140, class: "t-small t-muted", text: "16.7 ms: a 60 fps frame" }, svg);
    svgEl("line", { x1: LX, y1: 160, x2: LX + 24, y2: 160, class: "s-pix dot-dash" }, svg);
    svgEl("text", { x: LX + 32, y: 164, class: "t-small t-muted", text: "past here, URP Forward" }, svg);
    svgEl("text", { x: LX + 32, y: 178, class: "t-small t-muted", text: "would drop lights" }, svg);
    svgEl("text", { x: LX, y: 214, class: "t-small t-muted", text: "Lighting of opaque pixels" }, svg);
    svgEl("text", { x: LX, y: 229, class: "t-small t-muted", text: "only: no shadows, no post." }, svg);
    svgEl("text", { x: LX, y: 244, class: "t-small t-muted", text: "Constants in the fold below." }, svg);

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function draw() {
      var res = RESOLUTIONS.filter(function (r) { return r.id === state.res; })[0];
      var size = SIZES.filter(function (s) { return s.id === state.size; })[0];
      var P = res.w * res.h;
      var a = size.share;
      var N = Math.max(1, Math.round(Math.pow(2, state.logN)));

      // The y axis fits the steepest line at 1,024 lights.
      var top = niceMax(Math.max(forward(P, NMAX, a), deferred(P, NMAX, a), clustered(P, NMAX, a)) * 1000 * 1.04);
      function py(s) { return Y0 - ((s * 1000) / top) * (Y0 - Y1); }

      HB.svg.clear(layerAxes);
      // Four or five gridlines, whichever gives round numbers.
      var mant = top / Math.pow(10, Math.floor(Math.log10(top)));
      var divs = (mant === 2 || mant === 4 || mant === 8) ? 4 : 5;
      for (var k = 0; k <= divs; k++) {
        var v = (top * k) / divs;
        var yy = Y0 - (k / divs) * (Y0 - Y1);
        svgEl("line", { x1: X0, y1: yy, x2: X1, y2: yy, class: k === 0 ? "s-strong" : "s-line" }, layerAxes);
        svgEl("text", { x: X0 - 8, y: yy + 4, class: "t-mono t-small t-muted end", text: (v < 10 && v % 1 ? v.toFixed(1) : v.toFixed(0)) }, layerAxes);
      }
      svgEl("text", { x: X0 - 8, y: Y1 - 12, class: "t-small t-muted end", text: "ms" }, layerAxes);
      if (16.7 < top) {
        svgEl("line", { x1: X0, y1: py(0.0167), x2: X1, y2: py(0.0167), class: "s-muted dash" }, layerAxes);
      }
      // Where the average object meets more lights than URP Forward allows.
      var limitN = FORWARD_LIMIT / Math.min(1, OBJ_FACTOR * a);
      if (limitN >= 1 && limitN <= 1024) {
        svgEl("line", { x1: px(limitN), y1: Y1, x2: px(limitN), y2: Y0, class: "s-pix dot-dash" }, layerAxes);
      }

      HB.svg.clear(layerCurves);
      var g = svgEl("g", { "clip-path": "url(#lcc-clip)" }, layerCurves);
      PATHS.forEach(function (p) {
        var d = "";
        for (var i = 0; i <= 128; i++) {
          var n = Math.max(1, (i / 128) * NMAX);
          d += (i ? "L" : "M") + px(n).toFixed(1) + "," + py(p.fn(P, n, a)).toFixed(1);
        }
        svgEl("path", { d: d, class: p.cls }, g);
      });

      HB.svg.clear(layerMarks);
      svgEl("line", { x1: px(N), y1: Y1, x2: px(N), y2: Y0, class: "s-ink" }, layerMarks);
      var times = PATHS.map(function (p) { return p.fn(P, N, a); });
      PATHS.forEach(function (p, i) {
        var y = py(times[i]);
        if (y >= Y1 - 2) svgEl("circle", { cx: px(N), cy: y, r: 5, class: p.dot }, layerMarks);
      });
      svgEl("text", { x: px(N) + (px(N) > X1 - 90 ? -6 : 6), y: Y1 + 10, class: "t-small t-strong" + (px(N) > X1 - 90 ? " end" : ""), text: HB.fmt.int(N) + " lights" }, layerMarks);

      var best = 0;
      times.forEach(function (t, i) { if (t < times[best]) best = i; });
      var sorted = times.slice().sort(function (x, y) { return x - y; });
      var close = sorted[1] < sorted[0] * 1.15;
      var mb = deferredTraffic(P, N, a) / (1024 * 1024);
      readout.replaceChildren(
        cell("Forward" + (best === 0 ? ", cheapest" : ""), fmtMs(times[0])),
        cell("Deferred" + (best === 1 ? ", cheapest" : ""), fmtMs(times[1])),
        cell("Clustered" + (best === 2 ? ", cheapest" : ""), fmtMs(times[2])),
        cell("Lights per pixel, average", (N * a).toFixed(N * a < 1 ? 2 : N * a < 10 ? 1 : 0)),
        cell("Deferred memory traffic", (mb < 100 ? mb.toFixed(1) : Math.round(mb)) + " MB a frame")
      );

      var msg;
      if (close && N <= 8) {
        msg = "With only a few lights the paths cost about the same. Deferred pays a fixed price up front for writing and reading its G-buffer.";
      } else if (best === 0) {
        msg = "With this few lights, forward is cheapest: no G-buffer to write and read back, and no cluster lists to build.";
      } else if (best === 1) {
        msg = "Deferred wins here: the G-buffer costs a fixed amount, and each light only touches the pixels it covers.";
      } else {
        msg = "Clustered wins: every pixel loops over a short list of the lights near it, without re-reading a G-buffer for each light.";
      }
      if (N >= limitN) msg += " The average object now meets about " + Math.round(N * Math.min(1, OBJ_FACTOR * a)) + " lights, more than URP Forward's 8 per object, so some would simply be dropped.";
      note.textContent = msg;
      svg.setAttribute("aria-label", "Estimated lighting cost against light count at " + res.label + ". At " + N + " lights: forward " + fmtMs(times[0]) +
        ", deferred " + fmtMs(times[1]) + ", clustered " + fmtMs(times[2]) + ".");
    }

    draw();
    log.debug("ready");
  }

  HB.demos.register("light-count-cost", init);
})();

/*
 * tone-curve-lab.js: chapter 9.1's interactive.
 *
 * An HDR picture in linear light, computed once: a sunny square with a sky,
 * a sunlit wall, a building in shade with a dark archway, and a lantern
 * hanging in the arch. Underneath, two test ramps from 6 stops below to 6
 * stops above mid-grey (0.18): one neutral grey, one in the lantern's
 * colour at the same luminance. The scene spans about 12 stops, far more
 * than a screen shows.
 *
 * The reader sets exposure (a multiplier of 2^EV) and picks the operator
 * that turns light into screen values:
 *   No tone map   clamp each channel at 1 (what you get with none at all)
 *   Reinhard      x / (1 + x) per channel (Reinhard et al. 2002, equation 3,
 *                 applied per channel as games often do)
 *   ACES fit      Stephen Hill's fit of the ACES 1 reference rendering and
 *                 output transforms for an sRGB screen, the same curve the
 *                 Lantern Courtyard uses (input and output matrices included)
 *   AgX-like      Benjamin Wrensch's minimal AgX (MIT): inset matrix, log2
 *                 encoding from -12.47 to +4.03 stops, a polynomial fit of
 *                 the default sigmoid, outset matrix, 2.2 power
 * Each operator's input is pre-scaled so that mid-grey (0.18) comes out at
 * 0.18, as without tone mapping. Godot does the same internally for its
 * Filmic and ACES curves. This compares the shapes of the curves, not their
 * default brightness.
 *
 * The plot shows the chosen curve for neutral light, on a log axis of scene
 * light, with markers where five parts of the picture land. Readouts give
 * the share of pixels that hit full white in any channel (clipped) and the
 * hue of the lantern flame on screen compared with its true hue.
 *
 * Colours of the sky, sunlight and flame come from the theme's paint
 * tokens, decoded to linear light. The picture is content, so it looks the
 * same in both themes; only the plot follows the theme.
 *
 * The operators are exposed as HB.toneCurveLab for tests and figures.
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var log = HB.log && HB.log.scope ? HB.log.scope("tone-curve-lab") : null;

  var W = 480;           // picture width
  var HS = 150;          // scene height
  var HR = 24;           // each ramp's height
  var GAP = 6;
  var HTOT = HS + GAP + HR + GAP + HR;
  var MID = 0.18;
  var RAMP_STOPS = 6;    // ramps run from -6 to +6 stops around mid-grey

  /* ---------- Colour helpers ---------- */

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    c = c < 0 ? 0 : c > 1 ? 1 : c;
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }
  function parseHex(hex, fallback) {
    var m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
    if (!m) return fallback;
    var v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map(srgbToLinear);
  }
  function lum(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  /* Hue in degrees of an encoded colour (0 = red, 60 = yellow). */
  function hueOf(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 1e-6) return null;
    var hh;
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    return hh < 0 ? hh + 360 : hh;
  }

  /* ---------- Operators: linear RGB in, linear display RGB (0..1) out ---------- */

  function clip(c, out) {
    out[0] = Math.min(Math.max(c[0], 0), 1); out[1] = Math.min(Math.max(c[1], 0), 1); out[2] = Math.min(Math.max(c[2], 0), 1);
  }
  function reinhard(c, out) {
    out[0] = c[0] / (1 + c[0]); out[1] = c[1] / (1 + c[1]); out[2] = c[2] / (1 + c[2]);
  }
  // Hill's fit, rows of ACESInputMat and ACESOutputMat (BakingLab, MIT).
  function acesFit(c, out) {
    var r = 0.59719 * c[0] + 0.35458 * c[1] + 0.04823 * c[2];
    var g = 0.07600 * c[0] + 0.90834 * c[1] + 0.01566 * c[2];
    var b = 0.02840 * c[0] + 0.13383 * c[1] + 0.83777 * c[2];
    r = (r * (r + 0.0245786) - 0.000090537) / (r * (0.983729 * r + 0.432951) + 0.238081);
    g = (g * (g + 0.0245786) - 0.000090537) / (g * (0.983729 * g + 0.432951) + 0.238081);
    b = (b * (b + 0.0245786) - 0.000090537) / (b * (0.983729 * b + 0.432951) + 0.238081);
    out[0] = Math.min(Math.max(1.60475 * r - 0.53108 * g - 0.07367 * b, 0), 1);
    out[1] = Math.min(Math.max(-0.10208 * r + 1.10813 * g - 0.00605 * b, 0), 1);
    out[2] = Math.min(Math.max(-0.00327 * r - 0.07276 * g + 1.07602 * b, 0), 1);
  }
  // Wrensch's minimal AgX (MIT): GLSL mat3 columns written out as rows here.
  var AGX_MIN = -12.47393, AGX_MAX = 4.026069;
  function agxCurve(x) {
    var x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }
  function agxChannel(v) {
    v = Math.log(Math.max(v, 1e-10)) / Math.LN2;
    v = v < AGX_MIN ? AGX_MIN : v > AGX_MAX ? AGX_MAX : v;
    return agxCurve((v - AGX_MIN) / (AGX_MAX - AGX_MIN));
  }
  function agx(c, out) {
    var r = 0.842479062253094 * c[0] + 0.0784335999999992 * c[1] + 0.0792237451477643 * c[2];
    var g = 0.0423282422610123 * c[0] + 0.878468636469772 * c[1] + 0.0791661274605434 * c[2];
    var b = 0.0423756549057051 * c[0] + 0.0784336 * c[1] + 0.879142973793104 * c[2];
    r = agxChannel(r); g = agxChannel(g); b = agxChannel(b);
    var r2 = 1.19687900512017 * r - 0.0980208811401368 * g - 0.0990297440797205 * b;
    var g2 = -0.0528968517574562 * r + 1.15190312990417 * g - 0.0989611768448433 * b;
    var b2 = -0.0529716355144438 * r - 0.0980434501171241 * g + 1.15107367264116 * b;
    out[0] = Math.pow(Math.min(Math.max(r2, 0), 1), 2.2);
    out[1] = Math.pow(Math.min(Math.max(g2, 0), 1), 2.2);
    out[2] = Math.pow(Math.min(Math.max(b2, 0), 1), 2.2);
  }

  var OPS = [
    { id: "clip", label: "No tone map", fn: clip },
    { id: "reinhard", label: "Reinhard", fn: reinhard },
    { id: "aces", label: "ACES fit", fn: acesFit },
    { id: "agx", label: "AgX-like", fn: agx }
  ];
  var OP_BY_ID = {};
  OPS.forEach(function (op) { OP_BY_ID[op.id] = op; });

  /* Pre-scale so a neutral 0.18 comes out as 0.18 (bisection on a log scale). */
  (function normalise() {
    var c = [0, 0, 0], o = [0, 0, 0];
    OPS.forEach(function (op) {
      var lo = -4, hi = 4;
      for (var i = 0; i < 60; i++) {
        var m = (lo + hi) / 2;
        var k = Math.pow(2, m) * MID;
        c[0] = c[1] = c[2] = k;
        op.fn(c, o);
        if (o[1] < MID) lo = m; else hi = m;
      }
      op.scale = Math.pow(2, (lo + hi) / 2);
    });
  })();

  /* Encoded (0..1) screen value of a neutral scene value v at exposure ev. */
  function curve(op, v, ev) {
    var c = [0, 0, 0], o = [0, 0, 0];
    c[0] = c[1] = c[2] = v * Math.pow(2, ev) * op.scale;
    op.fn(c, o);
    return linearToSrgb(o[1]);
  }

  HB.toneCurveLab = { ops: OPS, curve: curve, linearToSrgb: linearToSrgb, hueOf: hueOf };

  /* ---------- The HDR picture ---------- */

  function buildScene(pal) {
    var img = new Float32Array(W * HTOT * 3);
    var SKY = pal.sky, DAY = pal.day, FLAME = pal.flame;
    var LANT = { x: 281, y: 66 };
    function set(i, r, g, b) { img[i * 3] = r; img[i * 3 + 1] = g; img[i * 3 + 2] = b; }
    for (var y = 0; y < HS; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        var t = Math.min(1, y / 118);
        // Sky: deep blue overhead, bright and whiter towards the horizon.
        var r = SKY[0] * (1.4 + 1.6 * t) + DAY[0] * 2.6 * t * t;
        var g = SKY[1] * (1.4 + 1.6 * t) + DAY[1] * 2.6 * t * t;
        var b = SKY[2] * (1.4 + 1.6 * t) + DAY[2] * 2.6 * t * t;
        var sun = 3.4;                    // sunlight on surfaces facing it
        var shadeFill = 0.5;              // sky light in shade
        var dl = Math.hypot(x - LANT.x, (y - LANT.y) * 1.1);
        var glow = 1.8 / (1 + (dl / 11) * (dl / 11));
        if (y >= 118) {
          // Paving: in sun, except in the shadow of the arch building.
          var inShadow = x > 150 && x < 360 - (y - 118) * 0.6;
          var a = [0.32, 0.3, 0.27];
          var L = inShadow ? [SKY[0] * shadeFill * 0.5, SKY[1] * shadeFill * 0.5, SKY[2] * shadeFill * 0.5] : [DAY[0] * sun, DAY[1] * sun, DAY[2] * sun];
          r = a[0] * L[0]; g = a[1] * L[1]; b = a[2] * L[2];
          if (inShadow) { r += a[0] * FLAME[0] * glow * 0.4; g += a[1] * FLAME[1] * glow * 0.4; b += a[2] * FLAME[2] * glow * 0.4; }
        } else if (x < 140 && y >= 30) {
          // Sunlit sandstone wall with two dark windows.
          var win = (x > 28 && x < 52 && y > 50 && y < 92) || (x > 86 && x < 110 && y > 50 && y < 92);
          var aw = win ? [0.02, 0.02, 0.025] : [0.6, 0.5, 0.4];
          r = aw[0] * DAY[0] * sun; g = aw[1] * DAY[1] * sun; b = aw[2] * DAY[2] * sun;
        } else if (x >= 160 && x < 392 && y >= 14) {
          // Building face in shade, with an archway.
          var ax = (x - 281) / 36;
          var inArch = Math.abs(ax) < 1 && (y > 84 || (y > 48 && (y - 84) * (y - 84) / (36 * 36) + ax * ax < 1));
          var ab = inArch ? [0.012, 0.011, 0.01] : [0.55, 0.5, 0.45];
          r = ab[0] * SKY[0] * shadeFill + ab[0] * 0.02 + 0.5 * ab[0] * FLAME[0] * glow;
          g = ab[1] * SKY[1] * shadeFill + ab[1] * 0.02 + 0.5 * ab[1] * FLAME[1] * glow;
          b = ab[2] * SKY[2] * shadeFill + ab[2] * 0.02 + 0.5 * ab[2] * FLAME[2] * glow;
          if (inArch) {
            // The lantern lights the inside of the arch.
            r += 0.4 * FLAME[0] * glow; g += 0.4 * FLAME[1] * glow; b += 0.4 * FLAME[2] * glow;
          }
          // The lantern: a glass housing and a bright flame, on a short chain.
          if (Math.abs(x - LANT.x) < 0.8 && y >= 48 && y < LANT.y - 7) { r = g = b = 0.01; }
          var dh = Math.hypot(x - LANT.x, (y - LANT.y) * 0.8);
          if (dh < 7) { r = FLAME[0] * 6; g = FLAME[1] * 6; b = FLAME[2] * 6; }
          if (Math.hypot(x - LANT.x, (y - LANT.y - 1) * 0.7) < 3.2) { r = FLAME[0] * 80; g = FLAME[1] * 80; b = FLAME[2] * 80; }
        } else if (x >= 410 && y >= 52) {
          // A second building, partly sunlit.
          var lit = x > 440;
          var k = lit ? sun * 0.8 : shadeFill;
          var src = lit ? DAY : SKY;
          r = 0.5 * src[0] * k; g = 0.47 * src[1] * k; b = 0.44 * src[2] * k;
        }
        set(i, r, g, b);
      }
    }
    // Ramps: neutral, then the flame colour at the same luminance.
    var flameUnit = [FLAME[0] / lum(FLAME), FLAME[1] / lum(FLAME), FLAME[2] / lum(FLAME)];
    for (var ry = 0; ry < HR; ry++) {
      for (var rx = 0; rx < W; rx++) {
        var s = -RAMP_STOPS + (2 * RAMP_STOPS * (rx + 0.5)) / W;
        var v = MID * Math.pow(2, s);
        set((HS + GAP + ry) * W + rx, v, v, v);
        set((HS + GAP + HR + GAP + ry) * W + rx, v * flameUnit[0], v * flameUnit[1], v * flameUnit[2]);
      }
    }
    // The gaps between bands stay at zero and are painted as background.
    return img;
  }

  /* Points of interest: picture position and name. */
  var MARKS = [
    { id: "arch", x: 300, y: 108, label: "inside the arch", dx: -9, dy: -7, anchor: "end" },
    { id: "shade", x: 200, y: 40, label: "wall in shade", dx: -9, dy: -7, anchor: "end" },
    { id: "sky", x: 440, y: 20, label: "sky", dx: -9, dy: -7, anchor: "end" },
    { id: "sunlit", x: 70, y: 40, label: "sunlit wall", dx: 8, dy: 17, anchor: "" },
    { id: "flame", x: 281, y: 67, label: "lantern flame", dx: 4, dy: -9, anchor: "end" }
  ];

  /* ---------- The figure ---------- */

  var PLOT = { w: 460, h: 310, x0: 56, x1: 442, y0: 64, y1: 248, s0: -7, s1: 9 };
  function px(s) { return PLOT.x0 + ((s - PLOT.s0) / (PLOT.s1 - PLOT.s0)) * (PLOT.x1 - PLOT.x0); }
  function py(v) { return PLOT.y1 - v * (PLOT.y1 - PLOT.y0); }

  function init(root) {
    var h = HB.html;
    var svgEl = HB.svg.el;
    var C = HB.demos.color;
    var pal = {
      sky: parseHex(C("paint-sky"), [0.337, 0.515, 1]),
      day: parseHex(C("paint-daylight"), [1, 0.92, 0.85]),
      flame: parseHex(C("paint-candle"), [1, 0.29, 0.022])
    };
    var scene = buildScene(pal);
    MARKS.forEach(function (m) {
      var i = (m.y * W + m.x) * 3;
      m.rgb = [scene[i], scene[i + 1], scene[i + 2]];
      m.lum = lum(m.rgb);
    });
    var flameHue = hueOf(linearToSrgb(pal.flame[0]), linearToSrgb(pal.flame[1]), linearToSrgb(pal.flame[2]));

    var state = { op: "clip", ev: 0, mark: true };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Tone curve lab" }),
      h("span", { class: "demo-hint", text: "Change the exposure and the tone curve; watch the sky, the lantern and the two ramps." })
    ]));
    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.slider("tcl-ev", "Exposure", {
      min: -4, max: 4, step: 0.5, value: state.ev,
      format: function (v) { return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + " EV"; }
    }, function (v) { state.ev = v; request(); }));
    controls.appendChild(HB.segmented("Tone curve", OPS.map(function (op) { return { value: op.id, label: op.label }; }), state.op, function (v) {
      state.op = v;
      request();
    }));
    var markBox = h("input", { type: "checkbox", id: "tcl-mark", checked: true });
    markBox.addEventListener("change", function () { state.mark = markBox.checked; request(); });
    controls.appendChild(h("div", { class: "checks" }, [h("label", { for: "tcl-mark" }, [markBox, "Mark clipped pixels"])]));
    root.appendChild(controls);

    var canvas = h("canvas", {
      width: W, height: HTOT, role: "img",
      style: "display:block;width:100%;height:auto;border-radius:6px;border:1px solid var(--line-strong)"
    });
    var axis = svgEl("svg", { class: "dg", viewBox: "0 0 " + W + " 30", role: "img", "aria-label": "Scale for the two ramps: from 6 stops below mid-grey on the left to 6 stops above on the right." });
    [-6, -3, 0, 3, 6].forEach(function (s) {
      var x = ((s + RAMP_STOPS) / (2 * RAMP_STOPS)) * W;
      svgEl("line", { x1: x, y1: 0, x2: x, y2: 5, class: "s-strong" }, axis);
      svgEl("text", { x: Math.min(W - 2, Math.max(2, x)), y: 17, class: "t-mono t-small t-muted " + (s === -6 ? "" : s === 6 ? "end" : "mid"), text: s === 0 ? "mid-grey" : (s > 0 ? "+" : "−") + Math.abs(s) + " stops" }, axis);
    });
    svgEl("text", { x: W / 2, y: 29, class: "t-small t-muted mid", text: "ramps: neutral grey (upper) and the flame colour at the same brightness (lower)" }, axis);
    var picture = h("div", { style: "max-width:640px;margin:0 auto;width:100%" }, [canvas, axis]);

    var plot = svgEl("svg", {
      class: "dg is-mid",
      viewBox: "0 0 " + PLOT.w + " " + PLOT.h,
      role: "img",
      "aria-label": "The tone curve: screen value against scene light on a log scale, with markers for five parts of the picture."
    });
    (function frame() {
      svgEl("text", { x: PLOT.x0, y: 14, class: "t-caps", text: "SCREEN VALUE FOR NEUTRAL LIGHT, BY SCENE LIGHT" }, plot);
      [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
        svgEl("line", { x1: PLOT.x0, y1: py(v), x2: PLOT.x1, y2: py(v), class: v === 0 ? "s-strong" : "s-line" }, plot);
        svgEl("text", { x: PLOT.x0 - 6, y: py(v) + 4, class: "t-mono t-small t-muted end", text: String(Math.round(v * 255)) }, plot);
      });
      for (var s = -6; s <= 8; s += 2) {
        svgEl("line", { x1: px(s), y1: PLOT.y1, x2: px(s), y2: PLOT.y1 + 5, class: "s-strong" }, plot);
        svgEl("text", { x: px(s), y: PLOT.y1 + 18, class: "t-mono t-small t-muted mid", text: s === 0 ? "0" : (s > 0 ? "+" : "−") + Math.abs(s) }, plot);
      }
      svgEl("line", { x1: px(0), y1: PLOT.y0, x2: px(0), y2: PLOT.y1, class: "s-muted dot-dash" }, plot);
      svgEl("text", { x: (PLOT.x0 + PLOT.x1) / 2, y: PLOT.y1 + 34, class: "t-small t-muted mid", text: "scene light, in stops from mid-grey (each step doubles it)" }, plot);
    })();
    var gCurves = svgEl("g", null, plot);
    var gMarks = svgEl("g", null, plot);
    var gLegend = svgEl("g", null, plot);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    var swatch = h("canvas", { width: 1, height: 1, "aria-hidden": "true", style: "width:1.1rem;height:1.1rem;border-radius:3px;border:1px solid var(--line-strong);vertical-align:-0.15rem;margin-right:.35rem" });
    var note = h("p", { class: "demo-hint" });

    root.appendChild(picture);
    root.appendChild(h("div", { class: "demo-stage" }, [h("div", { style: "max-width:600px;margin:0 auto" }, [plot])]));
    root.appendChild(readout);
    root.appendChild(note);

    var ctx = canvas.getContext("2d");
    var data = ctx.createImageData(W, HTOT);
    var sctx = swatch.getContext("2d");
    var swData = sctx.createImageData(1, 1);
    var bg = [128, 128, 128];
    var hatch = [185, 47, 88];

    function readTheme() {
      var probe = document.createElement("canvas");
      probe.width = probe.height = 1;
      var p = probe.getContext("2d", { willReadFrequently: true });
      function rgbOf(token, fb) {
        try {
          p.clearRect(0, 0, 1, 1);
          p.fillStyle = C(token) || fb;
          p.fillRect(0, 0, 1, 1);
          var d = p.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2]];
        } catch (err) {
          if (log) log.warn("could not read a theme colour", err);
          return null;
        }
      }
      bg = rgbOf("surface", "#ffffff") || bg;
      hatch = rgbOf("pix", "#b92f58") || hatch;
    }

    var ENC = new Uint8ClampedArray(4097);
    for (var e = 0; e <= 4096; e++) ENC[e] = Math.round(linearToSrgb(e / 4096) * 255);
    function enc(v) { return ENC[Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 4096)]; }

    function cell(label, value, pre) {
      var v = h("span", { class: "v" }, pre ? [pre, value] : [value]);
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), v]);
    }

    var pending = false;
    function request() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(render);
    }

    function render() {
      pending = false;
      var op = OP_BY_ID[state.op];
      var k = Math.pow(2, state.ev) * op.scale;
      var c = [0, 0, 0], o = [0, 0, 0];
      var d = data.data;
      var clipped = 0, sceneCount = W * HS;
      for (var y = 0; y < HTOT; y++) {
        var band = y < HS ? 0 : y < HS + GAP ? -1 : y < HS + GAP + HR ? 1 : y < HS + 2 * GAP + HR ? -1 : 2;
        for (var x = 0; x < W; x++) {
          var i = y * W + x, p = i * 4;
          if (band < 0) { d[p] = bg[0]; d[p + 1] = bg[1]; d[p + 2] = bg[2]; d[p + 3] = 255; continue; }
          c[0] = scene[i * 3] * k; c[1] = scene[i * 3 + 1] * k; c[2] = scene[i * 3 + 2] * k;
          op.fn(c, o);
          var R = enc(o[0]), G = enc(o[1]), B = enc(o[2]);
          var isClipped = R >= 254 || G >= 254 || B >= 254;
          if (isClipped && band === 0) clipped++;
          if (isClipped && state.mark && (x + y) % 7 < 2) { R = hatch[0]; G = hatch[1]; B = hatch[2]; }
          d[p] = R; d[p + 1] = G; d[p + 2] = B; d[p + 3] = 255;
        }
      }
      ctx.putImageData(data, 0, 0);

      drawPlot(op);

      // The flame's colour on screen, and its hue.
      var fm = MARKS[4];
      c[0] = fm.rgb[0] * k; c[1] = fm.rgb[1] * k; c[2] = fm.rgb[2] * k;
      op.fn(c, o);
      var fr = enc(o[0]), fg = enc(o[1]), fb = enc(o[2]);
      swData.data[0] = fr; swData.data[1] = fg; swData.data[2] = fb; swData.data[3] = 255;
      sctx.putImageData(swData, 0, 0);
      var hue = hueOf(fr / 255, fg / 255, fb / 255);
      var hueText = hue === null ? "white, no hue left" : Math.round(hue) + "° (true " + Math.round(flameHue) + "°)";
      var pct = (100 * clipped) / sceneCount;
      readout.replaceChildren(
        cell("Exposure", (state.ev > 0 ? "+" : state.ev < 0 ? "−" : "") + Math.abs(state.ev).toFixed(1) + " EV, ×" + (Math.pow(2, state.ev) < 1 ? Math.pow(2, state.ev).toFixed(3).replace(/0+$/, "") : HB.fmt.fixed(Math.pow(2, state.ev), Math.pow(2, state.ev) % 1 ? 2 : 0))),
        cell("Picture clipped to white", pct < 0.05 ? "none" : pct.toFixed(pct < 10 ? 1 : 0) + "%"),
        cell("Lantern flame on screen", hueText, swatch)
      );
      var msg;
      if (state.op === "clip") msg = "Without a tone curve, every channel above 1 is cut off. The sky and the wall flatten to white, and the flame loses its red-orange first in one channel, then in all.";
      else if (state.op === "reinhard") msg = "Reinhard never quite reaches white, so nothing clips, but the bright end is squeezed hard: highlights look grey and flat, and the ramp's top half barely changes.";
      else if (state.op === "aces") msg = "The ACES fit adds a dark toe and a shoulder, so contrast stays strong in the middle. Applied to each channel, it pushes the bright flame towards yellow before white.";
      else msg = "AgX squeezes each channel in log space after mixing a little of the other channels in, so bright saturated colours fade towards white with less hue shift.";
      note.textContent = msg;
      canvas.setAttribute("aria-label", "A sunny square with a sky, a sunlit wall, a building in shade and a lantern in its arch, with " + op.label +
        " at " + (state.ev >= 0 ? "+" : "−") + Math.abs(state.ev) + " EV. " + (pct < 0.05 ? "Nothing is clipped." : Math.round(pct) + " percent of the picture is clipped to white."));
    }

    function drawPlot(op) {
      HB.svg.clear(gCurves);
      HB.svg.clear(gMarks);
      HB.svg.clear(gLegend);
      // All four curves, the chosen one on top.
      OPS.slice().sort(function (a, b) { return (a === op) - (b === op); }).forEach(function (o2) {
        var d = "";
        for (var s = PLOT.s0; s <= PLOT.s1 + 1e-9; s += 0.125) {
          var v = curve(o2, MID * Math.pow(2, s), state.ev);
          d += (d ? "L" : "M") + px(s).toFixed(1) + "," + py(v).toFixed(1);
        }
        svgEl("path", { d: d, class: o2 === op ? "s-acc w3 round" : "s-muted", "stroke-opacity": o2 === op ? 1 : 0.6 }, gCurves);
      });
      // Where the chosen curve reaches white.
      var sw = null;
      for (var s2 = PLOT.s0; s2 <= PLOT.s1; s2 += 0.0625) {
        if (curve(op, MID * Math.pow(2, s2), state.ev) >= 0.995) { sw = s2; break; }
      }
      if (sw !== null) {
        svgEl("line", { x1: px(sw), y1: PLOT.y0 - 2, x2: px(sw), y2: PLOT.y1, class: "s-pix dash" }, gCurves);
        svgEl("text", { x: px(sw) + (sw > 5 ? -4 : 4), y: PLOT.y1 - 6, class: "t-small t-pix " + (sw > 5 ? "end" : ""), text: "white from here" }, gCurves);
      }
      // Markers for the picture's parts, on the chosen curve.
      MARKS.forEach(function (m) {
        var s = Math.log(m.lum / MID) / Math.LN2;
        if (s < PLOT.s0 || s > PLOT.s1) return;
        var v = curve(op, m.lum, state.ev);
        svgEl("circle", { cx: px(s), cy: py(v), r: 4.5, class: "f-surface s-ink w15" }, gMarks);
        // Labels sit up and to the left of a rising curve, except the sunlit
        // wall's, which sits below right so it never meets the sky's.
        svgEl("text", { x: px(s) + m.dx, y: py(v) + m.dy, class: "t-small " + m.anchor, text: m.label }, gMarks);
      });
      // Legend.
      var lx = PLOT.x0;
      OPS.forEach(function (o2) {
        svgEl("line", { x1: lx, y1: 32, x2: lx + 18, y2: 32, class: o2 === op ? "s-acc w3" : "s-muted" }, gLegend);
        svgEl("text", { x: lx + 23, y: 36, class: "t-small" + (o2 === op ? " t-acc t-strong" : " t-muted"), text: o2.label }, gLegend);
        lx += 32 + o2.label.length * 6.2;
      });
    }

    document.addEventListener("hb:themechange", function () {
      window.requestAnimationFrame(function () { readTheme(); request(); });
    });

    readTheme();
    render();
    if (log) log.debug("ready", OPS.map(function (op) { return op.id + " scale " + op.scale.toFixed(3); }).join(", "));
  }

  if (HB.demos && HB.demos.register) HB.demos.register("tone-curve-lab", init);
})();

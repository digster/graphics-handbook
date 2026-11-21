/*
 * linear-blend.js: chapter 3.2's interactive.
 *
 * Shows the same operation done two ways, side by side:
 *
 *   Gamma space   maths on the stored (sRGB-encoded) numbers directly, the
 *                 way an image editor or a renderer without linear colour
 *                 would do it.
 *   Linear space  decode to linear light with the sRGB transfer function
 *                 (IEC 61966-2-1), do the maths, encode again for display.
 *
 * Two operations:
 *   Two colours   a gradient from colour A to colour B, with a marker at the
 *                 mix amount. Readout: both mixes as stored values and as
 *                 relative luminance (Rec. 709 weights on linear values).
 *   Blur          a dark scene with three small bright lights, blurred with a
 *                 Gaussian. Readout: how much light survives the blur.
 *
 * The colours themselves are the content, so this is per-pixel canvas work;
 * nothing on the canvases depends on the page theme. Labels are HTML.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("linear-blend");
  var h = HB.html;

  /* ---------- sRGB transfer functions (IEC 61966-2-1), values 0..1 ---------- */

  function decode(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function encode(l) {
    if (l <= 0) return 0;
    if (l >= 1) return 1;
    return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  }
  /* Lookup table for decoding 8-bit values quickly. */
  var DEC = new Float32Array(256);
  for (var i = 0; i < 256; i++) DEC[i] = decode(i / 255);

  /* Relative luminance from linear RGB (Rec. 709 / sRGB primaries). */
  function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(c) {
    return "#" + c.map(function (v) { return ("0" + v.toString(16)).slice(-2); }).join("");
  }

  /* Mix two 8-bit colours by t, as stored numbers or as light. */
  function mixGamma(a, b, t) {
    return a.map(function (v, k) { return Math.round(v + (b[k] - v) * t); });
  }
  function mixLinear(a, b, t) {
    return a.map(function (v, k) {
      return Math.round(255 * encode(DEC[v] + (DEC[b[k]] - DEC[v]) * t));
    });
  }
  function lumOf(c) {
    return luminance(DEC[c[0]], DEC[c[1]], DEC[c[2]]);
  }

  var PRESETS = [
    { value: "rg", label: "Red, green", a: "#ff0000", b: "#00ff00" },
    { value: "by", label: "Blue, yellow", a: "#0000ff", b: "#ffff00" },
    { value: "bw", label: "Black, white", a: "#000000", b: "#ffffff" },
    { value: "mg", label: "Magenta, green", a: "#ff00ff", b: "#00ff00" }
  ];

  /* ---------- Blur scene ---------- */

  var BW = 300;
  var BH = 150;
  var BG = [16, 20, 40];
  var LIGHTS = [
    { x: 62, y: 70, r: 5, c: [255, 255, 255] },
    { x: 150, y: 70, r: 5, c: [255, 176, 64] },
    { x: 238, y: 70, r: 5, c: [64, 200, 255] }
  ];

  /* The unblurred scene as three Float32 channels of stored values 0..1. */
  function buildScene() {
    var ch = [new Float32Array(BW * BH), new Float32Array(BW * BH), new Float32Array(BW * BH)];
    for (var y = 0; y < BH; y++) {
      for (var x = 0; x < BW; x++) {
        var c = BG;
        LIGHTS.forEach(function (L) {
          var dx = x + 0.5 - L.x;
          var dy = y + 0.5 - L.y;
          if (dx * dx + dy * dy <= L.r * L.r) c = L.c;
        });
        // A thin bright line under the lights.
        if (y >= 116 && y < 118 && x >= 30 && x < 270) c = [255, 255, 255];
        for (var k = 0; k < 3; k++) ch[k][y * BW + x] = c[k] / 255;
      }
    }
    return ch;
  }

  /* Separable Gaussian blur, edges clamped. */
  function blur(src, sigma) {
    var rad = Math.max(1, Math.ceil(sigma * 3));
    var kern = new Float32Array(2 * rad + 1);
    var sum = 0;
    for (var k = -rad; k <= rad; k++) {
      kern[k + rad] = Math.exp(-(k * k) / (2 * sigma * sigma));
      sum += kern[k + rad];
    }
    for (k = 0; k < kern.length; k++) kern[k] /= sum;
    var tmp = new Float32Array(BW * BH);
    var out = new Float32Array(BW * BH);
    var x, y, acc, xx, yy;
    for (y = 0; y < BH; y++) {
      for (x = 0; x < BW; x++) {
        acc = 0;
        for (k = -rad; k <= rad; k++) {
          xx = x + k < 0 ? 0 : x + k >= BW ? BW - 1 : x + k;
          acc += src[y * BW + xx] * kern[k + rad];
        }
        tmp[y * BW + x] = acc;
      }
    }
    for (y = 0; y < BH; y++) {
      for (x = 0; x < BW; x++) {
        acc = 0;
        for (k = -rad; k <= rad; k++) {
          yy = y + k < 0 ? 0 : y + k >= BH ? BH - 1 : y + k;
          acc += tmp[yy * BW + x] * kern[k + rad];
        }
        out[y * BW + x] = acc;
      }
    }
    return out;
  }

  /* ---------- Init ---------- */

  function init(root) {
    var state = { mode: "mix", preset: "rg", a: [255, 0, 0], b: [0, 255, 0], t: 0.5, sigma: 8 };
    var scene = buildScene();

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Linear blend" }),
      h("span", { class: "demo-hint", text: "The same maths on stored numbers (top or left) and on light (bottom or right)." })
    ]));

    /* Controls */
    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Operation", [
      { value: "mix", label: "Mix two colours" },
      { value: "blur", label: "Blur bright lights" }
    ], state.mode, function (v) { state.mode = v; layout(); draw(); }));

    var mixControls = h("div", { class: "demo-controls" });
    var presetControl = HB.segmented("Colours", PRESETS.map(function (p) { return { value: p.value, label: p.label }; }), state.preset, function (v) {
      var p = PRESETS.filter(function (q) { return q.value === v; })[0];
      state.preset = v;
      state.a = hexToRgb(p.a);
      state.b = hexToRgb(p.b);
      pickA.value = p.a;
      pickB.value = p.b;
      draw();
    });
    var pickA = h("input", { type: "color", id: "lb-a", value: rgbToHex(state.a) });
    var pickB = h("input", { type: "color", id: "lb-b", value: rgbToHex(state.b) });
    function onPick() {
      state.a = hexToRgb(pickA.value);
      state.b = hexToRgb(pickB.value);
      presetControl.querySelectorAll("button").forEach(function (btn) { btn.setAttribute("aria-pressed", "false"); });
      draw();
    }
    pickA.addEventListener("input", onPick);
    pickB.addEventListener("input", onPick);
    mixControls.appendChild(presetControl);
    mixControls.appendChild(h("div", { class: "control" }, [h("label", { class: "label", for: "lb-a", text: "Colour A" }), pickA]));
    mixControls.appendChild(h("div", { class: "control" }, [h("label", { class: "label", for: "lb-b", text: "Colour B" }), pickB]));
    mixControls.appendChild(HB.slider("lb-t", "Mix amount", {
      min: 0, max: 100, step: 1, value: state.t * 100,
      format: function (v) { return v + "% B"; }
    }, function (v) { state.t = v / 100; draw(); }));

    var blurControls = h("div", { class: "demo-controls" });
    blurControls.appendChild(HB.slider("lb-sigma", "Blur size", {
      min: 1, max: 20, step: 1, value: state.sigma,
      format: function (v) { return v + " px"; }
    }, function (v) { state.sigma = v; draw(); }));

    controls.appendChild(mixControls);
    controls.appendChild(blurControls);
    root.appendChild(controls);

    /* Stage: mix view */
    var canvasStyle = "display:block;width:100%;border:1px solid var(--line-strong);border-radius:6px";
    function strip(id, title) {
      var cv = h("canvas", { width: 600, height: 40, style: canvasStyle + ";height:48px", role: "img", "aria-label": title });
      var sw = h("canvas", { width: 48, height: 48, style: "display:block;width:48px;height:48px;border:1px solid var(--line-strong);border-radius:6px;flex:none" });
      var val = h("span", { class: "t-mono", style: "font-family:var(--font-mono);font-size:var(--fs-sm)" });
      return {
        cv: cv, sw: sw, val: val,
        el: h("div", { class: "demo-panel" }, [
          h("span", { class: "label", text: title }),
          h("div", { style: "display:flex;gap:.75rem;align-items:center;min-width:0" }, [
            h("div", { style: "flex:1;min-width:0" }, [cv]),
            sw
          ]),
          val
        ])
      };
    }
    var gammaStrip = strip("lb-g", "Mixed as stored numbers (gamma space)");
    var linearStrip = strip("lb-l", "Mixed as light (linear space)");
    var mixView = h("div", { class: "demo-panels" }, [gammaStrip.el, linearStrip.el]);

    /* Stage: blur view */
    function blurPanel(title) {
      var cv = h("canvas", { width: BW, height: BH, style: canvasStyle + ";height:auto;aspect-ratio:2/1", role: "img", "aria-label": title });
      return { cv: cv, el: h("div", { class: "demo-panel" }, [h("span", { class: "label", text: title }), cv]) };
    }
    var blurG = blurPanel("Blurred as stored numbers (gamma space)");
    var blurL = blurPanel("Blurred as light (linear space)");
    var blurView = h("div", { style: "display:grid;gap:var(--sp-4);grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr))" }, [blurG.el, blurL.el]);

    root.appendChild(mixView);
    root.appendChild(blurView);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);
    var note = h("p", { class: "demo-hint" });
    root.appendChild(note);

    function layout() {
      var mix = state.mode === "mix";
      mixControls.hidden = !mix;
      mixView.hidden = !mix;
      blurControls.hidden = mix;
      blurView.hidden = mix;
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    /* ---------- Mix view ---------- */

    function paintStrip(cv, mixFn) {
      var ctx = cv.getContext("2d");
      var W = cv.width;
      var H = cv.height;
      var img = ctx.createImageData(W, H);
      for (var x = 0; x < W; x++) {
        var c = mixFn(state.a, state.b, x / (W - 1));
        for (var y = 0; y < H; y++) {
          var o = (y * W + x) * 4;
          img.data[o] = c[0];
          img.data[o + 1] = c[1];
          img.data[o + 2] = c[2];
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      // Marker at the mix amount: a dark and a light line, visible on any colour.
      var mx = Math.round(state.t * (W - 1));
      ctx.fillStyle = "rgb(0,0,0)";
      ctx.fillRect(mx - 2, 0, 1, H);
      ctx.fillRect(mx + 2, 0, 1, H);
      ctx.fillStyle = "rgb(255,255,255)";
      ctx.fillRect(mx - 1, 0, 3, H);
    }

    function paintSwatch(cv, c) {
      var ctx = cv.getContext("2d");
      ctx.fillStyle = "rgb(" + c.join(",") + ")";
      ctx.fillRect(0, 0, cv.width, cv.height);
    }

    function drawMix() {
      paintStrip(gammaStrip.cv, mixGamma);
      paintStrip(linearStrip.cv, mixLinear);
      var g = mixGamma(state.a, state.b, state.t);
      var l = mixLinear(state.a, state.b, state.t);
      paintSwatch(gammaStrip.sw, g);
      paintSwatch(linearStrip.sw, l);
      var yg = lumOf(g);
      var yl = lumOf(l);
      var ya = lumOf(state.a);
      var yb = lumOf(state.b);
      gammaStrip.val.textContent = "At " + Math.round(state.t * 100) + "%: stored (" + g.join(", ") + "), brightness " + yg.toFixed(2);
      linearStrip.val.textContent = "At " + Math.round(state.t * 100) + "%: stored (" + l.join(", ") + "), brightness " + yl.toFixed(2);
      readout.replaceChildren(
        cell("Brightness of A and B", ya.toFixed(2) + " and " + yb.toFixed(2)),
        cell("Gamma-space mix", yg.toFixed(2)),
        cell("Linear-space mix", yl.toFixed(2)),
        cell("Gamma mix is", yl > 0.0005 ? Math.round(100 * (1 - yg / yl)) + "% darker" : "the same")
      );
      var below = yg < Math.min(ya, yb) - 0.005;
      note.textContent = "Brightness here is relative luminance: the light the pixel gives off, from 0 (black) to 1 (white). " +
        (below ? "The gamma-space mix is darker than both of the colours it was mixed from, which no real mix of light can be." :
          "Mixing stored numbers is never brighter than mixing light, and usually darker in the middle.");
    }

    /* ---------- Blur view ---------- */

    function paintImage(cv, chans) {
      var ctx = cv.getContext("2d");
      var img = ctx.createImageData(BW, BH);
      for (var p = 0; p < BW * BH; p++) {
        img.data[p * 4] = Math.round(255 * chans[0][p]);
        img.data[p * 4 + 1] = Math.round(255 * chans[1][p]);
        img.data[p * 4 + 2] = Math.round(255 * chans[2][p]);
        img.data[p * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }

    /* Light in the image above the background, in linear luminance units. */
    function lightAbove(chans) {
      var bg = luminance(DEC[BG[0]], DEC[BG[1]], DEC[BG[2]]);
      var total = 0;
      for (var p = 0; p < BW * BH; p++) {
        total += luminance(decode(chans[0][p]), decode(chans[1][p]), decode(chans[2][p])) - bg;
      }
      return total;
    }

    var baseLight = lightAbove(scene);

    function drawBlur() {
      var s = state.sigma;
      var g = scene.map(function (ch) { return blur(ch, s); });
      var l = scene.map(function (ch) {
        var lin = new Float32Array(ch.length);
        for (var p = 0; p < ch.length; p++) lin[p] = decode(ch[p]);
        var b = blur(lin, s);
        for (p = 0; p < b.length; p++) b[p] = encode(b[p]);
        return b;
      });
      paintImage(blurG.cv, g);
      paintImage(blurL.cv, l);
      var centre = Math.round(LIGHTS[0].y) * BW + Math.round(LIGHTS[0].x);
      var lg = lightAbove(g) / baseLight;
      var ll = lightAbove(l) / baseLight;
      readout.replaceChildren(
        cell("White light's centre, stored", "gamma " + Math.round(255 * g[1][centre]) + " · linear " + Math.round(255 * l[1][centre])),
        cell("Light kept after blurring", "gamma " + Math.round(100 * lg) + "% · linear " + Math.round(100 * ll) + "%")
      );
      note.textContent = "A blur should spread light out, not lose it. Done on light, the total stays the same and the lights glow; done on stored numbers, light disappears and the lights shrink into dim smudges.";
    }

    function draw() {
      if (state.mode === "mix") drawMix();
      else drawBlur();
    }

    layout();
    draw();
    log.debug("ready");
  }

  HB.demos.register("linear-blend", init);
})();

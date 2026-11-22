/*
 * filter-floor.js: chapter 6.2's interactive.
 *
 * A checkerboard floor running to the horizon, rendered pixel by pixel on a
 * 320 × 180 canvas the way a GPU would texture it:
 *
 *   1. For every pixel, cast a ray from the camera and intersect it with
 *      the floor plane y = 0 (orthonormal camera, 50° vertical field of
 *      view, 1 m above the floor, tilted 12° down).
 *   2. Turn the hit point into texel coordinates: the 64 × 64 texture
 *      repeats every 2 m, so 32 texels per metre.
 *   3. Work out the pixel's footprint from the texel coordinates of its
 *      right and lower neighbours: the screen-space derivatives a GPU gets
 *      from each 2 × 2 quad of pixels.
 *   4. Filter, using the mode chosen:
 *        nearest      1 texel of mip 0
 *        bilinear     4 texels of mip 0
 *        mip-nearest  4 texels of the nearest mip level (bilinear + mipmaps)
 *        trilinear    4 texels from each of the two nearest levels, blended
 *        anisotropic  N trilinear probes spread along the footprint's long
 *                     axis, at the level of its short axis, following the
 *                     reference method in the EXT_texture_filter_anisotropic
 *                     specification: N = min(ceil(Pmax / Pmin), maxAniso),
 *                     lambda = log2(Pmax / N)
 *
 * Level of detail: lambda = log2(max(Px, Py)) + LOD bias, where Px and Py
 * are the lengths of the footprint's two edges in level-0 texels.
 *
 * Mips are built once, by 2 × 2 box filtering in linear light (the texture
 * is sRGB, so it is decoded first). Rendering happens only when a control
 * changes, at most once per animation frame. Nothing runs while idle.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("filter-floor");
  var h = HB.html;

  /* ---------- Scene constants ---------- */

  var W = 320;
  var H = 180;
  var FOV = 50 * Math.PI / 180;
  var TILT = 12 * Math.PI / 180;
  var CAM_H = 1.0; // metres above the floor
  var CAM_X = 0.3; // off-centre, so the pattern is not symmetric
  var TILE = 2.0; // metres covered by one repeat of the texture
  var TS = 64; // texture size in texels
  var LEVELS = 7; // 64, 32, 16, 8, 4, 2, 1

  /* ---------- Colour ---------- */

  function decode(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function encode(l) {
    if (l <= 0) return 0;
    if (l >= 1) return 1;
    return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  }
  var ENC_N = 4096;
  var ENC = new Uint8Array(ENC_N + 1);
  for (var e = 0; e <= ENC_N; e++) ENC[e] = Math.round(255 * encode(e / ENC_N));
  function lin(c) { return [decode(c[0] / 255), decode(c[1] / 255), decode(c[2] / 255)]; }

  /* Texture content: 16-texel checks, each with a round dot of radius 4.5
     texels in a contrasting colour. The dots make blocky texels obvious. */
  var LIGHT = lin([226, 221, 208]);
  var DARK = lin([46, 52, 70]);
  var DOT_ON_LIGHT = lin([74, 78, 214]);
  var DOT_ON_DARK = lin([236, 232, 220]);

  /* Debug tints for the mip-level view, one per level (content colours,
     the same in both themes). */
  var TINTS = [
    [222, 64, 64], [236, 146, 40], [214, 200, 40], [70, 172, 84],
    [40, 170, 196], [70, 96, 220], [180, 72, 196]
  ];
  var TINTS_LIN = TINTS.map(lin);

  /* ---------- Texture and mip chain ---------- */

  function buildMips() {
    var mips = [];
    var base = new Float32Array(TS * TS * 3);
    for (var y = 0; y < TS; y++) {
      for (var x = 0; x < TS; x++) {
        var check = ((x >> 4) + (y >> 4)) & 1;
        var dx = (x & 15) + 0.5 - 8;
        var dy = (y & 15) + 0.5 - 8;
        var inDot = dx * dx + dy * dy <= 4.5 * 4.5;
        var c = check ? (inDot ? DOT_ON_DARK : DARK) : (inDot ? DOT_ON_LIGHT : LIGHT);
        var o = (y * TS + x) * 3;
        base[o] = c[0];
        base[o + 1] = c[1];
        base[o + 2] = c[2];
      }
    }
    mips.push(base);
    for (var l = 1, size = TS / 2; l < LEVELS; l++, size /= 2) {
      var src = mips[l - 1];
      var ss = size * 2;
      var dst = new Float32Array(size * size * 3);
      for (var j = 0; j < size; j++) {
        for (var i = 0; i < size; i++) {
          for (var k = 0; k < 3; k++) {
            dst[(j * size + i) * 3 + k] = 0.25 * (
              src[((2 * j) * ss + 2 * i) * 3 + k] + src[((2 * j) * ss + 2 * i + 1) * 3 + k] +
              src[((2 * j + 1) * ss + 2 * i) * 3 + k] + src[((2 * j + 1) * ss + 2 * i + 1) * 3 + k]);
          }
        }
      }
      mips.push(dst);
    }
    return mips;
  }

  var MIPS = buildMips();

  /* ---------- Sampling (coordinates in level-0 texels) ---------- */

  var out = [0, 0, 0];
  var acc = [0, 0, 0];
  var reads = 0;

  function nearest(level, u, v, res) {
    var size = TS >> level;
    var s = 1 << level;
    var ix = Math.floor(u / s) & (size - 1);
    var iy = Math.floor(v / s) & (size - 1);
    var m = MIPS[level];
    var o = (iy * size + ix) * 3;
    res[0] = m[o];
    res[1] = m[o + 1];
    res[2] = m[o + 2];
    reads += 1;
  }

  function bilinear(level, u, v, res) {
    var size = TS >> level;
    var s = 1 << level;
    var x = u / s - 0.5;
    var y = v / s - 0.5;
    var x0 = Math.floor(x);
    var y0 = Math.floor(y);
    var fx = x - x0;
    var fy = y - y0;
    var m = MIPS[level];
    var mask = size - 1;
    var xa = x0 & mask;
    var xb = (x0 + 1) & mask;
    var ya = (y0 & mask) * size;
    var yb = ((y0 + 1) & mask) * size;
    var w00 = (1 - fx) * (1 - fy);
    var w10 = fx * (1 - fy);
    var w01 = (1 - fx) * fy;
    var w11 = fx * fy;
    var o00 = (ya + xa) * 3;
    var o10 = (ya + xb) * 3;
    var o01 = (yb + xa) * 3;
    var o11 = (yb + xb) * 3;
    for (var k = 0; k < 3; k++) {
      res[k] = m[o00 + k] * w00 + m[o10 + k] * w10 + m[o01 + k] * w01 + m[o11 + k] * w11;
    }
    reads += 4;
  }

  var tmpA = [0, 0, 0];
  var tmpB = [0, 0, 0];

  /* Trilinear probe at level of detail lambda. Returns the level used
     (fractional) through lastLevel, for the mip colour view. */
  var lastLevel = 0;
  function trilinear(lambda, u, v, res) {
    if (lambda <= 0) { bilinear(0, u, v, res); lastLevel = 0; return; }
    var max = LEVELS - 1;
    if (lambda >= max) { bilinear(max, u, v, res); lastLevel = max; return; }
    var l0 = Math.floor(lambda);
    var f = lambda - l0;
    bilinear(l0, u, v, tmpA);
    bilinear(l0 + 1, u, v, tmpB);
    for (var k = 0; k < 3; k++) res[k] = tmpA[k] + (tmpB[k] - tmpA[k]) * f;
    lastLevel = lambda;
  }

  function tintFor(level) {
    var l0 = Math.min(LEVELS - 1, Math.floor(level));
    var l1 = Math.min(LEVELS - 1, l0 + 1);
    var f = level - l0;
    var a = TINTS_LIN[l0];
    var b = TINTS_LIN[l1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  /* ---------- Rendering ---------- */

  var MODES = [
    { value: "nearest", label: "Nearest" },
    { value: "bilinear", label: "Bilinear" },
    { value: "mipnearest", label: "Bilinear + mipmaps" },
    { value: "trilinear", label: "Trilinear" },
    { value: "aniso", label: "Anisotropic" }
  ];
  var NOTES = {
    nearest: "Near the camera each texel is a hard-edged block. Far away each pixel picks one texel out of dozens, so the checks break into noise and moiré, and the noise crawls as the camera moves.",
    bilinear: "Near the camera the texels blend smoothly. The far floor is still noise: bilinear only ever mixes 4 texels, but a far pixel covers hundreds of them.",
    mipnearest: "Each pixel now reads a pre-shrunk copy that suits its size, so the far floor calms down. Look for the lines across the floor where one mip level hands over to the next.",
    trilinear: "Blending the two nearest levels hides the lines. The far floor turns to grey blur, because one square footprint is too big along the floor's depth and too small across it.",
    aniso: "Several probes along the long axis of each footprint, at a sharper level, keep the far checks readable. It costs more texel reads, almost all of them near the horizon."
  };

  function init(root) {
    var state = { mode: "bilinear", bias: 0, camZ: 0, maxAniso: 16, tint: false };
    var pending = false;
    var sky = [236, 238, 244];

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Filter floor" }),
      h("span", { class: "demo-hint", text: "A 64 × 64 checker texture on a floor, drawn pixel by pixel at 320 × 180. Pick a filter, then move the camera and watch the far floor." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Filtering", MODES, state.mode, function (v) { state.mode = v; sync(); request(); }));
    controls.appendChild(HB.slider("ff-cam", "Move the camera", {
      min: 0, max: 2, step: 0.01, value: state.camZ,
      format: function (v) { return v.toFixed(2) + " m"; }
    }, function (v) { state.camZ = v; request(); }));
    var biasControl = HB.slider("ff-bias", "LOD bias", {
      min: -2, max: 2, step: 0.25, value: state.bias,
      format: function (v) { return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2); }
    }, function (v) { state.bias = v; request(); });
    controls.appendChild(biasControl);
    var anisoControl = HB.segmented("Max anisotropy", [
      { value: 2, label: "2×" }, { value: 4, label: "4×" }, { value: 8, label: "8×" }, { value: 16, label: "16×" }
    ], state.maxAniso, function (v) { state.maxAniso = v; request(); });
    controls.appendChild(anisoControl);
    var tintBox = h("input", { type: "checkbox", id: "ff-tint" });
    tintBox.addEventListener("change", function () { state.tint = tintBox.checked; sync(); request(); });
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "View" }),
      h("div", { class: "checks" }, [h("label", { for: "ff-tint" }, [tintBox, "Colour by mip level"])])
    ]));
    root.appendChild(controls);

    var canvas = h("canvas", {
      width: W, height: H, role: "img",
      style: "display:block;width:100%;height:auto;aspect-ratio:16/9;image-rendering:pixelated;border:1px solid var(--line-strong);border-radius:8px"
    });
    root.appendChild(h("div", { class: "demo-stage" }, [canvas]));
    var ctx = canvas.getContext("2d");
    var img = ctx.createImageData(W, H);

    var legend = h("div", { class: "legend-row" }, [h("span", { text: "Mip level:" })].concat(TINTS.map(function (c, i) {
      return h("span", null, [h("span", { class: "sw", style: "background:rgb(" + c.join(",") + ")" }), String(i) + " (" + (TS >> i) + "²)"]);
    })));
    root.appendChild(legend);
    var note = h("p", { class: "demo-hint" });
    root.appendChild(note);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    function usesMips(mode) {
      return mode === "mipnearest" || mode === "trilinear" || mode === "aniso";
    }

    /* Show controls only where they do something. */
    function sync() {
      legend.hidden = !state.tint;
      biasControl.style.opacity = usesMips(state.mode) ? "" : "0.45";
      biasControl.title = usesMips(state.mode) ? "" : "LOD bias only changes which mip level is read, so it needs mipmaps";
      anisoControl.style.opacity = state.mode === "aniso" ? "" : "0.45";
      note.textContent = NOTES[state.mode];
    }

    /* Read a theme colour as RGB through a 1 × 1 canvas, so any CSS colour
       syntax works. */
    var probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    var pctx = probe.getContext("2d", { willReadFrequently: true });
    function readSky() {
      try {
        pctx.fillStyle = HB.demos.color("sunken") || "#eceef4";
        pctx.fillRect(0, 0, 1, 1);
        var d = pctx.getImageData(0, 0, 1, 1).data;
        sky = [d[0], d[1], d[2]];
      } catch (err) {
        log.warn("could not read the theme colour", err);
      }
    }

    /* Texel coordinates of every pixel centre plus one extra column and
       row, so each pixel can difference with its right and lower
       neighbours. NaN marks rays that miss the floor. */
    var UU = new Float64Array((W + 1) * (H + 1));
    var VV = new Float64Array((W + 1) * (H + 1));
    function castRays() {
      var tv = Math.tan(FOV / 2);
      var asp = W / H;
      var fy = -Math.sin(TILT);
      var fz = -Math.cos(TILT);
      var uy = Math.cos(TILT);
      var uz = -Math.sin(TILT);
      var k = TS / TILE;
      for (var y = 0; y <= H; y++) {
        var yn = (1 - 2 * (y + 0.5) / H) * tv;
        var dy = fy + yn * uy;
        var dz = fz + yn * uz;
        for (var x = 0; x <= W; x++) {
          var idx = y * (W + 1) + x;
          if (dy >= -1e-7) { UU[idx] = NaN; VV[idx] = NaN; continue; }
          var dx = (2 * (x + 0.5) / W - 1) * tv * asp;
          var t = -CAM_H / dy;
          UU[idx] = (CAM_X + t * dx) * k;
          VV[idx] = (-state.camZ + t * dz) * k;
        }
      }
    }

    function render() {
      pending = false;
      castRays();
      var data = img.data;
      var mode = state.mode;
      var tint = state.tint;
      var bias = state.bias;
      var maxA = state.maxAniso;
      var floorPx = 0;
      var minL = Infinity;
      var maxL = -Infinity;
      reads = 0;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var o = (y * W + x) * 4;
          var idx = y * (W + 1) + x;
          var u = UU[idx];
          if (u !== u) { // NaN: sky
            data[o] = sky[0]; data[o + 1] = sky[1]; data[o + 2] = sky[2]; data[o + 3] = 255;
            continue;
          }
          floorPx++;
          var v = VV[idx];
          var dudx = UU[idx + 1] - u;
          var dvdx = VV[idx + 1] - v;
          var dudy = UU[idx + W + 1] - u;
          var dvdy = VV[idx + W + 1] - v;
          var px = Math.sqrt(dudx * dudx + dvdx * dvdx);
          var py = Math.sqrt(dudy * dudy + dvdy * dvdy);
          var level = 0;
          if (mode === "nearest") {
            nearest(0, u, v, out);
          } else if (mode === "bilinear") {
            bilinear(0, u, v, out);
          } else if (mode === "mipnearest") {
            var lam = Math.log2(Math.max(px, py)) + bias;
            level = Math.max(0, Math.min(LEVELS - 1, Math.round(lam)));
            bilinear(level, u, v, out);
          } else if (mode === "trilinear") {
            trilinear(Math.log2(Math.max(px, py)) + bias, u, v, out);
            level = lastLevel;
          } else {
            var pmax = Math.max(px, py);
            var pmin = Math.max(1e-6, Math.min(px, py));
            var n = Math.min(Math.ceil(pmax / pmin), maxA);
            var lamA = Math.log2(pmax / n) + bias;
            var ax = px > py ? dudx : dudy;
            var ay = px > py ? dvdx : dvdy;
            acc[0] = acc[1] = acc[2] = 0;
            var lvl = 0;
            for (var i = 1; i <= n; i++) {
              var f = i / (n + 1) - 0.5;
              trilinear(lamA, u + ax * f, v + ay * f, out);
              acc[0] += out[0]; acc[1] += out[1]; acc[2] += out[2];
              lvl = lastLevel;
            }
            out[0] = acc[0] / n; out[1] = acc[1] / n; out[2] = acc[2] / n;
            level = lvl;
          }
          if (level < minL) minL = level;
          if (level > maxL) maxL = level;
          var r = out[0];
          var g = out[1];
          var b = out[2];
          if (tint) {
            var tc = tintFor(level);
            r = r * 0.4 + tc[0] * 0.6;
            g = g * 0.4 + tc[1] * 0.6;
            b = b * 0.4 + tc[2] * 0.6;
          }
          data[o] = ENC[Math.min(ENC_N, (r * ENC_N) | 0)];
          data[o + 1] = ENC[Math.min(ENC_N, (g * ENC_N) | 0)];
          data[o + 2] = ENC[Math.min(ENC_N, (b * ENC_N) | 0)];
          data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      var perPx = floorPx ? reads / floorPx : 0;
      var lo = Math.floor(minL + 1e-9);
      var hi = Math.ceil(maxL - 1e-9);
      function cell(label, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
      }
      var modeLabel = MODES.filter(function (m) { return m.value === mode; })[0].label;
      if (mode === "aniso") modeLabel += " " + maxA + "×";
      readout.replaceChildren(
        cell("Filter", modeLabel),
        cell("Texels read per pixel", perPx < 10 ? perPx.toFixed(1) : String(Math.round(perPx))),
        cell("Mip levels used", usesMips(mode) ? (lo === hi ? String(lo) : lo + " to " + hi) : "0 only"),
        cell("Pixels drawn", HB.fmt.int(W * H))
      );
      canvas.setAttribute("aria-label", "A checkerboard floor receding to the horizon, filtered with " + modeLabel +
        ". On average " + perPx.toFixed(1) + " texels are read per floor pixel.");
    }

    function request() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(render);
    }

    document.addEventListener("hb:themechange", function () {
      // The new tokens apply on the next style pass.
      window.requestAnimationFrame(function () { readSky(); request(); });
    });

    readSky();
    sync();
    render();
    log.debug("ready");
  }

  HB.demos.register("filter-floor", init);
})();

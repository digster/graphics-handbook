/*
 * material-sphere.js: chapter 6.5's interactive.
 *
 * A sphere shaded per pixel on a 256 × 256 canvas with the metal/roughness
 * model most engines use, under one draggable light and a simple ambient
 * term. Everything is recomputed whenever a control changes.
 *
 * Shading (Karis, "Real Shading in Unreal Engine 4", SIGGRAPH 2013 course
 * notes, equations 1 to 5):
 *   diffuse   Lambert, c_diff / PI, with c_diff = base * (1 - metallic)
 *   specular  Cook-Torrance D * F * G / (4 (n.l)(n.v))
 *     D  GGX / Trowbridge-Reitz, alpha = roughness^2
 *     G  Schlick-GGX, k = (roughness + 1)^2 / 8 for the analytic light,
 *        k = alpha / 2 for image-based (ambient) light, as the notes say
 *     F  Schlick, with Karis's spherical Gaussian form of the power
 *   F0 = mix(0.04, base, metallic): non-metals reflect 4% head-on, metals
 *        reflect their base colour (glTF 2.0 and Unreal's default).
 *
 * Ambient: a two-tone studio environment (lit sky above, dark floor below).
 * Diffuse ambient uses that environment's exact irradiance; specular
 * ambient blurs the environment with roughness (an approximation) and
 * weights it with the split-sum scale and bias (F0 * A + B), integrated
 * at start-up with Karis's IntegrateBRDF importance sampling.
 *
 * Display: values are linear light. A short shoulder above 0.8 keeps
 * highlights from clipping hard, then the sRGB curve encodes for the
 * screen. Below 0.8 nothing is changed, so base colours read honestly.
 *
 * Views: Lit, Fresnel only (F for the view direction, the share of the
 * environment a mirror would reflect), Specular only, Diffuse only.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("material-sphere");
  var h = HB.html;
  var svgEl = HB.svg.el;

  var SIZE = 256;          // canvas pixels, square
  var CX = SIZE / 2;
  var CY = SIZE / 2;
  var RADIUS = 86;         // sphere radius in canvas pixels
  var R_MAX = 1.42;        // furthest the light handle goes, in sphere radii
  /* The handle's distance from the centre sets the light's angle from the
     view direction: 65° per sphere radius, so a handle just outside the
     rim lights from the side and the furthest position, 92°, grazes from
     slightly behind. */
  var DEG_PER_RADIUS = 65;
  var PI = Math.PI;

  /* Light and environment, in linear units chosen so a white Lambert
     surface facing the light reads just under 1. */
  var LIGHT_E = 2.2;       // illuminance of the light
  var SKY = 0.55;          // sky radiance at the zenith
  var HORIZON = 0.38;      // sky radiance at the horizon
  var GROUND = 0.04;       // floor radiance

  /* Base colour presets. Linear values. Measured values are from Epic's
     "Physically Based Materials" page; the red plastic is an example. */
  var PRESETS = [
    { id: "charcoal", label: "Charcoal", base: [0.02, 0.02, 0.02], metal: 0, src: "measured 0.02" },
    { id: "concrete", label: "Concrete", base: [0.51, 0.51, 0.51], metal: 0, src: "measured 0.51" },
    { id: "snow", label: "Snow", base: [0.81, 0.81, 0.81], metal: 0, src: "measured 0.81" },
    { id: "plastic", label: "Red plastic", base: [0.55, 0.06, 0.04], metal: 0, src: "example value" },
    { id: "gold", label: "Gold", base: [1.0, 0.766, 0.336], metal: 1, src: "measured" },
    { id: "copper", label: "Copper", base: [0.955, 0.637, 0.538], metal: 1, src: "measured" },
    { id: "iron", label: "Iron", base: [0.56, 0.57, 0.58], metal: 1, src: "measured" }
  ];
  var PRESET_BY_ID = {};
  PRESETS.forEach(function (p) { PRESET_BY_ID[p.id] = p; });

  /* ---------- Maths helpers ---------- */

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }
  function lum(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function f0Of(base, metal) {
    return base.map(function (b) { return 0.04 + (b - 0.04) * metal; });
  }
  /* Schlick's Fresnel with the usual fifth power, for the readouts and the
     plot (the per-pixel code uses Karis's equivalent faster form). */
  function schlick(f0, cosT) {
    var m = 1 - cosT;
    var m5 = m * m * m * m * m;
    return f0 + (1 - f0) * m5;
  }

  /* sRGB encoding (IEC 61966-2-1) through a lookup table: linear 0..1 in
     4096 steps -> 0..255. */
  var ENC = new Uint8ClampedArray(4097);
  for (var e = 0; e <= 4096; e++) {
    var l = e / 4096;
    var s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    ENC[e] = Math.round(s * 255);
  }
  /* Identity below 0.8, then a smooth roll-off towards 1. */
  function shoulder(x) {
    if (x <= 0.8) return x < 0 ? 0 : x;
    return 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
  }
  function toByte(x) {
    return ENC[Math.round(shoulder(x) * 4096)];
  }
  /* For the Fresnel view, whose values are fractions from 0 to 1. */
  function toByteRaw(x) {
    return ENC[Math.round(clamp01(x) * 4096)];
  }

  /* ---------- Split-sum environment BRDF table ---------- */

  /* Van der Corput radical inverse, for the Hammersley point set. */
  function radicalInverse(i) {
    var bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    return bits / 4294967296;
  }

  /* Karis 2013, IntegrateBRDF: scale (A) and bias (B) applied to F0 when
     the specular BRDF is integrated against a white environment. */
  function integrateBRDF(rough, NoV, samples) {
    var vx = Math.sqrt(1 - NoV * NoV);
    var vz = NoV;
    var a = rough * rough;
    var k = a / 2;
    var A = 0;
    var B = 0;
    for (var i = 0; i < samples; i++) {
      var x1 = (i + 0.5) / samples;
      var x2 = radicalInverse(i);
      var phi = 2 * PI * x1;
      var cosT = Math.sqrt((1 - x2) / (1 + (a * a - 1) * x2));
      var sinT = Math.sqrt(1 - cosT * cosT);
      var hx = sinT * Math.cos(phi);
      var hz = cosT;
      var VoH = vx * hx + vz * hz;
      var lz = 2 * VoH * hz - vz;
      var NoL = clamp01(lz);
      var NoH = clamp01(hz);
      VoH = clamp01(VoH);
      if (NoL > 0) {
        var gl = NoL / (NoL * (1 - k) + k);
        var gv = NoV / (NoV * (1 - k) + k);
        var gVis = (gl * gv * VoH) / (NoH * NoV);
        var fc = Math.pow(1 - VoH, 5);
        A += (1 - fc) * gVis;
        B += fc * gVis;
      }
    }
    return [A / samples, B / samples];
  }

  var LUT_N = 32;
  var LUT_A = new Float32Array(LUT_N * LUT_N);
  var LUT_B = new Float32Array(LUT_N * LUT_N);
  (function buildLUT() {
    for (var j = 0; j < LUT_N; j++) {          // roughness
      for (var i = 0; i < LUT_N; i++) {        // n.v
        var nv = Math.max((i + 0.5) / LUT_N, 1e-3);
        var r = Math.max(j / (LUT_N - 1), 0.02);
        var ab = integrateBRDF(r, nv, 96);
        LUT_A[j * LUT_N + i] = ab[0];
        LUT_B[j * LUT_N + i] = ab[1];
      }
    }
  })();
  /* Bilinear lookup. Returns into out[0], out[1]. */
  function envBRDF(rough, NoV, out) {
    var x = clamp01(NoV) * LUT_N - 0.5;
    var y = clamp01(rough) * (LUT_N - 1);
    var x0 = Math.max(0, Math.min(LUT_N - 2, Math.floor(x)));
    var y0 = Math.max(0, Math.min(LUT_N - 2, Math.floor(y)));
    var fx = clamp01(x - x0);
    var fy = clamp01(y - y0);
    var i00 = y0 * LUT_N + x0;
    var i10 = i00 + 1;
    var i01 = i00 + LUT_N;
    var i11 = i01 + 1;
    out[0] = (LUT_A[i00] * (1 - fx) + LUT_A[i10] * fx) * (1 - fy) + (LUT_A[i01] * (1 - fx) + LUT_A[i11] * fx) * fy;
    out[1] = (LUT_B[i00] * (1 - fx) + LUT_B[i10] * fx) * (1 - fy) + (LUT_B[i01] * (1 - fx) + LUT_B[i11] * fx) * fy;
  }

  /* ---------- Environment ---------- */

  /* Radiance seen along direction y (its up component), blurred by
     roughness: the sky-floor edge widens and the whole picture drifts
     towards its average. An approximation of a prefiltered environment. */
  function envRadiance(y, rough) {
    var w = 0.03 + 0.9 * rough * rough;
    var skyPart = HORIZON + (SKY - HORIZON) * clamp01(y);
    var sharp = GROUND + (skyPart - GROUND) * smoothstep(-w, w, y);
    var avg = (SKY + HORIZON) * 0.25 + GROUND * 0.5;
    var t = rough * rough * 0.6;
    return sharp * (1 - t) + avg * t;
  }

  /* ---------- Per-pixel normals, computed once ---------- */

  var NX = new Float32Array(SIZE * SIZE);
  var NY = new Float32Array(SIZE * SIZE);
  var NZ = new Float32Array(SIZE * SIZE);
  var COVER = new Float32Array(SIZE * SIZE);   // antialiased silhouette
  (function buildNormals() {
    for (var py = 0; py < SIZE; py++) {
      for (var px = 0; px < SIZE; px++) {
        var i = py * SIZE + px;
        var dx = (px + 0.5 - CX) / RADIUS;
        var dy = (py + 0.5 - CY) / RADIUS;
        var d = Math.sqrt(dx * dx + dy * dy);
        COVER[i] = clamp01((1 - d) * RADIUS + 0.5);
        if (COVER[i] <= 0) continue;
        // Clamp just inside the rim so edge pixels still get a normal.
        var dd = Math.min(d, 0.999);
        var sx = d > 0 ? (dx / d) * dd : 0;
        var sy = d > 0 ? (dy / d) * dd : 0;
        NX[i] = sx;
        NY[i] = -sy;                 // screen y runs down, world y up
        NZ[i] = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
      }
    }
  })();

  /* ---------- Shading ---------- */

  /*
   * Fills img (RGBA bytes) for the given material and light.
   * light: unit vector [x, y, z]; view is +z (an orthographic camera).
   */
  function shadeImage(img, m, light, view, bg) {
    var data = img.data;
    var base = m.base;
    var metal = m.metal;
    var rough = Math.max(m.rough, 0.05);  // alpha = 0 would be a delta
    var a = rough * rough;
    var a2 = a * a;
    var kDirect = ((rough + 1) * (rough + 1)) / 8;
    var f0 = f0Of(base, metal);
    var cd = [base[0] * (1 - metal), base[1] * (1 - metal), base[2] * (1 - metal)];
    var lx = light[0];
    var ly = light[1];
    var lz = light[2];
    // Half vector between light and view (view = 0, 0, 1).
    var hx = lx;
    var hy = ly;
    var hz = lz + 1;
    var hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
    hx /= hl; hy /= hl; hz /= hl;
    var VoH = clamp01(hz);
    // Karis 2013, equation 5: Schlick with a spherical Gaussian power.
    var fw = Math.pow(2, (-5.55473 * VoH - 6.98316) * VoH);
    var F = [f0[0] + (1 - f0[0]) * fw, f0[1] + (1 - f0[1]) * fw, f0[2] + (1 - f0[2]) * fw];
    var ab = [0, 0];
    var showDiff = view === "lit" || view === "diffuse";
    var showSpec = view === "lit" || view === "specular";

    for (var i = 0, p = 0; i < SIZE * SIZE; i++, p += 4) {
      var cov = COVER[i];
      if (cov <= 0) {
        data[p] = bg[0]; data[p + 1] = bg[1]; data[p + 2] = bg[2]; data[p + 3] = 255;
        continue;
      }
      var nx = NX[i];
      var ny = NY[i];
      var nz = NZ[i];
      var NoV = Math.max(nz, 1e-4);
      var r = 0;
      var g = 0;
      var b = 0;

      if (view === "fresnel") {
        // Schlick for the view direction: the share of the environment a
        // mirror of this material reflects back to the eye.
        var m5 = Math.pow(1 - NoV, 5);
        r = f0[0] + (1 - f0[0]) * m5;
        g = f0[1] + (1 - f0[1]) * m5;
        b = f0[2] + (1 - f0[2]) * m5;
      } else {
        var NoL = nx * lx + ny * ly + nz * lz;
        // Direct light from the one light.
        if (NoL > 0) {
          if (showDiff) {
            var dk = (LIGHT_E * NoL) / PI;
            r += cd[0] * dk; g += cd[1] * dk; b += cd[2] * dk;
          }
          if (showSpec) {
            var NoH = clamp01(nx * hx + ny * hy + nz * hz);
            var dd = NoH * NoH * (a2 - 1) + 1;
            var D = a2 / (PI * dd * dd);
            var G = (NoL / (NoL * (1 - kDirect) + kDirect)) * (NoV / (NoV * (1 - kDirect) + kDirect));
            var sk = ((D * G) / (4 * NoL * NoV)) * LIGHT_E * NoL;
            r += F[0] * sk; g += F[1] * sk; b += F[2] * sk;
          }
        }
        // Ambient light from the studio environment.
        if (showDiff) {
          // Exact irradiance of a two-tone hemisphere split at the
          // horizon, using the sky's average radiance.
          var skyAvg = (SKY + HORIZON) / 2;
          var irr = skyAvg * (1 + ny) * 0.5 + GROUND * (1 - ny) * 0.5;
          r += cd[0] * irr; g += cd[1] * irr; b += cd[2] * irr;
        }
        if (showSpec) {
          // Mirror direction R = 2 (n.v) n - v; only its up part matters.
          var ry = 2 * NoV * ny;
          var env = envRadiance(ry, rough);
          envBRDF(rough, NoV, ab);
          r += env * (f0[0] * ab[0] + ab[1]);
          g += env * (f0[1] * ab[0] + ab[1]);
          b += env * (f0[2] * ab[0] + ab[1]);
        }
      }

      var enc = view === "fresnel" ? toByteRaw : toByte;
      var R8 = enc(r);
      var G8 = enc(g);
      var B8 = enc(b);
      if (cov < 1) {
        R8 = bg[0] + (R8 - bg[0]) * cov;
        G8 = bg[1] + (G8 - bg[1]) * cov;
        B8 = bg[2] + (B8 - bg[2]) * cov;
      }
      data[p] = R8; data[p + 1] = G8; data[p + 2] = B8; data[p + 3] = 255;
    }
  }

  /* ---------- The figure ---------- */

  function init(root) {
    var state = {
      preset: "plastic",
      base: PRESET_BY_ID.plastic.base,
      metal: 0,
      rough: 0.35,
      view: "lit",
      // Light handle position, in sphere radii from the centre (y down).
      u: -0.8,
      v: -0.78
    };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Material sphere" }),
      h("span", { class: "demo-hint", text: "Drag the light, or focus it and use the arrow keys to move it around the sphere." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Base colour", PRESETS.map(function (p) {
      return { value: p.id, label: p.label };
    }), state.preset, function (id) {
      var p = PRESET_BY_ID[id];
      state.preset = id;
      state.base = p.base;
      // A preset also sets metallic to the right value for the material.
      setMetal(p.metal);
      request();
    }));
    var roughControl = HB.slider("ms-rough", "Roughness", {
      min: 0, max: 1, step: 0.01, value: state.rough,
      format: function (v) { return v.toFixed(2); }
    }, function (v) { state.rough = v; request(); });
    var metalControl = HB.slider("ms-metal", "Metallic", {
      min: 0, max: 1, step: 0.01, value: state.metal,
      format: function (v) { return v.toFixed(2); }
    }, function (v) { state.metal = v; request(); });
    controls.appendChild(roughControl);
    controls.appendChild(metalControl);
    controls.appendChild(HB.segmented("Show", [
      { value: "lit", label: "Lit" },
      { value: "fresnel", label: "Fresnel only" },
      { value: "specular", label: "Specular only" },
      { value: "diffuse", label: "Diffuse only" }
    ], state.view, function (v) { state.view = v; request(); }));
    root.appendChild(controls);

    var metalInput = metalControl.querySelector("input");
    var metalOut = metalControl.querySelector("output");
    function setMetal(v) {
      state.metal = v;
      metalInput.value = String(v);
      metalOut.textContent = v.toFixed(2);
    }

    /* Left panel: the canvas with an SVG overlay holding the light handle. */
    var canvas = h("canvas", {
      width: SIZE, height: SIZE, role: "img",
      style: "display:block;width:100%;height:100%;border:1px solid var(--line-strong);border-radius:8px"
    });
    var overlay = svgEl("svg", {
      class: "dg",
      viewBox: "0 0 " + SIZE + " " + SIZE,
      style: "position:absolute;inset:0;width:100%;height:100%;touch-action:none",
      role: "group",
      "aria-label": "Light position"
    });
    var handle = svgEl("g", { "aria-label": "Light", "aria-valuemin": 0, "aria-valuemax": 360 }, overlay);
    svgEl("circle", { r: 15, class: "f-lit-soft s-lit handle-ring", "fill-opacity": 0.85 }, handle);
    for (var k = 0; k < 8; k++) {
      var ang = (k / 8) * 2 * PI;
      svgEl("line", {
        x1: Math.cos(ang) * 7.5, y1: Math.sin(ang) * 7.5, x2: Math.cos(ang) * 11.5, y2: Math.sin(ang) * 11.5,
        class: "s-lit w15 round"
      }, handle);
    }
    svgEl("circle", { r: 5, class: "f-lit" }, handle);
    var stageBox = h("div", { style: "position:relative;width:100%;max-width:320px;aspect-ratio:1/1;margin:0 auto" }, [canvas]);
    stageBox.appendChild(overlay);

    var leftPanel = h("div", { class: "demo-panel" }, [stageBox]);

    /* Right panel: Fresnel curve for the current material, and readouts. */
    var plotW = 420;
    var plotH = 210;
    var plot = svgEl("svg", {
      class: "dg is-mid",
      viewBox: "0 0 " + plotW + " " + plotH,
      role: "img",
      "aria-label": "Fresnel curve: how much light the material reflects at each angle between the view and the surface."
    });
    var PX0 = 48;
    var PX1 = 400;
    var PY0 = 176;
    var PY1 = 26;
    function ppx(deg) { return PX0 + (deg / 90) * (PX1 - PX0); }
    function ppy(f) { return PY0 - f * (PY0 - PY1); }
    (function drawPlotFrame() {
      svgEl("text", { x: PX0, y: 14, class: "t-caps", text: "FRESNEL: REFLECTANCE BY ANGLE" }, plot);
      [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
        svgEl("line", { x1: PX0, y1: ppy(f), x2: PX1, y2: ppy(f), class: f === 0 ? "s-strong" : "s-line" }, plot);
        svgEl("text", { x: PX0 - 6, y: ppy(f) + 4, class: "t-mono t-muted t-small end", text: Math.round(f * 100) + "%" }, plot);
      });
      [0, 30, 60, 90].forEach(function (d) {
        svgEl("line", { x1: ppx(d), y1: PY0, x2: ppx(d), y2: PY0 + 5, class: "s-strong" }, plot);
        svgEl("text", { x: ppx(d), y: PY0 + 18, class: "t-mono t-muted t-small mid", text: d + "°" }, plot);
      });
      svgEl("text", { x: (PX0 + PX1) / 2, y: PY0 + 32, class: "t-small t-muted mid", text: "angle between the view and the surface normal" }, plot);
    })();
    var plotLayer = svgEl("g", null, plot);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    var note = h("p", { class: "demo-hint" });
    var rightPanel = h("div", { class: "demo-panel" }, [h("div", { class: "demo-stage" }, [plot]), readout, note]);

    root.appendChild(h("div", { class: "demo-panels is-split" }, [leftPanel, rightPanel]));

    var ctx = canvas.getContext("2d");
    var img = ctx.createImageData(SIZE, SIZE);

    /* Background: the theme's sunken colour, read through a 1 × 1 canvas
       so any CSS colour syntax works. */
    var bg = [236, 238, 244];
    var probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    var pctx = probe.getContext("2d", { willReadFrequently: true });
    function readBackground() {
      try {
        pctx.clearRect(0, 0, 1, 1);
        pctx.fillStyle = HB.demos.color("sunken") || "#eceef4";
        pctx.fillRect(0, 0, 1, 1);
        var d = pctx.getImageData(0, 0, 1, 1).data;
        bg = [d[0], d[1], d[2]];
      } catch (err) {
        log.warn("could not read the theme colour", err);
      }
    }

    function lightDir() {
      var r = Math.sqrt(state.u * state.u + state.v * state.v);
      if (r < 1e-6) return [0, 0, 1];
      var theta = (Math.min(r, R_MAX) * DEG_PER_RADIUS * PI) / 180;
      var st = Math.sin(theta);
      return [st * (state.u / r), -st * (state.v / r), Math.cos(theta)];
    }

    function describeLight() {
      var r = Math.sqrt(state.u * state.u + state.v * state.v);
      var deg = Math.round(Math.min(r, R_MAX) * DEG_PER_RADIUS);
      if (deg < 5) return "from straight behind the viewer";
      var az = (Math.atan2(-state.v, state.u) * 180) / PI;   // 0 = right, 90 = up
      var names = ["right", "upper right", "top", "upper left", "left", "lower left", "bottom", "lower right"];
      var name = names[(Math.round(((az + 360) % 360) / 45)) % 8];
      return deg + "° from the view direction, from the " + name + (deg > 90 ? ", behind the sphere" : "");
    }

    function fmt3(c) {
      return c.map(function (x) { return x.toFixed(2); }).join(", ");
    }

    function drawPlot(f0) {
      HB.svg.clear(plotLayer);
      function curve(f, cls) {
        var d = "";
        for (var deg = 0; deg <= 90; deg += 1) {
          var y = schlick(f, Math.cos((deg * PI) / 180));
          d += (deg ? "L" : "M") + ppx(deg).toFixed(1) + "," + ppy(y).toFixed(1);
        }
        svgEl("path", { d: d, class: cls }, plotLayer);
      }
      var f = lum(f0);
      var isRef = Math.abs(f - 0.04) < 1e-3;
      if (!isRef) curve(0.04, "s-muted dash");
      curve(f, "s-acc w2");
      var f80 = schlick(f, Math.cos((80 * PI) / 180));
      svgEl("circle", { cx: ppx(0), cy: ppy(f), r: 4, class: "f-acc" }, plotLayer);
      svgEl("circle", { cx: ppx(80), cy: ppy(f80), r: 4, class: "f-acc" }, plotLayer);
      var labelUp = f > 0.85;
      svgEl("text", {
        x: ppx(0) + 8, y: labelUp ? ppy(f) + 16 : ppy(f) - 8, class: "t-small t-acc t-strong",
        text: "head-on: F0 = " + Math.round(f * 100) + "%"
      }, plotLayer);
      svgEl("text", { x: ppx(80) - 8, y: ppy(f80) - 8, class: "t-small t-acc end", text: "80°: " + Math.round(f80 * 100) + "%" }, plotLayer);
      if (!isRef) {
        svgEl("text", { x: ppx(26), y: ppy(0.04) - 6, class: "t-small t-muted mid", text: "typical non-metal, F0 = 4%" }, plotLayer);
      }
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function drawReadout(f0) {
      var f = lum(f0);
      var cd = state.base.map(function (b) { return b * (1 - state.metal); });
      var grey = Math.abs(cd[0] - cd[1]) < 1e-3 && Math.abs(cd[1] - cd[2]) < 1e-3;
      var diffText = lum(cd) < 0.0005 ? "none" : grey ? cd[0].toFixed(2) : fmt3(cd);
      var f0Text = Math.abs(f0[0] - f0[1]) < 1e-3 && Math.abs(f0[1] - f0[2]) < 1e-3 ? f0[0].toFixed(2) : fmt3(f0);
      readout.replaceChildren(
        cell("F0 (linear)", f0Text),
        cell("Reflects head-on", Math.round(f * 100) + "%"),
        cell("Reflects at 80°", Math.round(schlick(f, Math.cos((80 * PI) / 180)) * 100) + "%"),
        cell("Diffuse colour", diffText)
      );
      var p = PRESET_BY_ID[state.preset];
      var msg;
      if (state.metal > 0.02 && state.metal < 0.98) {
        msg = "Metallic " + state.metal.toFixed(2) + " is a half-metal no real surface has. Keep it at 0 or 1, except where one material blends into another, such as rust on steel.";
      } else if (state.metal >= 0.98 && p.metal === 0) {
        msg = p.label + " with metallic 1 turns its base colour into a coloured mirror. It now looks like painted chrome, which no real " + p.label.toLowerCase() + " does.";
      } else if (state.metal <= 0.02 && p.metal === 1) {
        msg = p.label + "'s base colour with metallic 0 becomes a coloured diffuse surface with a 4% white reflection: it reads as plastic, not metal.";
      } else {
        msg = p.label + ": base colour " + fmt3(p.base) + " (" + p.src + "). " +
          (p.metal ? "A metal has no diffuse colour; its base colour is its reflection colour." :
            "A non-metal reflects 4% head-on whatever its colour; its base colour is the diffuse colour.");
      }
      note.textContent = msg;
    }

    var pending = false;
    function render() {
      pending = false;
      var L = lightDir();
      var m = { base: state.base, metal: state.metal, rough: state.rough };
      var t0 = performance.now();
      shadeImage(img, m, L, state.view, bg);
      ctx.putImageData(img, 0, 0);
      var f0 = f0Of(state.base, state.metal);
      drawPlot(f0);
      drawReadout(f0);
      var hx = CX + state.u * RADIUS;
      var hy = CY + state.v * RADIUS;
      handle.setAttribute("transform", "translate(" + hx.toFixed(1) + "," + hy.toFixed(1) + ")");
      var az = Math.round((((Math.atan2(-state.v, state.u) * 180) / PI) + 360) % 360);
      handle.setAttribute("aria-valuenow", String(az));
      handle.setAttribute("aria-valuetext", "Light " + describeLight());
      canvas.setAttribute("aria-label", "A sphere of " + PRESET_BY_ID[state.preset].label.toLowerCase() +
        " base colour with roughness " + state.rough.toFixed(2) + " and metallic " + state.metal.toFixed(2) +
        ", showing " + (state.view === "lit" ? "the lit result" : state.view === "fresnel" ? "the Fresnel term only" : state.view + " light only") +
        ", lit " + describeLight() + ".");
      log.debug("shaded in", (performance.now() - t0).toFixed(1), "ms");
    }
    function request() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(render);
    }

    function moveTo(u, v) {
      var r = Math.sqrt(u * u + v * v);
      if (r > R_MAX) { u = (u / r) * R_MAX; v = (v / r) * R_MAX; }
      // Keep the handle inside the canvas.
      var lim = (SIZE / 2 - 16) / RADIUS;
      state.u = Math.max(-lim, Math.min(lim, u));
      state.v = Math.max(-lim, Math.min(lim, v));
      request();
    }
    function fromLocal(pt) {
      moveTo((pt.x - CX) / RADIUS, (pt.y - CY) / RADIUS);
    }

    HB.draggable(overlay, handle, {
      onDrag: fromLocal,
      // Arrow keys move the light around the view axis, 10° a step
      // (30° with Shift).
      onKey: function (dir, big) {
        var r = Math.max(Math.sqrt(state.u * state.u + state.v * state.v), 0.3);
        var az = Math.atan2(state.v, state.u) + dir * ((big ? 30 : 10) * PI) / 180;   // right and up turn it clockwise
        moveTo(Math.cos(az) * r, Math.sin(az) * r);
      }
    });
    // Pressing anywhere on the picture moves the light there.
    overlay.addEventListener("pointerdown", function (event) {
      if (handle.contains(event.target)) return;
      fromLocal(HB.svg.toLocal(overlay, event.clientX, event.clientY));
    });

    document.addEventListener("hb:themechange", function () {
      window.requestAnimationFrame(function () { readBackground(); request(); });
    });

    readBackground();
    render();
    log.debug("ready");
  }

  HB.demos.register("material-sphere", init);
})();

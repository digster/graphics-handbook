/*
 * shading-builder.js: chapter 7.2's interactive.
 *
 * A sphere shaded per pixel on a 256 × 256 canvas, built from the classic
 * terms of a shading model, each of which can be switched on and off:
 *
 *   ambient    a flat amount of light added everywhere: albedo × AMBIENT
 *   diffuse    Lambert: albedo / π × E × max(N·L, 0)
 *   specular   one of three models, all with Schlick Fresnel (F0 = 0.04,
 *              a typical non-metal) and all multiplied by E × max(N·L, 0):
 *     Phong        (m + 2) / 2π × max(R·V, 0)^m        R = reflect(-L, N)
 *     Blinn-Phong  (n + 8) / 8π × max(N·H, 0)^n        H = normalize(L + V)
 *     GGX          Cook-Torrance D·F·G / (4 (N·L)(N·V)), Karis 2013:
 *                  D = GGX, α = roughness², G = Schlick-GGX with
 *                  k = (roughness + 1)² / 8
 *
 * One roughness slider drives all three, so they can be compared at the
 * "same" setting: α = roughness², the Blinn-Phong exponent n = 2/α² − 2
 * (the usual match between Blinn-Phong and microfacet distributions,
 * Walter et al. 2007) and the Phong exponent m = n / 4 (the common rule
 * that a Blinn-Phong exponent is 2 to 4 times the Phong one).
 *
 * Toon look: the same N·L and highlight, pushed through hard steps. Diffuse
 * becomes three bands (shadow, mid, lit), the highlight a hard-edged blob
 * wherever its normalised lobe is above one half, and pixels near the
 * silhouette (N·V < 0.22) are inked as an outline. Ambient is raised so the
 * shadow band reads as a colour rather than black.
 *
 * The light is a draggable handle over the canvas (keyboard: arrows turn it
 * around the view axis). The plot beside the sphere is a cross-section of
 * the same functions at the point facing the camera: how much light leaves
 * towards each direction, for light arriving at the handle's angle.
 *
 * Values are linear light. A shoulder above 0.8 rolls highlights off, then
 * the sRGB curve encodes them (the same display path as material-sphere.js).
 * The rendered sphere is a picture of output, so it does not change with the
 * theme; only the background behind it follows the theme.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("shading-builder");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- Constants ---------- */

  var SIZE = 256;           // canvas pixels, square
  var CX = SIZE / 2;
  var CY = SIZE / 2;
  var RADIUS = 92;          // sphere radius in canvas pixels
  var R_MAX = 1.36;         // furthest the light handle goes, in sphere radii
  var DEG_PER_RADIUS = 65;  // handle distance -> angle from the view direction
  var PI = Math.PI;

  var ALBEDO = [0.06, 0.2, 0.55];  // linear "blue ceramic"
  var E = 2.6;                     // light arriving; white Lambert facing it reads 0.83
  var AMBIENT = 0.14;              // flat ambient, as a fraction of albedo
  var AMBIENT_TOON = 0.3;
  var F0 = 0.04;
  var INK = [0.012, 0.014, 0.03];  // outline colour in toon mode

  /* ---------- Maths helpers ---------- */

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }
  function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

  /* sRGB encoding through a lookup table, with a soft shoulder above 0.8. */
  var ENC = new Uint8ClampedArray(4097);
  for (var e = 0; e <= 4096; e++) {
    var l = e / 4096;
    var s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    ENC[e] = Math.round(s * 255);
  }
  function shoulder(x) {
    if (x <= 0.8) return x < 0 ? 0 : x;
    return 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
  }
  function toByte(x) { return ENC[Math.round(shoulder(x) * 4096)]; }

  /* The three exponents and α that one roughness value stands for. */
  function params(rough) {
    var r = Math.max(rough, 0.05);
    var a = r * r;
    var n = Math.max(2 / (a * a) - 2, 1);
    return { r: r, a: a, a2: a * a, n: n, m: Math.max(n / 4, 1), k: ((r + 1) * (r + 1)) / 8 };
  }

  /*
   * Shades one point. N, L, V are unit vectors as [x, y, z].
   * Returns { amb, diff, spec } as scalars: amb and diff multiply the
   * albedo colour, spec is white light. Each is 0 when its term is off.
   */
  function shadePoint(N, L, V, st, p, out) {
    var NoL = N[0] * L[0] + N[1] * L[1] + N[2] * L[2];
    var NoV = Math.max(N[0] * V[0] + N[1] * V[1] + N[2] * V[2], 1e-4);
    out.amb = st.ambient ? (st.toon ? AMBIENT_TOON : AMBIENT) : 0;
    out.diff = 0;
    out.spec = 0;
    out.ink = st.toon && NoV < 0.22;
    if (NoL <= 0) return out;

    if (st.diffuse) {
      if (st.toon) {
        // Three bands: shadow (0), mid (0.5), lit (1), with a narrow
        // smooth edge so the steps do not alias.
        var band = 0.5 * smoothstep(0.02, 0.04, NoL) + 0.5 * smoothstep(0.5, 0.53, NoL);
        out.diff = (band * E) / PI;
      } else {
        out.diff = (NoL * E) / PI;
      }
    }

    if (st.specular) {
      var hx = L[0] + V[0];
      var hy = L[1] + V[1];
      var hz = L[2] + V[2];
      var hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
      hx /= hl; hy /= hl; hz /= hl;
      var NoH = clamp01(N[0] * hx + N[1] * hy + N[2] * hz);
      var VoH = clamp01(V[0] * hx + V[1] * hy + V[2] * hz);
      var F = F0 + (1 - F0) * Math.pow(1 - VoH, 5);
      var lobe = 0;   // the lobe's shape, 0..1, for the toon threshold
      var brdf = 0;
      if (st.model === "phong") {
        // R = 2 (N·L) N − L
        var rx = 2 * NoL * N[0] - L[0];
        var ry = 2 * NoL * N[1] - L[1];
        var rz = 2 * NoL * N[2] - L[2];
        var RoV = clamp01(rx * V[0] + ry * V[1] + rz * V[2]);
        lobe = Math.pow(RoV, p.m);
        brdf = (F * (p.m + 2) * lobe) / (2 * PI);
      } else if (st.model === "blinn") {
        lobe = Math.pow(NoH, p.n);
        brdf = (F * (p.n + 8) * lobe) / (8 * PI);
      } else {
        var dd = NoH * NoH * (p.a2 - 1) + 1;
        var D = p.a2 / (PI * dd * dd);
        lobe = D * PI * p.a2;   // D divided by its peak value
        var G = (NoL / (NoL * (1 - p.k) + p.k)) * (NoV / (NoV * (1 - p.k) + p.k));
        brdf = (D * F * G) / (4 * NoL * NoV);
      }
      if (st.toon) {
        out.spec = smoothstep(0.48, 0.52, lobe) * 0.9;
      } else {
        out.spec = brdf * E * NoL;
      }
    }
    return out;
  }

  /* ---------- Per-pixel normals of the sphere, computed once ---------- */

  var NX = new Float32Array(SIZE * SIZE);
  var NY = new Float32Array(SIZE * SIZE);
  var NZ = new Float32Array(SIZE * SIZE);
  var COVER = new Float32Array(SIZE * SIZE);
  (function buildNormals() {
    for (var py = 0; py < SIZE; py++) {
      for (var px = 0; px < SIZE; px++) {
        var i = py * SIZE + px;
        var dx = (px + 0.5 - CX) / RADIUS;
        var dy = (py + 0.5 - CY) / RADIUS;
        var d = Math.sqrt(dx * dx + dy * dy);
        COVER[i] = clamp01((1 - d) * RADIUS + 0.5);
        if (COVER[i] <= 0) continue;
        var dc = Math.min(d, 0.999);
        var sx = d > 0 ? (dx / d) * dc : 0;
        var sy = d > 0 ? (dy / d) * dc : 0;
        NX[i] = sx;
        NY[i] = -sy;   // screen y runs down, world y up
        NZ[i] = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
      }
    }
  })();

  /* ---------- The figure ---------- */

  function init(root) {
    var state = {
      ambient: true,
      diffuse: true,
      specular: true,
      model: "blinn",
      rough: 0.35,
      toon: false,
      // Light handle position, in sphere radii from the centre (y down).
      u: -0.72,
      v: -0.66
    };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Shading builder" }),
      h("span", { class: "demo-hint", text: "Drag the light, or focus it and use the arrow keys. Untick terms to see what each one adds." })
    ]));

    /* Controls */
    var controls = h("div", { class: "demo-controls" });
    function check(id, label, key) {
      var box = h("input", { type: "checkbox", id: id, checked: state[key] });
      box.addEventListener("change", function () { state[key] = box.checked; request(); });
      return h("label", { for: id }, [box, label]);
    }
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Terms" }),
      h("div", { class: "checks" }, [
        check("sb-amb", "Ambient", "ambient"),
        check("sb-diff", "Diffuse (Lambert)", "diffuse"),
        check("sb-spec", "Specular", "specular")
      ])
    ]));
    controls.appendChild(HB.segmented("Specular model", [
      { value: "phong", label: "Phong" },
      { value: "blinn", label: "Blinn-Phong" },
      { value: "ggx", label: "GGX (Cook-Torrance)" }
    ], state.model, function (v) { state.model = v; request(); }));
    var roughControl = HB.slider("sb-rough", "Roughness", {
      min: 0.05, max: 1, step: 0.01, value: state.rough,
      format: function (v) { return v.toFixed(2); }
    }, function (v) { state.rough = v; request(); });
    controls.appendChild(roughControl);
    controls.appendChild(h("div", { class: "control" }, [
      h("span", { class: "label", text: "Look" }),
      h("div", { class: "checks" }, [check("sb-toon", "Toon bands and outline", "toon")])
    ]));
    root.appendChild(controls);

    /* Left panel: canvas with an SVG overlay for the light handle. */
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

    /* Right panel: cross-section of the lobes, readouts and a note. */
    var PW = 440;
    var PH = 236;
    var plot = svgEl("svg", {
      class: "dg is-mid",
      viewBox: "0 0 " + PW + " " + PH,
      role: "img",
      "aria-label": "Cross-section at the point facing the camera: how much light leaves towards each direction."
    });
    var OX = PW / 2;     // the surface point
    var OY = 196;
    var R_DIFF = 44;     // plot radius of this surface's diffuse light at N·L = 1
    var R_CLIP = 168;    // lobes are clipped here
    (function drawPlotFrame() {
      svgEl("text", { x: 30, y: 14, class: "t-caps", text: "LIGHT LEAVING THE CENTRE POINT, BY DIRECTION" }, plot);
      svgEl("rect", { x: 30, y: OY, width: PW - 60, height: 10, class: "f-solid" }, plot);
      svgEl("line", { x1: 30, y1: OY, x2: PW - 30, y2: OY, class: "s-strong w15" }, plot);
      [0.5, 1, 2, 3].forEach(function (t) {
        var rr = R_DIFF * t;
        if (rr > R_CLIP) return;
        svgEl("path", { d: "M" + (OX - rr) + "," + OY + " A" + rr + "," + rr + " 0 0 1 " + (OX + rr) + "," + OY, class: "s-line" }, plot);
      });
      svgEl("line", { x1: OX, y1: OY, x2: OX, y2: OY - 166, class: "s-muted dot-dash" }, plot);
      svgEl("text", { x: OX + 6, y: OY - 158, class: "t-small t-muted", text: "normal" }, plot);
      svgEl("text", { x: PW - 30, y: OY + 26, class: "t-small t-muted end", text: "rings: 0.5, 1, 2 and 3 × its diffuse brightness when facing the light" }, plot);
      svgEl("line", { x1: 30, y1: 30, x2: 52, y2: 30, class: "s-muted dash" }, plot);
      svgEl("text", { x: 58, y: 34, class: "t-small t-muted", text: "mirror direction" }, plot);
    })();
    var plotLayer = svgEl("g", null, plot);

    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    var note = h("p", { class: "demo-hint" });
    var rightPanel = h("div", { class: "demo-panel" }, [h("div", { class: "demo-stage" }, [plot]), readout, note]);
    root.appendChild(h("div", { class: "demo-panels is-split" }, [leftPanel, rightPanel]));

    var ctx = canvas.getContext("2d");
    var img = ctx.createImageData(SIZE, SIZE);

    /* Background: the theme's sunken colour, read through a 1 × 1 canvas. */
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

    function lightAngleDeg() {
      var r = Math.sqrt(state.u * state.u + state.v * state.v);
      return Math.min(r, R_MAX) * DEG_PER_RADIUS;
    }
    function lightDir() {
      var r = Math.sqrt(state.u * state.u + state.v * state.v);
      if (r < 1e-6) return [0, 0, 1];
      var theta = (lightAngleDeg() * PI) / 180;
      var st = Math.sin(theta);
      return [st * (state.u / r), -st * (state.v / r), Math.cos(theta)];
    }

    var V = [0, 0, 1];
    var tmp = { amb: 0, diff: 0, spec: 0, ink: false };

    /* Shades the sphere into img and returns each term's share of the
       light leaving the visible sphere (by luminance). */
    function shadeSphere(L, p) {
      var data = img.data;
      var sumA = 0;
      var sumD = 0;
      var sumS = 0;
      var albL = lum(ALBEDO[0], ALBEDO[1], ALBEDO[2]);
      var Nv = [0, 0, 0];
      for (var i = 0, q = 0; i < SIZE * SIZE; i++, q += 4) {
        var cov = COVER[i];
        if (cov <= 0) {
          data[q] = bg[0]; data[q + 1] = bg[1]; data[q + 2] = bg[2]; data[q + 3] = 255;
          continue;
        }
        Nv[0] = NX[i]; Nv[1] = NY[i]; Nv[2] = NZ[i];
        shadePoint(Nv, L, V, state, p, tmp);
        var k = tmp.amb + tmp.diff;
        var r = ALBEDO[0] * k + tmp.spec;
        var g = ALBEDO[1] * k + tmp.spec;
        var b = ALBEDO[2] * k + tmp.spec;
        if (tmp.ink) { r = INK[0]; g = INK[1]; b = INK[2]; }
        else {
          sumA += tmp.amb * albL;
          sumD += tmp.diff * albL;
          sumS += tmp.spec;
        }
        var R8 = toByte(r);
        var G8 = toByte(g);
        var B8 = toByte(b);
        if (cov < 1) {
          R8 = bg[0] + (R8 - bg[0]) * cov;
          G8 = bg[1] + (G8 - bg[1]) * cov;
          B8 = bg[2] + (B8 - bg[2]) * cov;
        }
        data[q] = R8; data[q + 1] = G8; data[q + 2] = B8; data[q + 3] = 255;
      }
      var total = sumA + sumD + sumS;
      return total > 0 ? { a: sumA / total, d: sumD / total, s: sumS / total, total: total } : { a: 0, d: 0, s: 0, total: 0 };
    }

    /* Cross-section: light arrives in the x-y plane at the handle's angle,
       from the left; the curve is the light leaving towards each direction
       of that plane, in units of this surface's diffuse brightness when it
       faces the light. */
    function drawPlot(p) {
      HB.svg.clear(plotLayer);
      var theta = (Math.min(lightAngleDeg(), 89) * PI) / 180;
      var L = [-Math.sin(theta), Math.cos(theta), 0];
      var N = [0, 1, 0];
      var albL = lum(ALBEDO[0], ALBEDO[1], ALBEDO[2]);
      var pts = [];
      var clipped = false;
      var peak = 0;
      for (var deg = -89; deg <= 89; deg += 1) {
        var ph = (deg * PI) / 180;
        var Vd = [Math.sin(ph), Math.cos(ph), 0];
        shadePoint(N, L, Vd, state, p, tmp);
        // In units of the surface's own diffuse brightness when facing the
        // light: diffuse and ambient carry the albedo's luminance.
        var val = ((tmp.amb + tmp.diff) * albL + tmp.spec) / ((E / PI) * albL);
        if (tmp.ink) val = 0;
        peak = Math.max(peak, val);
        var rr = val * R_DIFF;
        if (rr > R_CLIP) { rr = R_CLIP; clipped = true; }
        pts.push([OX + Math.sin(ph) * rr, OY - Math.cos(ph) * rr]);
      }
      var d = "M" + OX + "," + OY + " " + pts.map(function (q) { return "L" + q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ") + " Z";
      svgEl("path", { d: d, class: "f-acc-soft s-acc w2", "fill-opacity": 0.75 }, plotLayer);
      // Incoming light and its mirror direction.
      var lx = OX + L[0] * 150;
      var ly = OY - L[1] * 150;
      svgEl("line", { x1: lx, y1: ly, x2: OX + L[0] * 14, y2: OY - L[1] * 14, class: "s-lit w2", "marker-end": "url(#sb-arr)" }, plotLayer);
      svgEl("text", { x: lx - 4, y: ly - 6, class: "t-small t-lit t-strong end", text: "light in" }, plotLayer);
      var mx = OX - L[0] * 160;
      var my = OY - L[1] * 160;
      svgEl("line", { x1: OX, y1: OY, x2: mx, y2: my, class: "s-muted dash" }, plotLayer);
      if (clipped) {
        svgEl("text", { x: PW - 14, y: 38, class: "t-small t-acc t-strong end", text: "highlight peak " + (peak < 10 ? peak.toFixed(1) : Math.round(peak)) + "×, off the chart" }, plotLayer);
      }
      return peak;
    }

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }
    function pct(x) { return Math.round(x * 100) + "%"; }

    function modelText(p) {
      if (state.model === "phong") return "Phong, exponent " + Math.round(p.m);
      if (state.model === "blinn") return "Blinn-Phong, exponent " + Math.round(p.n);
      return "GGX, α = " + p.a.toFixed(3);
    }

    function describeLight() {
      var deg = Math.round(lightAngleDeg());
      if (deg < 5) return "from straight behind the viewer";
      var az = (Math.atan2(-state.v, state.u) * 180) / PI;
      var names = ["right", "upper right", "top", "upper left", "left", "lower left", "bottom", "lower right"];
      var name = names[Math.round(((az + 360) % 360) / 45) % 8];
      return deg + "° from the view direction, from the " + name + (deg > 90 ? ", behind the sphere" : "");
    }

    function writeNote(shares) {
      var msg;
      if (!state.ambient && !state.diffuse && !state.specular) {
        msg = "With every term off there is no light at all. Each term is one piece of the answer.";
      } else if (state.ambient && !state.diffuse && !state.specular) {
        msg = "Ambient alone is a flat disc: the same light added everywhere, with no direction, so the sphere loses its shape.";
      } else if (!state.ambient && state.diffuse && !state.specular) {
        msg = "Lambert alone: brightness follows N·L, so the side facing away from the light is pure black. That missing light is what the ambient term stands in for.";
      } else if (!state.ambient && !state.diffuse && state.specular) {
        msg = "Specular alone: a reflection of the light, placed by the viewer as well as the light. Move the light and the highlight moves twice as far as a diffuse shading change would.";
      } else if (state.toon) {
        msg = "Toon: the same N·L and highlight, pushed through hard steps. The terms are unchanged; only the curve that turns them into brightness is different.";
      } else if (state.model === "phong" && state.specular) {
        msg = "Phong compares the view direction with the mirror direction of the light. Blinn-Phong compares the normal with the half vector instead, which behaves better at grazing angles and low exponents; OpenGL's old fixed-function pipeline used it.";
      } else if (state.model === "ggx" && state.specular) {
        msg = "GGX has a long, soft tail around the highlight. Compare it with Blinn-Phong at the same roughness: the peaks match, the glow around them does not.";
      } else {
        msg = "Diffuse gives the sphere its shape and colour; specular adds the white highlight that tells you how smooth it is. Here specular is " + pct(shares.s) + " of the light, concentrated in a small spot.";
      }
      note.textContent = msg;
    }

    var pending = false;
    function render() {
      pending = false;
      var t0 = performance.now();
      var p = params(state.rough);
      var L = lightDir();
      var shares = shadeSphere(L, p);
      ctx.putImageData(img, 0, 0);
      drawPlot(p);
      readout.replaceChildren(
        cell("Ambient share", pct(shares.a)),
        cell("Diffuse share", pct(shares.d)),
        cell("Specular share", pct(shares.s)),
        cell("Specular", state.specular ? modelText(p) : "off")
      );
      writeNote(shares);
      var hx = CX + state.u * RADIUS;
      var hy = CY + state.v * RADIUS;
      handle.setAttribute("transform", "translate(" + hx.toFixed(1) + "," + hy.toFixed(1) + ")");
      var az = Math.round((((Math.atan2(-state.v, state.u) * 180) / PI) + 360) % 360);
      handle.setAttribute("aria-valuenow", String(az));
      handle.setAttribute("aria-valuetext", "Light " + describeLight());
      var on = [state.ambient && "ambient", state.diffuse && "Lambert diffuse", state.specular && (modelText(p) + " specular")].filter(Boolean);
      canvas.setAttribute("aria-label", "A blue sphere shaded with " + (on.length ? on.join(", ") : "no terms") +
        (state.toon ? " in a toon style" : "") + ", lit " + describeLight() + ".");
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
      var lim = (SIZE / 2 - 16) / RADIUS;
      state.u = Math.max(-lim, Math.min(lim, u));
      state.v = Math.max(-lim, Math.min(lim, v));
      request();
    }
    function fromLocal(pt) { moveTo((pt.x - CX) / RADIUS, (pt.y - CY) / RADIUS); }

    HB.draggable(overlay, handle, {
      onDrag: fromLocal,
      onKey: function (dir, big) {
        var r = Math.max(Math.sqrt(state.u * state.u + state.v * state.v), 0.3);
        var az = Math.atan2(state.v, state.u) + dir * ((big ? 30 : 10) * PI) / 180;
        moveTo(Math.cos(az) * r, Math.sin(az) * r);
      }
    });
    overlay.addEventListener("pointerdown", function (event) {
      if (handle.contains(event.target)) return;
      fromLocal(HB.svg.toLocal(overlay, event.clientX, event.clientY));
    });

    // Arrow marker for the plot, unique to this demo.
    var defs = svgEl("defs", null, plot);
    var mk = svgEl("marker", { id: "sb-arr", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" }, defs);
    svgEl("path", { d: "M0,0 L8,4 L0,8 Z", class: "f-lit" }, mk);

    document.addEventListener("hb:themechange", function () {
      window.requestAnimationFrame(function () { readBackground(); request(); });
    });

    readBackground();
    render();
    log.debug("ready");
  }

  HB.demos.register("shading-builder", init);
})();

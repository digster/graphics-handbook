/*
 * courtyard.js: the Lantern Courtyard, a small real-time deferred renderer
 * that chapters embed to show a real scene and the buffers behind it.
 *
 * Embedding (chapters depend on this contract):
 *   <div class="demo" data-demo="courtyard" data-view="final"
 *        data-views="final,albedo,normals" data-passes="off" data-orbit="on">
 *     <p class="demo-hint">fallback text</p></div>
 *   data-view    first view shown (one of HB.courtyard.views)
 *   data-views   optional comma list: adds buttons to switch among them
 *   data-passes  "on": the frame-anatomy scrubber (passes, outputs, timings)
 *   data-orbit   "on": drag or arrow keys orbit the camera
 * Scripts, in order: kit.js, courtyard-gl.js, courtyard-shaders.js, courtyard.js.
 *
 * The scene: a stone courtyard at dusk with an arch, a banner moving in the
 * wind, crates, a lantern on a post, a puddle and a low wall. Every texture
 * is generated on the GPU at start-up; nothing is loaded from disk.
 *
 * The frame (see planFor() for which passes each view runs):
 *   shadow    sun depth into a 2048 x 2048 shadow map
 *   gbuffer   albedo, normal, roughness/metallic/emissive/wet, depth
 *   ao        SSAO at half resolution plus a depth-aware blur
 *   lighting  sun + shadows, lantern, sky light x AO, emissive -> HDR
 *   ssr       reflections marched through the depth buffer, puddle only
 *   fog       height fog and lantern glow
 *   bloom     bright-pass and a down/up blur chain
 *   tonemap   exposure, bloom, filmic curve, sRGB
 *   final     FXAA onto the canvas (or a buffer drawn as a picture)
 *
 * Performance: internal resolution at most 960 x 540 (device pixel ratio
 * capped at 1.5); GPU work only while the figure is on screen; with reduced
 * motion, or nothing moving, a frame is drawn only when something changes.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("courtyard");
  var h = HB.html;

  /* ---------- The contract: views and passes ---------- */

  var VIEWS = [
    { id: "final", label: "Final", desc: "The finished frame: every pass, tone mapped, with FXAA." },
    { id: "wireframe", label: "Wireframe", desc: "Every triangle edge the GPU draws, with hidden lines removed." },
    { id: "albedo", label: "Albedo", desc: "G-buffer: the surface colour of each pixel, with no light at all." },
    { id: "normals", label: "Normals", desc: "G-buffer: the direction each pixel faces. Red is x, green is up, blue is toward the back wall's opposite side." },
    { id: "depth", label: "Depth", desc: "Depth buffer: distance from the camera, near dark and far light." },
    { id: "roughness", label: "Roughness", desc: "G-buffer: roughness, from smooth (dark) to rough (light). The puddle is almost black." },
    { id: "shadow-map", label: "Shadow map", desc: "The sun's shadow map: the scene's depth seen from the sun, near dark and far light." },
    { id: "ao", label: "AO", desc: "Screen-space ambient occlusion, computed at half resolution and blurred. Dark means less sky can reach." },
    { id: "lighting", label: "Direct light", desc: "Direct light only: the sun and the lantern, with no sky light and no post-processing." },
    { id: "no-ao", label: "No AO", desc: "The final frame with ambient occlusion switched off." },
    { id: "no-shadows", label: "No shadows", desc: "The final frame with the sun's shadows switched off." },
    { id: "ssr", label: "Reflections", desc: "Screen-space reflections alone: what the puddle reflects. Rays that leave the screen fall back to the sky." },
    { id: "fog-off", label: "No fog", desc: "The final frame with height fog switched off." },
    { id: "bloom", label: "Bloom", desc: "The bloom buffer: light brighter than white, blurred at several sizes." },
    { id: "hdr-clipped", label: "No tone map", desc: "No tone mapping: every value above 1 clips to flat white." },
    { id: "triangles", label: "Triangles", desc: "Each draw call in its own colour, with its triangle edges. The four crates are one instanced draw." }
  ];
  var VIEW_BY_ID = {};
  VIEWS.forEach(function (v) { VIEW_BY_ID[v.id] = v; });

  /* With more than four views, buttons are grouped so each row stays short. */
  var VIEW_GROUPS = [
    { label: "Picture", ids: ["final", "hdr-clipped", "bloom"] },
    { label: "Surface buffers", ids: ["albedo", "normals", "roughness"] },
    { label: "Depth and shadow", ids: ["depth", "shadow-map", "ao"] },
    { label: "Light", ids: ["lighting", "ssr"] },
    { label: "Switched off", ids: ["no-ao", "no-shadows", "fog-off"] },
    { label: "Geometry", ids: ["wireframe", "triangles"] }
  ];

  var PASSES = {
    shadow: { label: "Shadow map", desc: "Depth seen from the sun, into a 2048 × 2048 map that tells the lighting what the sun can reach." },
    gbuffer: { label: "G-buffer", desc: "Every object drawn once into the G-buffer: albedo, normals, roughness and depth (shown here as four tiles)." },
    ao: { label: "Ambient occlusion", desc: "SSAO at half resolution from depth and normals, then a blur that stops at silhouettes." },
    lighting: { label: "Lighting", desc: "One full-screen pass: sun with soft shadows, lantern, sky light times AO, glowing glass. HDR output." },
    ssr: { label: "Reflections (SSR)", desc: "Rays marched through the depth buffer from puddle pixels; rays that leave the screen use the sky." },
    fog: { label: "Height fog", desc: "Fog thickest near the ground and thinning with height, plus the lantern's glow in the haze." },
    bloom: { label: "Bloom", desc: "Pixels brighter than white kept, shrunk four times and blurred back up." },
    tonemap: { label: "Tone map", desc: "Exposure, bloom added, a filmic curve squeezes HDR into 0 to 1, then sRGB gamma." },
    geometry: { label: "Debug geometry", desc: "The meshes drawn as flat colour and lines instead of materials." },
    final: { label: "Final", desc: "FXAA smooths stair-stepped edges and the image reaches the screen." }
  };
  var FULL_FRAME = ["shadow", "gbuffer", "ao", "lighting", "ssr", "fog", "bloom", "tonemap", "final"];

  // For tests and chapter authors: the ids the embedding attributes accept.
  HB.courtyard = {
    views: VIEWS.map(function (v) { return v.id; }),
    passes: FULL_FRAME.slice(),
    labels: VIEWS.reduce(function (acc, v) { acc[v.id] = v.label; return acc; }, {})
  };

  var CK = HB.courtyardKit;

  /*
   * Which passes a view runs, and how. Each view runs only what it needs,
   * so the pass list (and its timings) is honest: "No AO" really skips the
   * AO pass, a G-buffer view stops after the G-buffer.
   * display: what the last step ("final") draws to the canvas.
   */
  function planFor(view) {
    var flags = { shadows: true, ao: true, direct: false, ssr: true, fog: true, bloom: true, tone: "filmic", ssrOnly: false };
    switch (view) {
      case "albedo": case "normals": case "roughness": case "depth":
        return { passes: ["gbuffer", "final"], flags: flags, display: view };
      case "shadow-map":
        return { passes: ["shadow", "final"], flags: flags, display: "shadow-map" };
      case "ao":
        return { passes: ["gbuffer", "ao", "final"], flags: flags, display: "ao" };
      case "wireframe": case "triangles":
        return { passes: ["geometry", "final"], flags: flags, display: "fxaa", geometry: view };
      case "lighting":
        flags.direct = true; flags.ao = false; flags.ssr = false; flags.fog = false; flags.bloom = false;
        return { passes: ["shadow", "gbuffer", "lighting", "final"], flags: flags, display: "hdr" };
      case "ssr":
        flags.ssrOnly = true;
        return { passes: ["shadow", "gbuffer", "ao", "lighting", "ssr", "final"], flags: flags, display: "ssr" };
      case "bloom":
        return { passes: ["shadow", "gbuffer", "ao", "lighting", "ssr", "fog", "bloom", "final"], flags: flags, display: "bloom" };
      case "no-ao": flags.ao = false; break;
      case "no-shadows": flags.shadows = false; break;
      case "fog-off": flags.fog = false; break;
      case "hdr-clipped": flags.tone = "clip"; break;
    }
    var passes = FULL_FRAME.filter(function (id) {
      return (id !== "shadow" || flags.shadows) && (id !== "ao" || flags.ao) && (id !== "fog" || flags.fog);
    });
    return { passes: passes, flags: flags, display: "fxaa" };
  }

  /* ---------- The scene ---------- */

  var SUN_DIR = normalize3([-0.85, 0.29, -0.45]);
  var SUN_COLOR = [1.05, 0.4, 0.15];
  var LANTERN = { pos: [2.6, 2.51, 1.2], color: [1.0, 0.55, 0.22], intensity: 10, range: 10 };
  // In front of the arch, where the default camera sees the pillars, the
  // banner and the sky through the arch mirrored in the water.
  var PUDDLE = [0.9, 1.9];
  var EXPOSURE = 2.0;
  var BLOOM = { threshold: 2.5, strength: 0.1 };
  var FOG = [0.009, 0.2, 0.12, 120];
  var NEAR = 0.1;
  var FAR = 200;
  var SHADOW_SIZE = 2048;
  var CAMERA = { target: [-0.3, 1.3, -0.9], dist: 9.6, yaw: 0.42, pitch: 0.17, fov: (46 * Math.PI) / 180 };
  var ORBIT_LIMITS = { yaw: 0.85, pitchMin: 0.03, pitchMax: 0.62 };
  var STILL_TIME = 1.35; // the banner's pose when nothing animates

  function normalize3(v) {
    var l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  /* Baked materials: texture size, what one repeat covers in metres, and
     the height range stored in the normal map's blue channel. */
  var MATERIALS = {
    paving: { id: 0, w: 512, h: 512, metres: [4, 4], height: 0.018, wrap: "REPEAT" },
    ashlar: { id: 1, w: 512, h: 512, metres: [2, 2], height: 0.024, wrap: "REPEAT" },
    wood: { id: 2, w: 256, h: 256, metres: [0.7, 0.7], height: 0.02, wrap: "CLAMP_TO_EDGE" },
    cloth: { id: 3, w: 256, h: 512, metres: [0.95, 1.5], height: 0.002, wrap: "CLAMP_TO_EDGE" },
    iron: { id: 4, w: 64, h: 64, metres: [0.25, 0.25], height: 0.002, wrap: "REPEAT" }
  };

  // Instances: [x, y, z, yaw, size x, size y, size z, variant]. Boxes are centred.
  var STONE = [
    [-1.5, 0.15, -1.5, 0, 0.86, 0.3, 0.86, 0.1],    // pillar bases
    [1.5, 0.15, -1.5, 0, 0.86, 0.3, 0.86, 0.6],
    [-1.5, 1.75, -1.5, 0, 0.62, 2.9, 0.62, 0.3],    // pillar shafts
    [1.5, 1.75, -1.5, 0, 0.62, 2.9, 0.62, 0.8],
    [-1.5, 3.3, -1.5, 0, 0.8, 0.2, 0.8, 0.5],       // capitals
    [1.5, 3.3, -1.5, 0, 0.8, 0.2, 0.8, 0.2],
    [0, 3.7, -1.5, 0, 4.1, 0.6, 0.76, 0.4],         // lintel
    [0, 4.06, -1.5, 0, 4.3, 0.12, 0.86, 0.7],       // cornice
    [0, 0.04, -1.5, 0, 2.3, 0.08, 1.1, 0.9],        // threshold
    [0, 0.55, -5.2, 0, 16.5, 1.1, 0.5, 0.35],       // back wall
    [0, 1.16, -5.2, 0, 16.8, 0.12, 0.64, 0.65],     // its coping
    [-8.0, 0.45, -1.2, 0, 0.5, 0.9, 7.5, 0.15],     // side wall, left
    [-8.0, 0.96, -1.2, 0, 0.62, 0.12, 7.6, 0.55]
  ];
  var CRATES = [
    [-2.95, 0.4, -0.2, 0.25, 0.8, 0.8, 0.8, 0.2],
    [-3.85, 0.35, -1.0, -0.2, 0.7, 0.7, 0.7, 0.75],
    [-3.0, 1.1, -0.25, 0.62, 0.6, 0.6, 0.6, 0.45],  // stacked on the first
    [-2.05, 0.28, 0.85, 0.9, 0.56, 0.56, 0.56, 0.9]
  ];
  var L = LANTERN.pos;
  var IRON = [
    [L[0], 1.15, L[2], 0, 0.11, 2.3, 0.11, 0.5],               // post
    [L[0], 0.12, L[2], 0, 0.26, 0.24, 0.26, 0.2],              // foot
    [L[0], 2.32, L[2], 0, 0.3, 0.04, 0.3, 0.4],                // base plate
    [L[0] - 0.12, 2.51, L[2] - 0.12, 0, 0.03, 0.36, 0.03, 0.5], // corner bars
    [L[0] + 0.12, 2.51, L[2] - 0.12, 0, 0.03, 0.36, 0.03, 0.5],
    [L[0] - 0.12, 2.51, L[2] + 0.12, 0, 0.03, 0.36, 0.03, 0.5],
    [L[0] + 0.12, 2.51, L[2] + 0.12, 0, 0.03, 0.36, 0.03, 0.5],
    [L[0], 2.715, L[2], 0, 0.34, 0.05, 0.34, 0.3],             // cap
    [L[0], 2.78, L[2], 0, 0.2, 0.08, 0.2, 0.6],
    [L[0], 2.86, L[2], 0, 0.05, 0.1, 0.05, 0.6],               // finial
    [0, 3.36, -1.06, 0, 1.1, 0.035, 0.035, 0.5]                // banner rod
  ];

  /* One entry per draw call. debug is the colour in the "Triangles" view. */
  var DRAWS = [
    { name: "ground", mesh: "grid", material: "paving", kind: 1, uvMode: 0, uvScale: 0.25,
      tint: [1, 1, 1], rough: 1, metallic: 0, normalScale: 1, debug: [0.32, 0.58, 0.55],
      instances: [[0, 0, 0, 0, 1, 1, 1, 0.5]] },
    { name: "stone", mesh: "box", material: "ashlar", kind: 3, uvMode: 1, uvScale: 0.5,
      tint: [1, 1, 1], rough: 1, metallic: 0, normalScale: 1, debug: [0.86, 0.7, 0.45], instances: STONE },
    { name: "crates", mesh: "box", material: "wood", kind: 0, uvMode: 0, uvScale: 1,
      tint: [1, 1, 1], rough: 1, metallic: 0, normalScale: 1, debug: [0.93, 0.5, 0.27], instances: CRATES },
    { name: "iron", mesh: "box", material: "iron", kind: 0, uvMode: 1, uvScale: 4,
      tint: [0.075, 0.07, 0.066], rough: 1, metallic: 0.5, normalScale: 1, debug: [0.58, 0.54, 0.9], instances: IRON },
    { name: "glass", mesh: "box", material: "iron", kind: 4, uvMode: 0, uvScale: 1, emissive: 7,
      tint: [1, 0.8, 0.52], rough: 0.3, metallic: 0, normalScale: 0, debug: [1, 0.86, 0.38],
      instances: [[L[0], L[1], L[2], 0, 0.22, 0.34, 0.22, 0.5]] },
    { name: "banner", mesh: "cloth", material: "cloth", kind: 2, uvMode: 0, uvScale: 1, deform: 1, twoSided: true,
      tint: [1, 1, 1], rough: 1, metallic: 0, normalScale: 1, debug: [0.9, 0.38, 0.52],
      instances: [[0, 3.34, -1.06, 0, 0.95, 1.5, 1, 0.5]] }
  ];

  /* ---------- Renderer ---------- */

  /*
   * Owns every GPU resource of one canvas. build() makes the size-independent
   * ones (programs, baked materials, meshes, shadow map); setSize() makes the
   * screen-sized targets. After a lost context both simply run again.
   */
  function Renderer(gl, caps) {
    this.gl = gl;
    this.caps = caps;
    this.timer = new CK.GpuTimer(gl, caps.timer);
    this.programs = {};
    this.materials = {};
    this.draws = [];
    this.t = {};
    this.fbo = {};
    this.size = null;
    this.drawCalls = 0;
    this.build();
  }

  Renderer.prototype.build = function () {
    var gl = this.gl;
    var defines = this.caps.hdr === "RGBA8" ? { HDR_RGBA8: 1 } : null;
    Object.keys(CK.glsl.sources).forEach(function (name) {
      var src = CK.glsl.sources[name];
      this.programs[name] = CK.program(gl, src[0], CK.glsl.withDefines(src[1], defines), name);
    }, this);
    this.hdrInternal = this.caps.hdr === "RGBA16F" ? gl.RGBA16F : gl.RGBA8;
    Object.keys(MATERIALS).forEach(function (key) { this.materials[key] = this.bake(MATERIALS[key]); }, this);
    this.buildScene();
    this.buildShadowMap();
    this.kernel = ssaoKernel();
  };

  /* Runs the bake shader once into a material's two textures, then mipmaps them. */
  Renderer.prototype.bake = function (m) {
    var gl = this.gl;
    var wrap = gl[m.wrap];
    var albedo = CK.texture(gl, { w: m.w, h: m.h, internal: gl.SRGB8_ALPHA8, mips: true, wrap: wrap });
    var normal = CK.texture(gl, { w: m.w, h: m.h, internal: gl.RGBA8, mips: true, wrap: wrap });
    var fb = CK.framebuffer(gl, [albedo, normal], null);
    if (!fb.complete) throw new Error("material bake target incomplete (" + fb.status + ")");
    this.fullscreen("bake", fb, {}, { u_material: m.id, u_size: [m.w, m.h], u_metres: m.metres, u_heightRange: m.height });
    gl.deleteFramebuffer(fb.fb);
    [albedo, normal].forEach(function (t) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      if (this.caps.aniso) gl.texParameterf(gl.TEXTURE_2D, this.caps.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, this.caps.maxAniso));
    }, this);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { albedo: albedo, normal: normal };
  };

  Renderer.prototype.buildScene = function () {
    var gl = this.gl;
    var meshes = {
      box: CK.mesh.upload(gl, CK.mesh.box()),
      grid: CK.mesh.upload(gl, CK.mesh.grid(10.5, 90, 24)),
      cloth: CK.mesh.upload(gl, CK.mesh.cloth(12, 24))
    };
    this.triangles = 0;
    this.draws = DRAWS.map(function (d) {
      var item = CK.mesh.drawable(gl, meshes[d.mesh], d.instances);
      item.def = d;
      this.triangles += (item.indexCount / 3) * item.instanceCount;
      return item;
    }, this);
  };

  /*
   * The sun never moves, so its matrices are fixed: an orthographic camera
   * looking along the sun direction, fitted around the courtyard. The
   * sampler object turns on hardware depth comparison with bilinear
   * filtering for the lighting pass only; the debug view reads the same
   * texture as plain depth.
   */
  Renderer.prototype.buildShadowMap = function () {
    var gl = this.gl;
    var size = Math.min(SHADOW_SIZE, this.caps.maxTexture);
    this.t.shadow = CK.texture(gl, { w: size, h: size, internal: gl.DEPTH_COMPONENT24, filter: gl.NEAREST });
    this.fbo.shadow = CK.framebuffer(gl, [], this.t.shadow);
    this.shadowSampler = gl.createSampler();
    gl.samplerParameteri(this.shadowSampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.samplerParameteri(this.shadowSampler, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.samplerParameteri(this.shadowSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.shadowSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.shadowSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.shadowSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    var center = [0, 1.5, 0];
    var view = CK.mat4.lookAt(CK.vec3.add(center, CK.vec3.scale(SUN_DIR, 30)), center, [0, 1, 0]);
    var lo = [Infinity, Infinity, Infinity];
    var hi = [-Infinity, -Infinity, -Infinity];
    [-9, 9].forEach(function (x) {
      [0, 4.6].forEach(function (y) {
        [-6.5, 10].forEach(function (z) {
          var p = CK.mat4.transformPoint(view, [x, y, z]);
          for (var k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
        });
      });
    });
    var proj = CK.mat4.ortho(lo[0], hi[0], lo[1], hi[1], -hi[2] - 1, -lo[2] + 1);
    this.lightViewProj = CK.mat4.multiply(proj, view);
    this.shadowTexel = 1 / size;
  };

  /* Screen-sized targets, remade whenever the canvas size changes. */
  Renderer.prototype.setSize = function (w, h) {
    var gl = this.gl;
    this.releaseScreenTargets();
    var hw = Math.ceil(w / 2);
    var hh = Math.ceil(h / 2);
    var t = this.t;
    var f = this.fbo;
    var tex = function (tw, th, internal, filter) {
      return CK.texture(gl, { w: tw, h: th, internal: internal, filter: filter || gl.LINEAR });
    };
    t.albedo = tex(w, h, gl.SRGB8_ALPHA8, gl.NEAREST);
    t.normal = tex(w, h, gl.RGB10_A2, gl.NEAREST);
    t.material = tex(w, h, gl.RGBA8, gl.NEAREST);
    t.depth = tex(w, h, gl.DEPTH_COMPONENT24, gl.NEAREST);
    f.gbuffer = CK.framebuffer(gl, [t.albedo, t.normal, t.material], t.depth);
    if (!f.gbuffer.complete) {
      // Some drivers refuse mixed formats: fall back to 8-bit normals.
      gl.deleteFramebuffer(f.gbuffer.fb);
      gl.deleteTexture(t.normal.tex);
      t.normal = tex(w, h, gl.RGBA8, gl.NEAREST);
      f.gbuffer = CK.framebuffer(gl, [t.albedo, t.normal, t.material], t.depth);
      if (!f.gbuffer.complete) throw new Error("G-buffer incomplete (" + f.gbuffer.status + ")");
    }
    t.aoA = tex(hw, hh, gl.R8);
    t.aoB = tex(hw, hh, gl.R8);
    f.aoA = CK.framebuffer(gl, [t.aoA], null);
    f.aoB = CK.framebuffer(gl, [t.aoB], null);
    ["lit", "ssr", "fog"].forEach(function (k) {
      t[k] = tex(w, h, this.hdrInternal);
      f[k] = CK.framebuffer(gl, [t[k]], null);
    }, this);
    // Bloom chain: four levels down from half resolution, three back up.
    this.bloomDown = [];
    this.bloomUp = [];
    for (var i = 0; i < 4; i++) {
      var lw = Math.max(1, Math.ceil(w / Math.pow(2, i + 1)));
      var lh = Math.max(1, Math.ceil(h / Math.pow(2, i + 1)));
      var d = tex(lw, lh, this.hdrInternal);
      this.bloomDown.push({ t: d, f: CK.framebuffer(gl, [d], null) });
      if (i < 3) {
        var u = tex(lw, lh, this.hdrInternal);
        this.bloomUp.push({ t: u, f: CK.framebuffer(gl, [u], null) });
      }
    }
    t.ldr = tex(w, h, gl.RGBA8);
    f.ldr = CK.framebuffer(gl, [t.ldr], null);
    f.geo = CK.framebuffer(gl, [t.ldr], t.depth);
    this.size = { w: w, h: h, hw: hw, hh: hh };
  };

  Renderer.prototype.releaseScreenTargets = function () {
    if (!this.size) return;
    var gl = this.gl;
    var t = this.t;
    var f = this.fbo;
    ["albedo", "normal", "material", "depth", "aoA", "aoB", "lit", "ssr", "fog", "ldr"].forEach(function (k) {
      gl.deleteTexture(t[k].tex);
    });
    ["gbuffer", "aoA", "aoB", "lit", "ssr", "fog", "ldr", "geo"].forEach(function (k) {
      gl.deleteFramebuffer(f[k].fb);
    });
    this.bloomDown.concat(this.bloomUp).forEach(function (l) {
      gl.deleteTexture(l.t.tex);
      gl.deleteFramebuffer(l.f.fb);
    });
  };

  /* ---------- Draw helpers ---------- */

  Renderer.prototype.target = function (fbo) {
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo ? fbo.fb : null);
    gl.viewport(0, 0, fbo ? fbo.w : this.size.w, fbo ? fbo.h : this.size.h);
  };

  /*
   * One full-screen pass: binds the target, the program, its textures (one
   * unit each, by sampler name) and uniforms, then draws. The shadow map is
   * bound together with the comparison sampler, which is unbound afterwards.
   */
  Renderer.prototype.fullscreen = function (name, fbo, textures, uniforms) {
    var gl = this.gl;
    var p = this.programs[name];
    this.target(fbo);
    gl.useProgram(p.prog);
    var units = {};
    var shadowUnit = -1;
    Object.keys(textures).forEach(function (key, unit) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[key].tex);
      if (key === "u_shadow") {
        gl.bindSampler(unit, this.shadowSampler);
        shadowUnit = unit;
      }
      units[key] = unit;
    }, this);
    CK.setUniforms(gl, p, units);
    CK.setUniforms(gl, p, uniforms);
    CK.drawFullscreen(gl);
    if (shadowUnit >= 0) gl.bindSampler(shadowUnit, null);
    this.drawCalls++;
  };

  /* Per-frame camera and light values shared by every pass. */
  Renderer.prototype.frameState = function (o) {
    var M = CK.mat4;
    var cam = o.camera;
    var cp = Math.cos(cam.pitch);
    var eye = [
      cam.target[0] + cam.dist * cp * Math.sin(cam.yaw),
      cam.target[1] + cam.dist * Math.sin(cam.pitch),
      cam.target[2] + cam.dist * cp * Math.cos(cam.yaw)
    ];
    var proj = M.perspective(cam.fov, this.size.w / this.size.h, NEAR, FAR);
    var view = M.lookAt(eye, cam.target, [0, 1, 0]);
    var viewProj = M.multiply(proj, view);
    return {
      eye: eye,
      proj: proj,
      view: view,
      viewProj: viewProj,
      invProj: M.invert(proj),
      invView: M.invert(view),
      invViewProj: M.invert(viewProj),
      time: o.time,
      flicker: o.flicker,
      lantern: LANTERN.color.map(function (c) { return c * LANTERN.intensity * o.flicker; })
    };
  };

  /* Draws every mesh with the bound program, as triangles or as edges. */
  Renderer.prototype.drawScene = function (p, f, perDraw, mode) {
    var gl = this.gl;
    var culling = gl.isEnabled(gl.CULL_FACE);
    this.draws.forEach(function (d) {
      var def = d.def;
      var mat = this.materials[def.material];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, mat.albedo.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mat.normal.tex);
      CK.setUniforms(gl, p, {
        u_albedoRough: 0,
        u_normalHeight: 1,
        u_deform: def.deform || 0,
        u_uvMode: def.uvMode,
        u_uvScale: def.uvScale,
        u_kind: def.kind,
        u_tint: def.tint,
        u_roughMul: def.rough,
        u_metallic: def.metallic,
        u_emissive: def.emissive || 0,
        u_normalScale: def.normalScale
      });
      if (perDraw) perDraw(def);
      // Cloth has two sides: never cull it.
      if (def.twoSided) gl.disable(gl.CULL_FACE);
      if (mode === "lines") {
        gl.bindVertexArray(d.edgeVao);
        gl.drawElementsInstanced(gl.LINES, d.edgeCount, gl.UNSIGNED_SHORT, 0, d.instanceCount);
      } else {
        gl.bindVertexArray(d.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, d.indexCount, gl.UNSIGNED_SHORT, 0, d.instanceCount);
      }
      if (def.twoSided && culling) gl.enable(gl.CULL_FACE);
      this.drawCalls++;
    }, this);
    gl.bindVertexArray(null);
  };

  /* ---------- Passes ---------- */
  // Each returns what the pass produced, as a display descriptor
  // ({ mode, tex }) so the scrubber can show it.

  var VM = null; // view modes, filled once the shader library is known

  Renderer.prototype.passShadow = function (f) {
    var gl = this.gl;
    var p = this.programs.shadow;
    this.target(this.fbo.shadow);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 3);
    gl.useProgram(p.prog);
    CK.setUniforms(gl, p, { u_viewProj: this.lightViewProj, u_time: f.time });
    this.drawScene(p, f, null, "tri");
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.DEPTH_TEST);
    return { mode: VM.SHADOW, tex: this.t.shadow };
  };

  Renderer.prototype.passGbuffer = function (f) {
    var gl = this.gl;
    var p = this.programs.gbuffer;
    this.target(this.fbo.gbuffer);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0.5, 0.5, 0.5, 0]);
    gl.clearBufferfv(gl.COLOR, 2, [1, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(p.prog);
    CK.setUniforms(gl, p, { u_viewProj: f.viewProj, u_time: f.time, u_flicker: f.flicker, u_puddle: PUDDLE });
    this.drawScene(p, f, null, "tri");
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    return { mode: VM.MOSAIC };
  };

  Renderer.prototype.passAO = function (f) {
    var t = this.t;
    var s = this.size;
    var nearFar = [NEAR, FAR];
    this.fullscreen("ssao", this.fbo.aoA, { u_depth: t.depth, u_normal: t.normal },
      { u_proj: f.proj, u_invProj: f.invProj, u_view: f.view, u_kernel: this.kernel, u_radius: 0.6 });
    this.fullscreen("blur", this.fbo.aoB, { u_src: t.aoA, u_depth: t.depth }, { u_step: [1 / s.hw, 0], u_nearFar: nearFar });
    this.fullscreen("blur", this.fbo.aoA, { u_src: t.aoB, u_depth: t.depth }, { u_step: [0, 1 / s.hh], u_nearFar: nearFar });
    return { mode: VM.AO, tex: t.aoA };
  };

  Renderer.prototype.passLighting = function (f, flags) {
    var t = this.t;
    this.fullscreen("lighting", this.fbo.lit,
      { u_albedo: t.albedo, u_normal: t.normal, u_material: t.material, u_depth: t.depth, u_ao: t.aoA, u_shadow: t.shadow },
      {
        u_invViewProj: f.invViewProj, u_lightViewProj: this.lightViewProj, u_camPos: f.eye,
        u_sunDir: SUN_DIR, u_sunColor: SUN_COLOR, u_lanternPos: LANTERN.pos, u_lanternColor: f.lantern,
        u_lanternRange: LANTERN.range, u_shadowTexel: this.shadowTexel,
        u_useShadows: flags.shadows ? 1 : 0, u_useAO: flags.ao ? 1 : 0, u_directOnly: flags.direct ? 1 : 0
      });
    this.hdr = t.lit;
    return { mode: VM.HDR, tex: t.lit };
  };

  Renderer.prototype.passSSR = function (f, flags) {
    var t = this.t;
    this.fullscreen("ssr", this.fbo.ssr,
      { u_hdr: this.hdr, u_depth: t.depth, u_normal: t.normal, u_material: t.material },
      { u_proj: f.proj, u_invProj: f.invProj, u_view: f.view, u_invView: f.invView, u_ssrMode: flags.ssrOnly ? 1 : 0, u_sunDir: SUN_DIR, u_sunColor: SUN_COLOR });
    this.hdr = t.ssr;
    return { mode: VM.HDR, tex: t.ssr };
  };

  Renderer.prototype.passFog = function (f) {
    var t = this.t;
    this.fullscreen("fog", this.fbo.fog, { u_hdr: this.hdr, u_depth: t.depth },
      { u_invViewProj: f.invViewProj, u_camPos: f.eye, u_fog: FOG, u_lanternPos: LANTERN.pos, u_lanternColor: f.lantern, u_sunDir: SUN_DIR, u_sunColor: SUN_COLOR });
    this.hdr = t.fog;
    return { mode: VM.HDR, tex: t.fog };
  };

  Renderer.prototype.passBloom = function () {
    var down = this.bloomDown;
    var up = this.bloomUp;
    var s = this.size;
    this.fullscreen("bloomPre", down[0].f, { u_src: this.hdr },
      { u_texel: [1 / s.w, 1 / s.h], u_exposure: EXPOSURE, u_threshold: BLOOM.threshold });
    for (var i = 1; i < down.length; i++) {
      var src = down[i - 1].t;
      this.fullscreen("bloomDown", down[i].f, { u_src: src }, { u_texel: [1 / src.w, 1 / src.h] });
    }
    var lower = down[down.length - 1].t;
    for (var k = up.length - 1; k >= 0; k--) {
      this.fullscreen("bloomUp", up[k].f, { u_src: lower, u_add: down[k].t }, { u_texel: [0.5 / lower.w, 0.5 / lower.h] });
      lower = up[k].t;
    }
    this.bloom = up[0].t;
    return { mode: VM.BLOOM, tex: this.bloom };
  };

  Renderer.prototype.passTonemap = function (f, flags) {
    var t = this.t;
    this.fullscreen("tonemap", this.fbo.ldr, { u_hdr: this.hdr, u_bloom: this.bloom || this.hdr }, {
      u_exposure: EXPOSURE, u_bloomStrength: BLOOM.strength,
      u_useBloom: flags.bloom && this.bloom ? 1 : 0, u_toneMode: flags.tone === "clip" ? 1 : 0
    });
    return { mode: VM.LDR, tex: t.ldr };
  };

  /*
   * Debug geometry for "Wireframe" and "Triangles". Wireframe: a depth-only
   * pre-pass (pushed back slightly) so hidden lines fail the depth test,
   * then every edge as a line. Triangles: each draw call filled in its own
   * colour, then its edges in a darker shade.
   */
  Renderer.prototype.passGeometry = function (f, flags, which) {
    var gl = this.gl;
    var p = this.programs.flat;
    var wire = which === "wireframe";
    this.target(this.fbo.geo);
    gl.clearBufferfv(gl.COLOR, 0, wire ? [0.035, 0.045, 0.075, 0.04] : [0.07, 0.075, 0.095, 0.07]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(p.prog);
    CK.setUniforms(gl, p, { u_viewProj: f.viewProj, u_time: f.time, u_camPos: f.eye });
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    if (wire) gl.colorMask(false, false, false, false);
    CK.setUniforms(gl, p, { u_flatMode: 1 });
    this.drawScene(p, f, function (def) { CK.setUniforms(gl, p, { u_color: def.debug }); }, "tri");
    gl.colorMask(true, true, true, true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    CK.setUniforms(gl, p, { u_flatMode: 0 });
    this.drawScene(p, f, function (def) {
      var c = def.debug;
      CK.setUniforms(gl, p, {
        u_color: wire ? [0.55 + c[0] * 0.45, 0.6 + c[1] * 0.4, 0.65 + c[2] * 0.35] : [c[0] * 0.3, c[1] * 0.3, c[2] * 0.3]
      });
    }, "lines");
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.DEPTH_TEST);
    return { mode: VM.LDR, tex: this.t.ldr };
  };

  /* Draws a pass output, or the view's final picture, onto the canvas. */
  Renderer.prototype.present = function (desc, f) {
    var t = this.t;
    var s = this.size;
    if (desc.mode === "fxaa") {
      this.fullscreen("fxaa", null, { u_src: t.ldr }, { u_texel: [1 / s.w, 1 / s.h] });
      return;
    }
    this.fullscreen("view", null,
      { u_tex: desc.tex || t.ldr, u_albedo: t.albedo, u_normal: t.normal, u_material: t.material, u_depth: t.depth },
      { u_mode: desc.mode, u_exposure: EXPOSURE, u_aspect: s.w / s.h, u_nearFar: [NEAR, FAR] });
  };

  /* The view's own final picture. */
  Renderer.prototype.finalDisplay = function (plan) {
    var t = this.t;
    switch (plan.display) {
      case "albedo": return { mode: VM.ALBEDO };
      case "normals": return { mode: VM.NORMALS };
      case "roughness": return { mode: VM.ROUGHNESS };
      case "depth": return { mode: VM.DEPTH };
      case "shadow-map": return { mode: VM.SHADOW, tex: t.shadow };
      case "ao": return { mode: VM.AO, tex: t.aoA };
      case "hdr": return { mode: VM.HDR, tex: t.lit };
      case "ssr": return { mode: VM.HDR, tex: t.ssr };
      case "bloom": return { mode: VM.BLOOM, tex: this.bloom };
      default: return { mode: "fxaa" };
    }
  };

  /*
   * Renders one frame of a view. o: { view, step, camera, time, flicker }.
   * Every pass of the view's plan runs (so timings cover the whole frame);
   * then the chosen step's output is drawn to the canvas. Returns the plan
   * and the step actually shown.
   */
  Renderer.prototype.render = function (o) {
    var plan = planFor(o.view);
    var f = this.frameState(o);
    var outputs = {};
    this.drawCalls = 0;
    this.hdr = null;
    this.bloom = null;
    this.timer.beginFrame();
    plan.passes.forEach(function (id) {
      if (id === "final") return;
      this.timer.begin(id);
      outputs[id] = this.runPass(id, f, plan);
      this.timer.end();
    }, this);
    var step = outputs[o.step] ? o.step : "final";
    this.timer.begin("final");
    this.present(step === "final" ? this.finalDisplay(plan) : outputs[step], f);
    this.timer.end();
    this.timer.endFrame();
    return { plan: plan, step: step };
  };

  Renderer.prototype.runPass = function (id, f, plan) {
    switch (id) {
      case "shadow": return this.passShadow(f);
      case "gbuffer": return this.passGbuffer(f);
      case "ao": return this.passAO(f);
      case "lighting": return this.passLighting(f, plan.flags);
      case "ssr": return this.passSSR(f, plan.flags);
      case "fog": return this.passFog(f);
      case "bloom": return this.passBloom();
      case "tonemap": return this.passTonemap(f, plan.flags);
      case "geometry": return this.passGeometry(f, plan.flags, plan.geometry);
    }
    throw new Error("unknown pass " + id);
  };

  /* SSAO sample offsets: 12 points in the unit hemisphere (z up), packed
     closer to the centre so nearby geometry counts most. Seeded, so every
     load looks the same. */
  function ssaoKernel() {
    var rand = HB.rng(1847);
    var out = new Float32Array(36);
    for (var i = 0; i < 12; i++) {
      var v = normalize3([rand() * 2 - 1, rand() * 2 - 1, 0.15 + rand() * 0.85]);
      var s = (i + 1) / 12;
      s = 0.15 + 0.85 * s * s;
      out.set([v[0] * s, v[1] * s, v[2] * s], i * 3);
    }
    return out;
  }

  /* ---------- Fallback without WebGL2 ---------- */

  var FALLBACK_TEXT = {
    "no-webgl2": "This browser has WebGL 2 switched off or does not support it, so the live renderer cannot run.",
    startup: "The live renderer could not start on this device.",
    scripts: "The renderer's scripts did not load."
  };

  /* A static sketch of the scene, drawn with the diagram classes so it
     follows the theme like every other figure. */
  function sketch() {
    var s = HB.svg.el;
    var svg = s("svg", {
      class: "dg", viewBox: "0 0 640 300", role: "img",
      "aria-label": "Sketch of the Lantern Courtyard at dusk: a stone arch with a banner, crates on the left, a lantern on a post on the right, a puddle in front and a low wall behind, with the low sun behind the wall."
    });
    s("rect", { x: 0, y: 0, width: 640, height: 196, class: "f-sunken" }, svg);
    s("circle", { cx: 62, cy: 112, r: 30, class: "f-lit-soft" }, svg);
    s("circle", { cx: 62, cy: 112, r: 11, class: "f-lit" }, svg);
    s("rect", { x: 0, y: 196, width: 640, height: 104, class: "f-surface" }, svg);
    [214, 236, 262].forEach(function (y) { s("line", { x1: 0, y1: y, x2: 640, y2: y, class: "s-line" }, svg); });
    [-200, 0, 200, 400, 600, 800].forEach(function (x) {
      s("line", { x1: 320 + (x - 320) * 0.35, y1: 196, x2: x, y2: 300, class: "s-line" }, svg);
    });
    s("rect", { x: 0, y: 168, width: 640, height: 28, class: "f-solid s-strong" }, svg);
    s("line", { x1: 0, y1: 168, x2: 640, y2: 168, class: "s-ink" }, svg);
    s("ellipse", { cx: 330, cy: 252, rx: 72, ry: 13, class: "f-sunken s-strong" }, svg);
    s("line", { x1: 300, y1: 250, x2: 345, y2: 250, class: "s-lit dash" }, svg);
    // Arch: pillars, capitals, lintel, then the banner and its rod.
    s("rect", { x: 262, y: 84, width: 22, height: 128, class: "f-solid s-ink" }, svg);
    s("rect", { x: 376, y: 84, width: 22, height: 128, class: "f-solid s-ink" }, svg);
    s("rect", { x: 257, y: 78, width: 32, height: 8, class: "f-solid s-ink" }, svg);
    s("rect", { x: 371, y: 78, width: 32, height: 8, class: "f-solid s-ink" }, svg);
    s("rect", { x: 248, y: 58, width: 164, height: 22, class: "f-solid s-ink" }, svg);
    s("path", { d: "M314,84 L346,84 L346,140 L330,130 L314,140 Z", class: "f-strong s-ink" }, svg);
    s("circle", { cx: 330, cy: 106, r: 7, class: "f-lit-soft s-lit" }, svg);
    // Crates.
    s("rect", { x: 128, y: 176, width: 40, height: 40, class: "f-solid s-ink" }, svg);
    s("line", { x1: 128, y1: 216, x2: 168, y2: 176, class: "s-strong" }, svg);
    s("rect", { x: 172, y: 188, width: 30, height: 30, class: "f-solid s-ink" }, svg);
    s("rect", { x: 134, y: 146, width: 30, height: 30, class: "f-solid s-ink" }, svg);
    s("line", { x1: 134, y1: 176, x2: 164, y2: 146, class: "s-strong" }, svg);
    // Lantern on its post, with its pool of light.
    s("ellipse", { cx: 492, cy: 236, rx: 64, ry: 14, class: "f-lit-soft" }, svg);
    s("circle", { cx: 492, cy: 112, r: 26, class: "f-lit-soft" }, svg);
    s("line", { x1: 492, y1: 124, x2: 492, y2: 236, class: "s-ink w3" }, svg);
    s("rect", { x: 484, y: 100, width: 16, height: 22, class: "f-lit s-ink" }, svg);
    s("path", { d: "M480,100 L492,90 L504,100 Z", class: "f-ink" }, svg);
    // Low sunlight grazing over the wall and the crates.
    s("line", { x1: 86, y1: 106, x2: 246, y2: 70, class: "s-lit dash" }, svg);
    s("line", { x1: 88, y1: 120, x2: 256, y2: 156, class: "s-lit dash" }, svg);
    // Labels.
    [["low sun", 62, 70], ["arch and banner", 330, 46], ["crates", 160, 236], ["lantern", 492, 82],
      ["puddle", 330, 282], ["low wall", 590, 186]].forEach(function (l) {
      s("text", { x: l[1], y: l[2], class: "t-small t-muted mid", text: l[0] }, svg);
    });
    return svg;
  }

  function showFallback(root, reason) {
    root.setAttribute("data-webgl", "off");
    root.setAttribute("data-fallback", reason); // "no-webgl2", "startup" or "scripts"
    root.removeAttribute("data-rendered");
    root.replaceChildren(
      head("A sketch of the scene the live renderer draws."),
      h("p", { class: "demo-hint", text: FALLBACK_TEXT[reason] || FALLBACK_TEXT.startup }),
      h("div", { class: "demo-stage" }, [sketch()])
    );
    log.info("showing the static sketch:", reason);
  }

  /* ---------- Interface ---------- */

  function head(hint) {
    return h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Lantern Courtyard" }),
      h("span", { class: "demo-hint", text: hint })
    ]);
  }

  function readOptions(root) {
    var known = HB.courtyard.views;
    var view = (root.getAttribute("data-view") || "final").trim();
    if (known.indexOf(view) < 0) {
      log.warn("unknown data-view, using final:", view);
      view = "final";
    }
    var views = (root.getAttribute("data-views") || "").split(",").map(function (v) { return v.trim(); })
      .filter(function (v) {
        if (!v) return false;
        if (known.indexOf(v) < 0) { log.warn("ignoring unknown view in data-views:", v); return false; }
        return true;
      });
    if (views.length && views.indexOf(view) < 0) views.unshift(view);
    return {
      view: view,
      views: views.length > 1 ? views : [],
      passes: root.getAttribute("data-passes") === "on",
      orbit: root.getAttribute("data-orbit") === "on"
    };
  }

  /*
   * View buttons. Up to four views share one segmented control. More are
   * grouped by kind (picture, surface buffers...) into several controls
   * that wrap, and pressing a button in one group releases the others.
   */
  function viewControls(opts, onPick) {
    var wrap = h("div", { class: "demo-controls" });
    var groups = opts.views.length <= 4
      ? [{ label: "View", ids: opts.views }]
      : VIEW_GROUPS.map(function (g) {
        return { label: g.label, ids: g.ids.filter(function (id) { return opts.views.indexOf(id) > -1; }) };
      }).filter(function (g) { return g.ids.length; });
    groups.forEach(function (g) {
      var control = HB.segmented(g.label, g.ids.map(function (id) {
        return { value: id, label: VIEW_BY_ID[id].label };
      }), opts.view, function (v) {
        wrap.querySelectorAll("button[data-view]").forEach(function (b) {
          b.setAttribute("aria-pressed", b.getAttribute("data-view") === v ? "true" : "false");
        });
        onPick(v);
      });
      control.querySelectorAll("button").forEach(function (b, i) { b.setAttribute("data-view", g.ids[i]); });
      wrap.appendChild(control);
    });
    return wrap;
  }

  function cell(label, value) {
    var v = h("span", { class: "v", text: value });
    return { node: h("span", { class: "r" }, [h("span", { class: "label", text: label }), v]), value: v };
  }

  function fmtMs(ms) {
    return ms === null ? "…" : ms < 0.1 ? ms.toFixed(3) + " ms" : ms.toFixed(2) + " ms";
  }

  var instanceCount = 0;

  /* ---------- One embedded instance ---------- */

  function init(root) {
    var opts = readOptions(root);
    var n = ++instanceCount;
    if (!CK || !CK.glsl || !CK.mesh) {
      showFallback(root, "scripts");
      return;
    }
    VM = CK.glsl.VIEW_MODES;
    var canvas = h("canvas", {
      width: 960, height: 540, role: "img",
      style: "display:block;width:100%;height:auto;border-radius:var(--radius-m);background:var(--buffer-lo)"
    });
    var ctx = CK.createContext(canvas);
    if (!ctx.gl) {
      showFallback(root, ctx.reason);
      return;
    }
    var gl = ctx.gl;
    var reduced = HB.demos.reducedMotion();
    var state = {
      view: opts.view,
      step: "final",
      camera: { target: CAMERA.target, dist: CAMERA.dist, yaw: CAMERA.yaw, pitch: CAMERA.pitch, fov: CAMERA.fov },
      time: STILL_TIME,
      animate: !reduced,
      frames: 0,
      plan: planFor(opts.view)
    };
    var renderer = null;
    var lost = false;
    var visible = false;
    var started = false;
    var dirty = true;
    var raf = 0;
    var lastTick = 0;
    var measure = 0;

    /* -- Markup -- */
    root.replaceChildren();
    root.setAttribute("data-webgl", "on");
    root.appendChild(head(opts.orbit
      ? "Drag the picture, or focus it and use the arrow keys, to walk around the courtyard."
      : "A real deferred renderer running in your browser."));
    if (opts.views.length) root.appendChild(viewControls(opts, setView));
    var passUI = opts.passes ? passPanel() : null;
    if (passUI) {
      // Picture first, so on phones (stacked) the scrubber sits under what it
      // changes. When .demo-panels splits into columns (900px, as in
      // diagrams.css) the pass list moves to the left column.
      root.appendChild(h("div", { class: "demo-panels is-split" }, [h("div", { class: "demo-panel" }, [canvas]), passUI.panel]));
      if (window.matchMedia) {
        var wide = window.matchMedia("(min-width: 900px)");
        var place = function () { passUI.panel.style.order = wide.matches ? "-1" : ""; };
        place();
        if (wide.addEventListener) wide.addEventListener("change", place);
      }
    } else {
      root.appendChild(canvas);
    }
    var cells = {
      view: cell("View", ""),
      pass: opts.passes ? cell("Showing", "") : null,
      tris: cell("Scene triangles", "…"),
      draws: cell("Draw calls", "…"),
      res: cell("Resolution", "…"),
      gpu: cell(opts.passes ? "GPU time, this pass" : "GPU time", "…")
    };
    root.appendChild(h("div", { class: "demo-readout", "aria-live": "polite" },
      Object.keys(cells).filter(function (k) { return cells[k]; }).map(function (k) { return cells[k].node; })));
    var note = h("p", { class: "demo-hint" });
    root.appendChild(note);
    if (opts.orbit) attachOrbit(canvas, state.camera, request);
    describe();

    /* -- Pass scrubber -- */
    function passPanel() {
      var panel = h("div", { class: "demo-panel" });
      var headRow = h("tr");
      var body = h("tbody");
      var table = h("table", { class: "byte-table" }, [h("thead", null, [headRow]), body]);
      var timingNote = h("p", { class: "demo-hint" });
      var sliderSlot = h("div");
      panel.appendChild(sliderSlot);
      panel.appendChild(h("div", { class: "table-scroll" }, [table]));
      panel.appendChild(timingNote);
      return { panel: panel, headRow: headRow, body: body, sliderSlot: sliderSlot, timingNote: timingNote, rows: [] };
    }

    /* Rebuilds the scrubber for the current view's plan. */
    function buildPasses() {
      if (!passUI) return;
      var passes = state.plan.passes;
      var index = Math.max(0, passes.indexOf(state.step));
      passUI.sliderSlot.replaceChildren(HB.slider("cy-pass-" + n, "Show the image after", {
        min: 1, max: passes.length, step: 1, value: index + 1,
        format: function (v) { return v + " / " + passes.length; }
      }, function (v) { setStep(passes[v - 1]); }));
      // The GPU column only exists when there are real timings to show.
      var timed = !!renderer && renderer.timer.available();
      passUI.headRow.replaceChildren(h("th", { text: "Pass" }), h("th", { text: "Writes" }));
      if (timed) passUI.headRow.appendChild(h("th", { text: "GPU" }));
      passUI.rows = passes.map(function (id) {
        var gpu = timed ? h("td", { text: "…" }) : null;
        var row = h("tr", { style: "cursor:pointer" }, [h("td", { text: passLabel(id) }), h("td", { text: writes(id) }), gpu]);
        row.addEventListener("click", function () { selectStep(id); });
        passUI.body.appendChild(row);
        return { id: id, row: row, gpu: gpu };
      });
      while (passUI.body.children.length > passUI.rows.length) passUI.body.removeChild(passUI.body.firstChild);
      passUI.timingNote.textContent = renderer && !renderer.timer.available()
        ? "Timing unavailable: this browser does not offer GPU timer queries (EXT_disjoint_timer_query_webgl2)."
        : "Times are measured on your GPU with timer queries, averaged over recent frames.";
      highlightStep();
    }

    function passLabel(id) {
      if (id === "final" && state.plan.display !== "fxaa") return "Display buffer";
      return PASSES[id].label;
    }

    /* What each pass writes: format, and size when it is not the full
       frame (the readout gives the full size). */
    function writes(id) {
      if (!renderer || !renderer.size) return "";
      var hdr = renderer.caps.hdr === "RGBA16F" ? "RGBA16F" : "RGBA8 (packed)";
      switch (id) {
        case "shadow": return renderer.t.shadow.w + "² depth";
        case "gbuffer": return "3 colour + depth";
        case "ao": return "R8, ½ size";
        case "lighting": case "ssr": case "fog": return hdr;
        case "bloom": return hdr + ", ½ to 1/16";
        case "tonemap": return "RGBA8";
        case "geometry": return "RGBA8 + depth";
        default: return "Canvas";
      }
    }

    function selectStep(id) {
      var input = passUI.sliderSlot.querySelector("input");
      var i = state.plan.passes.indexOf(id);
      if (input && i > -1) {
        input.value = String(i + 1);
        input.dispatchEvent(new Event("input"));
      }
    }

    function highlightStep() {
      if (!passUI) return;
      passUI.rows.forEach(function (r) {
        r.row.classList.toggle("is-hot", r.id === state.step);
        if (r.id === state.step) r.row.setAttribute("aria-current", "step");
        else r.row.removeAttribute("aria-current");
      });
    }

    /* -- State changes -- */
    function setView(v) {
      state.view = v;
      state.plan = planFor(v);
      state.step = "final";
      buildPasses();
      describe();
      measure = 12;
      request();
    }

    function setStep(id) {
      state.step = id;
      highlightStep();
      describe();
      request();
    }

    /* Caption-friendly text: what the canvas shows right now. */
    function describe() {
      var v = VIEW_BY_ID[state.view];
      var showingPass = opts.passes && state.step !== "final";
      cells.view.value.textContent = v.label;
      if (cells.pass) cells.pass.value.textContent = passLabel(state.step);
      note.textContent = showingPass ? PASSES[state.step].desc
        : opts.passes && state.step === "final" && state.plan.display === "fxaa" ? PASSES.final.desc : v.desc;
      canvas.setAttribute("aria-label", "Lantern Courtyard, " + v.label + " view. " + note.textContent +
        (opts.orbit ? " Use the arrow keys to orbit the camera." : ""));
    }

    function updateReadout() {
      if (!renderer || !renderer.size) return;
      var s = renderer.size;
      cells.tris.value.textContent = HB.fmt.int(renderer.triangles);
      cells.draws.value.textContent = String(state.lastDrawCalls || 0);
      cells.res.value.textContent = s.w + " × " + s.h;
      updateTimings();
    }

    function updateTimings() {
      var timer = renderer.timer;
      if (!timer.available()) {
        cells.gpu.value.textContent = "timing unavailable";
        return;
      }
      if (opts.passes) {
        cells.gpu.value.textContent = fmtMs(timer.average(state.step));
        passUI.rows.forEach(function (r) { if (r.gpu) r.gpu.textContent = fmtMs(timer.average(r.id)); });
      } else {
        var total = 0;
        var known = true;
        state.plan.passes.forEach(function (id) {
          var ms = timer.average(id);
          if (ms === null) known = false; else total += ms;
        });
        cells.gpu.value.textContent = known ? fmtMs(total) : "…";
      }
    }

    /* -- Rendering and scheduling -- */
    function request() {
      dirty = true;
      kick();
    }

    function kick() {
      if (!raf && visible && started && renderer && !lost) raf = window.requestAnimationFrame(tick);
    }

    /*
     * One animation frame. Draws only when something changed, the wind is
     * blowing, or the pass panel is collecting timings; otherwise the loop
     * stops until the next request(). It also stops while the figure is
     * off screen (visible = false).
     */
    function tick(now) {
      raf = 0;
      if (!renderer) return;
      var again = false;
      if (state.animate) {
        var dt = lastTick ? Math.min(now - lastTick, 100) / 1000 : 0;
        if (now - lastTick >= 32 || !lastTick) {
          state.time += dt;
          lastTick = now;
          dirty = true;
        }
        again = true;
      }
      if (measure > 0 && renderer.timer.available()) {
        measure--;
        dirty = true;
        again = true;
      }
      if (dirty) {
        dirty = false;
        draw();
      }
      if (renderer && renderer.timer.poll()) again = true;
      if (renderer && renderer.size && renderer.timer.available()) updateTimings();
      if (again) kick();
    }

    function draw() {
      if (!renderer) return;
      resize();
      var flicker = state.animate ? 1 + 0.05 * Math.sin(state.time * 7.3) + 0.03 * Math.sin(state.time * 13.1 + 1) : 1;
      try {
        var out = renderer.render({ view: state.view, step: state.step, camera: state.camera, time: state.time, flicker: flicker });
        state.lastDrawCalls = renderer.drawCalls;
        state.frames++;
        root.setAttribute("data-rendered", state.view + ":" + out.step);
        root.setAttribute("data-frames", String(state.frames));
        updateReadout();
      } catch (err) {
        fail("render", err);
      }
    }

    /* Internal resolution follows the displayed size, capped at 960 wide
       and at a device pixel ratio of 1.5. */
    function resize() {
      var css = canvas.clientWidth || root.clientWidth || 640;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      var w = Math.max(160, Math.min(960, Math.round(css * dpr)));
      var hgt = Math.round((w * 9) / 16);
      if (renderer.size && renderer.size.w === w && renderer.size.h === hgt) return;
      canvas.width = w;
      canvas.height = hgt;
      renderer.setSize(w, hgt);
      buildPasses();
    }

    /* Builds the GPU side the first time the figure comes near the screen. */
    function start() {
      if (started || lost) return;
      started = true;
      try {
        var t0 = performance.now();
        renderer = new Renderer(gl, ctx.caps);
        log.debug("renderer built in", Math.round(performance.now() - t0), "ms; HDR", ctx.caps.hdr, "; timer", !!ctx.caps.timer);
        resize();
        measure = 12;
        request();
      } catch (err) {
        fail("start", err);
      }
    }

    /* Anything unexpected: keep the page clean and show the sketch. */
    function fail(where, err) {
      log.warn("renderer stopped (" + where + "):", err && err.message ? err.message : err);
      renderer = null;
      started = true;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      showFallback(root, "startup");
    }

    canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault(); // tells the browser we want the context back
      lost = true;
      renderer = null;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      note.textContent = "The graphics context was lost. The picture will return when the browser restores it.";
      log.info("WebGL context lost");
    });
    canvas.addEventListener("webglcontextrestored", function () {
      log.info("WebGL context restored");
      lost = false;
      started = false;
      CK.forgetContext(gl);
      ctx.caps = CK.detectCaps(gl);
      describe();
      if (visible) start();
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () { if (renderer) request(); }).observe(canvas);
    }
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) {
          lastTick = 0;
          if (!started) start(); else kick();
        }
      }, { rootMargin: "200px 0px" }).observe(root);
    } else {
      visible = true;
      start();
    }
  }

  /* ---------- Orbit ---------- */

  /*
   * Drag (mouse, pen or a horizontal finger drag) or arrow keys turn the
   * camera around its target; Shift makes key steps bigger, Home resets.
   * Limits keep the camera inside the courtyard and above the ground.
   * touch-action pan-y leaves vertical swipes to page scrolling on phones.
   */
  function attachOrbit(canvas, cam, onChange) {
    var drag = null;
    canvas.setAttribute("tabindex", "0");
    canvas.style.touchAction = "pan-y";
    canvas.style.cursor = "grab";
    function clamp() {
      cam.yaw = Math.max(CAMERA.yaw - ORBIT_LIMITS.yaw, Math.min(CAMERA.yaw + ORBIT_LIMITS.yaw, cam.yaw));
      cam.pitch = Math.max(ORBIT_LIMITS.pitchMin, Math.min(ORBIT_LIMITS.pitchMax, cam.pitch));
      onChange();
    }
    canvas.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
      canvas.style.cursor = "grabbing";
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      cam.yaw -= (e.clientX - drag.x) * 0.006;
      cam.pitch += (e.clientY - drag.y) * 0.004;
      drag.x = e.clientX;
      drag.y = e.clientY;
      clamp();
    });
    function stop(e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      canvas.style.cursor = "grab";
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    }
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 0.2 : 0.06;
      if (e.key === "ArrowLeft") cam.yaw += step;
      else if (e.key === "ArrowRight") cam.yaw -= step;
      else if (e.key === "ArrowUp") cam.pitch += step * 0.6;
      else if (e.key === "ArrowDown") cam.pitch -= step * 0.6;
      else if (e.key === "Home") { cam.yaw = CAMERA.yaw; cam.pitch = CAMERA.pitch; }
      else return;
      e.preventDefault();
      clamp();
    });
  }

  HB.demos.register("courtyard", init);
})();

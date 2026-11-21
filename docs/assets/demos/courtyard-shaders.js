/*
 * courtyard-shaders.js: the GLSL for the Lantern Courtyard renderer.
 *
 * Every shader is GLSL ES 3.00 (WebGL2). Sources are assembled from small
 * chunks by CK.glsl.build(defines, chunks...), which puts the #version line
 * first, then #defines, then precision, then the chunks in order.
 *
 * Passes, in frame order (courtyard.js runs them):
 *   BAKE       once at start-up: procedural stone, wood, cloth and iron
 *              textures rendered into mipmapped textures (no image files)
 *   SHADOW     scene depth from the sun into the shadow map
 *   GBUFFER    scene into albedo, normal and material targets plus depth
 *   SSAO/BLUR  ambient occlusion at half resolution, then a depth-aware blur
 *   LIGHTING   sun (with PCF shadows), lantern and sky light into HDR
 *   SSR        screen-space reflections, only on puddle pixels
 *   FOG        height fog and the lantern's glow in the haze
 *   BLOOM      bright-pass, a chain of downsamples, then upsamples
 *   TONEMAP    exposure, bloom, ACES-style curve, sRGB, luma for FXAA
 *   FXAA       edge smoothing straight onto the canvas
 *   VIEW       debug display of any buffer (albedo, normals, depth...)
 *   FLAT       wireframe and per-draw colour views
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var CK = (HB.courtyardKit = HB.courtyardKit || {});

  var PRECISION = [
    "precision highp float;",
    "precision highp int;",
    "precision highp sampler2D;",
    "precision highp sampler2DShadow;"
  ].join("\n");

  /* defines: { NAME: number }. Returns a complete shader source. */
  function build(defines) {
    var head = ["#version 300 es"];
    Object.keys(defines || {}).forEach(function (k) {
      head.push("#define " + k + " " + defines[k]);
    });
    head.push(PRECISION);
    return head.concat(Array.prototype.slice.call(arguments, 1)).join("\n");
  }

  /* ---------- Shared chunks ---------- */

  var COMMON = `
#define PI 3.14159265
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Interleaved gradient noise (Jimenez 2014): a per-pixel value in [0, 1)
// whose pattern blurs away well. Rotates sample kernels from pixel to pixel.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Integer hash of a cell, stable on every GPU.
float hash21(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 32768) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967295.0);
}

// Value noise and a small fractal sum of it.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// HDR storage. With half-float targets values are stored as they are.
// Without them (HDR_RGBA8 defined) they are kept in 8 bits as sqrt(c / RANGE):
// coarser, but the square root spends the precision on the dark values,
// and half a step of per-pixel noise turns the remaining bands into grain.
// (Only fragment shaders include this chunk, so gl_FragCoord is available.)
#ifdef HDR_RGBA8
const float HDR_RANGE = 16.0;
vec4 encodeHDR(vec3 c) {
  return vec4(sqrt(saturate(c / HDR_RANGE)) + (ign(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
}
vec3 decodeHDR(vec4 t) { return t.rgb * t.rgb * HDR_RANGE; }
#else
vec4 encodeHDR(vec3 c) { return vec4(min(max(c, 0.0), vec3(60000.0)), 1.0); }
vec3 decodeHDR(vec4 t) { return t.rgb; }
#endif

// The G-buffer stores emissive radiance divided by this, in 8 bits.
const float EMISSIVE_RANGE = 64.0;
`;

  /* Dusk sky: a cool zenith, a horizon that turns orange toward the sun,
     a glow and disc around the sun, and dark haze below the horizon. Used
     for the background, for reflections that leave the screen, for fog
     colour and (averaged) for ambient light. */
  var SKY = `
uniform vec3 u_sunDir;     // unit vector toward the sun (world space)
uniform vec3 u_sunColor;   // sun illuminance: colour times intensity

// The sky without the sun: gradient from horizon to zenith, warmest at
// the sun's side, and haze below the horizon.
vec3 skyGradient(vec3 d) {
  vec2 hz = d.xz / max(length(d.xz), 1e-4);
  vec2 sz = u_sunDir.xz / max(length(u_sunDir.xz), 1e-4);
  float towardSun = dot(hz, sz) * 0.5 + 0.5;
  vec3 zenith = vec3(0.006, 0.011, 0.042);
  vec3 upper = vec3(0.02, 0.032, 0.1);
  vec3 horizon = mix(vec3(0.085, 0.065, 0.13), vec3(0.8, 0.26, 0.075), pow(towardSun, 6.0));
  float h = max(d.y, 0.0);
  vec3 col = mix(horizon, upper, smoothstep(0.0, 0.22, h));
  col = mix(col, zenith, smoothstep(0.2, 0.9, h));
  vec3 below = mix(horizon * 0.5, vec3(0.022, 0.022, 0.032), saturate(-d.y * 5.0));
  return d.y < 0.0 ? below : col;
}

// The full sky seen directly: gradient, the glow around the sun and its disc.
vec3 skyColor(vec3 d) {
  float s = max(dot(d, u_sunDir), 0.0);
  vec3 col = skyGradient(d);
  if (d.y < 0.0) return col;
  col += vec3(1.0, 0.36, 0.1) * (pow(s, 24.0) * 0.4 + pow(s, 200.0) * 1.6);
  return col + vec3(28.0, 15.0, 7.0) * smoothstep(0.99955, 0.99975, s);
}

// The sky as a rough surface reflects it: no disc (the sun's own highlight
// comes from the BRDF), and a glow that widens and dims with roughness.
// A cheap stand-in for a pre-filtered environment map.
vec3 skyReflected(vec3 d, float rough) {
  float s = max(dot(d, u_sunDir), 0.0);
  float spread = mix(24.0, 2.0, rough);
  return skyGradient(d) + vec3(1.0, 0.36, 0.1) * pow(s, spread) * 0.4 * (1.0 - rough * 0.7) * step(0.0, d.y);
}

// Average radiance arriving at a surface facing n: a cheap fit of the sky
// above, the dim ground below and the warm sunset side of the horizon.
vec3 skyAmbient(vec3 n) {
  vec2 sz = normalize(u_sunDir.xz);
  float side = dot(n.xz, sz) * 0.5 + 0.5;
  vec3 sky = vec3(0.04, 0.055, 0.13);
  vec3 ground = vec3(0.022, 0.02, 0.02);
  vec3 c = mix(ground, sky, n.y * 0.5 + 0.5);
  c += mix(vec3(0.04, 0.035, 0.07), vec3(0.17, 0.075, 0.035), side * side) * (1.0 - abs(n.y));
  return c;
}
`;

  /* Cook-Torrance with the GGX distribution, the height-correlated Smith
     visibility term and Schlick's Fresnel: the "PBR-ish" core of the
     lighting pass. */
  var BRDF = `
float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float f = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / (PI * f * f);
}
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 F_Schlick(float VoH, vec3 F0) {
  return F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
}
// Radiance reflected toward V from a light of illuminance E along L.
// lightSize widens the highlight for a light that is a small sphere rather
// than a point (Karis 2013), with the energy rescaled to match.
vec3 shade(vec3 N, vec3 V, vec3 L, vec3 E, vec3 diffColor, vec3 F0, float rough, float lightSize) {
  float NoL = dot(N, L);
  if (NoL <= 0.0) return vec3(0.0);
  vec3 H = normalize(V + L);
  float NoV = max(dot(N, V), 1e-4);
  float NoH = saturate(dot(N, H));
  float VoH = saturate(dot(V, H));
  float a = rough * rough;
  float aWide = saturate(a + lightSize);
  float energy = (a / aWide) * (a / aWide);
  vec3 F = F_Schlick(VoH, F0);
  vec3 spec = D_GGX(NoH, aWide) * energy * V_SmithGGX(NoV, NoL, a) * F;
  vec3 diff = diffColor * (1.0 / PI) * (1.0 - F);
  return (diff + spec) * E * NoL;
}
// Split-sum environment BRDF, analytic fit (Karis 2014, mobile).
vec3 envBRDF(vec3 F0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return F0 * ab.x + ab.y;
}
`;

  /* Helpers for passes that rebuild positions from the depth buffer. */
  var DEPTH = `
uniform vec2 u_nearFar;
// Depth buffer value [0, 1] to distance in front of the camera (metres).
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  float n = u_nearFar.x;
  float f = u_nearFar.y;
  return 2.0 * n * f / (f + n - z * (f - n));
}
`;

  /* ---------- Vertex shaders ---------- */

  /* One triangle that covers the screen; v_uv runs 0..1 over the viewport. */
  var FULLSCREEN_VS = build(null, `
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`);

  /*
   * Every mesh goes through this vertex shader, in the shadow, G-buffer and
   * debug passes alike, so the banner sways identically in all of them.
   * Instances carry position, yaw, scale and a variant number; the model
   * matrix is built here rather than uploaded per object.
   */
  var GEOMETRY_VS = build(null, `
#define PI 3.14159265
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in vec2 a_uv;
layout(location = 3) in vec4 a_tan;
layout(location = 4) in vec4 a_inst0;  // xyz position, w yaw (radians)
layout(location = 5) in vec4 a_inst1;  // xyz scale, w variant in [0, 1]

uniform mat4 u_viewProj;
uniform float u_time;
uniform int u_deform;     // 1: the banner, moved by wind
uniform int u_uvMode;     // 0: mesh uv times u_uvScale; 1: box faces in metres times u_uvScale
uniform float u_uvScale;

out vec3 v_world;
out vec3 v_nrm;
out vec4 v_tan;
out vec2 v_uv;
out vec2 v_meshUv;
out float v_variant;

// Wind on the banner. u runs across, v runs down from the rod. The cloth is
// pinned along the top (displacement grows with v squared) and moves along
// its own normal (local z). Returns the displacement and its derivatives
// along u and v, so the normal can be rebuilt exactly.
vec3 wind(vec2 uv, float t) {
  float u = uv.x;
  float v = uv.y;
  float k = v * v;
  float p1 = t * 1.7 + v * 3.2 + u * 1.3;
  float p2 = t * 2.9 - v * 5.1 + u * 4.0;
  float w1 = 0.10;
  float w2 = 0.03;
  float wave = w1 * sin(p1) + w2 * sin(p2);
  float billow = 0.06 * sin(u * PI) * v;
  float z = k * wave + billow;
  float dzdu = k * (w1 * 1.3 * cos(p1) + w2 * 4.0 * cos(p2)) + 0.06 * PI * cos(u * PI) * v;
  float dzdv = 2.0 * v * wave + k * (w1 * 3.2 * cos(p1) - w2 * 5.1 * cos(p2)) + 0.06 * sin(u * PI);
  return vec3(z, dzdu, dzdv);
}

void main() {
  vec3 scale = a_inst1.xyz;
  vec3 p = a_pos * scale;
  vec3 n = a_nrm / scale;      // normals use the inverse scale
  vec3 t = a_tan.xyz * scale;  // tangents follow the surface, like positions
  if (u_deform == 1) {
    vec3 w = wind(a_uv, u_time);
    p.z += w.x;
    vec3 tu = vec3(scale.x, 0.0, w.y);   // dP/du
    vec3 tv = vec3(0.0, -scale.y, w.z);  // dP/dv (v runs down)
    n = cross(tv, tu);
    t = tu;
  }
  float c = cos(a_inst0.w);
  float s = sin(a_inst0.w);
  mat3 yaw = mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  vec3 world = yaw * p + a_inst0.xyz;

  vec2 uv = a_uv;
  if (u_uvMode == 1) {
    // Box faces in metres: the face's extent along its tangent and bitangent.
    vec3 b = cross(a_nrm, a_tan.xyz) * a_tan.w;
    uv *= vec2(dot(abs(a_tan.xyz), scale), dot(abs(b), scale));
    uv += a_inst1.w * vec2(5.37, 2.11);  // shift the pattern per instance
  }

  v_world = world;
  v_nrm = yaw * normalize(n);
  v_tan = vec4(yaw * normalize(t), a_tan.w);
  v_uv = uv * u_uvScale;
  v_meshUv = a_uv;
  v_variant = a_inst1.w;
  gl_Position = u_viewProj * vec4(world, 1.0);
}
`);

  /* ---------- Procedural texture bake ---------- */

  /*
   * Runs once per material at start-up, one pixel per texel. Outputs:
   *   o_albedoRough   rgb linear albedo (stored sRGB), a roughness
   *   o_normalHeight  xy tangent-space normal, b height (0 = joint, 1 = top)
   * Each material is a function from texture uv to { albedo, rough, height }
   * with height in metres; the normal comes from the height by finite
   * differences, so relief and lighting always agree. Tiling materials use
   * periodic noise so their edges meet seamlessly.
   */
  var BAKE_FS = build(null, COMMON, `
uniform int u_material;     // 0 paving, 1 ashlar, 2 crate wood, 3 banner cloth, 4 iron
uniform vec2 u_size;        // texture size in texels
uniform vec2 u_metres;      // what one texture repeat covers, in metres
uniform float u_heightRange;
layout(location = 0) out vec4 o_albedoRough;
layout(location = 1) out vec4 o_normalHeight;

struct Surface { vec3 albedo; float rough; float height; };

// Value noise that repeats every 'period' cells, for tileable textures.
float pnoise(vec2 p, vec2 period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(mod(i, period));
  float b = hash21(mod(i + vec2(1.0, 0.0), period));
  float c = hash21(mod(i + vec2(0.0, 1.0), period));
  float d = hash21(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 p, vec2 period, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * pnoise(p, period);
    norm += amp;
    p *= 2.0;
    period *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
// Signed distance to a rounded rectangle centred at the origin.
float roundRect(vec2 p, vec2 hs, float r) {
  vec2 q = abs(p) - hs + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Stones laid in rows with jittered joints. Joint k of a row sits near
// k * width; the jitter repeats every 'count' joints so the tile wraps.
float joint(float k, float row, float width, float count, float jitter) {
  return (k + (hash21(vec2(mod(k, count), row)) - 0.5) * jitter) * width;
}
// Finds the stone under x in a row: returns (start, end, index).
vec3 stoneSpan(float x, float row, float width, float count, float jitter) {
  float k = floor(x / width);
  float a = joint(k, row, width, count, jitter);
  float b = joint(k + 1.0, row, width, count, jitter);
  if (x < a) { b = a; k -= 1.0; a = joint(k, row, width, count, jitter); }
  else if (x > b) { a = b; k += 1.0; b = joint(k + 1.0, row, width, count, jitter); }
  return vec3(a, b, mod(k, count));
}

// Flagstones: 8 rows of 0.5 m per 4 m tile, 6 stones per row, 1.2 cm joints.
Surface paving(vec2 uv) {
  vec2 p = uv * 4.0;
  float row = floor(p.y / 0.5);
  float x = p.x + hash21(vec2(row, 3.0)) * 0.9;
  vec3 span = stoneSpan(x, row, 4.0 / 6.0, 6.0, 0.5);
  vec2 size = vec2(span.y - span.x, 0.5);
  vec2 local = vec2(x - span.x, p.y - row * 0.5) - size * 0.5;
  vec2 id = vec2(span.z, row);
  float r1 = hash21(id * 7.0 + 1.0);
  float r2 = hash21(id * 3.0 + 11.0);
  float inside = -roundRect(local, size * 0.5 - 0.006, 0.035);
  float chip = pfbm(p * 6.0, vec2(24.0), 3);
  inside -= smoothstep(0.58, 0.85, chip) * 0.025;
  float top = smoothstep(0.0, 0.022, inside);
  vec2 tilt = (vec2(hash21(id + 5.0), hash21(id + 9.0)) - 0.5) * 0.014;
  float n1 = pfbm(p * 2.5, vec2(10.0), 5);
  float surface = 0.010 + dot(local, tilt) + (n1 - 0.5) * 0.004 + (r1 - 0.5) * 0.003;
  float groutH = 0.0015 * pnoise(p * 20.0, vec2(80.0));
  vec3 stone = mix(vec3(0.40, 0.385, 0.36), vec3(0.47, 0.415, 0.35), step(0.5, r1));
  stone = mix(stone, vec3(0.33, 0.345, 0.36), step(0.75, r2));
  stone *= 0.5 + 0.36 * n1;
  stone *= 0.9 + 0.16 * pnoise(p * 64.0, vec2(256.0));
  stone *= mix(0.72, 1.0, smoothstep(0.0, 0.07, inside));
  vec3 grout = vec3(0.12, 0.115, 0.105) * (0.8 + 0.4 * pnoise(p * 15.0, vec2(60.0)));
  grout = mix(grout, vec3(0.085, 0.11, 0.055), smoothstep(0.45, 0.75, pfbm(p * 4.0, vec2(16.0), 3)));
  Surface s;
  s.albedo = mix(grout, stone, top);
  s.rough = mix(0.96, 0.58 + 0.3 * n1, top);
  s.height = mix(groutH, surface, top);
  return s;
}

// Ashlar blocks for the arch and walls: courses of 0.4 m, three blocks per
// 2 m, running bond, recessed mortar, slightly domed faces, chipped edges
// and vertical rain streaks.
Surface ashlar(vec2 uv) {
  vec2 p = uv * 2.0;
  float row = floor(p.y / 0.4);
  float rowId = mod(row, 5.0);
  float w = 2.0 / 3.0;
  float x = p.x + mod(rowId, 2.0) * w * 0.5;
  vec3 span = stoneSpan(x, rowId, w, 3.0, 0.35);
  vec2 size = vec2(span.y - span.x, 0.4);
  vec2 local = vec2(x - span.x, p.y - row * 0.4) - size * 0.5;
  vec2 id = vec2(span.z, rowId);
  float r1 = hash21(id * 5.0 + 2.0);
  float inside = -roundRect(local, size * 0.5 - 0.007, 0.02);
  float chip = pfbm(p * 7.0, vec2(14.0), 3);
  inside -= smoothstep(0.6, 0.85, chip) * 0.03;
  float top = smoothstep(0.0, 0.018, inside);
  vec2 q = local / (size * 0.5);
  float dome = 0.006 * (2.0 - pow(abs(q.x), 4.0) - pow(abs(q.y), 4.0));
  float n1 = pfbm(p * 3.0, vec2(6.0), 5);
  float streak = pfbm(vec2(p.x * 9.0, p.y * 1.2), vec2(18.0, 2.4), 4);
  vec3 stone = vec3(0.44, 0.38, 0.31) * (0.8 + 0.34 * r1);
  stone *= 0.78 + 0.42 * n1;
  stone *= mix(1.0, 0.8, smoothstep(0.45, 0.75, streak));
  stone *= 0.92 + 0.14 * pnoise(p * 70.0, vec2(140.0));
  vec3 mortar = vec3(0.34, 0.32, 0.29) * (0.85 + 0.3 * pnoise(p * 25.0, vec2(50.0)));
  Surface s;
  s.albedo = mix(mortar, stone, top);
  s.rough = mix(0.95, 0.78 + 0.15 * n1, top);
  s.height = mix(0.0, 0.012 + dome + (n1 - 0.5) * 0.004, top);
  return s;
}

// One crate face: a raised frame of four boards, a diagonal brace, four
// planks behind them and a nail at each frame corner.
Surface wood(vec2 uv) {
  const float fw = 0.13;
  bool frame = uv.x < fw || uv.x > 1.0 - fw || uv.y < fw || uv.y > 1.0 - fw;
  bool rail = uv.y < fw || uv.y > 1.0 - fw;
  float brace = abs(uv.x - uv.y) * 0.7071;
  float h;
  float board;
  vec2 g;
  float edge;
  if (frame) {
    board = rail ? (uv.y < fw ? 0.0 : 1.0) : (uv.x < fw ? 2.0 : 3.0);
    g = rail ? uv : uv.yx;
    float across = rail ? min(abs(uv.y - fw), abs(uv.y - (1.0 - fw))) : min(abs(uv.x - fw), abs(uv.x - (1.0 - fw)));
    across = min(across, rail ? min(uv.y, 1.0 - uv.y) : min(uv.x, 1.0 - uv.x));
    edge = rail ? across : min(across, min(abs(uv.y - fw), abs(uv.y - (1.0 - fw))));
    h = 0.014;
  } else if (brace < 0.07) {
    board = 4.0;
    g = vec2((uv.x + uv.y) * 0.7071, brace * 1.0);
    edge = 0.07 - brace;
    h = 0.009;
  } else {
    float plank = floor((uv.y - fw) / ((1.0 - 2.0 * fw) / 4.0));
    board = 5.0 + plank;
    g = uv;
    float local = fract((uv.y - fw) / ((1.0 - 2.0 * fw) / 4.0));
    edge = min(local, 1.0 - local) * (1.0 - 2.0 * fw) / 4.0;
    h = 0.004;
  }
  float tone = hash21(vec2(board, 3.0));
  float grain = pfbm(vec2(g.x * 3.0 + board * 7.1, g.y * 46.0), vec2(1e4), 5);
  float rings = smoothstep(0.35, 0.65, fract(grain * 7.0 + g.x * 0.6));
  vec3 col = vec3(0.50, 0.335, 0.19) * (0.78 + 0.4 * tone);
  col *= 0.72 + 0.45 * grain;
  col *= mix(0.85, 1.0, rings);
  float gap = smoothstep(0.0, 0.008, edge);
  col *= mix(0.25, 1.0, gap);
  col = mix(col, col * vec3(0.8, 0.82, 0.86), smoothstep(0.4, 0.9, pfbm(uv * 5.0, vec2(1e4), 3)));
  float rough = 0.62 + 0.22 * grain;
  h = h * gap + (grain - 0.5) * 0.0012;
  // Nails near the four frame corners.
  vec2 c = abs(uv - 0.5);
  float nail = length(c - vec2(0.5 - fw * 0.5));
  if (nail < 0.018) {
    col = vec3(0.10, 0.09, 0.085);
    rough = 0.4;
    h = 0.016 + 0.002 * (1.0 - nail / 0.018);
  }
  Surface s;
  s.albedo = col;
  s.rough = rough;
  s.height = h;
  return s;
}

// The banner: crimson wool with a fine weave, gold borders and a gold
// emblem (a lantern flame in a ring of rays). uv runs across and down.
Surface cloth(vec2 uv) {
  vec2 q = uv * u_metres;
  float n = pfbm(uv * vec2(6.0, 10.0), vec2(1e4), 4);
  float weave = sin(q.x * 6.2831 * 70.0) * sin(q.y * 6.2831 * 70.0);
  vec3 col = vec3(0.33, 0.028, 0.035) * (0.82 + 0.3 * n);
  float rough = 0.92;
  float h = 0.00025 * weave;
  float gold = 0.0;
  // Borders down both sides and a hem along the top.
  float side = min(uv.x, 1.0 - uv.x) * u_metres.x;
  gold = max(gold, step(0.035, side) * step(side, 0.055));
  gold = max(gold, step(0.08, q.y) * step(q.y, 0.1) * step(0.035, side));
  // Emblem: ring, rays and a flame-shaped core.
  vec2 e = q - vec2(u_metres.x * 0.5, 0.62);
  float r = length(e);
  gold = max(gold, step(abs(r - 0.17), 0.018));
  float ang = atan(e.y, e.x);
  float sector = mod(ang + PI / 8.0, PI / 4.0) - PI / 8.0;
  float rayW = 0.2 * (1.0 - saturate((r - 0.21) / 0.1));
  gold = max(gold, step(0.21, r) * step(r, 0.31) * step(abs(sector), rayW));
  vec2 f = e * vec2(1.0, 0.75);
  float flame = length(f + vec2(0.0, 0.02)) - 0.075 + 0.04 * saturate(-e.y / 0.1);
  gold = max(gold, step(flame, 0.0));
  if (gold > 0.5) {
    col = vec3(0.78, 0.53, 0.18) * (0.85 + 0.25 * n);
    rough = 0.5;
    h += 0.0008;
  }
  // The top hem folds over the rod and sits in its shadow.
  col *= mix(0.55, 1.0, smoothstep(0.0, 0.06, q.y));
  Surface s;
  s.albedo = col;
  s.rough = rough;
  s.height = h;
  return s;
}

// Blackened iron and plain surfaces: white, tinted per draw.
Surface iron(vec2 uv) {
  float n = pfbm(uv * 4.0, vec2(4.0), 4);
  Surface s;
  s.albedo = vec3(0.82 + 0.18 * n);
  s.rough = 0.42 + 0.35 * n;
  s.height = 0.0005 * pfbm(uv * 8.0, vec2(8.0), 3);
  return s;
}

Surface material(vec2 uv) {
  if (u_material == 0) return paving(uv);
  if (u_material == 1) return ashlar(uv);
  if (u_material == 2) return wood(uv);
  if (u_material == 3) return cloth(uv);
  return iron(uv);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec2 texel = 1.0 / u_size;
  Surface s = material(uv);
  float hx = material(uv + vec2(texel.x, 0.0)).height;
  float hy = material(uv + vec2(0.0, texel.y)).height;
  vec2 px = u_metres * texel;
  vec3 n = normalize(vec3(-(hx - s.height) / px.x, -(hy - s.height) / px.y, 1.0));
  o_albedoRough = vec4(s.albedo, s.rough);
  o_normalHeight = vec4(n.xy * 0.5 + 0.5, saturate(s.height / u_heightRange), 1.0);
}
`);

  /* ---------- Geometry fragment shaders ---------- */

  // The banner's swallowtail: a V cut out of the bottom edge.
  var BANNER_CUT = `
bool bannerCut(vec2 meshUv) {
  return meshUv.y > 1.0 - 0.14 * (1.0 - abs(2.0 * meshUv.x - 1.0));
}
`;

  /* Shadow pass: depth only. Only the banner needs a fragment shader at all,
     to cut its swallowtail out of the shadow too. */
  var SHADOW_FS = build(null, BANNER_CUT, `
uniform int u_kind;
in vec2 v_meshUv;
void main() {
  if (u_kind == 2 && bannerCut(v_meshUv)) discard;
}
`);

  /*
   * G-buffer pass. Three colour targets and depth:
   *   0  SRGB8_ALPHA8  albedo (the hardware encodes on write, decodes on read)
   *   1  RGB10_A2      world normal * 0.5 + 0.5
   *   2  RGBA8         roughness, metallic, emissive / EMISSIVE_RANGE, wet mask
   * The wet mask marks puddle water: the reflection pass only runs there.
   * u_kind adds a few per-object touches: the puddle on the paving, the
   * banner's cut, grime at the foot of stone and the lantern's flame.
   */
  var GBUFFER_FS = build(null, COMMON, BANNER_CUT, `
uniform sampler2D u_albedoRough;
uniform sampler2D u_normalHeight;
uniform vec3 u_tint;
uniform float u_roughMul;
uniform float u_metallic;
uniform float u_emissive;
uniform float u_normalScale;
uniform int u_kind;          // 0 plain, 1 paving with puddle, 2 banner, 3 stone, 4 lantern glass
uniform float u_flicker;
uniform vec2 u_puddle;       // puddle centre on the ground (x, z)

in vec3 v_world;
in vec3 v_nrm;
in vec4 v_tan;
in vec2 v_uv;
in vec2 v_meshUv;
in float v_variant;

layout(location = 0) out vec4 o_albedo;
layout(location = 1) out vec4 o_normal;
layout(location = 2) out vec4 o_material;

void main() {
  if (u_kind == 2 && bannerCut(v_meshUv)) discard;
  vec4 ar = texture(u_albedoRough, v_uv);
  vec4 nh = texture(u_normalHeight, v_uv);
  vec3 albedo = ar.rgb * u_tint * (0.9 + 0.2 * v_variant);
  float rough = ar.a * u_roughMul;
  float emissive = 0.0;
  float wet = 0.0;

  // Normal map: tangent-space xy from the texture, z rebuilt, then into world.
  vec2 nxy = (nh.xy * 2.0 - 1.0) * u_normalScale;
  vec3 nts = vec3(nxy, sqrt(saturate(1.0 - dot(nxy, nxy))));
  vec3 N = normalize(v_nrm);
  if (!gl_FrontFacing) N = -N;  // two-sided cloth
  vec3 T = normalize(v_tan.xyz - N * dot(N, v_tan.xyz));
  vec3 B = cross(N, T) * v_tan.w;
  vec3 n = normalize(T * nts.x + B * nts.y + N * nts.z);

  if (u_kind == 1) {
    // Puddle: water fills the paving from the lowest point up. The water
    // level falls with distance from the centre (made irregular by noise);
    // wherever the baked height is below it, the pixel is water. Joints
    // flood first, so the edge follows the stones like a real puddle.
    vec2 q = v_world.xz - u_puddle;
    vec2 d = vec2(dot(q, vec2(0.91, -0.41)), dot(q, vec2(0.41, 0.91))) * vec2(0.6, 1.0);
    float r = length(d) + (vnoise(v_world.xz * 1.6) - 0.5) * 0.5 + (vnoise(v_world.xz * 4.1) - 0.5) * 0.16;
    float level = 1.45 - r * 1.05;
    float water = smoothstep(-0.04, 0.04, level - nh.b);
    float damp = saturate((level + 0.55 - nh.b) * 1.6);
    albedo *= mix(1.0, 0.5, damp);
    rough = mix(rough, rough * 0.4, damp);
    albedo = mix(albedo, albedo * 0.3, water);
    rough = mix(rough, 0.035, water);
    n = normalize(mix(n, vec3(0.0, 1.0, 0.0), water));
    wet = water;
    // Beyond the courtyard walls the paving gives way to dark, rough earth.
    vec2 w = v_world.xz;
    float outside = smoothstep(0.0, 4.0, max(abs(w.x) - 9.0, max(-w.y - 6.5, w.y - 12.0)));
    vec3 earth = vec3(0.05, 0.055, 0.035) * (0.7 + 0.6 * vnoise(w * 0.7));
    albedo = mix(albedo, earth, outside);
    rough = mix(rough, 1.0, outside);
    n = normalize(mix(n, vec3(0.0, 1.0, 0.0), outside));
  } else if (u_kind == 3) {
    // Stone darkens and greens toward the ground, where rain splashes.
    float g = smoothstep(0.0, 0.8, v_world.y);
    albedo *= mix(vec3(0.6, 0.64, 0.52), vec3(1.0), g);
    rough = mix(0.97, rough, g);
  } else if (u_kind == 4) {
    // Lantern glass: brightest at the flame, low in the middle.
    vec2 c = v_meshUv - vec2(0.5, 0.36);
    float core = exp(-dot(c * vec2(3.2, 2.4), c * vec2(3.2, 2.4)) * 2.5);
    emissive = u_emissive * u_flicker * (0.35 + 1.4 * core);
  }

  o_albedo = vec4(albedo, 1.0);
  o_normal = vec4(n * 0.5 + 0.5, 1.0);
  o_material = vec4(clamp(rough, 0.03, 1.0), u_metallic, saturate(emissive / EMISSIVE_RANGE), wet);
}
`);

  /* Wireframe and per-draw colour views. Colours are display values
     already; alpha carries luma for FXAA. */
  var FLAT_FS = build(null, COMMON, BANNER_CUT, `
uniform vec3 u_color;
uniform int u_flatMode;   // 0: lines faded with distance, 1: filled and shaded
uniform int u_kind;
uniform vec3 u_camPos;
in vec3 v_world;
in vec3 v_nrm;
in vec2 v_meshUv;
out vec4 o_color;
void main() {
  if (u_kind == 2 && bannerCut(v_meshUv)) discard;
  vec3 c;
  if (u_flatMode == 1) {
    vec3 n = normalize(v_nrm);
    if (!gl_FrontFacing) n = -n;
    c = u_color * (0.5 + 0.5 * saturate(dot(n, normalize(vec3(-0.35, 0.85, 0.45)))));
  } else {
    c = u_color * mix(1.0, 0.35, smoothstep(5.0, 26.0, length(v_world - u_camPos)));
  }
  o_color = vec4(c, luma(c));
}
`);

  /* ---------- Screen-space passes ---------- */

  /*
   * SSAO, at half resolution. For each pixel: rebuild its view-space
   * position from depth, place 12 samples in the hemisphere around its
   * normal (rotated per pixel), project each back to the screen and ask the
   * depth buffer whether something sits in front of it. The range check
   * fades out occluders much farther away than the radius.
   */
  var SSAO_FS = build(null, COMMON, `
uniform sampler2D u_depth;
uniform sampler2D u_normal;
uniform mat4 u_proj;
uniform mat4 u_invProj;
uniform mat4 u_view;
uniform vec3 u_kernel[12];
uniform float u_radius;
in vec2 v_uv;
out vec4 o_ao;

vec3 viewPos(vec2 uv, float d) {
  vec4 p = u_invProj * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

void main() {
  float d = texture(u_depth, v_uv).r;
  if (d >= 1.0) { o_ao = vec4(1.0); return; }
  vec3 P = viewPos(v_uv, d);
  vec3 N = normalize(mat3(u_view) * (texture(u_normal, v_uv).xyz * 2.0 - 1.0));
  float a = ign(gl_FragCoord.xy) * 6.2831853;
  vec3 rv = vec3(cos(a), sin(a), 0.0);
  vec3 T = normalize(rv - N * dot(rv, N));
  mat3 tbn = mat3(T, cross(N, T), N);
  float occ = 0.0;
  for (int i = 0; i < 12; i++) {
    vec3 S = P + tbn * u_kernel[i] * u_radius;
    vec4 c = u_proj * vec4(S, 1.0);
    vec2 suv = c.xy / c.w * 0.5 + 0.5;
    float sz = viewPos(suv, texture(u_depth, suv).r).z;
    float range = smoothstep(0.0, 1.0, u_radius / max(abs(P.z - sz), 1e-4));
    occ += step(S.z + 0.025, sz) * range;
  }
  float ao = pow(1.0 - occ / 12.0, 1.6);
  o_ao = vec4(ao, ao, ao, 1.0);
}
`);

  /* Separable depth-aware blur: 9 taps along u_step, with taps on a
     different surface (big depth difference) given no weight, so the AO
     does not bleed across silhouettes. */
  var BLUR_FS = build(null, COMMON, DEPTH, `
uniform sampler2D u_src;
uniform sampler2D u_depth;
uniform vec2 u_step;
in vec2 v_uv;
out vec4 o_color;
void main() {
  float zc = linearDepth(texture(u_depth, v_uv).r);
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec2 uv = v_uv + u_step * float(i);
    float z = linearDepth(texture(u_depth, uv).r);
    float w = exp(-float(i * i) / 12.0) * max(0.0, 1.0 - abs(z - zc) / (0.05 * zc + 0.02));
    sum += texture(u_src, uv).r * w;
    wsum += w;
  }
  float ao = sum / max(wsum, 1e-4);
  o_color = vec4(ao, ao, ao, 1.0);
}
`);

  /*
   * Lighting: one full-screen pass reads the G-buffer and writes HDR
   * radiance. Sun with a filtered shadow lookup, the lantern as a small
   * sphere light with a windowed inverse-square falloff, sky light on
   * diffuse and specular scaled by AO, and emissive glass. Background
   * pixels (depth = 1) get the sky.
   */
  var LIGHTING_FS = build(null, COMMON, SKY, BRDF, `
uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform sampler2D u_material;
uniform sampler2D u_depth;
uniform sampler2D u_ao;
uniform sampler2DShadow u_shadow;
uniform mat4 u_invViewProj;
uniform mat4 u_lightViewProj;
uniform vec3 u_camPos;
uniform vec3 u_lanternPos;
uniform vec3 u_lanternColor;
uniform float u_lanternRange;
uniform float u_shadowTexel;
uniform int u_useShadows;
uniform int u_useAO;
uniform int u_directOnly;
in vec2 v_uv;
out vec4 o_color;

const vec2 POISSON[12] = vec2[12](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
  vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
  vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));

// Percentage-closer filtering: 12 hardware-compared taps (each already a
// bilinear 2x2 test) on a Poisson disc, rotated per pixel. The position is
// pushed along the normal first (more at grazing angles) to avoid acne.
float sunShadow(vec3 P, vec3 N, float NoL) {
  vec3 p = P + N * (0.02 + 0.05 * (1.0 - NoL));
  vec4 c = u_lightViewProj * vec4(p, 1.0);
  vec3 s = c.xyz / c.w * 0.5 + 0.5;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  float a = ign(gl_FragCoord.xy) * 6.2831853;
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  float sum = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 o = rot * POISSON[i] * u_shadowTexel * 2.5;
    sum += texture(u_shadow, vec3(s.xy + o, s.z - 0.0006));
  }
  return sum / 12.0;
}

void main() {
  float d = texture(u_depth, v_uv).r;
  vec4 wp = u_invViewProj * vec4(vec3(v_uv, d) * 2.0 - 1.0, 1.0);
  vec3 P = wp.xyz / wp.w;
  vec3 V = normalize(u_camPos - P);
  if (d >= 1.0) { o_color = encodeHDR(skyColor(-V)); return; }

  vec3 albedo = texture(u_albedo, v_uv).rgb;
  vec3 N = normalize(texture(u_normal, v_uv).xyz * 2.0 - 1.0);
  vec4 m = texture(u_material, v_uv);
  float rough = max(m.r, 0.045);
  float metal = m.g;
  float emissive = m.b * EMISSIVE_RANGE;
  float wet = m.a;
  vec3 diffColor = albedo * (1.0 - metal);
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  float NoV = max(dot(N, V), 1e-4);

  // Sun.
  float NoLs = dot(N, u_sunDir);
  float sh = (u_useShadows == 1 && NoLs > 0.0) ? sunShadow(P, N, NoLs) : 1.0;
  vec3 col = shade(N, V, u_sunDir, u_sunColor * sh, diffColor, F0, rough, 0.0);

  // Lantern: inverse square, windowed to reach zero at u_lanternRange.
  vec3 Lv = u_lanternPos - P;
  float d2 = dot(Lv, Lv);
  float win = saturate(1.0 - pow(d2 / (u_lanternRange * u_lanternRange), 2.0));
  vec3 E = u_lanternColor * win * win / (d2 + 0.05);
  col += shade(N, V, Lv * inversesqrt(d2), E, diffColor, F0, rough, 0.1 * inversesqrt(d2));

  if (u_directOnly == 0) {
    // Sky light. AO darkens it; specular occlusion (Lagarde 2014) keeps
    // creases from reflecting sky they cannot see.
    float ao = u_useAO == 1 ? texture(u_ao, v_uv).r : 1.0;
    col += diffColor * skyAmbient(N) * ao;
    vec3 R = reflect(-V, N);
    vec3 env = mix(skyReflected(R, rough), skyAmbient(R), saturate(rough * 1.2));
    float so = saturate(pow(NoV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao);
    // Water gets its reflection from the SSR pass instead.
    col += env * envBRDF(F0, rough, NoV) * so * (1.0 - wet);
  }
  col += albedo * emissive;
  o_color = encodeHDR(col);
}
`);

  /*
   * Screen-space reflections, puddle pixels only. A reflected ray is
   * marched in view space with steps that grow with distance; at each step
   * it is projected to the screen and compared with the depth buffer. The
   * first step that lands behind a surface (but not too far behind, or it
   * passed behind an object) is refined with a binary search. Hits fade near
   * the screen edges; misses and faded hits use the sky colour instead.
   * u_ssrMode 1 writes the reflection alone, for the "Reflections" view.
   */
  var SSR_FS = build(null, COMMON, SKY, `
uniform sampler2D u_hdr;
uniform sampler2D u_depth;
uniform sampler2D u_normal;
uniform sampler2D u_material;
uniform mat4 u_proj;
uniform mat4 u_invProj;
uniform mat4 u_view;
uniform mat4 u_invView;
uniform int u_ssrMode;
in vec2 v_uv;
out vec4 o_color;

vec3 viewPos(vec2 uv) {
  float d = texture(u_depth, uv).r;
  vec4 p = u_invProj * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
vec2 project(vec3 p) {
  vec4 c = u_proj * vec4(p, 1.0);
  return c.xy / c.w * 0.5 + 0.5;
}

void main() {
  vec3 base = decodeHDR(texture(u_hdr, v_uv));
  float wet = texture(u_material, v_uv).a;
  if (wet < 0.01) {
    o_color = encodeHDR(u_ssrMode == 1 ? vec3(luma(base) * 0.05) : base);
    return;
  }
  vec3 P = viewPos(v_uv);
  vec3 N = normalize(mat3(u_view) * (texture(u_normal, v_uv).xyz * 2.0 - 1.0));
  vec3 V = normalize(-P);
  vec3 R = reflect(-V, N);

  const int STEPS = 40;
  const float MAX_DIST = 16.0;
  float jitter = ign(gl_FragCoord.xy);
  float prev = 0.0;
  float hit = 0.0;
  vec2 hitUv = vec2(0.0);
  for (int i = 0; i < STEPS; i++) {
    float t = MAX_DIST * pow((float(i) + jitter) / float(STEPS), 1.8) + 0.02;
    vec3 S = P + R * t;
    if (S.z > -0.05) break;
    vec2 uv = project(S);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float behind = viewPos(uv).z - S.z;
    if (behind > 0.0 && behind < max(0.3, (t - prev) * 2.0)) {
      float lo = prev;
      float hi = t;
      for (int k = 0; k < 5; k++) {
        float mid = 0.5 * (lo + hi);
        vec3 M = P + R * mid;
        if (viewPos(project(M)).z - M.z > 0.0) hi = mid; else lo = mid;
      }
      hitUv = project(P + R * hi);
      vec2 edge = smoothstep(0.0, 0.07, hitUv) * smoothstep(0.0, 0.07, 1.0 - hitUv);
      hit = edge.x * edge.y * (1.0 - smoothstep(0.6, 1.0, hi / MAX_DIST));
      break;
    }
    prev = t;
  }
  vec3 env = skyColor(normalize(mat3(u_invView) * R));
  vec3 refl = hit > 0.0 ? mix(env, decodeHDR(texture(u_hdr, hitUv)), hit) : env;
  // Water reflects 2% head-on and almost everything at grazing angles
  // (Schlick); a small floor keeps the puddle readable from above.
  float F = 0.02 + 0.98 * pow(1.0 - saturate(dot(N, V)), 5.0);
  F = mix(F, 1.0, 0.3);
  vec3 add = refl * F * wet;
  o_color = encodeHDR(u_ssrMode == 1 ? add : base + add);
}
`);

  /*
   * Height fog. Density falls exponentially with height, so the fog along
   * a view ray has a closed-form integral (no ray marching). The fog colour
   * is the horizon sky in the ray's direction, which makes the far ground
   * melt into the sky. The lantern's glow in the haze is the closed-form
   * single-scattering integral of a point light along the ray.
   */
  var FOG_FS = build(null, COMMON, SKY, `
uniform sampler2D u_hdr;
uniform sampler2D u_depth;
uniform mat4 u_invViewProj;
uniform vec3 u_camPos;
uniform vec4 u_fog;          // x density at y = 0, y height falloff, z glow strength, w sky distance
uniform vec3 u_lanternPos;
uniform vec3 u_lanternColor;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec3 base = decodeHDR(texture(u_hdr, v_uv));
  float d = texture(u_depth, v_uv).r;
  vec4 wp = u_invViewProj * vec4(vec3(v_uv, d) * 2.0 - 1.0, 1.0);
  vec3 ray = wp.xyz / wp.w - u_camPos;
  float dist = length(ray);
  vec3 dir = ray / dist;
  if (d >= 1.0) dist = u_fog.w;

  float a = u_fog.x;
  float b = u_fog.y;
  float fy = dir.y * b * dist;
  float shape = abs(fy) > 1e-3 ? (1.0 - exp(-fy)) / fy : 1.0;
  float depth = a * exp(-b * u_camPos.y) * dist * shape;
  float T = exp(-depth);
  // In-scattered colour: the horizon sky in this direction, cooled a little.
  vec3 fogCol = skyColor(normalize(vec3(dir.x, 0.06, dir.z))) * vec3(0.55, 0.6, 0.75);

  vec3 toL = u_lanternPos - u_camPos;
  float t0 = dot(toL, dir);
  float h = max(length(toL - dir * t0), 0.05);
  float glow = (atan((dist - t0) / h) + atan(t0 / h)) / h;
  float local = a * exp(-b * u_lanternPos.y);

  vec3 col = base * T + fogCol * (1.0 - T) + u_lanternColor * glow * local * u_fog.z;
  o_color = encodeHDR(col);
}
`);

  /* Bloom step 1: half resolution, exposure applied, then a soft threshold
     keeps only what is brighter than white. Taps are weighted by
     1 / (1 + luma) so a single very bright pixel cannot flicker. */
  var BLOOM_PRE_FS = build(null, COMMON, `
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_exposure;
uniform float u_threshold;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2((i & 1) == 0 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0) * u_texel;
    vec3 c = decodeHDR(texture(u_src, v_uv + o)) * u_exposure;
    float w = 1.0 / (1.0 + luma(c));
    sum += c * w;
    wsum += w;
  }
  vec3 c = sum / wsum;
  float br = max(c.r, max(c.g, c.b));
  float knee = u_threshold * 0.5;
  float soft = clamp(br - u_threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float keep = max(soft, br - u_threshold) / max(br, 1e-4);
  o_color = encodeHDR(c * keep);
}
`);

  /* Bloom step 2: each downsample averages a 4x4 area with five bilinear
     taps (the "dual filter"). */
  var BLOOM_DOWN_FS = build(null, COMMON, `
uniform sampler2D u_src;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec3 c = decodeHDR(texture(u_src, v_uv)) * 4.0;
  c += decodeHDR(texture(u_src, v_uv + vec2(-1.0, -1.0) * u_texel));
  c += decodeHDR(texture(u_src, v_uv + vec2(1.0, -1.0) * u_texel));
  c += decodeHDR(texture(u_src, v_uv + vec2(-1.0, 1.0) * u_texel));
  c += decodeHDR(texture(u_src, v_uv + vec2(1.0, 1.0) * u_texel));
  o_color = encodeHDR(c / 8.0);
}
`);

  /* Bloom step 3: each upsample spreads the smaller level with an 8-tap
     tent and adds the matching level of the way down, so wide and tight
     glows sum together. */
  var BLOOM_UP_FS = build(null, COMMON, `
uniform sampler2D u_src;
uniform sampler2D u_add;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec3 c = vec3(0.0);
  c += decodeHDR(texture(u_src, v_uv + vec2(-2.0, 0.0) * u_texel));
  c += decodeHDR(texture(u_src, v_uv + vec2(2.0, 0.0) * u_texel));
  c += decodeHDR(texture(u_src, v_uv + vec2(0.0, -2.0) * u_texel));
  c += decodeHDR(texture(u_src, v_uv + vec2(0.0, 2.0) * u_texel));
  c += decodeHDR(texture(u_src, v_uv + vec2(-1.0, -1.0) * u_texel)) * 2.0;
  c += decodeHDR(texture(u_src, v_uv + vec2(1.0, -1.0) * u_texel)) * 2.0;
  c += decodeHDR(texture(u_src, v_uv + vec2(-1.0, 1.0) * u_texel)) * 2.0;
  c += decodeHDR(texture(u_src, v_uv + vec2(1.0, 1.0) * u_texel)) * 2.0;
  o_color = encodeHDR(c / 12.0 + decodeHDR(texture(u_add, v_uv)));
}
`);

  /* ACES filmic curve, Stephen Hill's fit of the RRT and ODT (input and
     output matrices convert to and from the ACES working space). */
  var ACES = `
vec3 acesFilmic(vec3 c) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = inM * c;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return saturate(outM * (a / b));
}
`;

  /*
   * Tone map: exposure, bloom added, a light vignette, then the filmic
   * curve (or a hard clip at 1 for the "No tone map" view), sRGB encoding
   * and a little noise against banding. Alpha stores luma for FXAA.
   */
  var TONEMAP_FS = build(null, COMMON, ACES, `
uniform sampler2D u_hdr;
uniform sampler2D u_bloom;
uniform float u_exposure;
uniform float u_bloomStrength;
uniform int u_useBloom;
uniform int u_toneMode;   // 0 filmic, 1 clip
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec3 c = decodeHDR(texture(u_hdr, v_uv)) * u_exposure;
  if (u_useBloom == 1) c += decodeHDR(texture(u_bloom, v_uv)) * u_bloomStrength;
  vec2 q = v_uv - 0.5;
  c *= 1.0 - 0.3 * smoothstep(0.12, 0.5, dot(q, q));
  c = u_toneMode == 0 ? acesFilmic(c) : saturate(c);
  vec3 s = linearToSrgb(c) + (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  o_color = vec4(s, luma(s));
}
`);

  /*
   * FXAA (after Lottes): find pixels whose neighbourhood has strong
   * contrast, estimate the edge direction from the luma of the four
   * diagonal neighbours, and blend along the edge. If the wider blend
   * overshoots the local luma range, fall back to the narrower one.
   */
  var FXAA_FS = build(null, COMMON, `
uniform sampler2D u_src;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 m = texture(u_src, v_uv);
  float lNW = texture(u_src, v_uv + vec2(-1.0, -1.0) * u_texel).a;
  float lNE = texture(u_src, v_uv + vec2(1.0, -1.0) * u_texel).a;
  float lSW = texture(u_src, v_uv + vec2(-1.0, 1.0) * u_texel).a;
  float lSE = texture(u_src, v_uv + vec2(1.0, 1.0) * u_texel).a;
  float lMin = min(m.a, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(m.a, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.04, lMax * 0.125)) { o_color = vec4(m.rgb, 1.0); return; }
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * scale, -8.0, 8.0) * u_texel;
  vec3 a = 0.5 * (texture(u_src, v_uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(u_src, v_uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(u_src, v_uv - dir * 0.5).rgb + texture(u_src, v_uv + dir * 0.5).rgb);
  float lb = luma(b);
  o_color = vec4((lb < lMin || lb > lMax) ? a : b, 1.0);
}
`);

  /* Display modes of VIEW_FS. courtyard.js uses the same numbers. */
  var VIEW_MODES = {
    ALBEDO: 0, NORMALS: 1, DEPTH: 2, ROUGHNESS: 3, SHADOW: 4,
    AO: 5, HDR: 6, BLOOM: 7, LDR: 8, MOSAIC: 9
  };

  /*
   * Debug display: draws one buffer to the canvas as a picture. Buffer
   * pictures use the handbook's buffer colours (--buffer-lo / --buffer-hi)
   * so they match the diagrams. HDR buffers are shown through the same
   * exposure and filmic curve as the final image, so they are comparable.
   */
  var VIEW_FS = build(VIEW_MODES, COMMON, DEPTH, ACES, `
uniform sampler2D u_tex;
uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform sampler2D u_material;
uniform sampler2D u_depth;
uniform int u_mode;
uniform float u_exposure;
uniform float u_aspect;
in vec2 v_uv;
out vec4 o_color;

const vec3 BUF_LO = vec3(0.082, 0.090, 0.122);
const vec3 BUF_HI = vec3(0.945, 0.949, 0.965);

vec3 ramp(float t) { return mix(BUF_LO, BUF_HI, saturate(t)); }

vec3 show(int mode, vec2 uv) {
  float d = texture(u_depth, uv).r;
  if (mode == ALBEDO) return linearToSrgb(texture(u_albedo, uv).rgb);
  if (mode == NORMALS) return d >= 1.0 ? BUF_LO : texture(u_normal, uv).rgb;
  if (mode == ROUGHNESS) return d >= 1.0 ? BUF_LO : ramp(texture(u_material, uv).r);
  // Logarithmic ramp: 2 m is black, 60 m is white, so near detail shows.
  if (mode == DEPTH) return d >= 1.0 ? BUF_HI : ramp(log(linearDepth(d) / 2.0) / log(30.0));
  if (mode == AO) return ramp(texture(u_tex, uv).r);
  if (mode == SHADOW) {
    // The shadow map is square: letterbox it in the middle of the frame.
    vec2 s = vec2((uv.x - 0.5) * u_aspect + 0.5, uv.y);
    if (s.x < 0.0 || s.x > 1.0) return BUF_LO * 0.6;
    return ramp(texture(u_tex, s).r);
  }
  vec3 c = decodeHDR(texture(u_tex, uv));
  if (mode == HDR) return linearToSrgb(acesFilmic(c * u_exposure));
  if (mode == BLOOM) return linearToSrgb(acesFilmic(c * 2.0));
  return texture(u_tex, uv).rgb;  // LDR: already display values
}

void main() {
  if (u_mode == MOSAIC) {
    // G-buffer at a glance: albedo, normals / roughness, depth.
    vec2 cell = floor(v_uv * 2.0);
    vec2 uv = fract(v_uv * 2.0);
    vec2 px = abs(v_uv - 0.5) * vec2(u_aspect, 1.0);
    if (min(px.x, px.y) < 0.003) { o_color = vec4(BUF_LO, 1.0); return; }
    int mode = cell.y > 0.5 ? (cell.x < 0.5 ? ALBEDO : NORMALS) : (cell.x < 0.5 ? ROUGHNESS : DEPTH);
    o_color = vec4(show(mode, uv), 1.0);
    return;
  }
  o_color = vec4(show(u_mode, v_uv), 1.0);
}
`);

  /* Adds #defines to a built source, right after its #version line. Used
     for choices that depend on the context, such as HDR_RGBA8. */
  function withDefines(src, defines) {
    var lines = Object.keys(defines || {}).map(function (k) { return "#define " + k + " " + defines[k]; });
    if (!lines.length) return src;
    var cut = src.indexOf("\n");
    return src.slice(0, cut + 1) + lines.join("\n") + "\n" + src.slice(cut + 1);
  }

  CK.glsl = {
    build: build,
    withDefines: withDefines,
    VIEW_MODES: VIEW_MODES,
    sources: {
      bake: [FULLSCREEN_VS, BAKE_FS],
      shadow: [GEOMETRY_VS, SHADOW_FS],
      gbuffer: [GEOMETRY_VS, GBUFFER_FS],
      flat: [GEOMETRY_VS, FLAT_FS],
      ssao: [FULLSCREEN_VS, SSAO_FS],
      blur: [FULLSCREEN_VS, BLUR_FS],
      lighting: [FULLSCREEN_VS, LIGHTING_FS],
      ssr: [FULLSCREEN_VS, SSR_FS],
      fog: [FULLSCREEN_VS, FOG_FS],
      bloomPre: [FULLSCREEN_VS, BLOOM_PRE_FS],
      bloomDown: [FULLSCREEN_VS, BLOOM_DOWN_FS],
      bloomUp: [FULLSCREEN_VS, BLOOM_UP_FS],
      tonemap: [FULLSCREEN_VS, TONEMAP_FS],
      fxaa: [FULLSCREEN_VS, FXAA_FS],
      view: [FULLSCREEN_VS, VIEW_FS]
    }
  };
})();

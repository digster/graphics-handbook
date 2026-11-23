/*
 * spp-slider.js: chapter 8.7's interactive.
 *
 * A tiny path tracer. The scene is a box room seen through its open front:
 * a red left wall, a green right wall, white floor, ceiling and back wall,
 * a small square light in the ceiling, a tall white block and a mirror
 * sphere. The image is 96 × 96 pixels, shown enlarged so each pixel's noise
 * is visible.
 *
 * Each sample per pixel traces one path from the camera: up to 4 bounces,
 * diffuse surfaces scattering in a cosine-weighted random direction, the
 * mirror reflecting. Two ways to find the light:
 *   Light sampling on   at every diffuse bounce a shadow ray is aimed at a
 *                       random point on the light (next event estimation),
 *                       and paths that later hit the light by chance do not
 *                       count it again. Light seen in the mirror is still
 *                       found only by chance, which is where fireflies
 *                       come from.
 *   Light sampling off  light counts only when a path happens to hit it.
 *
 * Samples accumulate into running sums (colour, and luminance squared for
 * the noise estimate). Snapshots are kept at 1, 2, 4 ... 1,024 samples, so
 * moving the slider down shows the stored image instantly and moving it up
 * continues from the largest image computed so far. Work runs in slices of
 * about 12 ms per animation frame, only while the figure is on screen, so
 * the page never freezes.
 *
 * Noise estimate: per pixel, the standard error of the mean luminance,
 * sqrt(variance / n), combined as a root mean square over the image and
 * divided by the image's mean luminance. It halves for every four times
 * the samples.
 *
 * Denoiser: a small edge-aware à-trous filter in the spirit of SVGF
 * (Schied et al. 2017), spatial only: albedo is divided out, three passes
 * of a 5 × 5 kernel with gaps of 1, 2 and 4 pixels blend neighbours whose
 * depth and normal match and whose brightness is within the local noise,
 * then albedo is multiplied back. The inputs (depth, normal, albedo) come
 * from one ray through each pixel's centre, as a G-buffer would.
 *
 * Display: linear light, exposure 1, a short shoulder above 0.8, then sRGB.
 * Wall colours come from the theme's paint tokens, decoded to linear.
 *
 * The tracing core is exposed as HB.sppSlider for tests and offline figures.
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var log = HB.log && HB.log.scope ? HB.log.scope("spp-slider") : null;

  var N = 96;                 // image is N × N
  var MAX_POW = 10;           // up to 2^10 = 1,024 samples per pixel
  var MAX_DEPTH = 4;          // bounces per path
  var PI = Math.PI;

  /* ---------- Scene (metres; the room is the cube -1..1) ---------- */

  var LIGHT = { x0: -0.28, x1: 0.28, z0: -0.28, z1: 0.28, y: 0.999, area: 0.56 * 0.56, le: 16 };
  var SPHERE = { x: -0.42, y: -0.6, z: -0.25, r: 0.4, rr: 0.16 };
  var BLOCK = { x0: 0.12, x1: 0.68, y0: -1, y1: 0.25, z0: -0.72, z1: -0.16 };
  var CAM = { x: 0, y: 0, z: 3.35, tanHalf: Math.tan((34 * PI) / 360) };

  // Material ids.
  var WHITE = 0, RED = 1, GREEN = 2, LIGHTM = 3, MIRROR = 4;
  var MIRROR_R = 0.9;

  /* Linear albedos; red and green replaced from the paint tokens at start. */
  var ALB = [[0.73, 0.73, 0.73], [0.43, 0.04, 0.03], [0.08, 0.25, 0.05], [0.8, 0.8, 0.8], [1, 1, 1]];
  var LE = [16, 15.2, 13.6];  // light colour, set from --paint-daylight

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function parseHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
    if (!m) return null;
    var v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map(srgbToLinear);
  }
  function setPaint(red, green, daylight) {
    var r = parseHex(red), g = parseHex(green), d = parseHex(daylight);
    if (r) ALB[RED] = r;
    if (g) ALB[GREEN] = g;
    if (d) LE = [d[0] * LIGHT.le, d[1] * LIGHT.le, d[2] * LIGHT.le];
  }

  /* Hit record, reused to avoid allocation in the inner loop. */
  var H = { t: 0, nx: 0, ny: 0, nz: 0, m: 0 };

  /*
   * Closest hit for a ray inside the room (or entering through its open
   * front). Returns false if the ray leaves through the front.
   */
  function intersect(ox, oy, oz, dx, dy, dz) {
    // Room walls: the exit point of the cube from the inside.
    var tx = dx > 0 ? (1 - ox) / dx : dx < 0 ? (-1 - ox) / dx : Infinity;
    var ty = dy > 0 ? (1 - oy) / dy : dy < 0 ? (-1 - oy) / dy : Infinity;
    var tz = dz > 0 ? (1 - oz) / dz : dz < 0 ? (-1 - oz) / dz : Infinity;
    var t = tx, axis = 0;
    if (ty < t) { t = ty; axis = 1; }
    if (tz < t) { t = tz; axis = 2; }
    var hit = true;
    if (axis === 0) {
      H.nx = dx > 0 ? -1 : 1; H.ny = 0; H.nz = 0; H.m = dx > 0 ? GREEN : RED;
    } else if (axis === 1) {
      H.nx = 0; H.ny = dy > 0 ? -1 : 1; H.nz = 0; H.m = WHITE;
      if (dy > 0) {
        var lx = ox + dx * t, lz = oz + dz * t;
        if (lx > LIGHT.x0 && lx < LIGHT.x1 && lz > LIGHT.z0 && lz < LIGHT.z1) H.m = LIGHTM;
      }
    } else {
      if (dz > 0) hit = false;              // out through the open front
      H.nx = 0; H.ny = 0; H.nz = 1; H.m = WHITE;
    }
    H.t = t;

    // Sphere.
    var px = ox - SPHERE.x, py = oy - SPHERE.y, pz = oz - SPHERE.z;
    var b = px * dx + py * dy + pz * dz;
    var c = px * px + py * py + pz * pz - SPHERE.rr;
    var disc = b * b - c;
    if (disc > 0) {
      var s = Math.sqrt(disc);
      var ts = -b - s;
      if (ts < 1e-4) ts = -b + s;
      if (ts > 1e-4 && ts < H.t) {
        H.t = ts; hit = true; H.m = MIRROR;
        H.nx = (px + dx * ts) / SPHERE.r; H.ny = (py + dy * ts) / SPHERE.r; H.nz = (pz + dz * ts) / SPHERE.r;
      }
    }

    // Block: slab test, entered from outside.
    var t0 = 1e-4, t1 = H.t, n0 = 0, inv, ta, tb, tmp, na;
    inv = 1 / dx; ta = (BLOCK.x0 - ox) * inv; tb = (BLOCK.x1 - ox) * inv; na = 0;
    if (ta > tb) { tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) { t0 = ta; n0 = 1; }
    if (tb < t1) t1 = tb;
    if (t0 <= t1) {
      inv = 1 / dy; ta = (BLOCK.y0 - oy) * inv; tb = (BLOCK.y1 - oy) * inv;
      if (ta > tb) { tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) { t0 = ta; n0 = 2; }
      if (tb < t1) t1 = tb;
      if (t0 <= t1) {
        inv = 1 / dz; ta = (BLOCK.z0 - oz) * inv; tb = (BLOCK.z1 - oz) * inv;
        if (ta > tb) { tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) { t0 = ta; n0 = 3; }
        if (tb < t1) t1 = tb;
        if (t0 <= t1 && n0 > 0 && t0 < H.t) {
          H.t = t0; hit = true; H.m = WHITE;
          H.nx = n0 === 1 ? (dx > 0 ? -1 : 1) : 0;
          H.ny = n0 === 2 ? (dy > 0 ? -1 : 1) : 0;
          H.nz = n0 === 3 ? (dz > 0 ? -1 : 1) : 0;
        }
      }
    }
    return hit;
  }

  /* True if something blocks the segment from o to o + d * dist. Only the
     sphere and the block can stand between a surface and the light. */
  function occluded(ox, oy, oz, dx, dy, dz, dist) {
    var px = ox - SPHERE.x, py = oy - SPHERE.y, pz = oz - SPHERE.z;
    var b = px * dx + py * dy + pz * dz;
    var c = px * px + py * py + pz * pz - SPHERE.rr;
    var disc = b * b - c;
    if (disc > 0) {
      var s = Math.sqrt(disc);
      var ts = -b - s;
      if (ts < 1e-4) ts = -b + s;
      if (ts > 1e-4 && ts < dist) return true;
    }
    var t0 = 1e-4, t1 = dist, inv, ta, tb, tmp;
    inv = 1 / dx; ta = (BLOCK.x0 - ox) * inv; tb = (BLOCK.x1 - ox) * inv;
    if (ta > tb) { tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
    inv = 1 / dy; ta = (BLOCK.y0 - oy) * inv; tb = (BLOCK.y1 - oy) * inv;
    if (ta > tb) { tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
    inv = 1 / dz; ta = (BLOCK.z0 - oz) * inv; tb = (BLOCK.z1 - oz) * inv;
    if (ta > tb) { tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    return t0 <= t1;
  }

  /* xorshift32: fast, good enough for sampling, reseeded per pass. */
  var seed = 1;
  function rnd() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  }

  /* Primary ray direction through image position (u, v) in pixels. */
  var RAY = { x: 0, y: 0, z: 0 };
  function cameraRay(u, v) {
    var sx = ((u / N) * 2 - 1) * CAM.tanHalf;
    var sy = (1 - (v / N) * 2) * CAM.tanHalf;
    var l = Math.sqrt(sx * sx + sy * sy + 1);
    RAY.x = sx / l; RAY.y = sy / l; RAY.z = -1 / l;
  }

  var OUT = [0, 0, 0];
  /* One path for pixel (px, py). Writes radiance to OUT. */
  function tracePath(px, py, nee) {
    cameraRay(px + rnd(), py + rnd());
    var dx = RAY.x, dy = RAY.y, dz = RAY.z;
    // Start on the plane of the open front.
    var t0 = (1 - CAM.z) / dz;
    var ox = CAM.x + dx * t0, oy = CAM.y + dy * t0, oz = 1;
    OUT[0] = 0; OUT[1] = 0; OUT[2] = 0;
    if (ox < -1 || ox > 1 || oy < -1 || oy > 1) return;
    var tr = 1, tg = 1, tb = 1;
    var countEmission = true;             // camera rays and mirror bounces see the light
    for (var depth = 0; depth < MAX_DEPTH; depth++) {
      if (!intersect(ox, oy, oz, dx, dy, dz)) break;
      var hx = ox + dx * H.t, hy = oy + dy * H.t, hz = oz + dz * H.t;
      var m = H.m;
      if (m === LIGHTM) {
        if (countEmission || !nee) { OUT[0] += tr * LE[0]; OUT[1] += tg * LE[1]; OUT[2] += tb * LE[2]; }
        break;
      }
      var nx = H.nx, ny = H.ny, nz = H.nz;
      if (m === MIRROR) {
        var dn = dx * nx + dy * ny + dz * nz;
        dx -= 2 * dn * nx; dy -= 2 * dn * ny; dz -= 2 * dn * nz;
        tr *= MIRROR_R; tg *= MIRROR_R; tb *= MIRROR_R;
        ox = hx + nx * 1e-4; oy = hy + ny * 1e-4; oz = hz + nz * 1e-4;
        countEmission = true;
        continue;
      }
      var a = ALB[m];
      ox = hx + nx * 1e-4; oy = hy + ny * 1e-4; oz = hz + nz * 1e-4;
      if (nee) {
        // Shadow ray to a random point on the light.
        var lx = LIGHT.x0 + rnd() * (LIGHT.x1 - LIGHT.x0);
        var lz = LIGHT.z0 + rnd() * (LIGHT.z1 - LIGHT.z0);
        var wx = lx - ox, wy = LIGHT.y - oy, wz = lz - oz;
        var d2 = wx * wx + wy * wy + wz * wz;
        var dist = Math.sqrt(d2);
        wx /= dist; wy /= dist; wz /= dist;
        var cosS = wx * nx + wy * ny + wz * nz;
        var cosL = wy;                    // the light faces straight down
        if (cosS > 0 && cosL > 0 && !occluded(ox, oy, oz, wx, wy, wz, dist - 1e-3)) {
          var g = (cosS * cosL * LIGHT.area) / (d2 * PI);
          OUT[0] += tr * a[0] * LE[0] * g; OUT[1] += tg * a[1] * LE[1] * g; OUT[2] += tb * a[2] * LE[2] * g;
        }
      }
      // Cosine-weighted bounce: the cosine and 1/pi cancel, leaving albedo.
      tr *= a[0]; tg *= a[1]; tb *= a[2];
      var r1 = 2 * PI * rnd(), r2 = rnd(), r2s = Math.sqrt(r2);
      // Orthonormal basis around the normal.
      var ux, uy, uz;
      if (Math.abs(nx) > 0.1) { ux = 0; uy = 1; uz = 0; } else { ux = 1; uy = 0; uz = 0; }
      var bx = uy * nz - uz * ny, by = uz * nx - ux * nz, bz = ux * ny - uy * nx;
      var bl = Math.sqrt(bx * bx + by * by + bz * bz);
      bx /= bl; by /= bl; bz /= bl;
      var cx = ny * bz - nz * by, cy = nz * bx - nx * bz, cz = nx * by - ny * bx;
      var c1 = Math.cos(r1) * r2s, c2 = Math.sin(r1) * r2s, c3 = Math.sqrt(1 - r2);
      dx = bx * c1 + cx * c2 + nx * c3;
      dy = by * c1 + cy * c2 + ny * c3;
      dz = bz * c1 + cz * c2 + nz * c3;
      countEmission = false;
    }
  }

  /* G-buffer from one ray through each pixel's centre: depth, normal, albedo. */
  function gbuffer() {
    var gb = { depth: new Float32Array(N * N), nx: new Float32Array(N * N), ny: new Float32Array(N * N), nz: new Float32Array(N * N), alb: new Float32Array(N * N * 3) };
    for (var py = 0; py < N; py++) {
      for (var px = 0; px < N; px++) {
        var i = py * N + px;
        cameraRay(px + 0.5, py + 0.5);
        var t0 = (1 - CAM.z) / RAY.z;
        var ox = CAM.x + RAY.x * t0, oy = CAM.y + RAY.y * t0;
        gb.alb[i * 3] = gb.alb[i * 3 + 1] = gb.alb[i * 3 + 2] = 1;
        if (ox < -1 || ox > 1 || oy < -1 || oy > 1 || !intersect(ox, oy, 1, RAY.x, RAY.y, RAY.z)) {
          gb.depth[i] = 1e3;
          continue;
        }
        gb.depth[i] = t0 + H.t;
        gb.nx[i] = H.nx; gb.ny[i] = H.ny; gb.nz[i] = H.nz;
        if (H.m !== MIRROR && H.m !== LIGHTM) {
          var a = ALB[H.m];
          gb.alb[i * 3] = a[0]; gb.alb[i * 3 + 1] = a[1]; gb.alb[i * 3 + 2] = a[2];
        }
      }
    }
    return gb;
  }

  function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

  /*
   * Accumulator: running sums for every pixel, a pass counter, and the
   * snapshots. One pass adds one sample to every pixel; passes run in row
   * slices so a frame's work can stop part way through one.
   */
  function Accumulator(nee) {
    this.nee = nee;
    this.sum = new Float64Array(N * N * 3);
    this.sumL2 = new Float64Array(N * N);
    this.sumL = new Float64Array(N * N);
    this.passes = 0;          // completed samples per pixel
    this.row = 0;             // next row of the current pass
    this.ms = 0;              // compute time so far
    this.snaps = {};          // spp -> { sum, sumL, sumL2, ms }
  }
  Accumulator.prototype.work = function (budgetMs, maxPasses) {
    var start = performance.now();
    var nee = this.nee;
    while (this.passes < maxPasses) {
      if (this.row === 0) seed = (this.passes + 1) * 2654435761 >>> 0 || 1;
      var py = this.row;
      for (var px = 0; px < N; px++) {
        tracePath(px, py, nee);
        var i = py * N + px;
        this.sum[i * 3] += OUT[0]; this.sum[i * 3 + 1] += OUT[1]; this.sum[i * 3 + 2] += OUT[2];
        var l = lum(OUT[0], OUT[1], OUT[2]);
        this.sumL[i] += l;
        this.sumL2[i] += l * l;
      }
      this.row++;
      if (this.row === N) {
        this.row = 0;
        this.passes++;
        var p = this.passes;
        if ((p & (p - 1)) === 0) {
          this.ms += performance.now() - start;
          start = performance.now();
          this.snaps[p] = { sum: this.sum.slice(), sumL: this.sumL.slice(), sumL2: this.sumL2.slice(), ms: this.ms };
        }
      }
      if (performance.now() - start > budgetMs) break;
    }
    this.ms += performance.now() - start;
  };

  /* Mean colour image (Float32, linear) for a snapshot. */
  function meanImage(snap, spp) {
    var img = new Float32Array(N * N * 3);
    for (var k = 0; k < img.length; k++) img[k] = snap.sum[k] / spp;
    return img;
  }

  /* Root-mean-square standard error over mean luminance, as a fraction. */
  function noiseOf(snap, spp) {
    if (spp < 2) return null;
    var se2 = 0, mean = 0;
    for (var i = 0; i < N * N; i++) {
      var m = snap.sumL[i] / spp;
      var v = Math.max(0, (snap.sumL2[i] - spp * m * m) / (spp - 1));
      se2 += v / spp;
      mean += m;
    }
    mean /= N * N;
    return Math.sqrt(se2 / (N * N)) / Math.max(mean, 1e-6);
  }

  /* Edge-aware à-trous denoiser (spatial only). */
  var KERNEL = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];
  function denoise(img, gb) {
    var n = N * N;
    var cur = new Float32Array(n * 3);
    var lumv = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      // Demodulate: filter the light arriving, not the surface colour.
      cur[i * 3] = img[i * 3] / gb.alb[i * 3];
      cur[i * 3 + 1] = img[i * 3 + 1] / gb.alb[i * 3 + 1];
      cur[i * 3 + 2] = img[i * 3 + 2] / gb.alb[i * 3 + 2];
    }
    var next = new Float32Array(n * 3);
    var sigma = new Float32Array(n);
    for (var pass = 0; pass < 3; pass++) {
      var step = 1 << pass;
      for (i = 0; i < n; i++) lumv[i] = lum(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
      // Local noise: luminance spread over the 3 × 3 neighbours on the same surface.
      for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
          var c = y * N + x, s1 = 0, s2 = 0, w = 0;
          for (var yy = -1; yy <= 1; yy++) {
            for (var xx = -1; xx <= 1; xx++) {
              var qx = x + xx * step, qy = y + yy * step;
              if (qx < 0 || qy < 0 || qx >= N || qy >= N) continue;
              var q = qy * N + qx;
              if (Math.abs(gb.depth[q] - gb.depth[c]) > 0.05 * gb.depth[c]) continue;
              s1 += lumv[q]; s2 += lumv[q] * lumv[q]; w++;
            }
          }
          var mu = s1 / w;
          sigma[c] = Math.sqrt(Math.max(0, s2 / w - mu * mu));
        }
      }
      for (y = 0; y < N; y++) {
        for (x = 0; x < N; x++) {
          c = y * N + x;
          var r = 0, g = 0, b = 0, wsum = 0;
          var dc = gb.depth[c], nxc = gb.nx[c], nyc = gb.ny[c], nzc = gb.nz[c];
          var lc = lumv[c], sl = 4 * sigma[c] + 1e-3;
          for (var ky = 0; ky < 5; ky++) {
            qy = y + (ky - 2) * step;
            if (qy < 0 || qy >= N) continue;
            for (var kx = 0; kx < 5; kx++) {
              qx = x + (kx - 2) * step;
              if (qx < 0 || qx >= N) continue;
              q = qy * N + qx;
              var wz = Math.exp(-Math.abs(gb.depth[q] - dc) / (0.02 * dc * step));
              var dot = nxc * gb.nx[q] + nyc * gb.ny[q] + nzc * gb.nz[q];
              var wn = dot > 0 ? Math.pow(dot, 64) : 0;
              var wl = Math.exp(-Math.abs(lumv[q] - lc) / sl);
              var wt = KERNEL[kx] * KERNEL[ky] * wz * wn * wl;
              r += cur[q * 3] * wt; g += cur[q * 3 + 1] * wt; b += cur[q * 3 + 2] * wt;
              wsum += wt;
            }
          }
          if (wsum > 0) { next[c * 3] = r / wsum; next[c * 3 + 1] = g / wsum; next[c * 3 + 2] = b / wsum; }
          else { next[c * 3] = cur[c * 3]; next[c * 3 + 1] = cur[c * 3 + 1]; next[c * 3 + 2] = cur[c * 3 + 2]; }
        }
      }
      var tmp = cur; cur = next; next = tmp;
    }
    var out = new Float32Array(n * 3);
    for (i = 0; i < n * 3; i++) out[i] = cur[i] * gb.alb[i];
    return out;
  }

  /* sRGB encoding through a table, after a short shoulder above 0.8. */
  var ENC = new Uint8ClampedArray(4097);
  for (var e = 0; e <= 4096; e++) {
    var lv = e / 4096;
    ENC[e] = Math.round((lv <= 0.0031308 ? 12.92 * lv : 1.055 * Math.pow(lv, 1 / 2.4) - 0.055) * 255);
  }
  function toByte(x) {
    if (x > 0.8) x = 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
    return ENC[Math.round((x < 0 ? 0 : x) * 4096)];
  }

  HB.sppSlider = {
    N: N, setPaint: setPaint, tracePath: tracePath, gbuffer: gbuffer, Accumulator: Accumulator,
    meanImage: meanImage, noiseOf: noiseOf, denoise: denoise, toByte: toByte, out: OUT
  };

  /* ---------- The figure ---------- */

  function init(root) {
    var h = HB.html;
    var C = HB.demos.color;
    setPaint(C("paint-red"), C("paint-green"), C("paint-daylight"));
    var gb = gbuffer();

    var state = { pow: 2, denoise: false, nee: true, visible: true };
    var acc = new Accumulator(state.nee);
    var raf = 0;

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Samples per pixel" }),
      h("span", { class: "demo-hint", text: "Move the slider to add samples. Each step doubles them; the image keeps every sample already traced." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    var slider = HB.slider("spp-count", "Samples per pixel", {
      min: 0, max: MAX_POW, step: 1, value: state.pow,
      format: function (v) { return HB.fmt.int(1 << v); }
    }, function (v) { state.pow = v; update(); });
    controls.appendChild(slider);
    controls.appendChild(HB.segmented("Denoiser", [
      { value: "off", label: "Off" },
      { value: "on", label: "On" }
    ], "off", function (v) { state.denoise = v === "on"; update(); }));
    controls.appendChild(HB.segmented("Light sampling", [
      { value: "on", label: "Aim at the light" },
      { value: "off", label: "Random bounces only" }
    ], "on", function (v) {
      state.nee = v === "on";
      acc = new Accumulator(state.nee);
      update();
    }));
    root.appendChild(controls);

    var canvas = h("canvas", {
      width: N, height: N, role: "img",
      style: "display:block;width:100%;max-width:384px;aspect-ratio:1/1;margin:0 auto;image-rendering:pixelated;border:1px solid var(--line-strong);border-radius:8px"
    });
    var status = h("p", { class: "demo-hint", "aria-live": "polite", style: "text-align:center" });
    root.appendChild(h("div", { class: "demo-panel" }, [canvas, status]));
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    var ctx = canvas.getContext("2d");
    var imgData = ctx.createImageData(N, N);
    var shown = { spp: 0, denoise: null, nee: null };

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    /* Largest snapshot not above the target. */
    function bestSnap(target) {
      var best = 0;
      for (var p = 1; p <= target; p *= 2) if (acc.snaps[p]) best = p;
      return best;
    }

    function paint(spp) {
      var snap = acc.snaps[spp];
      var img = meanImage(snap, spp);
      if (state.denoise) img = denoise(img, gb);
      var d = imgData.data;
      for (var i = 0, p = 0; i < N * N; i++, p += 4) {
        d[p] = toByte(img[i * 3]); d[p + 1] = toByte(img[i * 3 + 1]); d[p + 2] = toByte(img[i * 3 + 2]); d[p + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      var noise = noiseOf(snap, spp);
      readout.replaceChildren(
        cell("Samples per pixel", HB.fmt.int(spp)),
        cell("Noise, before denoising", noise === null ? "needs 2+" : (noise * 100).toFixed(noise < 0.1 ? 1 : 0) + "%"),
        cell("Paths traced", HB.fmt.int(spp * N * N)),
        cell("Time in this browser", snap.ms < 1000 ? Math.round(snap.ms) + " ms" : (snap.ms / 1000).toFixed(1) + " s")
      );
      canvas.setAttribute("aria-label", "A small box room with a red left wall, a green right wall, a light in the ceiling, a white block and a mirror sphere, path traced with " +
        spp + " sample" + (spp > 1 ? "s" : "") + " per pixel" + (state.denoise ? " and denoised" : "") + ". " +
        (noise === null ? "" : "Noise about " + Math.round(noise * 100) + " percent."));
      shown.spp = spp; shown.denoise = state.denoise; shown.nee = state.nee;
    }

    function target() { return 1 << state.pow; }

    function update() {
      var t = target();
      var best = bestSnap(t);
      if (best && (best !== shown.spp || shown.denoise !== state.denoise || shown.nee !== state.nee)) paint(best);
      if (best < t) {
        status.textContent = "Tracing… " + HB.fmt.int(acc.passes) + " of " + HB.fmt.int(t) + " samples per pixel";
        schedule();
      } else {
        status.textContent = t === 1 ? "One path per pixel: each pixel is a single random guess." :
          "Showing " + HB.fmt.int(t) + " samples per pixel" + (state.denoise ? ", denoised." : ".");
      }
    }

    function frame() {
      raf = 0;
      if (!state.visible) return;
      var t = target();
      if (acc.passes < t) acc.work(12, t);
      update();
    }
    function schedule() {
      if (raf || !state.visible) return;
      if (acc.passes >= target()) return;
      raf = window.requestAnimationFrame(frame);
    }

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        state.visible = entries[entries.length - 1].isIntersecting && !document.hidden;
        if (state.visible) schedule();
      }).observe(root);
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { state.visible = false; return; }
      var r = root.getBoundingClientRect();
      state.visible = r.bottom > 0 && r.top < window.innerHeight;
      if (state.visible) schedule();
    });

    // Draw the first samples at once, so the figure never opens empty.
    acc.work(1e9, 1);
    update();
    if (log) log.debug("ready");
  }

  if (HB.demos && HB.demos.register) HB.demos.register("spp-slider", init);
})();

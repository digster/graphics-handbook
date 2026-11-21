/*
 * courtyard-gl.js: the WebGL2 toolbox behind the Lantern Courtyard renderer.
 *
 * It knows nothing about the courtyard itself. It offers the small set of
 * pieces a deferred renderer needs, under HB.courtyardKit (CK):
 *
 *   CK.createContext(canvas)        WebGL2 context plus a capability report
 *   CK.program(gl, vs, fs, name)    compile and link, with readable errors
 *   CK.setUniforms(gl, prog, map)   set uniforms by name, typed by the program
 *   CK.texture / CK.framebuffer     render targets
 *   CK.drawFullscreen(gl)           one triangle that covers the viewport
 *   CK.GpuTimer                     per-pass GPU timing (timer query extension)
 *   CK.mat4 / CK.vec3               the matrix maths a camera needs
 *   CK.mesh                         procedural meshes and their upload
 *
 * Load order: kit.js, courtyard-gl.js, courtyard-shaders.js, courtyard.js.
 * Classic script with no modules and no network access, so it works when the
 * handbook is opened straight from disk.
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var CK = (HB.courtyardKit = HB.courtyardKit || {});

  /* ---------- Context and capabilities ---------- */

  // No multisampling, depth or alpha on the canvas itself: every pass draws
  // into its own targets and the canvas only receives the finished picture.
  var CONTEXT_ATTRS = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "default"
  };

  /* Returns { gl, caps } or { gl: null, reason } when WebGL2 is missing. */
  CK.createContext = function (canvas) {
    var gl = null;
    try {
      gl = canvas.getContext("webgl2", CONTEXT_ATTRS);
    } catch (err) {
      gl = null;
    }
    if (!gl) return { gl: null, reason: "no-webgl2" };
    return { gl: gl, caps: CK.detectCaps(gl) };
  };

  /*
   * What this GPU and browser allow. The one decision that changes the
   * pipeline is the HDR format: half-float targets when the browser lets us
   * render into them, otherwise 8-bit targets with values stored square-rooted
   * over a fixed range (see encodeHDR in courtyard-shaders.js).
   */
  CK.detectCaps = function (gl) {
    var floatRT = !!gl.getExtension("EXT_color_buffer_float");
    var halfRT = floatRT || !!gl.getExtension("EXT_color_buffer_half_float");
    var aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    var caps = {
      timer: gl.getExtension("EXT_disjoint_timer_query_webgl2"),
      aniso: aniso,
      maxAniso: aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1,
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      hdr: "RGBA8"
    };
    if (halfRT && canRenderTo(gl, gl.RGBA16F)) caps.hdr = "RGBA16F";
    return caps;
  };

  /* A format is only usable if a framebuffer with it reports complete. */
  function canRenderTo(gl, internal) {
    var t = CK.texture(gl, { w: 4, h: 4, internal: internal });
    var fb = CK.framebuffer(gl, [t], null);
    var ok = fb.complete;
    gl.deleteFramebuffer(fb.fb);
    gl.deleteTexture(t.tex);
    return ok;
  }

  /* ---------- Programs ---------- */

  /* Shader errors quote the offending lines, so a typo is easy to find. */
  function compile(gl, type, src, name) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      var info = gl.getShaderInfoLog(sh) || "";
      var lines = src.split("\n");
      var context = [];
      (info.match(/\d+:(\d+)/g) || []).slice(0, 3).forEach(function (m) {
        var n = Number(m.split(":")[1]);
        context.push(n + ": " + (lines[n - 1] || "").trim());
      });
      gl.deleteShader(sh);
      throw new Error(name + " shader: " + info.trim() + (context.length ? "\n" + context.join("\n") : ""));
    }
    return sh;
  }

  /*
   * Compiles and links a program and records every active uniform's
   * location and type, so setUniforms() can pick the right gl.uniform* call.
   */
  CK.program = function (gl, vsSrc, fsSrc, name) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc, name + " vertex");
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, name + " fragment");
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(name + " link: " + (gl.getProgramInfoLog(prog) || "").trim());
    }
    var uniforms = {};
    var count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
    for (var i = 0; i < count; i++) {
      var info = gl.getActiveUniform(prog, i);
      var key = info.name.replace(/\[0\]$/, "");
      uniforms[key] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
    }
    return { prog: prog, uniforms: uniforms, name: name };
  };

  /* Sets uniforms from a { name: value } map. Names the compiler removed
     are skipped, so a pass can always send its full set. */
  CK.setUniforms = function (gl, p, values) {
    Object.keys(values).forEach(function (name) {
      var u = p.uniforms[name];
      if (!u) return;
      var v = values[name];
      switch (u.type) {
        case gl.FLOAT: gl.uniform1f(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
        default: gl.uniform1i(u.loc, v); // int, bool and every sampler type
      }
    });
  };

  /* ---------- Textures and render targets ---------- */

  /*
   * Immutable texture storage. o: { w, h, internal, filter, wrap, mips }.
   * Returns { tex, w, h, internal }.
   */
  CK.texture = function (gl, o) {
    var tex = gl.createTexture();
    var levels = o.mips ? Math.floor(Math.log2(Math.max(o.w, o.h))) + 1 : 1;
    var filter = o.filter || gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, o.internal, o.w, o.h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.wrap || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, o.wrap || gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex: tex, w: o.w, h: o.h, internal: o.internal };
  };

  /* A framebuffer over colour textures and an optional depth texture. */
  CK.framebuffer = function (gl, colors, depth) {
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    var buffers = colors.map(function (c, i) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, c.tex, 0);
      return gl.COLOR_ATTACHMENT0 + i;
    });
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth.tex, 0);
    gl.drawBuffers(buffers.length ? buffers : [gl.NONE]);
    if (!buffers.length) gl.readBuffer(gl.NONE);
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    var size = colors[0] || depth;
    return { fb: fb, w: size.w, h: size.h, complete: status === gl.FRAMEBUFFER_COMPLETE, status: status };
  };

  /* Full-screen passes draw one oversized triangle. Its corners come from
     gl_VertexID, so no vertex buffer is needed; WebGL2 still wants a VAO. */
  var emptyVaos = typeof WeakMap === "function" ? new WeakMap() : null;
  CK.drawFullscreen = function (gl) {
    var vao = emptyVaos && emptyVaos.get(gl);
    if (!vao) {
      vao = gl.createVertexArray();
      if (emptyVaos) emptyVaos.set(gl, vao);
    }
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  /* After a context restore the old VAO is dead: forget it. */
  CK.forgetContext = function (gl) {
    if (emptyVaos) emptyVaos.delete(gl);
  };

  /* ---------- GPU timing ---------- */

  /*
   * Times each pass with EXT_disjoint_timer_query_webgl2. Results arrive a
   * few frames later, so poll() collects them as they become available and
   * keeps a short running average per pass. A "disjoint" event (the GPU was
   * interrupted, for example by a clock change) makes a frame's numbers
   * meaningless, so they are dropped. Without the extension every call is a
   * no-op and average() returns null: the page then says "timing unavailable"
   * instead of showing invented numbers.
   */
  function GpuTimer(gl, ext) {
    this.gl = gl;
    this.ext = ext || null;
    this.pending = [];
    this.frame = null;
    this.active = null;
    this.samples = {};
  }
  GpuTimer.prototype.available = function () {
    return !!this.ext;
  };
  GpuTimer.prototype.beginFrame = function () {
    if (this.ext) this.frame = [];
  };
  GpuTimer.prototype.begin = function (id) {
    if (!this.ext || !this.frame) return;
    var q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { id: id, q: q };
  };
  GpuTimer.prototype.end = function () {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.frame.push(this.active);
    this.active = null;
  };
  GpuTimer.prototype.endFrame = function () {
    if (!this.frame) return;
    if (this.frame.length) this.pending.push(this.frame);
    this.frame = null;
    // Never let unanswered queries pile up (a background tab can stall them).
    while (this.pending.length > 8) this.discard(this.pending.shift());
  };
  GpuTimer.prototype.discard = function (frame) {
    var gl = this.gl;
    frame.forEach(function (e) { gl.deleteQuery(e.q); });
  };
  /* Collects finished results. Returns true while some are still pending. */
  GpuTimer.prototype.poll = function () {
    if (!this.ext) return false;
    var gl = this.gl;
    var disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      var frame = this.pending[0];
      var last = frame[frame.length - 1].q;
      if (!disjoint && !gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) {
        frame.forEach(function (e) {
          this.record(e.id, gl.getQueryParameter(e.q, gl.QUERY_RESULT) / 1e6);
        }, this);
      }
      this.discard(frame);
    }
    return this.pending.length > 0;
  };
  GpuTimer.prototype.record = function (id, ms) {
    var list = this.samples[id] || (this.samples[id] = []);
    list.push(ms);
    if (list.length > 12) list.shift();
  };
  /* Mean of the recent samples for a pass, in milliseconds, or null. */
  GpuTimer.prototype.average = function (id) {
    var list = this.samples[id];
    if (!list || !list.length) return null;
    return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
  };
  GpuTimer.prototype.reset = function () {
    this.pending = [];
    this.frame = null;
    this.active = null;
    this.samples = {};
  };
  CK.GpuTimer = GpuTimer;

  /* ---------- Vector and matrix maths (column-major, like GLSL) ---------- */

  var vec3 = {
    sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
    add: function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
    scale: function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross: function (a, b) {
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    },
    normalize: function (a) {
      var l = Math.hypot(a[0], a[1], a[2]) || 1;
      return [a[0] / l, a[1] / l, a[2] / l];
    }
  };
  CK.vec3 = vec3;

  var mat4 = {
    identity: function () {
      var m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },
    perspective: function (fovy, aspect, near, far) {
      var f = 1 / Math.tan(fovy / 2);
      var m = new Float32Array(16);
      m[0] = f / aspect;
      m[5] = f;
      m[10] = (far + near) / (near - far);
      m[11] = -1;
      m[14] = (2 * far * near) / (near - far);
      return m;
    },
    ortho: function (l, r, b, t, n, f) {
      var m = mat4.identity();
      m[0] = 2 / (r - l);
      m[5] = 2 / (t - b);
      m[10] = -2 / (f - n);
      m[12] = -(r + l) / (r - l);
      m[13] = -(t + b) / (t - b);
      m[14] = -(f + n) / (f - n);
      return m;
    },
    lookAt: function (eye, center, up) {
      var z = vec3.normalize(vec3.sub(eye, center));
      var x = vec3.normalize(vec3.cross(up, z));
      var y = vec3.cross(z, x);
      var m = mat4.identity();
      m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
      m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
      m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
      m[12] = -vec3.dot(x, eye);
      m[13] = -vec3.dot(y, eye);
      m[14] = -vec3.dot(z, eye);
      return m;
    },
    multiply: function (a, b) {
      var out = new Float32Array(16);
      for (var c = 0; c < 4; c++) {
        for (var r = 0; r < 4; r++) {
          out[c * 4 + r] =
            a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
      }
      return out;
    },
    invert: function (m) {
      var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
      var a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
      var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
      var a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
      var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
      var b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
      var b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
      var b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
      var b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
      var b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      var out = new Float32Array(16);
      if (!det) return out;
      det = 1 / det;
      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return out;
    },
    /* Transforms a point (w = 1) and returns it without the perspective divide. */
    transformPoint: function (m, p) {
      return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
      ];
    }
  };
  CK.mat4 = mat4;

  /* ---------- Procedural meshes ---------- */

  /*
   * Every mesh uses one interleaved vertex layout, 48 bytes per vertex:
   *   position  vec3   location 0
   *   normal    vec3   location 1
   *   uv        vec2   location 2
   *   tangent   vec4   location 3  (xyz along +u, w = handedness of +v)
   * and is drawn instanced with two per-instance vec4s:
   *   location 4  position xyz, yaw in radians
   *   location 5  scale xyz, variant in [0, 1] (per-instance tint and pattern shift)
   */
  var FLOATS_PER_VERTEX = 12;

  function MeshBuilder() {
    this.v = [];
    this.i = [];
  }
  MeshBuilder.prototype.vertex = function (p, n, uv, t) {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], t[0], t[1], t[2], t[3]);
    return this.v.length / FLOATS_PER_VERTEX - 1;
  };
  MeshBuilder.prototype.quad = function (a, b, c, d) {
    this.i.push(a, b, c, a, c, d);
  };
  MeshBuilder.prototype.done = function () {
    return { vertices: new Float32Array(this.v), indices: new Uint16Array(this.i) };
  };

  /*
   * Unit cube centred on the origin, 24 vertices so each face has its own
   * normal and uv. For each face, u and v run along two axes chosen so that
   * cross(u, v) is the outward normal: the winding is counter-clockwise seen
   * from outside, v points up on the side faces, and the tangent is u with
   * handedness +1.
   */
  var BOX_FACES = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }
  ];
  function box() {
    var mb = new MeshBuilder();
    BOX_FACES.forEach(function (f) {
      var corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(function (st) {
        var p = [0, 1, 2].map(function (k) {
          return f.n[k] * 0.5 + (st[0] - 0.5) * f.u[k] + (st[1] - 0.5) * f.v[k];
        });
        return mb.vertex(p, f.n, st, [f.u[0], f.u[1], f.u[2], 1]);
      });
      mb.quad(corners[0], corners[1], corners[2], corners[3]);
    });
    return mb.done();
  }

  /*
   * Flat ground grid on y = 0, centred, facing +y. Cells are even across the
   * core (half-width 'core' metres, three quarters of the segments) and then
   * grow quickly out to half-width 'reach', so the ground's edge lies far
   * out in the fog without spending triangles there. Its uv is the position
   * in metres (u = x, v = z), so materials tile by world size. dP/dv is +z
   * while cross(normal, tangent) is -z, hence handedness -1.
   */
  function grid(core, reach, segs) {
    function coord(t) {
      var a = Math.abs(t);
      var x = a <= 0.75 ? (a / 0.75) * core : core + (reach - core) * Math.pow((a - 0.75) / 0.25, 2);
      return t < 0 ? -x : x;
    }
    var mb = new MeshBuilder();
    for (var j = 0; j <= segs; j++) {
      for (var i = 0; i <= segs; i++) {
        var x = coord((i / segs) * 2 - 1);
        var z = coord((j / segs) * 2 - 1);
        mb.vertex([x, 0, z], [0, 1, 0], [x, z], [1, 0, 0, -1]);
      }
    }
    var segX = segs;
    var segZ = segs;
    var row = segX + 1;
    for (var b = 0; b < segZ; b++) {
      for (var a = 0; a < segX; a++) {
        var k = b * row + a;
        // Counter-clockwise seen from above (+y).
        mb.quad(k, k + row, k + row + 1, k + 1);
      }
    }
    return mb.done();
  }

  /*
   * A cloth strip hanging from its top edge: x across in [-0.5, 0.5], y from
   * 0 down to -1, facing +z. uv = (across, down) in [0, 1]. The vertex shader
   * moves it with the wind; the mesh is only the rest pose.
   */
  function cloth(cols, rows) {
    var mb = new MeshBuilder();
    for (var j = 0; j <= rows; j++) {
      for (var i = 0; i <= cols; i++) {
        var u = i / cols;
        var v = j / rows;
        mb.vertex([u - 0.5, -v, 0], [0, 0, 1], [u, v], [1, 0, 0, -1]);
      }
    }
    var row = cols + 1;
    for (var b = 0; b < rows; b++) {
      for (var a = 0; a < cols; a++) {
        var k = b * row + a;
        // Counter-clockwise seen from +z: down the left edge, then across.
        mb.quad(k, k + row, k + row + 1, k + 1);
      }
    }
    return mb.done();
  }

  /* Unique triangle edges as line pairs, for the wireframe views. */
  function edges(indices) {
    var seen = new Set();
    var out = [];
    for (var t = 0; t < indices.length; t += 3) {
      for (var e = 0; e < 3; e++) {
        var a = indices[t + e];
        var b = indices[t + ((e + 1) % 3)];
        var key = a < b ? a * 65536 + b : b * 65536 + a;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a, b);
      }
    }
    return new Uint16Array(out);
  }

  /* Uploads a mesh's vertices, triangle indices and edge indices once. */
  function upload(gl, mesh) {
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    var ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    var lines = edges(mesh.indices);
    var ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    return { vbo: vbo, ibo: ibo, ebo: ebo, indexCount: mesh.indices.length, edgeCount: lines.length };
  }

  /*
   * A drawable: one uploaded mesh plus its instances. Two VAOs share the
   * same vertex and instance buffers: one with the triangle index buffer,
   * one with the edge index buffer for line drawing.
   * instances: array of [x, y, z, yaw, sx, sy, sz, variant].
   */
  function drawable(gl, buffers, instances) {
    var data = new Float32Array(instances.length * 8);
    instances.forEach(function (inst, n) { data.set(inst, n * 8); });
    var inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    function vao(indexBuffer) {
      var va = gl.createVertexArray();
      gl.bindVertexArray(va);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.vbo);
      var stride = FLOATS_PER_VERTEX * 4;
      [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 4, 32]].forEach(function (a) {
        gl.enableVertexAttribArray(a[0]);
        gl.vertexAttribPointer(a[0], a[1], gl.FLOAT, false, stride, a[2]);
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      [[4, 0], [5, 16]].forEach(function (a) {
        gl.enableVertexAttribArray(a[0]);
        gl.vertexAttribPointer(a[0], 4, gl.FLOAT, false, 32, a[1]);
        gl.vertexAttribDivisor(a[0], 1);
      });
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bindVertexArray(null);
      return va;
    }

    return {
      vao: vao(buffers.ibo),
      edgeVao: vao(buffers.ebo),
      indexCount: buffers.indexCount,
      edgeCount: buffers.edgeCount,
      instanceCount: instances.length
    };
  }

  CK.mesh = { box: box, grid: grid, cloth: cloth, edges: edges, upload: upload, drawable: drawable };
})();

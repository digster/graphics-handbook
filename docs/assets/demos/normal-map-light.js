/*
 * normal-map-light.js: chapter 6.4's interactive.
 *
 * A flat square, shaded pixel by pixel on a 320 × 320 canvas the way a
 * pixel shader would shade a normal-mapped quad:
 *
 *   1. A procedural height field (bricks or a riveted metal panel) is built
 *      once per surface. Its slopes, taken by central differences, give a
 *      tangent-space normal per texel: n = normalize(-k·dh/du, -k·dh/dv, 1),
 *      with u to the right and v up the texture (the OpenGL, Y+ convention).
 *      That array of normals is the "normal map".
 *   2. For every pixel, the shader reads the normal, optionally with the
 *      green (Y) channel inverted to mimic a map authored in the other
 *      convention, and lights it with one point light hovering above the
 *      square: Lambert diffuse plus a small Blinn-Phong highlight, with mild
 *      distance falloff. With the normal map off, every pixel uses (0, 0, 1).
 *   3. A second canvas shows the texture itself, encoded the way it is
 *      stored: RGB = (n + 1) / 2 × 255. That is why it looks blue-purple.
 *
 * The square is a quad lying in the screen plane, so tangent space and
 * screen space line up (tangent = right, bitangent = up, normal = towards
 * the viewer). The viewer looks straight down the normal.
 *
 * The lit image is a picture of rendered output, so it is drawn between the
 * --buffer-lo and --buffer-hi tokens, which stay the same in both themes.
 * The normal map view shows the stored data as real colours, on purpose.
 * Rendering happens only when something changes, at most once per frame.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("normal-map-light");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- Constants ---------- */

  var N = 320; // canvas size in pixels; one texel per pixel
  var STRENGTH = 4; // height slope to normal tilt factor
  var AMBIENT = 0.16;
  var EDGE = 0.04; // keep the light handle inside the square, in square widths

  /* ---------- Small maths helpers ---------- */

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }
  function smoothstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* Integer hash to [0, 1): deterministic, so the surface is the same on
     every load. */
  function hash2(x, y, seed) {
    var n = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  }

  /* Smooth value noise on a lattice of the given cell size. */
  function valueNoise(x, y, cell, seed) {
    var gx = x / cell;
    var gy = y / cell;
    var x0 = Math.floor(gx);
    var y0 = Math.floor(gy);
    var fx = gx - x0;
    var fy = gy - y0;
    var sx = fx * fx * (3 - 2 * fx);
    var sy = fy * fy * (3 - 2 * fy);
    var a = hash2(x0, y0, seed);
    var b = hash2(x0 + 1, y0, seed);
    var c = hash2(x0, y0 + 1, seed);
    var d = hash2(x0 + 1, y0 + 1, seed);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  /* ---------- Surfaces: height (0..1) and albedo per texel ---------- */

  /* Bricks: 8 courses of 40 px, bricks 80 px long, alternate courses offset
     by half a brick. Mortar joints are recessed; brick faces have a 6 px
     bevel and a little stony noise. */
  function buildBricks() {
    var height = new Float32Array(N * N);
    var albedo = new Float32Array(N * N);
    var BH = 40;
    var BW = 80;
    var MORTAR = 3;
    var BEVEL = 6;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var row = Math.floor(y / BH);
        var shift = row % 2 ? BW / 2 : 0;
        var lx = (x + shift) % BW;
        var ly = y % BH;
        var col = Math.floor((x + shift) / BW);
        var edge = Math.min(lx, BW - 1 - lx, ly, BH - 1 - ly) - MORTAR;
        var grain = valueNoise(x, y, 9, 3) * 0.6 + valueNoise(x, y, 3, 5) * 0.4;
        var i = y * N + x;
        if (edge < 0) {
          height[i] = 0.04 * grain;
          albedo[i] = 0.5 + 0.06 * grain;
        } else {
          var tone = hash2(col, row, 11);
          height[i] = smoothstep(0, BEVEL, edge) * (0.92 + 0.08 * tone) + 0.16 * (grain - 0.5);
          albedo[i] = 0.66 + 0.16 * tone + 0.08 * (grain - 0.5);
        }
      }
    }
    return { height: height, albedo: albedo, spec: 0.06, shine: 12 };
  }

  /* Riveted panel: four plates split by grooves, domed rivets along the
     plate edges, and fine horizontal brushing. */
  function buildRivets() {
    var height = new Float32Array(N * N);
    var albedo = new Float32Array(N * N);
    var PLATE = 160;
    var GROOVE = 2.5;
    var R = 7;
    var STEP = 32;
    var INSET = 14;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var px = x % PLATE;
        var py = y % PLATE;
        var edge = Math.min(px, PLATE - 1 - px, py, PLATE - 1 - py);
        var hgt = 0.45 + 0.02 * (valueNoise(x, y * 8, 6, 7) - 0.5);
        if (edge < GROOVE) hgt = 0.1;
        else if (edge < GROOVE + 3) hgt = 0.1 + 0.35 * smoothstep(GROOVE, GROOVE + 3, edge);
        // Nearest rivet: rows of rivets run INSET px inside each plate edge,
        // one every STEP px, along all four sides.
        var best = 1e9;
        var lines = [INSET, PLATE - 1 - INSET];
        var along = function (v) {
          return clamp(Math.round((v - INSET) / STEP) * STEP + INSET, INSET, PLATE - 1 - INSET);
        };
        for (var k = 0; k < 2; k++) {
          var d1 = Math.hypot(px - along(px), py - lines[k]); // top and bottom rows
          var d2 = Math.hypot(px - lines[k], py - along(py)); // left and right rows
          if (d1 < best) best = d1;
          if (d2 < best) best = d2;
        }
        if (best < R) {
          var t = best / R;
          hgt = Math.max(hgt, 0.45 + 0.55 * Math.sqrt(1 - t * t));
        }
        var i = y * N + x;
        height[i] = hgt;
        albedo[i] = 0.7 + 0.05 * (valueNoise(x, y * 10, 5, 9) - 0.5);
      }
    }
    return { height: height, albedo: albedo, spec: 0.55, shine: 48 };
  }

  /* Normals from heights by central differences, wrapping at the edges.
     Canvas rows run down, texture v runs up, so dh/dv = -dh/dy. */
  function normalsFrom(height) {
    var nrm = new Float32Array(N * N * 3);
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var l = height[y * N + ((x + N - 1) % N)];
        var r = height[y * N + ((x + 1) % N)];
        var u = height[((y + N - 1) % N) * N + x];
        var d = height[((y + 1) % N) * N + x];
        var dhdu = (r - l) / 2;
        var dhdv = -(d - u) / 2;
        var nx = -STRENGTH * dhdu;
        var ny = -STRENGTH * dhdv;
        var len = Math.sqrt(nx * nx + ny * ny + 1);
        var j = (y * N + x) * 3;
        nrm[j] = nx / len;
        nrm[j + 1] = ny / len;
        nrm[j + 2] = 1 / len;
      }
    }
    return nrm;
  }

  var SURFACES = { bricks: buildBricks, rivets: buildRivets };
  var cache = {};
  function surface(name) {
    if (!cache[name]) {
      var s = SURFACES[name]();
      s.normals = normalsFrom(s.height);
      cache[name] = s;
    }
    return cache[name];
  }

  /* ---------- Theme colours ---------- */

  var probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  var pctx = probe.getContext("2d", { willReadFrequently: true });
  function tokenRGB(name, fallback) {
    try {
      pctx.clearRect(0, 0, 1, 1);
      pctx.fillStyle = HB.demos.color(name) || fallback;
      pctx.fillRect(0, 0, 1, 1);
      var d = pctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    } catch (err) {
      log.warn("could not read theme colour", name, err);
      return null;
    }
  }

  /* ---------- Words for the readout ---------- */

  function compass(dx, dy) {
    // dx right, dy up, relative to the square's centre.
    if (Math.hypot(dx, dy) < 0.06) return "head-on, over the centre";
    var a = (Math.atan2(dy, dx) * 180) / Math.PI;
    var names = ["the right", "the upper right", "the top", "the upper left", "the left", "the lower left", "the bottom", "the lower right"];
    var k = Math.round(((a + 360) % 360) / 45) % 8;
    return names[k];
  }

  function init(root) {
    var state = {
      surface: "bricks",
      mapOn: true,
      flip: false,
      lx: 0.22, // light position: x to the right, y down, in square widths
      ly: 0.2,
      lz: 0.28, // height above the surface, in square widths
      hover: null // texel under the pointer, or null
    };
    var colours = { lo: [21, 23, 31], hi: [241, 242, 246] };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Normal map light" }),
      h("span", { class: "demo-hint", text: "Drag the light, click to place it, or focus it and use the arrow keys." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Surface", [
      { value: "bricks", label: "Bricks" },
      { value: "rivets", label: "Rivets" }
    ], state.surface, function (v) { state.surface = v; request(); }));
    controls.appendChild(HB.segmented("Normal map", [
      { value: "on", label: "On" },
      { value: "off", label: "Off" }
    ], "on", function (v) { state.mapOn = v === "on"; request(); }));
    controls.appendChild(HB.segmented("Green channel", [
      { value: "match", label: "Matches engine" },
      { value: "flip", label: "Flipped" }
    ], "match", function (v) { state.flip = v === "flip"; request(); }));
    controls.appendChild(HB.slider("nml-height", "Light height", {
      min: 0.06, max: 0.8, step: 0.01, value: state.lz,
      format: function (v) { return Math.round(v * 100) + "% of the width"; }
    }, function (v) { state.lz = v; request(); }));
    root.appendChild(controls);

    /* Two panels: the lit square with the light handle, and the texture. */
    var canvasStyle = "display:block;width:100%;height:auto;aspect-ratio:1/1;border:1px solid var(--line-strong);border-radius:8px";
    var litCanvas = h("canvas", { width: N, height: N, role: "img", style: canvasStyle });
    var mapCanvas = h("canvas", { width: N, height: N, role: "img", style: canvasStyle });
    var overlay = svgEl("svg", {
      class: "dg",
      viewBox: "0 0 " + N + " " + N,
      style: "position:absolute;inset:0;width:100%;height:100%;touch-action:none",
      role: "group",
      "aria-label": "Light position over the square"
    });
    var litWrap = h("div", { style: "position:relative;max-width:360px" }, [litCanvas]);
    litWrap.appendChild(overlay);
    var mapWrap = h("div", { style: "position:relative;max-width:360px" }, [mapCanvas]);
    root.appendChild(h("div", { class: "demo-stage" }, [
      h("div", { class: "fig-row" }, [
        h("div", { class: "demo-panel" }, [h("span", { class: "label", text: "Lit result" }), litWrap]),
        h("div", { class: "demo-panel" }, [h("span", { class: "label", text: "The texture the shader reads" }), mapWrap])
      ])
    ]));

    var note = h("p", { class: "demo-hint", "aria-live": "polite" });
    root.appendChild(note);
    var readout = h("div", { class: "demo-readout" });
    root.appendChild(readout);

    // Light handle: a ring the keyboard can focus, and the light itself.
    var handle = svgEl("g", { "aria-label": "Light" }, overlay);
    svgEl("circle", { r: 15, class: "f-lit-soft s-lit handle-ring", "fill-opacity": 0.55 }, handle);
    svgEl("circle", { r: 7, class: "f-lit s-ink" }, handle);
    var rays = svgEl("path", { class: "s-lit w15 round", d: "" }, handle);
    var shadowDot = svgEl("circle", { r: 3, class: "f-ink", "fill-opacity": 0.45 }, overlay);
    overlay.insertBefore(shadowDot, handle);
    (function drawRays() {
      var d = "";
      for (var k = 0; k < 8; k++) {
        var a = (k * Math.PI) / 4;
        d += "M" + (Math.cos(a) * 10).toFixed(1) + "," + (Math.sin(a) * 10).toFixed(1) +
          " L" + (Math.cos(a) * 13).toFixed(1) + "," + (Math.sin(a) * 13).toFixed(1) + " ";
      }
      rays.setAttribute("d", d);
    })();

    var litCtx = litCanvas.getContext("2d");
    var mapCtx = mapCanvas.getContext("2d");
    if (!litCtx || !mapCtx) throw new Error("2D canvas is not available");
    var litImg = litCtx.createImageData(N, N);
    var mapImg = mapCtx.createImageData(N, N);

    /* Reads the stored normal for texel i, as the shader would see it. */
    function readNormal(s, i, out) {
      if (!state.mapOn) {
        out[0] = 0; out[1] = 0; out[2] = 1;
        return out;
      }
      var j = i * 3;
      out[0] = s.normals[j];
      out[1] = state.flip ? -s.normals[j + 1] : s.normals[j + 1];
      out[2] = s.normals[j + 2];
      return out;
    }

    function render() {
      pending = false;
      var s = surface(state.surface);
      var lo = colours.lo;
      var hi = colours.hi;
      var L = [state.lx * N, state.ly * N, state.lz * N];
      var n = [0, 0, 1];
      var lit = litImg.data;
      var map = mapImg.data;
      for (var y = 0; y < N; y++) {
        for (var x = 0; x < N; x++) {
          var i = y * N + x;
          readNormal(s, i, n);
          // Tangent space (u right, v up) to canvas space (x right, y down).
          var nx = n[0];
          var ny = -n[1];
          var nz = n[2];
          var dx = L[0] - (x + 0.5);
          var dy = L[1] - (y + 0.5);
          var dz = L[2];
          var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          dx /= dist; dy /= dist; dz /= dist;
          var diff = nx * dx + ny * dy + nz * dz;
          if (diff < 0) diff = 0;
          // Blinn-Phong half vector with the viewer straight above (0, 0, 1).
          var hx = dx;
          var hy = dy;
          var hz = dz + 1;
          var hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
          var spec = diff > 0 ? Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), s.shine) : 0;
          var r = dist / N;
          var atten = 1 / (1 + 0.8 * r * r);
          var v = s.albedo[i] * (AMBIENT + 0.95 * diff * atten) + s.spec * spec * atten;
          v = v < 0 ? 0 : v > 1 ? 1 : v;
          var k = i * 4;
          lit[k] = lo[0] + (hi[0] - lo[0]) * v;
          lit[k + 1] = lo[1] + (hi[1] - lo[1]) * v;
          lit[k + 2] = lo[2] + (hi[2] - lo[2]) * v;
          lit[k + 3] = 255;
          // The stored texture: (n + 1) / 2, green as stored in the file.
          map[k] = Math.round((n[0] + 1) * 127.5);
          map[k + 1] = Math.round((n[1] + 1) * 127.5);
          map[k + 2] = Math.round((n[2] + 1) * 127.5);
          map[k + 3] = 255;
        }
      }
      litCtx.putImageData(litImg, 0, 0);
      mapCtx.putImageData(mapImg, 0, 0);
      placeHandle();
      describe();
    }

    var pending = false;
    function request() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(render);
    }

    function placeHandle() {
      var cx = state.lx * N;
      var cy = state.ly * N;
      handle.setAttribute("transform", "translate(" + cx.toFixed(1) + "," + cy.toFixed(1) + ")");
      shadowDot.setAttribute("cx", cx.toFixed(1));
      shadowDot.setAttribute("cy", cy.toFixed(1));
    }

    function texelText(x, y) {
      var s = surface(state.surface);
      var i = clamp(Math.floor(y), 0, N - 1) * N + clamp(Math.floor(x), 0, N - 1);
      var n = readNormal(s, i, [0, 0, 1]);
      var rgb = n.map(function (c) { return Math.round((c + 1) * 127.5); });
      return "RGB " + rgb.join(" ") + " → (" + n.map(function (c) { return (c >= 0 ? "" : "−") + Math.abs(c).toFixed(2); }).join(", ") + ")";
    }

    function describe() {
      var dx = state.lx - 0.5;
      var dy = 0.5 - state.ly;
      var where = compass(dx, dy);
      var elev = Math.round((Math.atan2(state.lz, Math.hypot(dx, dy)) * 180) / Math.PI);
      var mode = !state.mapOn ? "Off" : state.flip ? "On, green flipped" : "On, OpenGL Y+";
      var probeAt = state.hover || { x: state.lx * N, y: state.ly * N };
      function cell(label, value) {
        return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
      }
      readout.replaceChildren(
        cell("Light from", where),
        cell("Light elevation", elev + "°"),
        cell("Normal map", mode),
        cell(state.hover ? "Texel under the pointer" : "Texel under the light", texelText(probeAt.x, probeAt.y))
      );
      var vertical = Math.abs(dy) > Math.abs(dx) * 1.2;
      var sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
      var text;
      if (!state.mapOn) {
        text = "Off: every texel reads as flat (0, 0, 1). The light only brightens the area beneath it; the joints are just darker paint.";
      } else if (state.flip && vertical) {
        text = "Flipped green with the light from " + where + ": edges facing the light go dark, so bumps read as dents. Only up and down are swapped.";
      } else if (state.flip && sideways) {
        text = "Flipped green, but the light is at the side: it still looks right, because only the vertical tilt is inverted. Move the light to the top or bottom.";
      } else if (state.flip) {
        text = "Flipped green: the vertical half of the lighting is inverted, so the bumps look lopsided. Move the light to the top or bottom edge to see it clearly.";
      } else if (state.lz < 0.16) {
        text = "Grazing light: the slopes facing it light up and the rest falls into shade, which is when normal maps read most strongly.";
      } else {
        text = "Every pixel reads its own normal, so slopes facing the light brighten and the rest darken, on a surface that is perfectly flat.";
      }
      note.textContent = text;
      handle.setAttribute("aria-valuetext", "Light from " + where + ", " + elev + " degrees up");
      litCanvas.setAttribute("aria-label", "A flat square of " + state.surface + " lit from " + where + ". Normal map " + mode.toLowerCase() + ".");
      mapCanvas.setAttribute("aria-label", state.mapOn
        ? "The normal map texture: mostly blue-purple, with redder and greener tints where the surface tilts."
        : "No normal map: one flat blue-purple colour, 128, 128, 255.");
    }

    function moveLight(px, py) {
      state.lx = clamp(px / N, EDGE, 1 - EDGE);
      state.ly = clamp(py / N, EDGE, 1 - EDGE);
      request();
    }

    HB.draggable(overlay, handle, {
      onDrag: function (pt) { moveLight(pt.x, pt.y); }
    });
    // Arrow keys move the light on both axes; Shift moves further.
    handle.addEventListener("keydown", function (event) {
      var step = event.shiftKey ? 0.1 : 0.03;
      var moved = true;
      if (event.key === "ArrowLeft") state.lx = clamp(state.lx - step, EDGE, 1 - EDGE);
      else if (event.key === "ArrowRight") state.lx = clamp(state.lx + step, EDGE, 1 - EDGE);
      else if (event.key === "ArrowUp") state.ly = clamp(state.ly - step, EDGE, 1 - EDGE);
      else if (event.key === "ArrowDown") state.ly = clamp(state.ly + step, EDGE, 1 - EDGE);
      else moved = false;
      if (!moved) return;
      event.preventDefault();
      request();
    });

    // Press anywhere on the lit square to place the light, then drag it.
    var placing = false;
    overlay.addEventListener("pointerdown", function (event) {
      if (handle.contains(event.target)) return;
      placing = true;
      try { overlay.setPointerCapture(event.pointerId); } catch (err) { /* capture is optional */ }
      var pt = HB.svg.toLocal(overlay, event.clientX, event.clientY);
      moveLight(pt.x, pt.y);
      event.preventDefault();
    });
    overlay.addEventListener("pointermove", function (event) {
      if (!placing) return;
      var pt = HB.svg.toLocal(overlay, event.clientX, event.clientY);
      moveLight(pt.x, pt.y);
    });
    function stopPlacing(event) {
      if (!placing) return;
      placing = false;
      try { overlay.releasePointerCapture(event.pointerId); } catch (err) { /* already released */ }
    }
    overlay.addEventListener("pointerup", stopPlacing);
    overlay.addEventListener("pointercancel", stopPlacing);

    // Hovering either panel reports the texel under the pointer.
    function hoverOn(wrap, canvas) {
      wrap.addEventListener("pointermove", function (event) {
        var rect = canvas.getBoundingClientRect();
        if (!rect.width) return;
        state.hover = {
          x: ((event.clientX - rect.left) / rect.width) * N,
          y: ((event.clientY - rect.top) / rect.height) * N
        };
        describe();
      });
      wrap.addEventListener("pointerleave", function () {
        state.hover = null;
        describe();
      });
    }
    hoverOn(litWrap, litCanvas);
    hoverOn(mapWrap, mapCanvas);

    function readColours() {
      colours.lo = tokenRGB("buffer-lo", "#15171F") || colours.lo;
      colours.hi = tokenRGB("buffer-hi", "#F1F2F6") || colours.hi;
    }
    document.addEventListener("hb:themechange", function () {
      // The new tokens apply on the next style pass.
      window.requestAnimationFrame(function () { readColours(); request(); });
    });

    readColours();
    render();
    log.debug("ready");
  }

  HB.demos.register("normal-map-light", init);
})();

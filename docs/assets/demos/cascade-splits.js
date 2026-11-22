/*
 * cascade-splits.js: chapter 7.5's interactive.
 *
 * A camera stands on flat ground under a sun straight overhead, looking
 * along the ground. Seen from above, its view frustum is a wedge with a
 * 90° horizontal field of view (16:9 at 1920 × 1080, a 59° vertical field
 * of view), cut off at the shadow distance. The wedge is split into 1 to 4
 * cascades by distance, and each cascade gets its own square shadow map.
 *
 * Split positions follow the practical split scheme of Zhang, Sun and
 * Nyman (GPU Gems 3, chapter 10): a blend, by lambda, between even
 * (linear) splits and logarithmic splits, starting from NEAR metres:
 *
 *   log_i     = NEAR * (FAR / NEAR)^(i / m)
 *   linear_i  = NEAR + (FAR - NEAR) * i / m
 *   split_i   = lambda * log_i + (1 - lambda) * linear_i
 *
 * Fitting: each cascade's map is a square around the smallest circle that
 * encloses its slice of the wedge, the stable fit most engines use because
 * it does not change size as the camera turns. With a 90° field of view
 * that circle is centred on the slice's far edge and has the far distance
 * as its radius, so the square is 2 × far metres across and
 *
 *   texel size = 2 × far / resolution.
 *
 * What the screen needs: one shadow texel per screen pixel. A pixel at
 * distance z covers 2 z / 1920 metres across (90° field, 1920 pixels), so
 * the "needed" line in the chart is that footprint. The chart uses
 * logarithmic axes, on which that line is straight and logarithmic splits
 * are evenly spaced.
 *
 * Exposed as HB.cascadeSplits so the chapter's figure generator and tests
 * can reuse exactly the same numbers.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("cascade-splits");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- Model ---------- */

  var NEAR = 1;            // metres: where the split formula starts
  var SCREEN_W = 1920;     // pixels across the screen
  var TAN_HALF = 1;        // tan(45°): 90° horizontal field of view
  var NEAR_PROBE = 2;      // metres: the "near" readout distance

  function splits(count, far, lambda) {
    var out = [];
    for (var i = 1; i <= count; i++) {
      var lg = NEAR * Math.pow(far / NEAR, i / count);
      var ln = NEAR + (far - NEAR) * i / count;
      out.push(lambda * lg + (1 - lambda) * ln);
    }
    out[count - 1] = far;
    return out;
  }

  /* Smallest circle enclosing the slice [z0, z1] of the wedge, for any
     field of view: centre on the axis at c, radius r. */
  function enclosing(z0, z1) {
    var a = z0 * TAN_HALF, b = z1 * TAN_HALF;
    var c = (z1 * z1 + b * b - z0 * z0 - a * a) / (2 * (z1 - z0));
    if (c > z1) c = z1;
    return { c: c, r: Math.hypot(c - z1, b) };
  }

  function cascades(count, far, lambda, res) {
    var s = splits(count, far, lambda);
    var list = [];
    var z0 = NEAR;
    for (var i = 0; i < count; i++) {
      var z1 = s[i];
      var circ = enclosing(z0, z1);
      var side = 2 * circ.r;
      list.push({ index: i, z0: z0, z1: z1, centre: circ.c, side: side, texel: side / res, perMetre: res / side });
      z0 = z1;
    }
    return list;
  }

  /* Metres covered by one screen pixel at distance z. */
  function pixelFootprint(z) { return 2 * z * TAN_HALF / SCREEN_W; }

  function cascadeAt(list, z) {
    for (var i = 0; i < list.length; i++) if (z <= list[i].z1 + 1e-9) return list[i];
    return null;
  }

  HB.cascadeSplits = { NEAR: NEAR, splits: splits, cascades: cascades, pixelFootprint: pixelFootprint, enclosing: enclosing };

  /* ---------- Formatting ---------- */

  function metres(m) {
    if (m < 10) return m.toFixed(1) + " m";
    return Math.round(m).toLocaleString("en-GB") + " m";
  }
  function cm(m) {
    var c = m * 100;
    if (c < 1) return c.toFixed(2) + " cm";
    if (c < 100) return c.toFixed(1) + " cm";
    return Math.round(c) + " cm";
  }
  function perM(v) {
    if (v < 10) return v.toFixed(1);
    return Math.round(v).toLocaleString("en-GB");
  }

  /* ---------- Drawing constants ---------- */

  var VW = 820, VH = 356;
  // Top-down overview: camera at the left edge, looking right.
  var OV = { x: 20, y: 44, w: 292, h: 292 };
  // Chart: log distance (x) against log texel size (y).
  var CH = { x0: 404, x1: 800, y0: 300, y1: 52 };
  var DMIN = 1, DMAX = 1000;            // metres on the x axis
  var TMIN = 0.0005, TMAX = 2;          // metres on the y axis (0.05 cm to 2 m)
  function cx(z) { return CH.x0 + (Math.log(z / DMIN) / Math.log(DMAX / DMIN)) * (CH.x1 - CH.x0); }
  function cy(t) { return CH.y0 - (Math.log(t / TMIN) / Math.log(TMAX / TMIN)) * (CH.y0 - CH.y1); }

  var OPAC = [0.42, 0.3, 0.2, 0.12];

  var PRESETS = {
    one: { count: 1, lambda: 0.75 },
    even: { count: 4, lambda: 0 },
    logs: { count: 4, lambda: 1 },
    blend: { count: 4, lambda: 0.5 }
  };

  function init(root) {
    var state = { count: 4, far: 200, lambda: 0.75, res: 2048 };

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Cascade splits" }),
      h("span", { class: "demo-hint", text: "Change the cascade count, the shadow distance and where the splits fall." })
    ]));

    /* Controls. Slider positions for distance are logarithmic. */
    var controls = h("div", { class: "demo-controls" });
    var countSeg = HB.segmented("Cascades", [1, 2, 3, 4].map(function (n) { return { value: n, label: String(n) }; }), state.count, function (v) { state.count = v; draw(); });
    var distC = HB.slider("cs-dist", "Shadow distance", {
      min: 0, max: 100, step: 1, value: distToSlider(state.far),
      format: function (v) { return metres(sliderToDist(v)); }
    }, function (v) { state.far = sliderToDist(v); draw(); });
    var lamC = HB.slider("cs-lambda", "Split spacing: 0 even, 1 logarithmic", {
      min: 0, max: 1, step: 0.05, value: state.lambda,
      format: function (v) { return v.toFixed(2); }
    }, function (v) { state.lambda = v; draw(); });
    var resSeg = HB.segmented("Map per cascade", [1024, 2048, 4096].map(function (r) { return { value: r, label: String(r) }; }), state.res, function (v) { state.res = v; draw(); });
    var presetSeg = HB.segmented("Try", [
      { value: "one", label: "One map" },
      { value: "even", label: "Even splits" },
      { value: "logs", label: "Log splits" },
      { value: "blend", label: "Blend 0.5" }
    ], "", function (v) { applyPreset(PRESETS[v]); });
    controls.appendChild(countSeg);
    controls.appendChild(distC);
    controls.appendChild(lamC);
    controls.appendChild(resSeg);
    controls.appendChild(presetSeg);
    root.appendChild(controls);

    function distToSlider(d) { return Math.round(100 * Math.log(d / 20) / Math.log(1000 / 20)); }
    function sliderToDist(v) {
      var d = 20 * Math.pow(1000 / 20, v / 100);
      // Round to friendly values so the readouts stay readable.
      if (d < 100) return Math.round(d);
      return Math.round(d / 10) * 10;
    }
    function setSlider(ctrl, v) {
      var input = ctrl.querySelector("input");
      input.value = String(v);
      input.dispatchEvent(new Event("input"));
    }
    function pressSeg(seg, v) {
      seg.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", b.textContent === String(v) ? "true" : "false"); });
    }
    function applyPreset(p) {
      state.count = p.count;
      pressSeg(countSeg, p.count);
      setSlider(lamC, p.lambda);   // redraws
    }

    var stage = h("div", { class: "demo-stage" });
    var svg = svgEl("svg", { class: "dg is-wide", viewBox: "0 0 " + VW + " " + VH, role: "img", "aria-label": "Cascade splits seen from above, and the shadow texel size each cascade gives" });
    stage.appendChild(svg);
    root.appendChild(stage);

    var tableWrap = h("div", { class: "table-scroll" });
    root.appendChild(tableWrap);
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);
    var note = h("p", { class: "demo-hint" });
    root.appendChild(note);

    /* Static parts of the SVG. */
    var defs = svgEl("defs", null, svg);
    var clip = svgEl("clipPath", { id: "cs-ov-clip" }, defs);
    svgEl("rect", { x: OV.x, y: OV.y, width: OV.w, height: OV.h }, clip);
    var clipC = svgEl("clipPath", { id: "cs-ch-clip" }, defs);
    svgEl("rect", { x: CH.x0, y: CH.y1, width: CH.x1 - CH.x0, height: CH.y0 - CH.y1 }, clipC);

    svgEl("text", { x: OV.x, y: 18, class: "t-caps", text: "SEEN FROM ABOVE · SUN OVERHEAD" }, svg);
    svgEl("text", { x: OV.x, y: 33, class: "t-small t-muted", text: "Dashed squares: the ground each shadow map covers" }, svg);
    svgEl("text", { x: CH.x0, y: 18, class: "t-caps", text: "SHADOW TEXEL SIZE AT EACH DISTANCE" }, svg);
    svgEl("text", { x: CH.x0, y: 33, class: "t-small t-muted", text: "Both axes logarithmic, each grid line ×10 · rose dashes: one screen pixel" }, svg);

    // Chart frame, grid and axis labels.
    var chartBg = svgEl("g", null, svg);
    svgEl("rect", { x: CH.x0, y: CH.y1, width: CH.x1 - CH.x0, height: CH.y0 - CH.y1, class: "f-sunken" }, chartBg);
    [1, 10, 100, 1000].forEach(function (z) {
      svgEl("line", { x1: cx(z), y1: CH.y1, x2: cx(z), y2: CH.y0, class: "s-line" }, chartBg);
      svgEl("text", { x: cx(z), y: CH.y0 + 15, class: "t-small t-muted mid", text: z >= 1000 ? "1 km" : z + " m" }, chartBg);
    });
    [[0.001, "0.1 cm"], [0.01, "1 cm"], [0.1, "10 cm"], [1, "1 m"]].forEach(function (t) {
      svgEl("line", { x1: CH.x0, y1: cy(t[0]), x2: CH.x1, y2: cy(t[0]), class: "s-line" }, chartBg);
      svgEl("text", { x: CH.x0 - 6, y: cy(t[0]) + 4, class: "t-small t-muted end", text: t[1] }, chartBg);
    });
    svgEl("text", { x: (CH.x0 + CH.x1) / 2, y: CH.y0 + 32, class: "t-small t-muted mid", text: "distance from the camera" }, chartBg);
    svgEl("rect", { x: CH.x0, y: CH.y1, width: CH.x1 - CH.x0, height: CH.y0 - CH.y1, class: "s-strong" }, chartBg);
    // The screen pixel footprint: what one texel per pixel would need.
    svgEl("line", { x1: cx(DMIN), y1: cy(pixelFootprint(DMIN)), x2: cx(DMAX), y2: cy(pixelFootprint(DMAX)), class: "s-pix w2 dash", "clip-path": "url(#cs-ch-clip)" }, chartBg);

    var layerOv = svgEl("g", null, svg);
    var layerChart = svgEl("g", null, svg);

    function cell(label, value) {
      return h("span", { class: "r" }, [h("span", { class: "label", text: label }), h("span", { class: "v", text: value })]);
    }

    function draw() {
      var list = cascades(state.count, state.far, state.lambda, state.res);
      var far = state.far;

      /* Overview: the wedge and squares, scaled so the last square fits. */
      HB.svg.clear(layerOv);
      var last = list[list.length - 1];
      var extent = Math.max(last.centre + last.side / 2, last.side) * 1.04;  // metres across the panel
      var k = OV.w / extent;
      var ox = OV.x + 6, oy = OV.y + OV.h / 2;
      function px(z) { return ox + z * k; }
      function py(y) { return oy - y * k; }
      svgEl("rect", { x: OV.x, y: OV.y, width: OV.w, height: OV.h, class: "f-sunken" }, layerOv);
      var g = svgEl("g", { "clip-path": "url(#cs-ov-clip)" }, layerOv);
      // Squares first (largest first) so smaller ones stay visible on top.
      for (var i = list.length - 1; i >= 0; i--) {
        var c = list[i];
        svgEl("rect", { x: px(c.centre - c.side / 2), y: py(c.side / 2), width: Math.max(1.5, c.side * k), height: Math.max(1.5, c.side * k), class: "s-acc dash" }, g);
      }
      // Slices of the wedge, one tint per cascade.
      list.forEach(function (c) {
        var z0 = c.z0, z1 = c.z1;
        var pts = [[z0, z0 * TAN_HALF], [z1, z1 * TAN_HALF], [z1, -z1 * TAN_HALF], [z0, -z0 * TAN_HALF]];
        svgEl("polygon", { points: pts.map(function (p) { return px(p[0]).toFixed(1) + "," + py(p[1]).toFixed(1); }).join(" "), class: "f-acc", "fill-opacity": OPAC[c.index] }, g);
      });
      // Wedge outline and the camera.
      svgEl("path", { d: "M" + px(0) + "," + py(0) + " L" + px(far) + "," + py(far) + " M" + px(0) + "," + py(0) + " L" + px(far) + "," + py(-far), class: "s-ink" }, g);
      svgEl("circle", { cx: px(0), cy: py(0), r: 4, class: "f-ink" }, layerOv);
      svgEl("text", { x: OV.x + 4, y: OV.y + OV.h - 8, class: "t-small t-muted", text: "camera at the left edge · panel " + metres(extent) + " across" }, layerOv);
      svgEl("rect", { x: OV.x, y: OV.y, width: OV.w, height: OV.h, class: "s-strong" }, layerOv);
      // Label each cascade where it is wide enough, else with a leader.
      list.forEach(function (c) {
        var mid = (c.z0 + c.z1) / 2;
        var w = (c.z1 - c.z0) * k;
        var lx = px(mid), ly = py(0) + 4;
        if (w > 16) {
          svgEl("text", { x: lx, y: ly, class: "t-small t-strong mid", text: String(c.index + 1) }, layerOv);
        } else {
          var tx = OV.x + 30 + c.index * 22, ty = OV.y + 18;
          svgEl("line", { x1: lx, y1: py(0) - 2, x2: tx, y2: ty + 3, class: "s-muted" }, layerOv);
          svgEl("text", { x: tx, y: ty, class: "t-small t-strong mid", text: String(c.index + 1) }, layerOv);
        }
      });

      /* Chart: texel size per cascade, as steps over its distance range. */
      HB.svg.clear(layerChart);
      var cg = svgEl("g", { "clip-path": "url(#cs-ch-clip)" }, layerChart);
      // One map stretched over the whole distance, for comparison.
      var single = enclosing(NEAR, far);
      var singleT = 2 * single.r / state.res;
      if (state.count > 1) {
        svgEl("line", { x1: cx(NEAR), y1: cy(singleT), x2: cx(far), y2: cy(singleT), class: "s-muted dash" }, cg);
        svgEl("text", { x: cx(NEAR) + 6, y: cy(singleT) - 6, class: "t-small t-muted", text: "one map for the whole distance: " + cm(singleT) }, cg);
      }
      list.forEach(function (c) {
        var xa = cx(c.z0), xb = cx(c.z1), y = cy(c.texel);
        svgEl("rect", { x: xa, y: y, width: Math.max(1, xb - xa), height: CH.y0 - y, class: "f-acc", "fill-opacity": OPAC[c.index] }, cg);
        svgEl("line", { x1: xa, y1: y, x2: xb, y2: y, class: "s-acc w3" }, cg);
        if (xb - xa > 26) svgEl("text", { x: (xa + xb) / 2, y: y - 6, class: "t-small t-acc t-strong mid", text: String(c.index + 1) }, cg);
      });
      // Past the shadow distance there are no shadows at all.
      svgEl("rect", { x: cx(far), y: CH.y1, width: CH.x1 - cx(far), height: CH.y0 - CH.y1, class: "f-surface", "fill-opacity": 0.75 }, cg);
      if (CH.x1 - cx(far) > 46) svgEl("text", { x: (cx(far) + CH.x1) / 2, y: CH.y1 + 20, class: "t-small t-muted mid", text: "no shadows" }, cg);
      svgEl("line", { x1: cx(far), y1: CH.y1, x2: cx(far), y2: CH.y0, class: "s-ink" }, cg);
      svgEl("line", { x1: cx(NEAR_PROBE), y1: CH.y1, x2: cx(NEAR_PROBE), y2: CH.y0, class: "s-muted dot-dash" }, cg);
      svgEl("text", { x: cx(NEAR_PROBE) + 4, y: CH.y0 - 6, class: "t-small t-muted", text: "2 m" }, cg);

      /* Table of cascades. */
      var head = h("tr", null, ["Cascade", "From", "To", "Map covers", "Texel", "Texels per m"].map(function (t) { return h("th", { scope: "col", text: t }); }));
      var body = h("tbody", null, list.map(function (c) {
        return h("tr", null, [
          h("td", { text: String(c.index + 1) }),
          h("td", { text: metres(c.z0) }),
          h("td", { text: metres(c.z1) }),
          h("td", { text: metres(c.side) + " square" }),
          h("td", { text: cm(c.texel) }),
          h("td", { text: perM(c.perMetre) })
        ]);
      }));
      tableWrap.replaceChildren(h("table", { class: "byte-table" }, [h("thead", null, [head]), body]));

      /* Readouts. */
      var nearC = cascadeAt(list, NEAR_PROBE) || list[0];
      var farC = last;
      var needNear = 1 / pixelFootprint(NEAR_PROBE);
      var needFar = 1 / pixelFootprint(far);
      var mb = state.count * state.res * state.res * 2 / (1024 * 1024);
      readout.replaceChildren(
        cell("Near, at 2 m", perM(nearC.perMetre) + " texels/m"),
        cell("Screen needs at 2 m", perM(needNear) + " /m"),
        cell("Far, at " + metres(far), perM(farC.perMetre) + " texels/m"),
        cell("Screen needs there", perM(needFar) + " /m"),
        cell("Shadow renders", String(state.count) + " · " + (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB at 16-bit")
      );

      var ratioNear = needNear / nearC.perMetre;
      var msg;
      if (state.count === 1) {
        msg = "One map for the whole view: every texel is " + cm(nearC.texel) + " wide. At 2 m that one texel covers about " + Math.round(ratioNear) + " screen pixels, so shadows near the camera are blocky, while far away the map has more detail than the screen can show.";
      } else if (state.lambda < 0.2) {
        msg = "Even splits: cascade 1 alone reaches " + metres(list[0].z1) + ", so near the camera a texel still covers about " + Math.round(ratioNear) + " screen pixels. The far cascades are short in proportion to their distance and give more detail than needed.";
      } else if (state.lambda > 0.9) {
        msg = "Logarithmic splits: each cascade reaches the same multiple further than the one before, so texels per screen pixel stay about the same everywhere. The price is a very short first cascade, " + metres(list[0].z1) + " here, which a character a few metres away has already left.";
      } else {
        msg = "A blend: the first cascade reaches " + metres(list[0].z1) + ", long enough for the character and nearby props, and the steps still follow the screen's need roughly. Near the camera a texel covers about " + Math.max(1, Math.round(ratioNear)) + " screen pixels.";
      }
      note.textContent = msg;
      svg.setAttribute("aria-label", state.count + " cascades over " + metres(far) + ". " + list.map(function (c) { return "Cascade " + (c.index + 1) + " from " + metres(c.z0) + " to " + metres(c.z1) + ", texels " + cm(c.texel); }).join("; ") + ".");
    }

    draw();
    log.debug("ready");
  }

  HB.demos.register("cascade-splits", init);
})();

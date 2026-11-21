/*
 * vertex-buffer-inspector.js: chapter 4.2's interactive.
 *
 * Shows one small mesh three ways at once: as triangles, as the rows of its
 * vertex buffer, and as the entries of its index buffer. Pointing at any of
 * them highlights the matching parts of the other two. The controls change
 * the layout and show what each choice does to memory:
 *
 *   mesh         quad, hexagon fan or 3x3 grid (different amounts of sharing)
 *   index buffer on: shared corners stored once; off: one row per corner
 *   precision    full (float32) or compact (16-bit and packed) attributes
 *   attributes   which optional attributes each vertex carries
 *   index size   16-bit or 32-bit indices
 *
 * All numbers are computed from the same formulas the chapter teaches:
 *   vertex buffer = rows x stride
 *   index buffer  = triangles x 3 x bytes per index
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("vb-inspector");
  var svgEl = HB.svg.el;
  var h = HB.html;

  /* ---------- Meshes (positions in -1..1, y up) ---------- */

  function hexagon() {
    var verts = [[0, 0]];
    var tris = [];
    for (var i = 0; i < 6; i++) {
      var a = (i * Math.PI) / 3;
      verts.push([Math.round(Math.cos(a) * 100) / 100, Math.round(Math.sin(a) * 100) / 100]);
      tris.push([0, i + 1, ((i + 1) % 6) + 1]);
    }
    return { name: "Hexagon fan", verts: verts, tris: tris };
  }

  function grid() {
    var verts = [];
    var tris = [];
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) verts.push([c - 1, r - 1]);
    }
    for (var qr = 0; qr < 2; qr++) {
      for (var qc = 0; qc < 2; qc++) {
        var a = qr * 3 + qc;
        tris.push([a, a + 1, a + 3], [a + 3, a + 1, a + 4]);
      }
    }
    return { name: "Grid", verts: verts, tris: tris };
  }

  var MESHES = {
    quad: { name: "Quad", verts: [[-1, -1], [1, -1], [-1, 1], [1, 1]], tris: [[0, 1, 2], [2, 1, 3]] },
    fan: hexagon(),
    grid: grid()
  };

  /* ---------- Attribute formats ---------- */

  var ATTRS = [
    { key: "pos", label: "position", cls: "a-pos", always: true,
      full: { bytes: 12, fmt: "3 × float32" }, compact: { bytes: 8, fmt: "4 × float16" } },
    { key: "nrm", label: "normal", cls: "a-nrm",
      full: { bytes: 12, fmt: "3 × float32" }, compact: { bytes: 4, fmt: "2 × snorm16" } },
    { key: "uv", label: "uv", cls: "a-uv",
      full: { bytes: 8, fmt: "2 × float32" }, compact: { bytes: 4, fmt: "2 × float16" } },
    { key: "col", label: "colour", cls: "a-col",
      full: { bytes: 4, fmt: "4 × unorm8" }, compact: { bytes: 4, fmt: "4 × unorm8" } }
  ];

  var COLOURS = [[255, 140, 0], [70, 80, 214], [11, 127, 116], [185, 47, 88], [240, 177, 77], [120, 130, 160], [60, 200, 180], [210, 90, 140], [90, 110, 250]];

  function n2(v) {
    var s = v.toFixed(2);
    return s === "-0.00" ? "0.00" : s;
  }

  function valueOf(attrKey, vIndex, xy) {
    if (attrKey === "pos") return n2(xy[0]) + ", " + n2(xy[1]) + ", 0";
    if (attrKey === "nrm") return "0, 0, 1";
    if (attrKey === "uv") return n2((xy[0] + 1) / 2) + ", " + n2((xy[1] + 1) / 2);
    var c = COLOURS[vIndex % COLOURS.length];
    return c[0] + ", " + c[1] + ", " + c[2] + ", 255";
  }

  /* ---------- Demo ---------- */

  function init(root) {
    var state = {
      mesh: "quad",
      indexed: true,
      precision: "full",
      use: { nrm: true, uv: true, col: false },
      indexBits: 16,
      pinned: { kind: "vertex", id: 1 },
      hover: null
    };

    function activeAttrs() {
      return ATTRS.filter(function (a) { return a.always || state.use[a.key]; });
    }

    function stride() {
      return activeAttrs().reduce(function (sum, a) { return sum + a[state.precision].bytes; }, 0);
    }

    /* Rows of the vertex buffer: unique vertices, or one per triangle corner. */
    function rows() {
      var mesh = MESHES[state.mesh];
      if (state.indexed) {
        return mesh.verts.map(function (xy, i) { return { v: i, tri: null, dupOf: null }; });
      }
      var out = [];
      var firstRow = {};
      mesh.tris.forEach(function (tri, t) {
        tri.forEach(function (v) {
          var row = out.length;
          out.push({ v: v, tri: t, dupOf: v in firstRow ? firstRow[v] : null });
          if (!(v in firstRow)) firstRow[v] = row;
        });
      });
      return out;
    }

    function hot() {
      return state.hover || state.pinned;
    }

    function rowIsHot(row, rowIndex) {
      var hh = hot();
      if (!hh) return false;
      if (hh.kind === "vertex") return row.v === hh.id;
      var tri = MESHES[state.mesh].tris[hh.id];
      if (state.indexed) return tri.indexOf(row.v) !== -1;
      return Math.floor(rowIndex / 3) === hh.id;
    }

    /* ---------- Static scaffold ---------- */

    root.replaceChildren();
    root.appendChild(h("div", { class: "demo-head" }, [
      h("span", { class: "label", text: "Interactive" }),
      h("span", { class: "demo-title", text: "Vertex buffer inspector" }),
      h("span", { class: "demo-hint", text: "Point at a corner, a triangle, a row or an index. Click to pin it." })
    ]));

    var controls = h("div", { class: "demo-controls" });
    controls.appendChild(HB.segmented("Mesh", [
      { value: "quad", label: "Quad" }, { value: "fan", label: "Hexagon fan" }, { value: "grid", label: "Grid" }
    ], state.mesh, function (v) {
      state.mesh = v;
      state.pinned = { kind: "vertex", id: v === "quad" ? 1 : v === "fan" ? 0 : 4 };
      render();
    }));
    controls.appendChild(HB.segmented("Index buffer", [
      { value: "on", label: "On" }, { value: "off", label: "Off" }
    ], "on", function (v) { state.indexed = v === "on"; render(); }));
    var bitsControl = HB.segmented("Index size", [
      { value: 16, label: "16-bit" }, { value: 32, label: "32-bit" }
    ], 16, function (v) { state.indexBits = v; render(); });
    controls.appendChild(bitsControl);
    controls.appendChild(HB.segmented("Precision", [
      { value: "full", label: "Full" }, { value: "compact", label: "Compact" }
    ], "full", function (v) { state.precision = v; render(); }));

    var checks = h("div", { class: "checks" });
    [["nrm", "Normal"], ["uv", "UV"], ["col", "Colour"]].forEach(function (pair, i) {
      var id = "vbi-attr-" + pair[0] + "-" + i;
      var box = h("input", { type: "checkbox", id: id, checked: state.use[pair[0]] });
      box.addEventListener("change", function () { state.use[pair[0]] = box.checked; render(); });
      checks.appendChild(h("label", { for: id }, [box, pair[1]]));
    });
    controls.appendChild(h("div", { class: "control" }, [h("span", { class: "label", text: "Attributes" }), checks]));
    root.appendChild(controls);

    var panels = h("div", { class: "demo-panels is-split" });
    var meshPanel = h("div", { class: "demo-panel" });
    var dataPanel = h("div", { class: "demo-panel" });
    panels.appendChild(meshPanel);
    panels.appendChild(dataPanel);
    root.appendChild(panels);

    var meshSvg = svgEl("svg", { class: "dg", viewBox: "0 0 260 268", role: "group", "aria-label": "Mesh: select a corner or a triangle" });
    meshPanel.appendChild(h("span", { class: "label", text: "Mesh" }));
    meshPanel.appendChild(meshSvg);

    var strideHead = h("p", { class: "label" });
    var strideBar = h("div", { class: "stride-bar", "aria-hidden": "true" });
    var legend = h("div", { class: "legend-row" });
    var vbLabel = h("span", { class: "label" });
    var tableWrap = h("div", { class: "table-scroll" });
    var ibLabel = h("span", { class: "label" });
    var ibStrip = h("div", { class: "index-strip" });
    dataPanel.append(strideHead, strideBar, legend, vbLabel, tableWrap, ibLabel, ibStrip);

    var memBars = h("div", { class: "mem-bars" });
    var readout = h("div", { class: "demo-readout", "aria-live": "polite" });
    var scaleNote = h("p", { class: "demo-hint" });
    root.append(memBars, readout, scaleNote);

    /* ---------- Interaction helpers ---------- */

    function bindHover(node, target) {
      node.addEventListener("pointerenter", function () { state.hover = target; paintHot(); });
      node.addEventListener("pointerleave", function () { state.hover = null; paintHot(); });
      node.addEventListener("focus", function () { state.hover = target; paintHot(); });
      node.addEventListener("blur", function () { state.hover = null; paintHot(); });
      node.addEventListener("click", function () {
        var same = state.pinned && state.pinned.kind === target.kind && state.pinned.id === target.id;
        state.pinned = same ? null : target;
        paintHot();
      });
      node.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          node.dispatchEvent(new MouseEvent("click"));
        }
      });
    }

    /* Elements that light up, collected on each render. */
    var hotTargets = [];

    function paintHot() {
      var hh = hot();
      hotTargets.forEach(function (t) {
        var on = t.test(hh);
        if (t.kind === "class") t.node.classList.toggle("is-hot", on);
        else t.apply(on);
      });
    }

    /* ---------- Rendering ---------- */

    function renderMesh() {
      var mesh = MESHES[state.mesh];
      HB.svg.clear(meshSvg);
      var sx = function (x) { return 130 + x * 100; };
      var sy = function (y) { return 130 - y * 100; };

      mesh.tris.forEach(function (tri, t) {
        var pts = tri.map(function (v) { return sx(mesh.verts[v][0]) + "," + sy(mesh.verts[v][1]); }).join(" ");
        var g = svgEl("g", { role: "button", tabindex: "0", "aria-label": "Triangle " + String.fromCharCode(65 + t) + ": vertices " + tri.join(", ") }, meshSvg);
        var poly = svgEl("polygon", { points: pts, class: "f-surface s-strong" }, g);
        var cx = (sx(mesh.verts[tri[0]][0]) + sx(mesh.verts[tri[1]][0]) + sx(mesh.verts[tri[2]][0])) / 3;
        var cy = (sy(mesh.verts[tri[0]][1]) + sy(mesh.verts[tri[1]][1]) + sy(mesh.verts[tri[2]][1])) / 3;
        svgEl("text", { x: cx, y: cy + 4, class: "t-mono t-muted mid", text: String.fromCharCode(65 + t) }, g);
        bindHover(g, { kind: "tri", id: t });
        hotTargets.push({
          kind: "fn",
          test: function (hh) {
            if (!hh) return false;
            if (hh.kind === "tri") return hh.id === t;
            return false;
          },
          apply: function (on) { poly.setAttribute("class", on ? "f-acc-soft s-acc" : "f-surface s-strong"); }
        });
      });

      mesh.verts.forEach(function (xy, v) {
        var g = svgEl("g", { role: "button", tabindex: "0", "aria-label": "Vertex " + v }, meshSvg);
        var ring = svgEl("circle", { cx: sx(xy[0]), cy: sy(xy[1]), r: 11, class: "f-surface s-strong hit-ring" }, g);
        var dot = svgEl("circle", { cx: sx(xy[0]), cy: sy(xy[1]), r: 4.5, class: "f-ink" }, g);
        var lx = sx(xy[0]) + (xy[0] < 0 ? -16 : xy[0] > 0 ? 16 : 0);
        var ly = sy(xy[1]) + (xy[1] > 0 ? -14 : xy[1] < 0 ? 22 : (xy[0] === 0 ? -14 : 4));
        var label = svgEl("text", { x: lx, y: ly, class: "t-mono mid", text: String(v) }, g);
        bindHover(g, { kind: "vertex", id: v });
        hotTargets.push({
          kind: "fn",
          test: function (hh) {
            if (!hh) return false;
            if (hh.kind === "vertex") return hh.id === v;
            return mesh.tris[hh.id].indexOf(v) !== -1;
          },
          apply: function (on) {
            dot.setAttribute("class", on ? "f-acc" : "f-ink");
            ring.setAttribute("class", on ? "f-acc-soft s-acc hit-ring" : "f-surface s-strong hit-ring");
            label.setAttribute("class", on ? "t-mono t-acc t-strong mid" : "t-mono mid");
          }
        });
      });
    }

    function renderData() {
      var mesh = MESHES[state.mesh];
      var attrs = activeAttrs();
      var size = stride();
      var list = rows();

      strideHead.textContent = "One vertex = " + size + " bytes (the stride)";
      strideBar.replaceChildren();
      legend.replaceChildren();
      var offset = 0;
      attrs.forEach(function (a) {
        var bytes = a[state.precision].bytes;
        strideBar.appendChild(h("span", { class: "seg-attr " + a.cls, style: "flex:" + bytes, text: a.label + " " + bytes }));
        legend.appendChild(h("span", null, [
          h("span", { class: "sw " + a.cls, style: "background: var(--" + (a.cls === "a-pos" ? "geo" : a.cls === "a-nrm" ? "accent" : a.cls === "a-uv" ? "lit" : "pix") + "-soft)" }),
          a.label + ": " + a[state.precision].fmt + ", bytes " + offset + "–" + (offset + bytes - 1)
        ]));
        offset += bytes;
      });

      vbLabel.textContent = "Vertex buffer: " + list.length + " rows × " + size + " B";
      var table = h("table", { class: "byte-table" });
      var headRow = h("tr", null, [h("th", { text: "row" })]);
      attrs.forEach(function (a) { headRow.appendChild(h("th", { text: a.label })); });
      headRow.appendChild(h("th", { text: "bytes" }));
      if (!state.indexed) headRow.appendChild(h("th", { text: "" }));
      table.appendChild(h("thead", null, [headRow]));
      var tbody = h("tbody");
      list.forEach(function (row, i) {
        var tr = h("tr", { tabindex: "0", "aria-label": "Row " + i + ", vertex " + row.v });
        tr.appendChild(h("td", { text: String(i) }));
        attrs.forEach(function (a) { tr.appendChild(h("td", { text: valueOf(a.key, row.v, mesh.verts[row.v]) })); });
        tr.appendChild(h("td", { text: i * size + "–" + ((i + 1) * size - 1) }));
        if (!state.indexed) {
          tr.appendChild(h("td", { class: "dup-note", text: row.dupOf === null ? "" : "copy of row " + row.dupOf }));
          if (row.dupOf !== null) tr.classList.add("is-dup");
        }
        bindHover(tr, { kind: "vertex", id: row.v });
        hotTargets.push({ kind: "class", node: tr, test: function () { return rowIsHot(row, i); } });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tableWrap.replaceChildren(table);

      ibStrip.replaceChildren();
      if (state.indexed) {
        ibLabel.textContent = "Index buffer: " + mesh.tris.length * 3 + " indices × " + state.indexBits / 8 + " B";
        mesh.tris.forEach(function (tri, t) {
          var btn = h("button", { type: "button", class: "index-tri", "aria-label": "Triangle " + String.fromCharCode(65 + t) + ": rows " + tri.join(", ") }, [
            h("span", { class: "tri-name", text: String.fromCharCode(65 + t) })
          ]);
          tri.forEach(function (v) {
            var cell = h("span", { text: String(v) });
            btn.appendChild(cell);
            hotTargets.push({ kind: "class", node: cell, test: function (hh) { return !!hh && hh.kind === "vertex" && hh.id === v; } });
          });
          bindHover(btn, { kind: "tri", id: t });
          hotTargets.push({ kind: "class", node: btn, test: function (hh) { return !!hh && hh.kind === "tri" && hh.id === t; } });
          ibStrip.appendChild(btn);
        });
      } else {
        ibLabel.textContent = "No index buffer";
        ibStrip.appendChild(h("p", { class: "demo-hint", text: "The GPU reads rows 0, 1, 2 for triangle A, rows 3, 4, 5 for triangle B, and so on. Every shared corner is stored again." }));
      }
    }

    function renderMemory() {
      var mesh = MESHES[state.mesh];
      var size = stride();
      var corners = mesh.tris.length * 3;
      var ib = corners * (state.indexBits / 8);
      var indexedTotal = mesh.verts.length * size + ib;
      var flatTotal = corners * size;
      var max = Math.max(indexedTotal, flatTotal);

      function bar(label, vbBytes, ibBytes, isCurrent) {
        var track = h("div", { class: "track" }, [
          h("span", { class: "fill-v", style: "width:" + (100 * vbBytes / max).toFixed(2) + "%" }),
          h("span", { class: "fill-i", style: "width:" + (100 * ibBytes / max).toFixed(2) + "%" })
        ]);
        return h("div", { class: "mem-bar" }, [
          h("span", { text: label + (isCurrent ? " (shown)" : "") }),
          track,
          h("span", { class: "bytes", text: HB.fmt.bytes(vbBytes + ibBytes) })
        ]);
      }
      memBars.replaceChildren(
        bar("With index buffer", mesh.verts.length * size, ib, state.indexed),
        bar("Without", flatTotal, 0, !state.indexed),
        h("div", { class: "legend-row" }, [
          h("span", null, [h("span", { class: "sw", style: "background: var(--geo)" }), "vertex buffer"]),
          h("span", null, [h("span", { class: "sw", style: "background: var(--accent)" }), "index buffer"])
        ])
      );

      var saving = Math.round(100 * (1 - indexedTotal / flatTotal));
      readout.replaceChildren(
        h("span", { class: "r" }, [h("span", { class: "label", text: "Stride" }), h("span", { class: "v", text: size + " B" })]),
        h("span", { class: "r" }, [h("span", { class: "label", text: "Unique corners" }), h("span", { class: "v", text: String(mesh.verts.length) })]),
        h("span", { class: "r" }, [h("span", { class: "label", text: "Triangle corners" }), h("span", { class: "v", text: String(corners) })]),
        h("span", { class: "r" }, [h("span", { class: "label", text: "Index buffer saves" }), h("span", { class: "v", text: saving + "%" })])
      );

      // Same layout on a realistic mesh: 50,000 triangles, ~30,000 unique vertices.
      var bigTris = 50000;
      var bigVerts = 30000;
      var bigWith = bigVerts * size + bigTris * 3 * (state.indexBits / 8);
      var bigWithout = bigTris * 3 * size;
      scaleNote.textContent = "The same layout on a 50,000-triangle character with about 30,000 unique vertices: " +
        HB.fmt.bytes(bigWith) + " with an index buffer, " + HB.fmt.bytes(bigWithout) + " without.";
    }

    function render() {
      hotTargets = [];
      bitsControl.querySelectorAll("button").forEach(function (b) { b.disabled = !state.indexed; });
      renderMesh();
      renderData();
      renderMemory();
      paintHot();
      log.debug("render", state.mesh, state.indexed ? "indexed" : "flat", stride() + "B");
    }

    render();
  }

  HB.demos.register("vertex-buffer-inspector", init);
})();

/*
 * kit.js: shared helpers for the handbook's interactive figures.
 *
 * Each interactive is one script that calls HB.demos.register(name, init).
 * The page marks where it goes with <div class="demo" data-demo="name">.
 * register() finds every such element and runs init(element) inside a
 * try/catch, so one broken demo never breaks the page; the figure caption
 * still explains the idea.
 *
 * Interactives that are vector diagrams (most of them) build SVG with
 * HB.svg.el and style it with the classes in diagrams.css, so they follow
 * the theme with no extra code. Per-pixel demos would use a canvas and read
 * colours with HB.demos.color(), redrawing on the "hb:themechange" event.
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var log = HB.log.scope("demos");
  var SVG_NS = "http://www.w3.org/2000/svg";

  /* ---------- SVG building ---------- */

  HB.svg = {
    /* el("circle", { cx: 4, class: "f-acc" }, parent) -> the new element */
    el: function (tag, attrs, parent) {
      var node = document.createElementNS(SVG_NS, tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (key) {
          var value = attrs[key];
          if (value === null || value === undefined || value === false) return;
          if (key === "text") node.textContent = value;
          else node.setAttribute(key, String(value));
        });
      }
      if (parent) parent.appendChild(node);
      return node;
    },
    clear: function (node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    },
    /* Client (mouse) coordinates -> the SVG's own viewBox coordinates. */
    toLocal: function (svg, clientX, clientY) {
      var pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      var ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      var local = pt.matrixTransform(ctm.inverse());
      return { x: local.x, y: local.y };
    }
  };

  /* ---------- HTML building ---------- */

  HB.html = function (tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === "text") node.textContent = value;
        else if (value === true) node.setAttribute(key, "");
        else node.setAttribute(key, String(value));
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined) return;
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return node;
  };

  /* A row of toggle buttons where exactly one is pressed.
     options: [{ value, label }]; onChange(value) runs on every change. */
  HB.segmented = function (label, options, initial, onChange) {
    var group = HB.html("div", { class: "seg", role: "group", "aria-label": label });
    var buttons = options.map(function (opt) {
      var b = HB.html("button", { type: "button", "aria-pressed": opt.value === initial ? "true" : "false", text: opt.label });
      b.addEventListener("click", function () {
        buttons.forEach(function (other) { other.setAttribute("aria-pressed", other === b ? "true" : "false"); });
        onChange(opt.value);
      });
      group.appendChild(b);
      return b;
    });
    return HB.html("div", { class: "control" }, [HB.html("span", { class: "label", text: label }), group]);
  };

  /* A labelled range slider that shows its value. format(value) -> text. */
  HB.slider = function (id, label, opts, onChange) {
    var input = HB.html("input", { type: "range", id: id, min: opts.min, max: opts.max, step: opts.step, value: opts.value });
    var out = HB.html("output", { class: "value", for: id });
    var fmt = opts.format || String;
    function sync() {
      out.textContent = fmt(Number(input.value));
    }
    input.addEventListener("input", function () {
      sync();
      onChange(Number(input.value));
    });
    sync();
    return HB.html("div", { class: "control" }, [
      HB.html("label", { class: "label", for: id, text: label }),
      HB.html("div", { style: "display:flex;gap:.6rem;align-items:center" }, [input, out])
    ]);
  };

  /* ---------- Dragging ---------- */

  /*
   * Makes an SVG element draggable with pointer or keyboard.
   *   svg     the root <svg> (for coordinate conversion)
   *   handle  the element to grab; gets tabindex and role="slider"
   *   opts.onDrag(localPoint)        pointer moves, in viewBox units
   *   opts.onKey(direction, big)     arrow keys: -1 or +1, Shift = big step
   */
  HB.draggable = function (svg, handle, opts) {
    handle.classList.add("handle");
    handle.setAttribute("tabindex", "0");
    handle.setAttribute("role", "slider");
    var dragging = false;

    handle.addEventListener("pointerdown", function (event) {
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      opts.onDrag(HB.svg.toLocal(svg, event.clientX, event.clientY));
    });
    function stop(event) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(event.pointerId); } catch (err) { /* already released */ }
    }
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("keydown", function (event) {
      var dir = 0;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") dir = -1;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") dir = 1;
      if (!dir || !opts.onKey) return;
      event.preventDefault();
      opts.onKey(dir, event.shiftKey);
    });
  };

  /* ---------- Numbers ---------- */

  /* Deterministic pseudo-random numbers (mulberry32), so a demo shows the
     same "random" samples every time it loads. */
  HB.rng = function (seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  HB.fmt = {
    int: function (n) {
      return Math.round(n).toLocaleString("en-GB");
    },
    bytes: function (n) {
      if (n < 1024) return Math.round(n).toLocaleString("en-GB") + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 2 : 1) + " KB";
      return (n / (1024 * 1024)).toFixed(2) + " MB";
    },
    fixed: function (n, digits) {
      return Number(n).toFixed(digits);
    }
  };

  /* ---------- Registration ---------- */

  function fail(el, name, err) {
    log.error("demo failed to start:", name, err);
    el.replaceChildren(HB.html("p", {
      class: "demo-failed",
      text: "This interactive could not start in your browser. The caption below describes what it shows."
    }));
  }

  HB.demos = {
    register: function (name, init) {
      var nodes = document.querySelectorAll('[data-demo="' + name + '"]');
      if (!nodes.length) log.warn("no element for demo", name);
      nodes.forEach(function (el) {
        try {
          init(el);
          el.setAttribute("data-demo-ready", "");
          log.debug("demo ready", name);
        } catch (err) {
          fail(el, name, err);
        }
      });
    },
    /* Read a theme token's current value, for canvas drawing. */
    color: function (token) {
      return getComputedStyle(document.documentElement).getPropertyValue("--" + token).trim();
    },
    reducedMotion: function () {
      return window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
    }
  };
})();

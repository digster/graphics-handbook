/*
 * home.js: the home page's live parts. Renders the full contents from
 * data/nav.js with a filter (all, core path, written), fills the counts in
 * the hero, and points the start button at the first written chapter.
 *
 * Needs demos/kit.js loaded first, for HB.html and HB.segmented.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("home");
  var nav = HB.nav;
  var h = HB.html;

  var published = nav.chapters.filter(function (c) { return c.status === "published"; });

  /* Counts in the hero always match the data. */
  var counts = {
    parts: nav.parts.length,
    chapters: nav.chapters.length,
    published: published.length,
    core: nav.chapters.filter(function (c) { return c.core; }).length
  };
  document.querySelectorAll("[data-count]").forEach(function (el) {
    var key = el.getAttribute("data-count");
    if (key in counts) el.textContent = counts[key];
  });

  var start = document.getElementById("start-link");
  if (start && published[0]) {
    start.href = published[0].file;
    start.textContent = "Start with " + published[0].num + " " + published[0].title;
  }

  var list = document.getElementById("contents-list");
  var filterRow = document.getElementById("contents-filter");
  if (!list) return;

  var FILTERS = [
    { value: "all", label: "All chapters" },
    { value: "core", label: "Core path" },
    { value: "written", label: "Written so far" }
  ];
  var active = "all";
  try {
    var saved = window.localStorage.getItem("hb.contentsFilter");
    if (saved && FILTERS.some(function (f) { return f.value === saved; })) active = saved;
  } catch (err) {
    /* Storage blocked: start with all chapters. */
  }

  function keep(ch) {
    if (active === "core") return ch.core;
    if (active === "written") return ch.status === "published";
    return true;
  }

  function render() {
    list.replaceChildren();
    nav.parts.forEach(function (part) {
      var chapters = part.chapters.filter(keep);
      if (!chapters.length) return;
      var written = part.chapters.filter(function (c) { return c.status === "published"; }).length;
      var block = h("div", { class: "contents-part" }, [
        h("div", { class: "contents-part-head" }, [
          h("h3", { text: "Part " + part.n + " · " + part.title }),
          h("span", { class: "label", text: written + " of " + part.chapters.length + " written" }),
          h("p", { text: part.blurb })
        ])
      ]);
      chapters.forEach(function (ch) {
        var isWritten = ch.status === "published";
        var title = isWritten ? h("a", { href: ch.file, text: ch.title }) : document.createTextNode(ch.title);
        var flags = h("div", { class: "flags" });
        if (isWritten) flags.appendChild(h("span", { class: "tag is-ready", text: "Read now" }));
        if (ch.core) flags.appendChild(h("span", { class: "tag is-core", text: "Core" }));
        block.appendChild(h("div", { class: "contents-ch", id: "ch-" + ch.num.replace(".", "-") }, [
          h("span", { class: "n", text: ch.num }),
          h("span", { class: "t" }, [title]),
          flags,
          h("span", { class: "terms", text: ch.terms })
        ]));
      });
      list.appendChild(block);
    });
  }

  if (filterRow) {
    filterRow.appendChild(HB.segmented("Show", FILTERS, active, function (value) {
      active = value;
      try { window.localStorage.setItem("hb.contentsFilter", value); } catch (err) { /* optional */ }
      render();
    }));
  }

  render();

  /* A link like index.html#ch-8-5 (a chapter not written yet) targets a row
     that only exists after rendering, so scroll to it now. */
  if (window.location.hash.indexOf("#ch-") === 0) {
    if (active !== "all") {
      active = "all";
      render();
    }
    var target = document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView({ block: "center" });
  }
  log.debug("contents rendered", counts);
})();

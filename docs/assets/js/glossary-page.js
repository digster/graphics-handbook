/*
 * glossary-page.js: renders glossary.html from data/glossary.js, grouped by
 * first letter, with a live filter. Entry ids match the glossary keys, so
 * links like glossary.html#stride land on the right entry.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("glossary");
  var nav = HB.nav;
  var glossary = HB.glossary || {};
  var list = document.getElementById("glossary-list");
  var filter = document.getElementById("glossary-filter");
  var countEl = document.getElementById("glossary-count");
  if (!list) return;

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (kids || []).forEach(function (kid) {
      if (kid) node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  var entries = Object.keys(glossary).map(function (id) {
    var g = glossary[id];
    return {
      id: id,
      g: g,
      haystack: [g.term].concat(g.aka || []).concat([g.def]).join(" ").toLowerCase()
    };
  }).sort(function (a, b) {
    return a.g.term.localeCompare(b.g.term, "en", { sensitivity: "base" });
  });

  function letterOf(term) {
    var c = term.charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : "#";
  }

  function whereNode(g) {
    var ch = nav.byNum(g.ch);
    if (!ch) return null;
    var label = ch.num + " " + ch.title;
    var link = ch.status === "published"
      ? el("a", { href: ch.file, text: label })
      : el("a", { href: nav.contentsHref(ch.num), text: label + " (not written yet)" });
    return el("span", { class: "where" }, ["Taught in ", link]);
  }

  /* Build every entry once; filtering only toggles visibility. */
  var groups = {};
  entries.forEach(function (entry) {
    var letter = letterOf(entry.g.term);
    if (!groups[letter]) {
      var dl = el("dl");
      var section = el("section", { class: "glossary-letter", "aria-label": "Terms starting with " + letter }, [el("h2", { text: letter }), dl]);
      groups[letter] = { section: section, dl: dl, rows: [] };
      list.appendChild(section);
    }
    var dt = el("dt", null, [entry.g.term]);
    if (entry.g.aka && entry.g.aka.length) dt.appendChild(el("span", { class: "aka", text: "Also: " + entry.g.aka.join(", ") }));
    var dd = el("dd", null, [el("span", { text: entry.g.def }), whereNode(entry.g)]);
    var row = el("div", { class: "g-entry", id: entry.id }, [dt, dd]);
    groups[letter].dl.appendChild(row);
    groups[letter].rows.push({ row: row, entry: entry });
  });

  function applyFilter() {
    var q = (filter && filter.value || "").trim().toLowerCase();
    var shown = 0;
    Object.keys(groups).forEach(function (letter) {
      var any = false;
      groups[letter].rows.forEach(function (r) {
        var match = !q || r.entry.haystack.indexOf(q) !== -1;
        r.row.hidden = !match;
        if (match) { any = true; shown++; }
      });
      groups[letter].section.hidden = !any;
    });
    if (countEl) countEl.textContent = shown === entries.length ? entries.length + " terms" : shown + " of " + entries.length + " terms";
  }

  if (filter) filter.addEventListener("input", applyFilter);
  applyFilter();

  if (window.location.hash) {
    var target = document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView({ block: "center" });
  }
  log.debug("glossary rendered", entries.length);
})();

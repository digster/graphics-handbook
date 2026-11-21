/*
 * acronyms-page.js: renders acronyms.html from data/glossary.js.
 *
 * An acronym is any glossary term or alias written in capitals (GTAO, LOD,
 * VRAM, HBAO+). Each is paired with its spelled-out form: the entry's term
 * when the acronym is an alias, or its first non-acronym alias when the term
 * itself is the acronym. Nothing is maintained by hand: add a term with an
 * acronym to the glossary and it appears here.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("acronyms");
  var nav = HB.nav;
  var glossary = HB.glossary || {};
  var list = document.getElementById("acronym-list");
  var filter = document.getElementById("acronym-filter");
  var countEl = document.getElementById("acronym-count");
  if (!list) return;

  /* Capitals and digits, optionally with + or -, 2 to 10 characters. */
  var ACRONYM = /^[A-Z][A-Z0-9+-]{1,9}$/;

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

  /* True when the acronym's letters appear, in order, in the name, starting
     with its first letter: "GTSO" fits "ground-truth specular occlusion",
     "CW" fits "clockwise". */
  function spellsOut(acronym, name) {
    var letters = acronym.toLowerCase().replace(/[^a-z0-9]/g, "");
    var text = name.toLowerCase();
    if (text.charAt(0) !== letters.charAt(0)) return false;
    var at = 0;
    for (var i = 0; i < letters.length; i++) {
      at = text.indexOf(letters.charAt(i), at);
      if (at === -1) return false;
      at++;
    }
    return true;
  }

  var rows = [];
  var seen = {};
  Object.keys(glossary).forEach(function (id) {
    var g = glossary[id];
    var names = [g.term].concat(g.aka || []);
    var words = names.filter(function (n) { return !ACRONYM.test(n); });
    names.forEach(function (name) {
      if (!ACRONYM.test(name) || seen[name + "|" + id]) return;
      seen[name + "|" + id] = true;
      var spelled = words.filter(function (w) { return spellsOut(name, w); })[0] || words[0] || g.term;
      rows.push({ acronym: name, spelled: spelled, id: id, g: g });
    });
  });
  rows.sort(function (a, b) { return a.acronym.localeCompare(b.acronym, "en"); });

  var dl = el("dl");
  var section = el("section", { class: "glossary-letter", "aria-label": "Acronyms" }, [dl]);
  list.appendChild(section);
  rows.forEach(function (r) {
    var ch = nav.byNum(r.g.ch);
    var where = ch
      ? el("span", { class: "where" }, ["Taught in ", el("a", { href: ch.status === "published" ? ch.file : nav.contentsHref(ch.num), text: ch.num + " " + ch.title + (ch.status === "published" ? "" : " (not written yet)") })])
      : null;
    var dt = el("dt", null, [r.acronym, el("span", { class: "aka", text: r.spelled })]);
    var dd = el("dd", null, [el("span", { text: r.g.def }), el("span", { class: "where" }, [el("a", { href: "glossary.html#" + r.id, text: "Glossary entry" })]), where]);
    r.row = el("div", { class: "g-entry", id: "acr-" + r.acronym.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + r.id }, [dt, dd]);
    r.haystack = (r.acronym + " " + r.spelled + " " + r.g.def).toLowerCase();
    dl.appendChild(r.row);
  });

  function applyFilter() {
    var q = ((filter && filter.value) || "").trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (r) {
      var match = !q || r.haystack.indexOf(q) !== -1;
      r.row.hidden = !match;
      if (match) shown++;
    });
    if (countEl) countEl.textContent = shown === rows.length ? rows.length + " acronyms" : shown + " of " + rows.length + " acronyms";
  }

  if (filter) filter.addEventListener("input", applyFilter);
  applyFilter();
  log.debug("acronyms rendered", rows.length);
})();

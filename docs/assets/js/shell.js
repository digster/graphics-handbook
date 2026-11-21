/*
 * shell.js: builds the chrome around every page and wires shared behaviour.
 *
 * Pages ship their own content as static HTML. This script adds what is the
 * same everywhere, generated from data/nav.js and data/glossary.js so the
 * book has one source of truth:
 *
 *   header tools   contents button (narrow screens), search, progress, theme
 *   sidebar        the book's chapter list (#sidebar)
 *   rail           "on this page" and the chapter's new terms (#rail)
 *   pager          previous / next written chapter (#pager)
 *   footer         status line (#site-footer)
 *   term cards     hover or focus any .term to see its glossary definition
 *   cross-refs     a.xref[data-ch] become links, or muted if not written yet
 *   copy buttons   on every .prompt brief
 *   progress       a chapter counts as read once its last beat is reached
 *
 * Everything here is a classic script (no modules, no fetch) so the site
 * works when opened straight from disk. It degrades to plain readable pages
 * without JavaScript.
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});
  var log = HB.log.scope("shell");
  var nav = HB.nav;
  var glossary = HB.glossary || {};

  if (!nav) {
    log.error("data/nav.js did not load; the page will render without navigation.");
    return;
  }

  var pageId = document.body.getAttribute("data-page") || "";
  var current = nav.byNum(pageId);
  var publishedChapters = nav.chapters.filter(function (c) { return c.status === "published"; });

  /* ---------- Small utilities ---------- */

  /* localStorage can throw (blocked storage, some file:// setups). Reading or
     writing is always optional: the page must work without it. */
  var store = {
    get: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        log.debug("storage unavailable; not saving", key);
      }
    }
  };
  HB.store = store;

  /* h("a", { class: "x", href: "#" }, ["text", childNode]) */
  function h(tag, attrs, kids) {
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
  }

  /* Static, trusted icon markup only. Never pass page or user data here. */
  var ICONS = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'
  };

  function icon(name) {
    var tpl = document.createElement("template");
    // width/height attributes keep the icon small even where no CSS sizes it.
    tpl.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' + ICONS[name] + "</svg>";
    return tpl.content.firstChild;
  }

  function chapterLabel(ch) {
    return ch.num + " " + ch.title;
  }

  /* ---------- Theme ---------- */

  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function effectiveTheme() {
    var explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "light" || explicit === "dark") return explicit;
    return darkQuery && darkQuery.matches ? "dark" : "light";
  }

  function buildThemeToggle() {
    var btn = h("button", { class: "icon-btn theme-toggle", type: "button" });
    function sync() {
      var theme = effectiveTheme();
      btn.replaceChildren(icon(theme === "dark" ? "sun" : "moon"));
      btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
      btn.title = btn.getAttribute("aria-label");
    }
    btn.addEventListener("click", function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      store.set("hb.theme", next);
      sync();
      document.dispatchEvent(new CustomEvent("hb:themechange", { detail: { theme: next } }));
      log.debug("theme", next);
    });
    if (darkQuery && darkQuery.addEventListener) {
      darkQuery.addEventListener("change", function () {
        sync();
        document.dispatchEvent(new CustomEvent("hb:themechange", { detail: { theme: effectiveTheme() } }));
      });
    }
    sync();
    return btn;
  }

  /* ---------- Reading progress ---------- */

  function readSet() {
    var list = store.get("hb.read", []);
    return Array.isArray(list) ? list : [];
  }

  function isRead(num) {
    return readSet().indexOf(num) !== -1;
  }

  var progressEl = null;

  function buildProgress() {
    progressEl = h("span", { class: "progress" });
    renderProgress();
    return progressEl;
  }

  function renderProgress() {
    if (!progressEl) return;
    var read = publishedChapters.filter(function (c) { return isRead(c.num); }).length;
    var total = publishedChapters.length;
    var circumference = 2 * Math.PI * 8;
    var filled = total ? (read / total) * circumference : 0;
    var tpl = document.createElement("template");
    tpl.innerHTML =
      '<svg viewBox="0 0 22 22" aria-hidden="true"><circle class="ring-bg" cx="11" cy="11" r="8"/>' +
      '<circle class="ring-fg" cx="11" cy="11" r="8" stroke-dasharray="' + filled.toFixed(2) + " " + circumference.toFixed(2) + '"/></svg>';
    progressEl.replaceChildren(tpl.content.firstChild, document.createTextNode(read + "/" + total));
    progressEl.title = read + " of " + total + " written chapters read";
    progressEl.setAttribute("aria-label", progressEl.title);
  }

  function watchCompletion() {
    if (!current) return;
    var target = document.getElementById("check");
    if (!target || !("IntersectionObserver" in window)) return;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var list = readSet();
        if (list.indexOf(current.num) === -1) {
          list.push(current.num);
          store.set("hb.read", list);
          log.info("marked read", current.num);
          renderProgress();
          refreshTocStates();
        }
        observer.disconnect();
      });
    }, { threshold: 0.15 });
    observer.observe(target);
  }

  /* ---------- Book contents (sidebar and mobile dialog) ---------- */

  var tocInstances = [];

  function buildBookToc() {
    var root = h("div", { class: "toc-book" });
    nav.parts.forEach(function (part) {
      var written = part.chapters.filter(function (c) { return c.status === "published"; }).length;
      var hasCurrent = current && current.part === part.n;
      var details = h("details", { open: hasCurrent || written > 0 });
      details.appendChild(h("summary", null, [
        h("span", { class: "part-name", text: "Part " + part.n + " · " + part.title }),
        h("span", { class: "part-count", text: written + "/" + part.chapters.length, title: written + " of " + part.chapters.length + " chapters written" })
      ]));
      var list = h("ol");
      part.chapters.forEach(function (ch) {
        var isCurrent = current && current.num === ch.num;
        var state = h("span", { class: "state", "data-state-for": ch.num });
        var row;
        if (ch.status === "published") {
          row = h("a", { class: "ch-link", href: ch.file, "aria-current": isCurrent ? "page" : null }, [
            h("span", { class: "n", text: ch.num }), h("span", { text: ch.title }), state
          ]);
        } else {
          row = h("span", { class: "ch-link is-planned", title: "Not written yet" }, [
            h("span", { class: "n", text: ch.num }), h("span", { text: ch.title }), h("span", { class: "state", text: "soon" })
          ]);
        }
        list.appendChild(h("li", null, [row]));
      });
      details.appendChild(list);
      root.appendChild(details);
    });
    tocInstances.push(root);
    refreshTocStates();
    return root;
  }

  function refreshTocStates() {
    tocInstances.forEach(function (root) {
      root.querySelectorAll("[data-state-for]").forEach(function (el) {
        var done = isRead(el.getAttribute("data-state-for"));
        el.textContent = done ? "read" : "";
        el.classList.toggle("is-read", done);
      });
    });
  }

  function buildSidebar() {
    var sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    sidebar.replaceChildren(
      h("p", { class: "label", text: "Contents" }),
      buildBookToc(),
      buildReferenceList(),
      h("p", { class: "sidebar-note", text: publishedChapters.length + " of " + nav.chapters.length + " chapters written so far." })
    );
  }

  /* Reference pages (glossary, acronyms...) listed under the parts. */
  function buildReferenceList() {
    var list = h("ol");
    (nav.reference || []).forEach(function (ref) {
      var isCurrent = pageId === ref.id;
      list.appendChild(h("li", null, [
        h("a", { class: "ch-link", href: ref.file, "aria-current": isCurrent ? "page" : null }, [
          h("span", { class: "n", text: "Ref" }), h("span", { text: ref.title }), h("span", { class: "state" })
        ])
      ]));
    });
    var details = h("details", { open: true }, [
      h("summary", null, [h("span", { class: "part-name", text: "Reference" }), h("span", { class: "part-count", text: String((nav.reference || []).length) })]),
      list
    ]);
    return h("div", { class: "toc-book toc-ref" }, [details]);
  }

  function buildNavDialog() {
    var dialog = h("dialog", { class: "sheet is-nav", "aria-label": "Contents" });
    var closeBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "Close contents" }, [icon("close")]);
    closeBtn.addEventListener("click", function () { dialog.close(); });
    dialog.appendChild(h("div", { class: "sheet-head" }, [
      h("a", { class: "brand", href: "index.html", text: "Graphics Handbook" }),
      h("span", { style: "margin-left:auto" }),
      closeBtn
    ]));
    dialog.appendChild(h("div", { class: "sheet-body" }, [buildBookToc()]));
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) dialog.close(); // click on the backdrop
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  /* ---------- Search ---------- */

  function tokenize(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9.+]+/)
      .filter(Boolean);
  }

  var preparedIndex = null;

  function prepareIndex() {
    if (preparedIndex) return preparedIndex;
    var raw = HB.searchIndex || [];
    preparedIndex = raw.map(function (entry) {
      return {
        entry: entry,
        title: entry.t.toLowerCase(),
        titleTokens: tokenize(entry.t),
        keyTokens: tokenize((entry.s || "") + " " + (entry.w || ""))
      };
    });
    if (!raw.length) log.warn("search index is empty; run npm run build:search");
    return preparedIndex;
  }

  /* Scores every entry against the query. Every query word must match
     something; title matches outrank keyword matches. */
  function search(query, limit) {
    var words = tokenize(query);
    if (!words.length) return [];
    var whole = String(query).trim().toLowerCase();
    var scored = [];
    prepareIndex().forEach(function (item) {
      var total = 0;
      for (var i = 0; i < words.length; i++) {
        var word = words[i];
        var best = 0;
        item.titleTokens.forEach(function (tok) {
          if (tok === word) best = Math.max(best, 30);
          else if (tok.indexOf(word) === 0) best = Math.max(best, 20);
          else if (word.length >= 3 && tok.indexOf(word) !== -1) best = Math.max(best, 8);
        });
        item.keyTokens.forEach(function (tok) {
          if (tok === word) best = Math.max(best, 12);
          else if (tok.indexOf(word) === 0) best = Math.max(best, 8);
        });
        if (!best) return;
        total += best;
      }
      if (item.title === whole) total += 100;
      else if (item.title.indexOf(whole) === 0) total += 25;
      var kind = item.entry.k;
      if (kind === "term") total += 6;
      if (kind === "chapter") total += 4;
      if (item.entry.p) total -= 5;
      scored.push({ score: total, entry: item.entry });
    });
    scored.sort(function (a, b) {
      return b.score - a.score || a.entry.t.length - b.entry.t.length;
    });
    return scored.slice(0, limit || 12).map(function (s) { return s.entry; });
  }
  HB.search = search;

  var KIND_LABEL = { chapter: "Chapter", section: "Section", term: "Term", page: "Page" };

  function buildSearchDialog() {
    var dialog = h("dialog", { class: "sheet search-sheet", "aria-label": "Search the handbook" });
    var input = h("input", {
      class: "search-input",
      id: "search-input",
      type: "search",
      placeholder: "Search chapters and terms",
      autocomplete: "off",
      spellcheck: "false",
      role: "combobox",
      "aria-expanded": "false",
      "aria-controls": "search-results",
      "aria-autocomplete": "list"
    });
    var closeBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "Close search" }, [icon("close")]);
    var results = h("ul", { class: "search-results", id: "search-results", role: "listbox", "aria-label": "Results" });
    var empty = h("p", { class: "search-empty", hidden: true });
    dialog.appendChild(h("div", { class: "sheet-head" }, [icon("search"), input, closeBtn]));
    dialog.appendChild(h("div", { class: "sheet-body" }, [results, empty]));
    document.body.appendChild(dialog);

    var selected = -1;
    var links = [];

    function select(i) {
      links.forEach(function (a, j) { a.setAttribute("aria-selected", j === i ? "true" : "false"); });
      selected = i;
      if (i >= 0 && links[i]) {
        input.setAttribute("aria-activedescendant", links[i].id);
        links[i].scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function render() {
      var q = input.value;
      var found = q.trim() ? search(q, 12) : defaultResults();
      results.replaceChildren();
      links = [];
      found.forEach(function (entry, i) {
        var title = h("span", { class: "title" }, [entry.t]);
        if (entry.p) title.appendChild(h("span", { class: "soon", text: "not written yet" }));
        var a = h("a", { href: entry.u, id: "sr-" + i, role: "option", "aria-selected": "false" }, [
          h("span", { class: "kind", text: KIND_LABEL[entry.k] || entry.k }),
          title,
          h("span", { class: "sub", text: entry.s || "" })
        ]);
        a.addEventListener("click", function () { dialog.close(); });
        links.push(a);
        results.appendChild(h("li", { role: "presentation" }, [a]));
      });
      input.setAttribute("aria-expanded", found.length ? "true" : "false");
      empty.hidden = found.length > 0;
      empty.textContent = q.trim()
        ? "Nothing matches “" + q.trim() + "”. Try a term such as stride, horizon or draw call."
        : "";
      select(found.length ? 0 : -1);
    }

    /* With an empty box, list the chapters that are written. */
    function defaultResults() {
      return (HB.searchIndex || []).filter(function (e) { return e.k === "chapter" && !e.p; });
    }

    input.addEventListener("input", render);
    input.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (links.length) select((selected + 1) % links.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (links.length) select((selected - 1 + links.length) % links.length);
      } else if (event.key === "Enter") {
        if (selected >= 0 && links[selected]) {
          event.preventDefault();
          dialog.close();
          window.location.href = links[selected].getAttribute("href");
        }
      } else if (event.key === "Escape") {
        // A search box would otherwise spend the first Escape clearing itself.
        event.preventDefault();
        dialog.close();
      }
    });
    closeBtn.addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) dialog.close();
    });

    return {
      open: function (prefill) {
        if (!dialog.open) dialog.showModal();
        if (typeof prefill === "string") input.value = prefill;
        render();
        input.focus();
        input.select();
      }
    };
  }

  function buildSearchTrigger(searchUi) {
    var btn = h("button", { class: "search-trigger", type: "button", "aria-label": "Search the handbook" }, [
      icon("search"),
      h("span", { class: "search-hint", text: "Search terms and chapters" }),
      h("kbd", { text: "/" })
    ]);
    btn.addEventListener("click", function () { searchUi.open(); });
    document.addEventListener("keydown", function (event) {
      var tag = (event.target && event.target.tagName) || "";
      var typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (event.target && event.target.isContentEditable);
      if (typing) return;
      if (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
        event.preventDefault();
        searchUi.open();
      }
    });
    return btn;
  }

  /* ---------- Header ---------- */

  function buildHeader() {
    var tools = document.getElementById("header-tools");
    if (!tools) return;
    var searchUi = buildSearchDialog();
    HB.openSearch = searchUi.open;
    tools.replaceChildren(buildSearchTrigger(searchUi), buildProgress(), buildThemeToggle());

    if (document.getElementById("sidebar")) {
      var navDialog = buildNavDialog();
      var menuBtn = h("button", { class: "icon-btn menu-btn", type: "button", "aria-label": "Open contents" }, [icon("menu")]);
      menuBtn.addEventListener("click", function () { navDialog.showModal(); });
      var header = tools.parentNode;
      header.insertBefore(menuBtn, header.firstChild);
    }
  }

  /* ---------- Right rail ---------- */

  function buildRail() {
    var rail = document.getElementById("rail");
    if (!rail) return;
    var beats = Array.prototype.slice.call(document.querySelectorAll("main section.beat[id]"));
    var blocks = [];

    if (beats.length) {
      var list = h("ol", { class: "rail-toc" });
      var linkFor = {};
      beats.forEach(function (section) {
        var heading = section.querySelector("h2");
        if (!heading) return;
        var text = heading.textContent.replace(/^\s*\d+\s*/, "").trim();
        var a = h("a", { href: "#" + section.id, text: text });
        linkFor[section.id] = a;
        list.appendChild(h("li", null, [a]));
      });
      blocks.push(h("div", { class: "rail-block" }, [h("span", { class: "label", text: "On this page" }), list]));

      /* Highlight the beat currently in view. */
      if ("IntersectionObserver" in window) {
        var visible = {};
        var spy = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) { visible[entry.target.id] = entry.isIntersecting; });
          var active = null;
          for (var i = 0; i < beats.length; i++) {
            if (visible[beats[i].id]) { active = beats[i].id; break; }
          }
          Object.keys(linkFor).forEach(function (id) {
            linkFor[id].classList.toggle("is-active", id === active);
          });
        }, { rootMargin: "-20% 0px -60% 0px" });
        beats.forEach(function (section) { spy.observe(section); });
      }
    }

    var seen = {};
    var chips = h("ul", { class: "chips" });
    document.querySelectorAll("main dfn.term[data-term]").forEach(function (dfn) {
      var id = dfn.getAttribute("data-term");
      if (seen[id] || !glossary[id]) return;
      seen[id] = true;
      chips.appendChild(h("li", null, [h("a", { class: "chip term", "data-term": id, href: "glossary.html#" + id, text: glossary[id].term })]));
    });
    if (chips.childNodes.length) {
      blocks.push(h("div", { class: "rail-block" }, [h("span", { class: "label", text: "New terms" }), chips]));
    }
    rail.replaceChildren.apply(rail, blocks);
  }

  /* ---------- Pager and footer ---------- */

  function buildPager() {
    var pager = document.getElementById("pager");
    if (!pager || !current) return;
    var idx = publishedChapters.indexOf(current);
    var prev = publishedChapters[idx - 1];
    var next = publishedChapters[idx + 1];
    var kids = [];
    if (prev) {
      kids.push(h("a", { href: prev.file, rel: "prev" }, [
        h("span", { class: "dir", text: "Previous written chapter" }), h("span", { class: "title", text: chapterLabel(prev) })
      ]));
    }
    if (next) {
      kids.push(h("a", { href: next.file, rel: "next", class: "is-next" }, [
        h("span", { class: "dir", text: "Next written chapter" }), h("span", { class: "title", text: chapterLabel(next) })
      ]));
    }
    kids.push(h("a", { href: "index.html#contents", class: prev && next ? null : "is-next" }, [
      h("span", { class: "dir", text: "All chapters" }), h("span", { class: "title", text: "Back to contents" })
    ]));
    pager.replaceChildren.apply(pager, kids);
  }

  function buildFooter() {
    var footer = document.getElementById("site-footer");
    if (!footer) return;
    footer.replaceChildren(h("div", { class: "footer-inner" }, [
      h("span", { text: "Graphics Handbook" }),
      h("span", { text: "Early access: " + publishedChapters.length + " of " + nav.chapters.length + " chapters written" }),
      h("a", { href: "glossary.html", text: "Glossary" }),
      h("a", { href: "https://github.com/digster/graphics-handbook", text: "Source on GitHub" }),
      h("span", { text: "MIT licence" })
    ]));
  }

  /* ---------- Cross-references ---------- */

  function wireXrefs() {
    document.querySelectorAll("a.xref[data-ch]").forEach(function (a) {
      var ch = nav.byNum(a.getAttribute("data-ch"));
      if (!ch) {
        log.warn("cross-reference to unknown chapter", a.getAttribute("data-ch"));
        return;
      }
      if (!a.textContent.trim()) a.textContent = chapterLabel(ch);
      if (ch.status === "published") {
        var anchor = a.getAttribute("data-anchor");
        a.href = ch.file + (anchor ? "#" + anchor : "");
      } else {
        a.href = nav.contentsHref(ch.num);
        a.classList.add("is-planned");
        a.title = chapterLabel(ch) + " is not written yet. This opens its entry in the contents.";
      }
    });
  }

  /* ---------- Term cards ---------- */

  function whereText(entry) {
    var ch = nav.byNum(entry.ch);
    if (!ch) return "";
    if (current && entry.ch === current.num) return "Introduced in this chapter";
    var label = chapterLabel(ch);
    if (current && nav.compare(entry.ch, current.num) > 0) {
      return "Covered later, in " + label + (ch.status === "published" ? "" : " (not written yet)");
    }
    return "Taught in " + label + (ch.status === "published" ? "" : " (not written yet)");
  }

  function wireTermCards() {
    var card = h("div", { class: "term-card", id: "term-card", role: "tooltip", hidden: true });
    document.body.appendChild(card);
    var activeEl = null;
    var hideTimer = null;

    function show(el) {
      var id = el.getAttribute("data-term");
      var entry = glossary[id];
      if (!entry) {
        log.warn("term not in glossary", id);
        return;
      }
      clearTimeout(hideTimer);
      activeEl = el;
      var kids = [h("span", { class: "tc-term", text: entry.term })];
      if (entry.aka && entry.aka.length) kids.push(h("span", { class: "tc-aka", text: "Also: " + entry.aka.join(", ") }));
      kids.push(h("span", { text: entry.def }));
      var where = whereText(entry);
      if (where) kids.push(h("span", { class: "tc-where", text: where }));
      card.replaceChildren.apply(card, kids);
      card.hidden = false;
      el.setAttribute("aria-describedby", "term-card");
      place(el);
    }

    function place(el) {
      var r = el.getBoundingClientRect();
      var cw = card.offsetWidth;
      var chh = card.offsetHeight;
      var left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
      var top = r.bottom + 8;
      if (top + chh > window.innerHeight - 12) top = Math.max(12, r.top - chh - 8);
      card.style.left = left + "px";
      card.style.top = top + "px";
    }

    function hide(immediate) {
      clearTimeout(hideTimer);
      var run = function () {
        card.hidden = true;
        if (activeEl) activeEl.removeAttribute("aria-describedby");
        activeEl = null;
      };
      if (immediate) run();
      else hideTimer = setTimeout(run, 120);
    }

    function termFrom(target) {
      return target && target.closest ? target.closest(".term[data-term]") : null;
    }

    document.addEventListener("pointerover", function (event) {
      if (event.pointerType === "touch") return; // touch: tapping follows the link
      var el = termFrom(event.target);
      if (el) show(el);
    });
    document.addEventListener("pointerout", function (event) {
      var el = termFrom(event.target);
      if (el && !el.contains(event.relatedTarget)) hide(false);
    });
    document.addEventListener("focusin", function (event) {
      var el = termFrom(event.target);
      if (el) show(el);
    });
    document.addEventListener("focusout", function (event) {
      if (termFrom(event.target)) hide(true);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") hide(true);
    });
    // Keep the card attached to its term while the page scrolls; hide it
    // only once the term has left the viewport.
    var scrollQueued = false;
    window.addEventListener("scroll", function () {
      if (!activeEl || scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(function () {
        scrollQueued = false;
        if (!activeEl) return;
        var r = activeEl.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) hide(true);
        else place(activeEl);
      });
    }, { passive: true });
  }

  /* ---------- Copy buttons on briefs ---------- */

  function wireCopyButtons() {
    document.querySelectorAll(".prompt").forEach(function (prompt) {
      var head = prompt.querySelector(".prompt-head");
      var body = prompt.querySelector(".prompt-body");
      if (!head || !body) return;
      var btn = h("button", { class: "btn copy-btn", type: "button", text: "Copy" });
      head.appendChild(btn);
      btn.addEventListener("click", function () {
        var text = body.textContent.trim();
        var done = function (label) {
          btn.textContent = label;
          setTimeout(function () { btn.textContent = "Copy"; }, 1800);
        };
        var fallback = function () {
          // Older app views refuse the async clipboard: select the text instead.
          var range = document.createRange();
          range.selectNodeContents(body);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          var ok = false;
          try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
          done(ok ? "Copied" : "Selected, press Ctrl+C");
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done("Copied"); }, fallback);
        } else {
          fallback();
        }
      });
    });
  }

  /* ---------- Boot ---------- */

  function boot() {
    var steps = [buildHeader, buildSidebar, buildRail, buildPager, buildFooter, wireXrefs, wireTermCards, wireCopyButtons, watchCompletion];
    steps.forEach(function (step) {
      try {
        step();
      } catch (err) {
        log.error("shell step failed:", step.name, err);
      }
    });
    document.documentElement.classList.add("hb-ready");
    log.info("shell ready", { page: pageId || "(none)", published: publishedChapters.length });
  }

  boot();
})();

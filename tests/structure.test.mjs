/**
 * Structure tests: run in plain Node, no browser.
 *
 * They enforce the rules that keep the handbook coherent as it grows:
 *   - nav.js, the pages on disk and the search index agree
 *   - every chapter has the eight beats, in order
 *   - every local link and anchor resolves
 *   - the site works from file:// (classic scripts, no fetch, no CDN)
 *   - "no term before its chapter": a term taught later must be marked
 *     data-forward where it is used
 *   - diagrams are accessible and never hard-code a colour
 *
 * Run: npm run test:structure
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import {
  DOCS, loadData, listPages, readPage, pageId, tags, attr, idsIn, compareNum, pagesInScope, DRAFT_MODE,
} from "../tools/lib/site.mjs";
import { buildIndex, renderIndexFile } from "../tools/build-search-index.mjs";

const { nav, glossary } = loadData();
// In draft mode (HB_ONLY set by tools/check-chapter.mjs) only the named
// pages are checked, and whole-site checks are skipped.
const pages = pagesInScope();
const html = Object.fromEntries(listPages().map((p) => [p, readPage(p)]));
const chapterPages = pages.filter((p) => nav.chapters.some((c) => c.file === p));
const BEATS = ["picture", "plain", "how", "cost", "breaks", "engines", "ai", "check"];

/** Recursively lists files under a docs/ subfolder. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]
  );
}

test("nav: chapter numbers and files are unique and sequential", () => {
  const nums = nav.chapters.map((c) => c.num);
  assert.equal(new Set(nums).size, nums.length, "duplicate chapter numbers");
  const files = nav.chapters.map((c) => c.file);
  assert.equal(new Set(files).size, files.length, "duplicate chapter files");
  for (const part of nav.parts) {
    part.chapters.forEach((ch, i) => {
      assert.equal(ch.num, `${part.n}.${i + 1}`, `chapter ${ch.num} is out of sequence in part ${part.n}`);
      assert.match(ch.slug, /^[a-z0-9-]+$/, `bad slug for ${ch.num}`);
      assert.ok(["published", "planned"].includes(ch.status), `bad status for ${ch.num}`);
    });
  }
});

test("nav and disk agree: published chapters have pages, planned ones do not", { skip: DRAFT_MODE }, () => {
  for (const ch of nav.chapters) {
    const exists = existsSync(join(DOCS, ch.file));
    if (ch.status === "published") assert.ok(exists, `${ch.num} is published but ${ch.file} is missing`);
    else assert.ok(!exists, `${ch.file} exists but ${ch.num} is still marked planned`);
  }
  for (const page of pages) {
    const known = page === "index.html" || page === "glossary.html" || chapterPages.includes(page);
    assert.ok(known, `${page} is not the home page, the glossary or a chapter in nav.js`);
  }
});

test("every page has the standard head, shell markup and script order", () => {
  const requiredScripts = [
    "assets/js/log.js",
    "assets/js/data/nav.js",
    "assets/js/data/glossary.js",
    "assets/js/data/search-index.js",
    "assets/js/shell.js",
  ];
  for (const [page, src] of Object.entries(html).filter(([p]) => pages.includes(p))) {
    assert.match(src, /^<!doctype html>/i, `${page}: missing doctype`);
    assert.match(src, /<html lang="en">/, `${page}: missing lang`);
    assert.match(src, /<meta name="viewport"/, `${page}: missing viewport meta`);
    assert.match(src, /<title>[^<]+<\/title>/, `${page}: missing title`);
    const head = src.split("</head>")[0];
    assert.ok(head.includes('src="assets/js/theme-init.js"'), `${page}: theme-init.js must load in <head>`);
    for (const css of ["tokens.css", "site.css", "diagrams.css"]) {
      assert.ok(head.includes(`href="assets/css/${css}"`), `${page}: missing ${css}`);
    }
    const order = requiredScripts.map((s) => src.indexOf(`src="${s}"`));
    order.forEach((pos, i) => assert.ok(pos > -1, `${page}: missing ${requiredScripts[i]}`));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${page}: shared scripts out of order`);
    assert.ok(src.includes('id="header-tools"'), `${page}: missing #header-tools`);
    assert.ok(src.includes('id="site-footer"'), `${page}: missing #site-footer`);
    assert.ok(src.includes('id="main"'), `${page}: missing #main`);
  }
});

test("chapter pages: correct id, title and the eight beats in order", () => {
  for (const page of chapterPages) {
    const ch = nav.chapters.find((c) => c.file === page);
    const src = html[page];
    assert.equal(pageId(src), ch.num, `${page}: body data-page should be ${ch.num}`);
    assert.ok(src.includes(`<span class="ch-num">${ch.num}</span>`), `${page}: h1 should show ${ch.num}`);
    const beats = tags(src, "section").map((t) => attr(t, "data-beat")).filter(Boolean);
    assert.deepEqual(beats, BEATS, `${page}: beats must be exactly ${BEATS.join(", ")}`);
    for (const beat of BEATS) {
      assert.match(src, new RegExp(`<section class="beat" id="${beat}" data-beat="${beat}">`), `${page}: beat ${beat} needs id="${beat}"`);
    }
    const quiz = src.split('id="check"')[1] || "";
    assert.ok((quiz.match(/<p class="q">/g) || []).length >= 3, `${page}: Check yourself needs at least 3 questions`);
    assert.ok(src.includes('id="sources"'), `${page}: missing sources section`);
    assert.ok(src.includes('id="pager"') && src.includes('id="rail"') && src.includes('id="sidebar"'), `${page}: missing shell containers`);
  }
});

test("all local links, images and scripts resolve, including #anchors", () => {
  const glossaryIds = new Set(Object.keys(glossary));
  for (const [page, src] of Object.entries(html).filter(([p]) => pages.includes(p))) {
    const refs = [...src.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|mailto:|tel:)/.test(ref)) continue;
      const [path, hash] = ref.split("#");
      const target = path === "" ? page : path;
      assert.ok(existsSync(join(DOCS, target)), `${page}: broken link ${ref}`);
      if (!hash) continue;
      if (target === "glossary.html" && !idsIn(html[target]).has(hash)) {
        // Glossary entries render from glossary.js, so check the data instead.
        assert.ok(glossaryIds.has(hash), `${page}: glossary has no entry "${hash}"`);
      } else if (target === "index.html" && hash.startsWith("ch-")) {
        const num = hash.slice(3).replace("-", ".");
        assert.ok(nav.byNum(num), `${page}: contents has no chapter ${num}`);
      } else if (extname(target) === ".html") {
        assert.ok(idsIn(html[target]).has(hash), `${page}: ${target} has no id "${hash}"`);
      }
    }
  }
});

test("works from file://: classic scripts, no fetch, no remote assets", () => {
  const scripts = walk(join(DOCS, "assets")).filter((f) => f.endsWith(".js"));
  for (const file of scripts) {
    const code = readFileSync(file, "utf8");
    assert.ok(!/\bfetch\s*\(/.test(code), `${file}: fetch() fails from file://`);
    assert.ok(!/XMLHttpRequest/.test(code), `${file}: XHR fails from file://`);
    assert.ok(!/^\s*(import|export)\s/m.test(code), `${file}: ES modules fail from file://`);
    assert.ok(!/\bimport\s*\(/.test(code), `${file}: dynamic import fails from file://`);
  }
  for (const [page, src] of Object.entries(html).filter(([p]) => pages.includes(p))) {
    assert.ok(!/type="module"/.test(src), `${page}: module scripts fail from file://`);
    for (const tag of [...tags(src, "script"), ...tags(src, "link"), ...tags(src, "img")]) {
      const url = attr(tag, "src") || attr(tag, "href");
      if (!url) continue;
      assert.ok(!/^(https?:)?\/\//.test(url), `${page}: remote asset ${url}; the site must work offline`);
      assert.ok(!url.startsWith("/"), `${page}: absolute path ${url} breaks on file:// and project Pages`);
    }
  }
  const css = walk(join(DOCS, "assets", "css"));
  for (const file of css) {
    const code = readFileSync(file, "utf8");
    assert.ok(!/@import/.test(code), `${file}: keep stylesheets flat`);
    assert.ok(!/url\(\s*["']?(https?:)?\/\//.test(code), `${file}: remote url() in CSS`);
  }
});

test("glossary entries are complete and point at real chapters", () => {
  for (const [id, g] of Object.entries(glossary)) {
    assert.match(id, /^[a-z0-9-]+$/, `glossary id "${id}" must be lowercase-hyphenated`);
    assert.ok(g.term && g.def, `glossary ${id}: needs term and def`);
    assert.ok(Array.isArray(g.aka), `glossary ${id}: aka must be an array`);
    assert.ok(nav.byNum(g.ch), `glossary ${id}: chapter ${g.ch} is not in nav.js`);
  }
});

test("no term before its chapter: later terms are marked data-forward", () => {
  for (const page of chapterPages) {
    const num = pageId(html[page]);
    for (const tag of tags(html[page], "a").concat(tags(html[page], "dfn"))) {
      const term = attr(tag, "data-term");
      if (!term) continue;
      const entry = glossary[term];
      assert.ok(entry, `${page}: data-term "${term}" is not in glossary.js`);
      const later = compareNum(entry.ch, num) > 0;
      const forward = /\sdata-forward(\s|>|=)/.test(tag);
      if (tag.startsWith("<dfn")) {
        assert.equal(entry.ch, num, `${page}: <dfn> for "${term}", but the glossary says ${entry.ch} teaches it`);
      } else if (later) {
        assert.ok(forward, `${page}: "${term}" is taught later (${entry.ch}); mark the link data-forward`);
      } else {
        assert.ok(!forward, `${page}: "${term}" is taught in ${entry.ch}, not later; remove data-forward`);
      }
    }
  }
  for (const page of [...pages].filter((p) => !chapterPages.includes(p))) {
    for (const tag of tags(html[page], "a")) {
      const term = attr(tag, "data-term");
      if (term) assert.ok(glossary[term], `${page}: data-term "${term}" is not in glossary.js`);
    }
  }
});

test("every term a published chapter owns is introduced there with <dfn>", () => {
  for (const page of chapterPages) {
    const num = pageId(html[page]);
    const defined = new Set(tags(html[page], "dfn").map((t) => attr(t, "data-term")));
    for (const [id, g] of Object.entries(glossary)) {
      if (g.ch === num) assert.ok(defined.has(id), `${page}: glossary says ${num} teaches "${id}", but the page has no <dfn> for it`);
    }
  }
});

test("cross-references point at chapters that exist", () => {
  for (const [page, src] of Object.entries(html).filter(([p]) => pages.includes(p))) {
    for (const tag of tags(src, "a")) {
      if (!/class="[^"]*\bxref\b/.test(tag)) continue;
      const num = attr(tag, "data-ch");
      assert.ok(num && nav.byNum(num), `${page}: xref to unknown chapter "${num}"`);
    }
  }
});

test("diagrams are accessible, have unique ids and use theme classes only", () => {
  for (const [page, src] of Object.entries(html).filter(([p]) => pages.includes(p))) {
    for (const tag of tags(src, "svg")) {
      if (attr(tag, "role") === "img") assert.ok(attr(tag, "aria-label"), `${page}: svg role="img" needs aria-label`);
    }
    const figures = src.split("<figure").slice(1);
    figures.forEach((fig, i) => {
      const body = fig.split("</figure>")[0];
      assert.ok(body.includes("<figcaption>"), `${page}: figure ${i + 1} has no figcaption`);
    });
    const ids = [...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `${page}: duplicate ids ${dupes.join(", ")}`);
    assert.ok(!/\s(fill|stroke|stop-color)="#/.test(src), `${page}: literal colour in SVG; use a class from diagrams.css`);
  }
  for (const file of ["site.css", "diagrams.css"]) {
    const lines = readFileSync(join(DOCS, "assets", "css", file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !line.includes("masks only")) {
        assert.fail(`${file}:${i + 1}: literal colour; define a token in tokens.css`);
      }
    });
  }
});

test("search index is up to date", { skip: DRAFT_MODE }, () => {
  const expected = renderIndexFile(buildIndex());
  const actual = readFileSync(join(DOCS, "assets", "js", "data", "search-index.js"), "utf8");
  assert.equal(actual, expected, "search-index.js is stale: run npm run build:search");
});

test("fonts referenced by tokens.css exist and ship with their licences", () => {
  const css = readFileSync(join(DOCS, "assets", "css", "tokens.css"), "utf8");
  const fonts = [...css.matchAll(/url\("\.\.\/fonts\/([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(fonts.length > 0, "no @font-face sources found");
  for (const f of fonts) assert.ok(existsSync(join(DOCS, "assets", "fonts", f)), `missing font ${f}`);
  for (const lic of ["OFL-IBM-Plex.txt", "OFL-Space-Grotesk.txt"]) {
    assert.ok(existsSync(join(DOCS, "assets", "fonts", lic)), `missing font licence ${lic}`);
  }
  assert.ok(existsSync(join(DOCS, ".nojekyll")), "docs/.nojekyll stops GitHub Pages running Jekyll");
});

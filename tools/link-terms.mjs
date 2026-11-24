#!/usr/bin/env node
/**
 * Links the first plain-text mention of glossary terms in chapter prose.
 *
 * Chapters were written in parallel, so a writer could only link terms that
 * already existed. This pass adds the missing links once the glossary is
 * complete. It is deliberately conservative:
 *
 *   - only terms whose name is several words ("depth buffer") or an acronym
 *     ("SSAO"); single ordinary words ("point", "build") are never linked,
 *     because a wrong link is worse than none;
 *   - only the first mention per page, and only if the page does not already
 *     link or define that term anywhere;
 *   - only inside running text: <p>, <li>, <td>, <dd>, <figcaption> within
 *     the article, never inside headings, links, <dfn>, <code>, <pre>, SVG,
 *     the "Terms introduced" chips or the sources list;
 *   - a term taught in a later chapter gets data-forward, as the tests require.
 *
 * Usage:
 *   node tools/link-terms.mjs --dry-run          report what would change
 *   node tools/link-terms.mjs                    rewrite the chapter pages
 *   node tools/link-terms.mjs --only 12-3-reviewing-ai-code.html
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DOCS, loadData, readPage, compareNum } from "./lib/site.mjs";
import { logger } from "./lib/log.mjs";

const log = logger("link-terms");

const ACRONYM = /^[A-Z][A-Z0-9+-]{1,9}$/;
/** A term is safe to auto-link if it is an acronym or has 2+ words. */
function linkable(name) {
  return ACRONYM.test(name) || /\s/.test(name.trim());
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Candidate patterns: one per glossary id, from its display name. */
function buildCandidates(glossary) {
  return Object.entries(glossary)
  .filter(([, g]) => linkable(g.term))
  .map(([id, g]) => {
    const name = g.term.trim();
    const isAcronym = ACRONYM.test(name);
    // Acronyms match case-sensitively; phrases case-insensitively, with an
    // optional plural "s". Word boundaries on both sides.
    const re = isAcronym
      ? new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`)
      : new RegExp(`(?<![\\w-])(${escapeRe(name)})(s?)(?![\\w-])`, "i");
    return { id, ch: g.ch, name, re };
  })
  // Longer names first, so "screen-space reflections" wins over "SSR"-style
  // overlaps and "shadow map" does not split "cascaded shadow maps".
  .sort((a, b) => b.name.length - a.name.length);
}

const TEXT_CONTAINERS = new Set(["p", "li", "td", "dd", "figcaption"]);
const FORBIDDEN = new Set(["a", "dfn", "code", "pre", "kbd", "samp", "svg", "select", "option", "label", "textarea", "output", "noscript", "h1", "h2", "h3", "h4", "script", "style", "summary", "button", "title"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Splits HTML into tag and text tokens. */
function tokenize(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<[^>]+>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > last) out.push({ text: html.slice(last, m.index) });
    out.push({ tag: m[0] });
    last = re.lastIndex;
  }
  if (last < html.length) out.push({ text: html.slice(last) });
  return out;
}

function tagName(tag) {
  const m = tag.match(/^<\/?\s*([a-zA-Z0-9-]+)/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Returns { html, added } for one page: the page with links inserted and the
 * list of "id (shown text)" strings that were linked. Does not write.
 */
function processPage(file, num, candidates) {
  const html = readPage(file);
  // Terms the page already links or defines anywhere are left alone.
  const present = new Set([...html.matchAll(/data-term="([^"]+)"/g)].map((m) => m[1]));
  const pending = candidates.filter((c) => !present.has(c.id));
  const tokens = tokenize(html);
  const stack = [];
  let inArticle = false;
  let inSources = false;
  const added = [];

  for (const tok of tokens) {
    if (tok.tag) {
      const t = tok.tag;
      if (t.startsWith("<!--") || t.startsWith("<!")) continue;
      const name = tagName(t);
      if (!name) continue;
      if (t.startsWith("</")) {
        const idx = stack.lastIndexOf(name);
        if (idx > -1) {
          const popped = stack.splice(idx);
          if (popped.includes("article")) inArticle = false;
          if (popped.some((p) => p === "section:sources")) inSources = false;
        }
        continue;
      }
      if (VOID.has(name) || t.endsWith("/>")) continue;
      if (name === "article") inArticle = true;
      if (name === "section" && /class="sources"/.test(t)) {
        inSources = true;
        stack.push("section:sources");
        continue;
      }
      stack.push(name);
      continue;
    }
    // Text token.
    if (!inArticle || inSources) continue;
    if (stack.some((n) => FORBIDDEN.has(n))) continue;
    if (!stack.some((n) => TEXT_CONTAINERS.has(n))) continue;
    let text = tok.text;
    // Repeatedly link the earliest match in the remaining text (the longest
    // name wins a tie), so a match late in the sentence never hides an
    // earlier one and a second run finds nothing new.
    for (;;) {
      let best = null;
      for (const c of pending) {
        const m = text.match(c.re);
        if (m && (!best || m.index < best.m.index)) best = { c, m };
      }
      if (!best) break;
      const { c, m } = best;
      const later = compareNum(c.ch, num) > 0;
      const shown = m[0];
      const link = `<a class="term" data-term="${c.id}"${later ? " data-forward" : ""} href="glossary.html#${c.id}">${shown}</a>`;
      tok.parts = tok.parts || [];
      tok.parts.push(text.slice(0, m.index), { link });
      text = text.slice(m.index + shown.length);
      added.push(`${c.id} (${shown})`);
      pending.splice(pending.indexOf(c), 1);
    }
    if (tok.parts) {
      tok.parts.push(text);
    }
  }

  if (!added.length) return { html, added };
  const rebuilt = tokens
    .map((tok) => {
      if (tok.tag) return tok.tag;
      if (tok.parts) return tok.parts.map((p) => (typeof p === "string" ? p : p.link)).join("");
      return tok.text;
    })
    .join("");
  return { html: rebuilt, added };
}

/**
 * Runs the pass over every published chapter (or the files in `only`).
 * Returns a map of file -> links added; writes the pages when `write` is set.
 */
export function linkTerms({ write = false, only = null } = {}) {
  const { nav, glossary } = loadData();
  const candidates = buildCandidates(glossary);
  const result = {};
  for (const ch of nav.chapters) {
    if (ch.status !== "published") continue;
    if (only && !only.includes(ch.file)) continue;
    const { html, added } = processPage(ch.file, ch.num, candidates);
    if (!added.length) continue;
    result[ch.file] = added;
    if (write) writeFileSync(join(DOCS, ch.file), html);
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx > -1 ? args[onlyIdx + 1].split(",") : null;
  const result = linkTerms({ write: !dryRun, only });
  let total = 0;
  for (const [file, added] of Object.entries(result)) {
    total += added.length;
    log.info(`${file}: ${added.length} links${dryRun ? " (dry run)" : ""}`);
    log.debug(added.join(", "));
  }
  log.info(`${dryRun ? "would add" : "added"} ${total} term links`);
}

/**
 * Shared helpers for the author tools and the structure tests.
 *
 * The site's data files (nav.js, glossary.js) are browser scripts that
 * assign to window.HB. loadData() runs them in a Node vm sandbox, so the
 * tools and tests read exactly what the browser reads, with no copy.
 *
 * HTML is parsed with small regular expressions. That is deliberate: the
 * pages are hand-written to a fixed template (see ARCHITECTURE.md), and the
 * tests fail loudly if a page drifts from it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DOCS = join(ROOT, "docs");
export const DATA_DIR = join(DOCS, "assets", "js", "data");

/** Evaluates the browser data scripts and returns { nav, glossary }. */
export function loadData() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const file of ["nav.js", "glossary.js"]) {
    vm.runInContext(readFileSync(join(DATA_DIR, file), "utf8"), sandbox, { filename: file });
  }
  const { nav, glossary } = sandbox.window.HB;
  return { nav, glossary };
}

/** Evaluates the generated search index file and returns its array. */
export function loadSearchIndex() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(DATA_DIR, "search-index.js"), "utf8"), sandbox);
  return sandbox.window.HB.searchIndex;
}

/** Top-level .html files in docs/ (the site is flat by design). */
export function listPages() {
  return readdirSync(DOCS).filter((f) => f.endsWith(".html")).sort();
}

export function readPage(file) {
  return readFileSync(join(DOCS, file), "utf8");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", times: "×", rarr: "→", minus: "−" };

/** Strips tags and decodes the few entities the pages use. */
export function textOf(html) {
  return html
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, code) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return String.fromCodePoint(n);
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Value of one attribute in a single tag string, or null. */
export function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : null;
}

/** Every opening tag of a given name, as raw strings. */
export function tags(html, name) {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || [];
}

/** Body data-page value. */
export function pageId(html) {
  const body = tags(html, "body")[0];
  return body ? attr(body, "data-page") : null;
}

/** All headings of a level that carry an id: [{ id, text }]. */
export function headingsWithId(html, level) {
  const out = [];
  const re = new RegExp(`<h${level}\\b([^>]*)>([\\s\\S]*?)</h${level}>`, "gi");
  let m;
  while ((m = re.exec(html))) {
    const id = attr(m[1], "id");
    if (id) out.push({ id, text: textOf(m[2]) });
  }
  return out;
}

/** First match of a tag with a class, returning its inner text. */
export function firstText(html, tagName, className) {
  const re = new RegExp(`<${tagName}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const m = html.match(re);
  return m ? textOf(m[1]) : "";
}

/** Every id attribute in the page. */
export function idsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

/** "4.2" vs "8.3" in book order. */
export function compareNum(a, b) {
  const [x1, x2] = a.split(".").map(Number);
  const [y1, y2] = b.split(".").map(Number);
  return x1 - y1 || x2 - y2;
}

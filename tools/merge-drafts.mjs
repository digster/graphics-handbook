#!/usr/bin/env node
/**
 * Merges draft glossary JSON files into docs/assets/js/data/glossary.js and
 * marks chapters published in nav.js. Used when a batch of chapters lands.
 *
 * Usage: node tools/merge-drafts.mjs --publish 1.1,1.2 --glossary a.json,b.json
 *
 * Refuses to give an existing glossary id to a different chapter, so two
 * chapters cannot both claim a term. Rewrites glossary.js sorted by id.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { DATA_DIR } from "./lib/site.mjs";
import { logger } from "./lib/log.mjs";

const log = logger("merge-drafts");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : "";
};
const publish = opt("publish").split(",").filter(Boolean);
const drafts = opt("glossary").split(",").filter(Boolean);

/* ---------- glossary ---------- */
const gPath = join(DATA_DIR, "glossary.js");
const gSrc = readFileSync(gPath, "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(gSrc, sandbox);
const glossary = JSON.parse(JSON.stringify(sandbox.window.HB.glossary));
let added = 0;
for (const file of drafts) {
  const extra = JSON.parse(readFileSync(file, "utf8"));
  for (const [id, entry] of Object.entries(extra)) {
    if (glossary[id] && glossary[id].ch !== entry.ch) {
      throw new Error(`${file}: "${id}" is already taught in ${glossary[id].ch}; refusing to move it to ${entry.ch}`);
    }
    if (!glossary[id]) added++;
    glossary[id] = { term: entry.term, aka: entry.aka || [], def: entry.def, ch: entry.ch };
  }
}

/* One entry per line, in the same style as the hand-written file. */
function line(id) {
  const g = glossary[id];
  return `    ${JSON.stringify(id)}: { term: ${JSON.stringify(g.term)}, aka: ${JSON.stringify(g.aka)}, def: ${JSON.stringify(g.def)}, ch: ${JSON.stringify(g.ch)} }`;
}
const body = Object.keys(glossary).sort().map(line).join(",\n");
const start = gSrc.indexOf("  HB.glossary = {");
const end = gSrc.indexOf("\n  };", start);
if (start < 0 || end < 0) throw new Error("could not find the HB.glossary block in glossary.js");
writeFileSync(gPath, gSrc.slice(0, start) + "  HB.glossary = {\n" + body + gSrc.slice(end));
log.info(`glossary: ${added} new terms, ${Object.keys(glossary).length} total`);

/* ---------- nav ---------- */
const nPath = join(DATA_DIR, "nav.js");
let nav = readFileSync(nPath, "utf8");
for (const num of publish) {
  const re = new RegExp(`(\\{ num: "${num.replace(".", "\\.")}",[^\\n]*status: )"planned"`);
  if (!re.test(nav)) throw new Error(`could not find planned chapter ${num} in nav.js`);
  nav = nav.replace(re, '$1"published"');
}
writeFileSync(nPath, nav);
log.info(`nav: published ${publish.join(", ") || "nothing"}`);

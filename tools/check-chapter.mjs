#!/usr/bin/env node
/**
 * Checks draft chapters before they are merged into the shared data files.
 *
 * Runs the structure tests and the browser page test for just the named
 * chapters, treating them as published and adding draft glossary entries
 * from JSON files (same shape as glossary.js: { "id": { term, aka, def, ch } }).
 *
 * Usage:
 *   node tools/check-chapter.mjs 1.1 1.2 --glossary path/to/terms.json
 *   node tools/check-chapter.mjs 4.3 --structure-only
 *
 * Prints only failures and the pass/fail totals. Exit code 1 on failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, DOCS, loadData } from "./lib/site.mjs";

const args = process.argv.slice(2);
const nums = args.filter((a) => /^\d+\.\d+$/.test(a));
const gIdx = args.indexOf("--glossary");
const glossaryFiles = gIdx > -1 ? args[gIdx + 1] : "";
const structureOnly = args.includes("--structure-only");

if (!nums.length) {
  console.error("usage: node tools/check-chapter.mjs <num> [<num>...] [--glossary a.json,b.json] [--structure-only]");
  process.exit(2);
}

const { nav } = loadData();
const files = nums.map((n) => {
  const ch = nav.byNum(n);
  if (!ch) throw new Error(`unknown chapter ${n}`);
  if (!existsSync(join(DOCS, ch.file))) throw new Error(`${ch.file} does not exist yet`);
  return ch.file;
});

const env = { ...process.env, HB_ONLY: files.join(","), HB_PUBLISH: nums.join(","), HB_GLOSSARY_EXTRA: glossaryFiles };
let failed = false;
const suites = structureOnly ? ["structure"] : ["structure", "browser"];
for (const suite of suites) {
  const run = spawnSync(process.execPath, ["--test", join(ROOT, "tests", `${suite}.test.mjs`)], { env, encoding: "utf8" });
  const lines = ((run.stdout || "") + (run.stderr || "")).split("\n");
  // Keep failing test names and their messages; drop stack traces.
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^not ok /.test(line)) {
      keep.push(line);
      for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
        if (/^(ok|not ok) /.test(lines[j])) break;
        if (/^\s+at /.test(lines[j]) || /^\s+(duration_ms|type|location|failureType|code|name|stack|operator):/.test(lines[j])) continue;
        if (/^\s+\S/.test(lines[j]) && !/^\s+---$/.test(lines[j]) && !/^\s+\.\.\.$/.test(lines[j])) keep.push(lines[j]);
      }
    }
    if (/^# (pass|fail|skipped)/.test(line)) keep.push(`${suite}: ${line.slice(2)}`);
  }
  console.log(keep.join("\n"));
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);

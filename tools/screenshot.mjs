#!/usr/bin/env node
/**
 * Author tool: screenshots a page, or each element matching a selector, so
 * diagrams can be reviewed by eye. Writes PNGs to --out (default: the OS
 * temp folder). Delete the images when done; never commit them.
 *
 * Usage:
 *   node tools/screenshot.mjs 04-2-vertex-buffers.html --each "main figure" --out /tmp/shots
 *   node tools/screenshot.mjs index.html --phone --dark
 * Flags: --each <selector>  --dark  --phone  --full  --out <dir>  --name <prefix>
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { DOCS } from "./lib/site.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--each", "--out", "--name"]);
const page = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : null;
};
const flag = (name) => args.includes(`--${name}`);
if (!page) {
  console.error("usage: node tools/screenshot.mjs <page.html> [--each selector] [--dark] [--phone] [--full] [--out dir]");
  process.exit(2);
}
const out = opt("out") || tmpdir();
const name = opt("name") || page.replace(/\.html$/, "");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: flag("phone") ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  colorScheme: flag("dark") ? "dark" : "light",
  deviceScaleFactor: 1,
});
const tab = await context.newPage();
const errors = [];
tab.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
tab.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await tab.goto(pathToFileURL(join(DOCS, page)).href);
await tab.waitForTimeout(800);
// Unstick the header so element shots are not covered by it.
await tab.addStyleTag({ content: ".site-header{position:static!important}" });

const written = [];
if (opt("each")) {
  const els = await tab.$$(opt("each"));
  for (let i = 0; i < els.length; i++) {
    const file = join(out, `${name}-${i}.png`);
    await els[i].screenshot({ path: file });
    written.push(file);
  }
} else {
  const file = join(out, `${name}.png`);
  await tab.screenshot({ path: file, fullPage: flag("full") });
  written.push(file);
}
const m = await tab.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
console.log(written.join("\n"));
console.log(`sideways overflow: ${m.scroll > m.client + 1 ? `YES (${m.scroll} > ${m.client})` : "no"}`);
console.log(`console: ${errors.length ? "\n" + errors.join("\n") : "clean"}`);
await browser.close();

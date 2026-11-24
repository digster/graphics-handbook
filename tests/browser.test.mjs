/**
 * Browser tests: open every page straight from disk (file://), the way a
 * reader who downloads the repository would, and check that it works.
 *
 * Browsers: BROWSERS env var, comma separated (default "chromium").
 * CI runs chromium,firefox,webkit.
 *
 * Run: npm run test:browser
 * In a cloud session with a preinstalled Playwright, the global copy is used
 * (resolved through NODE_PATH by createRequire).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { DOCS, loadData, pagesInScope, DRAFT_MODE } from "../tools/lib/site.mjs";

const require = createRequire(import.meta.url);
const playwright = require("playwright");

const { nav, glossary } = loadData();
const PAGES = pagesInScope();
const BROWSERS = (process.env.BROWSERS || "chromium").split(",").map((s) => s.trim()).filter(Boolean);
const url = (page) => pathToFileURL(join(DOCS, page)).href;
// Spread into a plain array: nav.js ran in a vm sandbox, and deepStrictEqual
// treats arrays from another realm as a different type.
const published = [...nav.chapters.filter((c) => c.status === "published")];

for (const browserName of BROWSERS) {
  let browser;

  before(async () => {
    browser = await playwright[browserName].launch();
  });
  after(async () => {
    await browser?.close();
  });

  /** Opens a page and records console errors and uncaught exceptions. */
  async function open(page, options = {}) {
    const context = await browser.newContext({
      viewport: options.viewport || { width: 1280, height: 900 },
      colorScheme: options.colorScheme || "light",
      reducedMotion: "reduce",
    });
    // file:// pages share one storage origin, and Chromium keeps it across
    // contexts and even launches. Start every page from empty storage so a
    // saved theme or reading progress from an earlier test cannot leak in.
    await context.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch (err) {
        /* storage blocked: nothing to clear */
      }
    });
    const tab = await context.newPage();
    const errors = [];
    tab.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    tab.on("pageerror", (err) => errors.push(err.message));
    await tab.goto(url(page) + (options.hash || ""));
    await tab.waitForFunction(() => document.documentElement.classList.contains("hb-ready"));
    return { tab, context, errors };
  }

  for (const page of PAGES) {
    test(`[${browserName}] ${page}: loads cleanly, fits a phone, follows both themes`, async () => {
      for (const colorScheme of ["light", "dark"]) {
        // 320 px is the narrowest phone still in common use; a page that fits it
        // fits wider ones, whatever small font-metric differences a browser has.
        for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 900 }]) {
          const { tab, context, errors } = await open(page, { viewport, colorScheme });
          // Let demos and fonts settle before measuring.
          await tab.waitForTimeout(150);
          const m = await tab.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            bg: getComputedStyle(document.body).backgroundColor,
            failed: document.querySelectorAll(".demo-failed").length,
            demos: document.querySelectorAll("[data-demo]").length,
            ready: document.querySelectorAll("[data-demo-ready]").length,
          }));
          assert.deepEqual(errors, [], `${page} (${colorScheme}, ${viewport.width}px): console errors`);
          assert.ok(m.scroll <= m.client + 1, `${page} (${viewport.width}px): page scrolls sideways (${m.scroll} > ${m.client})`);
          assert.equal(m.failed, 0, `${page}: an interactive failed to start`);
          assert.equal(m.ready, m.demos, `${page}: not every interactive started`);
          const darkBg = "rgb(17, 19, 28)";
          if (colorScheme === "dark") assert.equal(m.bg, darkBg, `${page}: dark theme not applied`);
          else assert.notEqual(m.bg, darkBg, `${page}: light theme not applied`);
          await context.close();
        }
      }
    });
  }

  test(`[${browserName}] shell: sidebar, rail, pager and cross-references`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open(published[0].file, { viewport: { width: 1440, height: 900 } });
    const links = await tab.$$eval("#sidebar .toc-book:not(.toc-ref) a.ch-link", (as) => as.map((a) => a.getAttribute("href")));
    assert.deepEqual(links.sort(), [...published.map((c) => c.file)].sort(), "sidebar should link every written chapter");
    const refs = await tab.$$eval("#sidebar .toc-ref a", (as) => as.map((a) => a.getAttribute("href")));
    assert.deepEqual(refs, [...nav.reference.map((r) => r.file)], "sidebar should list the reference pages");
    const current = await tab.$eval('#sidebar [aria-current="page"]', (a) => a.getAttribute("href"));
    assert.equal(current, published[0].file);
    const railItems = await tab.$$eval("#rail .rail-toc a", (as) => as.length);
    assert.equal(railItems, 8, "rail should list the eight beats");
    const pager = await tab.$$eval("#pager a", (as) => as.map((a) => a.getAttribute("href")));
    assert.ok(pager.includes(published[1].file), "pager should link the next written chapter");
    const xrefs = await tab.$$eval("a.xref", (as) => as.map((a) => ({ ch: a.getAttribute("data-ch"), href: a.getAttribute("href"), planned: a.classList.contains("is-planned") })));
    assert.ok(xrefs.length > 0, "the chapter has cross-references");
    // Every cross-reference links to its chapter if written, else to its
    // contents entry, whatever the publishing state of the book.
    for (const x of xrefs) {
      const ch = nav.byNum(x.ch);
      if (ch.status === "published") {
        assert.ok(x.href && x.href.startsWith(ch.file) && !x.planned, `xref to ${x.ch} should link ${ch.file}`);
      } else {
        assert.ok(x.href === nav.contentsHref(ch.num) && x.planned, `xref to unwritten ${x.ch} should link the contents`);
      }
    }
    await context.close();
  });

  test(`[${browserName}] term cards show the glossary definition on hover and focus`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open(published[0].file);
    const term = tab.locator("main a.term[data-term]").first();
    const id = await term.getAttribute("data-term");
    await term.hover();
    const card = tab.locator("#term-card");
    await card.waitFor({ state: "visible" });
    assert.ok((await card.textContent()).includes(glossary[id].def), "card should show the definition");
    await tab.keyboard.press("Escape");
    await card.waitFor({ state: "hidden" });
    await term.focus();
    await card.waitFor({ state: "visible" });
    await context.close();
  });

  test(`[${browserName}] search finds terms and chapters, with keyboard control`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open("index.html");
    await tab.keyboard.press("/");
    const input = tab.locator("#search-input");
    await input.waitFor({ state: "visible" });
    await input.fill("stride");
    const first = tab.locator("#search-results a").first();
    assert.equal(await first.getAttribute("href"), "glossary.html#stride", "exact term should rank first");
    await input.fill("horizon");
    const hrefs = await tab.$$eval("#search-results a", (as) => as.map((a) => a.getAttribute("href")));
    assert.ok(hrefs.some((h) => h.startsWith("08-3-")), "a section of chapter 8.3 should match");
    // Any chapter not written yet must still be findable, linking to its
    // contents entry. Pick one from the data so the test survives publishing.
    const unwritten = nav.chapters.find((c) => c.status !== "published");
    if (unwritten) {
      await input.fill(unwritten.title);
      const found = await tab.$$eval("#search-results a", (as) => as.map((a) => a.getAttribute("href")));
      assert.ok(found.includes(nav.contentsHref(unwritten.num)), `unwritten chapter ${unwritten.num} should be findable`);
    }
    await input.fill("lumen");
    const lumen = await tab.$$eval("#search-results a", (as) => as.map((a) => a.getAttribute("href")));
    assert.ok(lumen.includes("glossary.html#lumen"), "terms are findable by name");
    await input.fill("zzzz-nothing");
    assert.ok(await tab.locator(".search-empty").isVisible(), "empty state shows");
    await tab.keyboard.press("Escape");
    assert.ok(!(await input.isVisible()), "Escape closes search");
    await context.close();
  });

  test(`[${browserName}] theme toggle overrides the OS theme`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open("index.html", { colorScheme: "light" });
    assert.equal(await tab.getAttribute("html", "data-theme"), null, "no saved theme: follow the OS");
    await tab.click(".theme-toggle");
    assert.equal(await tab.getAttribute("html", "data-theme"), "dark", "first click switches to dark");
    // Headless Chromium occasionally reports the old computed style for a
    // moment after a root attribute change, so wait for it to settle.
    await tab.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(17, 19, 28)", null, { timeout: 3000 });
    await tab.click(".theme-toggle");
    assert.equal(await tab.getAttribute("html", "data-theme"), "light", "second click switches back");
    await context.close();
  });

  test(`[${browserName}] home contents lists every chapter and filters`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open("index.html");
    assert.equal(await tab.locator(".contents-ch").count(), nav.chapters.length);
    await tab.click('#contents-filter button:has-text("Written so far")');
    assert.equal(await tab.locator(".contents-ch").count(), published.length);
    await tab.click('#contents-filter button:has-text("Core path")');
    assert.equal(await tab.locator(".contents-ch").count(), nav.chapters.filter((c) => c.core).length);
    // Reference links come from nav.reference, with a blurb each.
    const refs = await tab.locator("#reference-list a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert.deepEqual(refs, [...nav.reference.map((r) => r.file)]);
    assert.equal(await tab.locator("#reference-list li span").count(), nav.reference.length);
    await context.close();
  });

  test(`[${browserName}] glossary renders every entry, filters and honours #anchors`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open("glossary.html", { hash: "#stride" });
    assert.equal(await tab.locator(".g-entry").count(), Object.keys(glossary).length);
    assert.ok(await tab.locator("#stride").isVisible());
    await tab.fill("#glossary-filter", "occlusion");
    const visible = await tab.locator(".g-entry:visible").count();
    assert.ok(visible > 0 && visible < Object.keys(glossary).length, "filter narrows the list");
    await context.close();
  });

  test(`[${browserName}] vertex buffer inspector: rows, toggles and byte totals`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open("04-2-vertex-buffers.html");
    const demo = tab.locator('[data-demo="vertex-buffer-inspector"]');
    const rows = demo.locator(".byte-table tbody tr");
    assert.equal(await rows.count(), 4, "quad: 4 unique vertices");
    assert.ok((await demo.locator(".mem-bars").textContent()).includes("140 B"), "quad with 16-bit indices is 140 bytes");
    const button = (name) => demo.getByRole("button", { name, exact: true });
    await button("Off").click();
    assert.equal(await rows.count(), 6, "no index buffer: one row per triangle corner");
    await button("On").click();
    await button("Hexagon fan").click();
    assert.equal(await rows.count(), 7, "hexagon fan: 7 unique vertices");
    await button("Compact").click();
    assert.ok((await demo.textContent()).includes("One vertex = 16 bytes"), "compact position + normal + uv = 16 bytes");
    await context.close();
  });

  test(`[${browserName}] horizon explorer: keyboard moves P and values stay in range`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open("08-3-ambient-occlusion.html");
    const demo = tab.locator('[data-demo="horizon-explorer"]');
    const readout = async () => (await demo.locator(".demo-readout").textContent()).replace(/\s+/g, " ");
    const before = await readout();
    assert.ok(before.includes("3.80 m"), "P starts beside the table");
    const handle = demo.locator('[role="slider"]');
    await handle.focus();
    for (let i = 0; i < 5; i++) await tab.keyboard.press("ArrowRight");
    const afterMove = await readout();
    assert.ok(afterMove.includes("4.05 m"), `five steps of 0.05 m: ${afterMove}`);
    const values = [...afterMove.matchAll(/(\d\.\d\d)(?= \(|$| G| S)/g)].map((m) => Number(m[1]));
    assert.ok(values.every((v) => v >= 0 && v <= 1), "visibility values lie between 0 and 1");
    await demo.locator('button:has-text("SSAO samples")').click();
    assert.ok((await demo.locator("svg circle").count()) > 8, "SSAO view draws its sample points");
    await context.close();
  });

  test(`[${browserName}] cheat sheets: print buttons, one sheet per printed page`, { skip: DRAFT_MODE }, async () => {
    // Record what the page asked to print instead of opening a dialog.
    const context = await browser.newContext({ viewport: { width: 703, height: 950 }, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      window.print = () => {
        window.__printed = {
          one: document.body.dataset.printOne || null,
          target: (document.querySelector(".cs-sheet.is-print-target") || {}).id || null,
        };
      };
    });
    const tab = await context.newPage();
    await tab.goto(url("cheat-sheets.html"));
    await tab.waitForFunction(() => document.documentElement.classList.contains("hb-ready"));
    const sheets = tab.locator(".cs-sheet");
    assert.equal(await sheets.count(), 4, "four sheets");
    assert.equal(await tab.locator("[data-print]:visible").count(), 5, "script reveals Print all and four Print this sheet buttons");

    await tab.getByRole("button", { name: "Print this sheet" }).nth(2).click();
    assert.deepEqual({ ...(await tab.evaluate(() => window.__printed)) }, { one: "sheet-budgets", target: "sheet-budgets" });
    await tab.waitForFunction(() => !document.body.dataset.printOne && !document.querySelector(".is-print-target"));
    await tab.getByRole("button", { name: "Print all four" }).click();
    assert.deepEqual({ ...(await tab.evaluate(() => window.__printed)) }, { one: null, target: null });

    // 703 x 950 CSS px is the printable area of A4 (narrower) and US Letter
    // (shorter) with typical margins. Each sheet must fit on one page.
    // The print styles land over a few frames after emulateMedia, so wait
    // until two readings agree before checking.
    await tab.emulateMedia({ media: "print" });
    const measure = () => sheets.evaluateAll((els) => els.map((el) => [el.id, Math.round(el.getBoundingClientRect().height)]));
    let heights = await measure();
    for (let i = 0, prev = null; i < 30 && JSON.stringify(heights) !== JSON.stringify(prev); i++) {
      prev = heights;
      await tab.waitForTimeout(100);
      heights = await measure();
    }
    for (const [id, h] of heights) assert.ok(h <= 950, `${id} is ${h}px tall in print; it must fit one page (950px)`);
    assert.equal(await tab.locator(".cs-page > .hero").isVisible(), false, "the intro does not print");
    await context.close();
  });

  test(`[${browserName}] reaching "Check yourself" marks a chapter as read`, { skip: DRAFT_MODE }, async () => {
    const { tab, context } = await open(published[0].file, { viewport: { width: 1280, height: 900 } });
    await tab.locator("#check").scrollIntoViewIfNeeded();
    await tab.waitForFunction(() => {
      try {
        return (JSON.parse(localStorage.getItem("hb.read")) || []).length > 0;
      } catch (err) {
        return true; // storage blocked: nothing to assert
      }
    });
    const label = await tab.locator(".progress").getAttribute("aria-label");
    assert.match(label, /^1 of \d+ written chapters read$/);
    await context.close();
  });
}

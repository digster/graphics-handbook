/**
 * Lantern Courtyard tests: open the dev harness (tools/dev/courtyard.html)
 * from file:// and drive the renderer the way a reader would.
 *
 * With WebGL2 (headless Chromium has it through SwiftShader):
 *   - every instance starts with no console errors and no WebGL errors
 *   - every view produces a picture with real variation (not blank), and
 *     no two views produce the same picture
 *   - the pass scrubber lists the passes and shows each one's output, with
 *     real timings or the words "timing unavailable"
 *   - orbit responds to arrow keys and dragging
 *   - a lost WebGL context comes back
 *   - without float render targets, HDR falls back to packed 8-bit targets
 * Without WebGL2 (getContext overridden, and Chromium's --disable-webgl):
 *   - every instance still reaches data-demo-ready and shows the sketch
 *
 * Browsers: BROWSERS env var, comma separated (default "chromium"). Firefox
 * and WebKit may have no WebGL2 when headless; the WebGL tests then skip and
 * the harness test checks that the fallback appeared instead.
 *
 * Run: node --test tests/courtyard.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { ROOT } from "../tools/lib/site.mjs";

const require = createRequire(import.meta.url);
const playwright = require("playwright");

const HARNESS = pathToFileURL(join(ROOT, "tools", "dev", "courtyard.html")).href;
const BROWSERS = (process.env.BROWSERS || "chromium").split(",").map((s) => s.trim()).filter(Boolean);
const INSTANCES = ["cy-views", "cy-passes", "cy-wire"];
const WAIT = { timeout: 90000 };
// Luma standard deviation (0..255) below which a picture counts as blank.
// The sparsest real view (reflections only) measures about 15.
const MIN_STDDEV = 5;
// Chromium reports WebGL errors as console warnings such as
// "[.WebGL-...] GL_INVALID_OPERATION: ...". Performance notes are fine.
const GL_ERROR = /GL_INVALID|GL ERROR|WebGL: INVALID|CONTEXT_LOST_WEBGL/;

/* ---------- A minimal PNG decoder (8-bit RGB/RGBA, no interlace) ---------- */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a Playwright screenshot into { width, height, bpp, pixels }. */
function decodePng(buf) {
  let pos = 8;
  let header = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  assert.ok(header && header.depth === 8 && header.interlace === 0 && [2, 6].includes(header.color), "unexpected PNG format");
  const bpp = header.color === 6 ? 4 : 3;
  const stride = header.width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(header.height * stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const v = raw[src + x];
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      out[y * stride + x] = (v + predictor) & 255;
    }
  }
  return { width: header.width, height: header.height, bpp, pixels: out };
}

/** Luma mean and standard deviation, plus a hash of the pixels. */
function pictureStats(png) {
  const { pixels, bpp } = decodePng(png);
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 0; i < pixels.length; i += bpp) {
    const l = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    sum += l;
    sq += l * l;
    n++;
  }
  const mean = sum / n;
  return { mean, stddev: Math.sqrt(Math.max(0, sq / n - mean * mean)), hash: createHash("sha1").update(pixels).digest("hex") };
}

/* ---------- Page helpers ---------- */

/** Opens the harness and records console errors, page errors and GL errors. */
async function openHarness(browser, { disableWebGL = false, noFloatTargets = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch (err) {
      /* storage blocked: nothing to clear */
    }
  });
  if (disableWebGL) {
    await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (/webgl/i.test(String(type))) return null;
        return original.call(this, type, ...rest);
      };
    });
  }
  if (noFloatTargets) {
    // As on GPUs that cannot render to float textures: HDR falls back to 8 bits.
    await context.addInitScript(() => {
      if (!window.WebGL2RenderingContext) return;
      const original = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function (name) {
        return /^EXT_color_buffer_(half_)?float$/.test(name) ? null : original.call(this, name);
      };
    });
  }
  const tab = await context.newPage();
  const errors = [];
  tab.on("console", (msg) => {
    if (msg.type() === "error" || GL_ERROR.test(msg.text())) errors.push(`${msg.type()}: ${msg.text()}`);
  });
  tab.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  await tab.goto(HARNESS);
  await tab.waitForFunction((ids) => ids.every((id) => document.getElementById(id).hasAttribute("data-demo-ready")), INSTANCES, WAIT);
  return { context, tab, errors };
}

/** Scrolls an instance into view and waits for its first frame (or its fallback). */
async function settle(tab, id) {
  await tab.locator(`#${id}`).scrollIntoViewIfNeeded();
  await tab.waitForFunction((id) => {
    const el = document.getElementById(id);
    return el.getAttribute("data-webgl") === "off" || el.hasAttribute("data-rendered");
  }, id, WAIT);
  return tab.locator(`#${id}`).getAttribute("data-webgl");
}

/**
 * Waits until an instance has drawn view:step twice. Every on-demand frame
 * is drawn a second time on the next animation frame, because WebKit shows
 * a WebGL canvas one draw behind (see tick() in courtyard.js); only after
 * the second draw is the picture on screen in every browser.
 */
async function waitForFrame(tab, id, rendered, framesBefore) {
  await tab.waitForFunction(([id, rendered, before]) => {
    const el = document.getElementById(id);
    return el.getAttribute("data-rendered") === rendered && Number(el.getAttribute("data-frames")) >= before + 2;
  }, [id, rendered, framesBefore], WAIT);
}

async function frames(tab, id) {
  return Number(await tab.locator(`#${id}`).getAttribute("data-frames"));
}

async function canvasStats(tab, id) {
  return pictureStats(await tab.locator(`#${id} canvas`).screenshot());
}

/* ---------- Tests ---------- */

for (const browserName of BROWSERS) {
  let browser;
  let webgl = null; // "on" or "off", learned from the first test

  before(async () => {
    browser = await playwright[browserName].launch();
  });
  after(async () => {
    await browser?.close();
  });

  const needsWebGL = (t) => {
    if (webgl === "on") return false;
    t.skip(`${browserName} has no WebGL2 here; the fallback is covered by the harness test`);
    return true;
  };

  test(`[${browserName}] harness: all three instances start cleanly`, async (t) => {
    const { tab, context, errors } = await openHarness(browser);
    const states = [];
    for (const id of INSTANCES) states.push(await settle(tab, id));
    assert.ok(states.every((s) => s === states[0]), `instances disagree about WebGL: ${states}`);
    webgl = states[0];
    if (webgl === "off") {
      // Only a missing WebGL2 is expected; a renderer that failed to start
      // would otherwise hide behind the sketch and skip the tests below.
      const reasons = await tab.$$eval(".demo[data-fallback]", (els) => els.map((el) => el.getAttribute("data-fallback")));
      t.diagnostic(`${browserName}: no live renderer (${reasons.join(", ")})`);
      assert.ok(reasons.every((r) => r === "no-webgl2"), `renderer failed to start: ${reasons}`);
      assert.notEqual(browserName, "chromium", "headless Chromium has WebGL2 through SwiftShader");
    }
    const exposed = await tab.evaluate(() => HB.courtyard);
    assert.equal(exposed.views.length, 16, "HB.courtyard.views lists the 16 views");
    assert.deepEqual([...exposed.passes], ["shadow", "gbuffer", "ao", "lighting", "ssr", "fog", "bloom", "tonemap", "final"]);
    assert.equal(await tab.locator(".demo-failed").count(), 0, "no instance failed");
    if (webgl === "off") {
      assert.equal(await tab.locator(".demo svg.dg[role='img']").count(), 3, "each instance shows the sketch");
    } else {
      assert.equal(await tab.locator(".demo canvas").count(), 3, "each instance has its canvas");
    }
    assert.deepEqual(errors, [], "console errors");
    await context.close();
  });

  test(`[${browserName}] every view renders a picture, and each view is different`, async (t) => {
    if (needsWebGL(t)) return;
    const { tab, context, errors } = await openHarness(browser);
    await settle(tab, "cy-views");
    const { views, labels } = await tab.evaluate(() => HB.courtyard);
    const demo = tab.locator("#cy-views");
    const hashes = new Map();
    for (const view of views) {
      const before = await frames(tab, "cy-views");
      await demo.getByRole("button", { name: labels[view], exact: true }).click();
      await waitForFrame(tab, "cy-views", `${view}:final`, before);
      const s = await canvasStats(tab, "cy-views");
      assert.ok(s.stddev > MIN_STDDEV, `${view}: picture looks blank (luma std dev ${s.stddev.toFixed(1)})`);
      assert.ok(!hashes.has(s.hash), `${view}: identical to ${hashes.get(s.hash)}`);
      hashes.set(s.hash, view);
      const readout = await demo.locator(".demo-readout").textContent();
      assert.ok(readout.includes(labels[view]), `${view}: readout names the view`);
    }
    assert.deepEqual(errors, [], "console errors");
    await context.close();
  });

  test(`[${browserName}] pass scrubber steps through every pass`, async (t) => {
    if (needsWebGL(t)) return;
    const { tab, context, errors } = await openHarness(browser);
    await settle(tab, "cy-passes");
    const passes = await tab.evaluate(() => HB.courtyard.passes);
    const demo = tab.locator("#cy-passes");
    assert.equal(await demo.locator(".byte-table tbody tr").count(), passes.length, "one row per pass");
    assert.equal(await demo.locator("tr.is-hot").count(), 1, "the current pass is highlighted");
    const slider = demo.locator('input[type="range"]');
    await slider.focus();
    for (let i = 0; i < passes.length; i++) {
      const before = await frames(tab, "cy-passes");
      await tab.keyboard.press(i === 0 ? "Home" : "ArrowRight");
      await waitForFrame(tab, "cy-passes", `final:${passes[i]}`, before);
      const s = await canvasStats(tab, "cy-passes");
      assert.ok(s.stddev > MIN_STDDEV, `after ${passes[i]}: picture looks blank (${s.stddev.toFixed(1)})`);
    }
    const gpu = await demo.locator(".demo-readout .r").last().textContent();
    assert.match(gpu, /(\d+\.\d+ ms|…|timing unavailable)$/, `GPU time shows a measurement or says it is unavailable: ${gpu}`);
    assert.deepEqual(errors, [], "console errors");
    await context.close();
  });

  test(`[${browserName}] orbit follows arrow keys and dragging`, async (t) => {
    if (needsWebGL(t)) return;
    const { tab, context, errors } = await openHarness(browser);
    await settle(tab, "cy-views");
    const start = await canvasStats(tab, "cy-views");
    const canvas = tab.locator("#cy-views canvas");
    let before = await frames(tab, "cy-views");
    await canvas.focus();
    await tab.keyboard.press("Shift+ArrowLeft");
    await waitForFrame(tab, "cy-views", "final:final", before);
    const afterKeys = await canvasStats(tab, "cy-views");
    assert.notEqual(afterKeys.hash, start.hash, "arrow key moved the camera");
    before = await frames(tab, "cy-views");
    const box = await canvas.boundingBox();
    await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await tab.mouse.down();
    await tab.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 4 });
    await tab.mouse.up();
    await waitForFrame(tab, "cy-views", "final:final", before);
    const afterDrag = await canvasStats(tab, "cy-views");
    assert.notEqual(afterDrag.hash, afterKeys.hash, "dragging moved the camera");
    assert.deepEqual(errors, [], "console errors");
    await context.close();
  });

  test(`[${browserName}] a lost WebGL context is restored`, async (t) => {
    if (needsWebGL(t)) return;
    const { tab, context, errors } = await openHarness(browser);
    await settle(tab, "cy-wire");
    // Keep the extension object: getExtension() returns null once the context is lost.
    const hasExt = await tab.evaluate(() => {
      window.__cyLose = document.querySelector("#cy-wire canvas").getContext("webgl2").getExtension("WEBGL_lose_context");
      return !!window.__cyLose;
    });
    if (!hasExt) {
      t.skip("WEBGL_lose_context is not available");
      await context.close();
      return;
    }
    const before = await frames(tab, "cy-wire");
    await tab.evaluate(() => window.__cyLose.loseContext());
    // restoreContext() is only allowed once the "lost" event has been handled;
    // the renderer's handler says so in the instance's note.
    await tab.waitForFunction(() => /context was lost/.test(document.querySelector("#cy-wire").textContent), null, WAIT);
    await tab.evaluate(() => window.__cyLose.restoreContext());
    await waitForFrame(tab, "cy-wire", "wireframe:final", before);
    const s = await canvasStats(tab, "cy-wire");
    assert.ok(s.stddev > MIN_STDDEV, `picture after restore looks blank (${s.stddev.toFixed(1)})`);
    assert.deepEqual(errors.filter((e) => !/CONTEXT_LOST_WEBGL/.test(e)), [], "console errors");
    await context.close();
  });

  test(`[${browserName}] without float render targets HDR falls back to 8 bits`, async (t) => {
    if (needsWebGL(t)) return;
    const { tab, context, errors } = await openHarness(browser, { noFloatTargets: true });
    await settle(tab, "cy-passes");
    const table = await tab.locator("#cy-passes .byte-table").textContent();
    assert.ok(table.includes("RGBA8 (packed)"), "the pass list reports the packed 8-bit HDR format");
    await settle(tab, "cy-views");
    const demo = tab.locator("#cy-views");
    for (const view of ["final", "bloom", "hdr-clipped"]) {
      const before = await frames(tab, "cy-views");
      await demo.getByRole("button", { name: await tab.evaluate((v) => HB.courtyard.labels[v], view), exact: true }).click();
      await waitForFrame(tab, "cy-views", `${view}:final`, before);
      const s = await canvasStats(tab, "cy-views");
      assert.ok(s.stddev > MIN_STDDEV, `${view} (8-bit HDR): picture looks blank (${s.stddev.toFixed(1)})`);
    }
    assert.deepEqual(errors, [], "console errors");
    await context.close();
  });

  test(`[${browserName}] without WebGL2 every instance shows the sketch`, async () => {
    const { tab, context, errors } = await openHarness(browser, { disableWebGL: true });
    await assertFallback(tab);
    assert.deepEqual(errors, [], "console errors");
    await context.close();
  });

  if (browserName === "chromium") {
    test("[chromium] launched with --disable-webgl, every instance shows the sketch", async () => {
      const noGL = await playwright.chromium.launch({ args: ["--disable-webgl"] });
      try {
        const { tab, context, errors } = await openHarness(noGL);
        await assertFallback(tab);
        assert.deepEqual(errors, [], "console errors");
        await context.close();
      } finally {
        await noGL.close();
      }
    });
  }
}

async function assertFallback(tab) {
  for (const id of INSTANCES) {
    assert.equal(await settle(tab, id), "off", `${id}: should report data-webgl="off"`);
    const demo = tab.locator(`#${id}`);
    assert.equal(await demo.locator("canvas").count(), 0, `${id}: no canvas left behind`);
    assert.equal(await demo.locator("svg.dg[role='img']").count(), 1, `${id}: shows the sketch`);
    assert.ok((await demo.locator(".demo-hint").first().textContent()).length > 0, `${id}: explains why`);
  }
  assert.equal(await tab.locator(".demo-failed").count(), 0, "no instance failed");
}

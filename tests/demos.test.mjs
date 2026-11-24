/**
 * Interactive tests: drive the interactives that expose a model (HB.*) or a
 * readout, and check two things:
 *
 *   1. the model is right: a BVH finds the same hit as testing every
 *      triangle, cascades tile the view range, tone curves keep mid-grey
 *      and never go backwards, TAA converges and clamping removes ghosts;
 *   2. the chapter's numbers come from the model: where a chapter quotes a
 *      figure the interactive produces (11.1's budget, 11.4's hitch session),
 *      the test reproduces it, so editing one without the other fails.
 *
 * Every page loads from file://, like the other browser tests.
 * Run: node --test tests/demos.test.mjs (or npm run test:browser)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { DOCS, DRAFT_MODE } from "../tools/lib/site.mjs";

const require = createRequire(import.meta.url);
const playwright = require("playwright");

const BROWSERS = (process.env.BROWSERS || "chromium").split(",").map((s) => s.trim()).filter(Boolean);
const url = (page) => pathToFileURL(join(DOCS, page)).href;

for (const browserName of BROWSERS) {
  let browser;

  before(async () => {
    browser = await playwright[browserName].launch();
  });
  after(async () => {
    await browser?.close();
  });

  /** Opens a chapter with empty storage and waits for the shell and demos. */
  async function open(page) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch (err) {
        /* storage blocked: nothing to clear */
      }
    });
    const tab = await context.newPage();
    const errors = [];
    tab.on("pageerror", (err) => errors.push(err.message));
    await tab.goto(url(page));
    await tab.waitForFunction(() => document.documentElement.classList.contains("hb-ready"));
    return { tab, context, errors };
  }

  const opts = { skip: DRAFT_MODE };

  test(`[${browserName}] budget builder (11.1): readout, v-sync and Apply match the chapter`, opts, async () => {
    const { tab, context, errors } = await open("11-1-frame-budgets.html");
    const demo = tab.locator('[data-demo="budget-builder"]');
    const readout = async () => (await demo.locator(".demo-readout").innerText()).replace(/\s+/g, " ").toLowerCase();

    // Defaults: the numbers the chapter's diagrams use.
    let r = await readout();
    assert.match(r, /budget 16\.7 ms/);
    assert.match(r, /gpu 14\.3 ms/, `default GPU time: ${r}`);
    assert.match(r, /limited by gpu/);
    assert.match(r, /with v-sync at 60 hz 60 fps/);

    // Real-time GI pushes the GPU over budget; with v-sync the game halves to 30.
    await demo.locator("#bb-gi").check();
    r = await readout();
    assert.match(r, /gpu 20\.9 ms/, `GI on: ${r}`);
    assert.match(r, /over by 4\.2 ms/);
    assert.match(r, /with v-sync at 60 hz 30 fps/);

    // The first suggested cut is the biggest saving; applying it restores the budget.
    const first = (await demo.locator("ul li").first().innerText()).replace(/\s+/g, " ");
    assert.match(first, /^Real-time GI off saves 6\.6 ms/);
    await demo.getByRole("button", { name: "Apply", exact: true }).first().click();
    r = await readout();
    assert.match(r, /gpu 14\.3 ms/);
    assert.equal(await demo.locator("#bb-gi").isChecked(), false, "Apply syncs the checkbox");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`[${browserName}] hitch gallery (11.4): the session matches the chapter's figures`, opts, async () => {
    const { tab, context } = await open("11-4-memory-hitches.html");
    const s = await tab.evaluate(() => {
      const g = window.HB.hitchGallery;
      return { before: g.stats(g.build(false)), after: g.stats(g.build(true)) };
    });
    // 11.4: "a 60-second session averages 69 fps but has a 1% low of 19 fps,
    // with 217 frames over the 16.7 ms budget" and "after the fixes the 1% low
    // is 65 fps and no frame is over budget".
    assert.equal(Math.round(s.before.avgFps), 69);
    assert.equal(Math.round(s.before.low1), 19);
    assert.equal(s.before.over, 217);
    assert.ok(s.before.hitches > 0, "the broken session has hitches");
    assert.equal(Math.round(s.after.low1), 65);
    assert.equal(s.after.over, 0);
    assert.equal(s.after.hitches, 0);
    await context.close();
  });

  test(`[${browserName}] BVH traversal (8.6): same hit as testing every triangle, far fewer tests`, opts, async () => {
    const { tab, context } = await open("08-6-ray-tracing.html");
    const r = await tab.evaluate(() => {
      const { tris, bvh, traverse, rayTri } = window.HB.bvhTraversal;
      const rng = window.HB.rng(7);
      const box = bvh.root.box;
      const out = { rays: 0, mismatches: [], anyMismatches: 0, triTests: 0, hits: 0 };
      for (let i = 0; i < 300; i++) {
        const o = { x: box.x0 + rng() * (box.x1 - box.x0), y: box.y0 + rng() * (box.y1 - box.y0) };
        const a = rng() * Math.PI * 2;
        const d = { x: Math.cos(a), y: Math.sin(a) };
        const tMax = 2000;
        let best = Infinity;
        tris.forEach((t) => { best = Math.min(best, rayTri(o, d, t, tMax)); });
        const closest = traverse(bvh, tris, o, d, tMax, "closest");
        const any = traverse(bvh, tris, o, d, tMax, "any");
        const brute = best < Infinity ? best : null;
        if ((brute === null) !== (closest.tHit === null) || (brute !== null && Math.abs(brute - closest.tHit) > 1e-6)) {
          out.mismatches.push({ i, brute, bvh: closest.tHit });
        }
        if ((brute === null) !== (any.hit === null)) out.anyMismatches++;
        if (brute !== null) out.hits++;
        out.triTests += closest.triTests;
        out.rays++;
      }
      out.avgTriTests = out.triTests / out.rays;
      out.triangles = tris.length;
      return out;
    });
    assert.deepEqual(r.mismatches, [], "closest-hit traversal disagrees with brute force");
    assert.equal(r.anyMismatches, 0, "any-hit traversal disagrees on whether something is hit");
    assert.ok(r.hits > 50, `enough rays hit something to be meaningful (${r.hits})`);
    assert.ok(r.avgTriTests < r.triangles / 4, `BVH tests ${r.avgTriTests.toFixed(1)} of ${r.triangles} triangles per ray`);
    await context.close();
  });

  test(`[${browserName}] cascade splits (7.5): cascades tile the range and grow with distance`, opts, async () => {
    const { tab, context } = await open("07-5-shadows-at-scale.html");
    const r = await tab.evaluate(() => {
      const c = window.HB.cascadeSplits;
      return {
        near: c.NEAR,
        uniform: c.splits(4, 201, 0),
        log: c.splits(4, 10000, 1),
        list: c.cascades(4, 200, 0.75, 2048),
      };
    });
    // lambda 0 is uniform: equal steps from NEAR to far.
    r.uniform.forEach((z, i) => assert.ok(Math.abs(z - (r.near + 50 * (i + 1))) < 1e-9, `uniform split ${i}: ${z}`));
    // lambda 1 is logarithmic: each split ten times the last for 1 to 10,000 m.
    r.log.forEach((z, i) => assert.ok(Math.abs(z / 10 ** (i + 1) - 1) < 1e-9, `log split ${i}: ${z}`));
    assert.equal(r.list[0].z0, r.near, "the first cascade starts at the near plane");
    assert.equal(r.list.at(-1).z1, 200, "the last cascade ends at the shadow distance");
    for (let i = 1; i < r.list.length; i++) {
      assert.equal(r.list[i].z0, r.list[i - 1].z1, `cascade ${i} starts where ${i - 1} ends`);
      assert.ok(r.list[i].texel > r.list[i - 1].texel, `cascade ${i} has bigger texels than ${i - 1}`);
    }
    await context.close();
  });

  test(`[${browserName}] tone curve lab (9.1): every curve keeps mid-grey and never goes backwards`, opts, async () => {
    const { tab, context } = await open("09-1-tone-mapping.html");
    const r = await tab.evaluate(() => {
      const t = window.HB.toneCurveLab;
      const grey = t.linearToSrgb(0.18);
      return t.ops.map((op) => {
        let monotonic = true;
        let prev = -1;
        for (let s = -10; s <= 10; s += 0.05) {
          const v = t.curve(op, 0.18 * 2 ** s, 0);
          if (v < prev - 1e-9) monotonic = false;
          prev = v;
        }
        return {
          id: op.id,
          greyError: Math.abs(t.curve(op, 0.18, 0) - grey),
          monotonic,
          bright: t.curve(op, 0.18 * 2 ** 6, 0),
          black: t.curve(op, 0, 0),
        };
      });
    });
    assert.deepEqual(r.map((o) => o.id), ["clip", "reinhard", "aces", "agx"]);
    for (const o of r) {
      assert.ok(o.greyError < 2e-3, `${o.id}: mid-grey moves by ${o.greyError}`);
      assert.ok(o.monotonic, `${o.id}: brighter light gives a darker pixel somewhere`);
      assert.ok(o.black < 0.02, `${o.id}: black is not black (${o.black})`);
    }
    const byId = Object.fromEntries(r.map((o) => [o.id, o]));
    assert.ok(byId.clip.bright > 1 - 1e-9, "without tone mapping, six stops over grey clips to white");
    assert.ok(byId.reinhard.bright < 1, "Reinhard approaches white but never reaches it");
    await context.close();
  });

  test(`[${browserName}] TAA time machine (9.2): history converges, clamping removes ghosts`, opts, async () => {
    const { tab, context } = await open("09-2-anti-aliasing.html");
    const r = await tab.evaluate(() => {
      const t = window.HB.taaTimeMachine;
      function run(mode, frames, clamp) {
        const sim = t.simulate({ mode, frames, clamp, minWeight: 0.1, probe: [10, 4] });
        return t.measure(mode, frames, sim.history, sim.raw);
      }
      const jit = [];
      for (let k = 1; k <= 16; k++) jit.push(t.jitter(k));
      return {
        still8: run("still", 8, false),
        still16: run("still", 16, false),
        movingNoClamp: run("moving", 16, false),
        movingClamp: run("moving", 16, true),
        jitterInPixel: jit.every(([x, y]) => x >= -0.5 && x < 0.5 && y >= -0.5 && y < 0.5),
        jitterDistinct: new Set(jit.map((j) => j.join())).size,
      };
    });
    assert.ok(r.jitterInPixel, "jitter offsets stay inside the pixel");
    assert.equal(r.jitterDistinct, 16, "sixteen frames, sixteen different offsets");
    assert.ok(r.still8.edgeError < r.still8.rawError / 2, `history beats one frame on edges (${r.still8.edgeError} vs ${r.still8.rawError})`);
    assert.ok(r.still16.edgeError <= r.still8.edgeError + 1e-9, "more frames do not make a still image worse");
    assert.ok(r.movingNoClamp.ghosts > 0, "without clamping, the moving object leaves a ghost");
    assert.ok(r.movingClamp.ghosts < r.movingNoClamp.ghosts, `clamping removes ghost pixels (${r.movingClamp.ghosts} vs ${r.movingNoClamp.ghosts})`);
    await context.close();
  });

  test(`[${browserName}] bounce room (8.1): each bounce carries less light than the last`, opts, async () => {
    const { tab, context } = await open("08-1-indirect-light.html");
    const r = await tab.evaluate(() => {
      const b = window.HB.bounceRoom;
      const sol = b.solve(true);
      const direct = b.total(sol, 0);
      const all = b.total(sol, Infinity);
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      return {
        shares: sol.shares.slice(0, 6),
        bounces: sol.shares.length,
        brighter: all.every((c, i) => lum(c) >= lum(direct[i]) - 1e-12),
        unlitButLit: all.filter((c, i) => lum(direct[i]) === 0 && lum(c) > 0).length,
      };
    });
    assert.equal(r.shares[0], 1, "direct light is the reference");
    for (let i = 1; i < r.shares.length; i++) {
      assert.ok(r.shares[i] < r.shares[i - 1], `bounce ${i} carries less than bounce ${i - 1}`);
    }
    assert.ok(r.bounces < 400, "the bounces converge");
    assert.ok(r.brighter, "adding bounces never darkens a patch");
    assert.ok(r.unlitButLit > 0, "bounced light reaches patches the sun does not");
    await context.close();
  });

  test(`[${browserName}] brief builder (12.2): scores, composes and copies the brief`, opts, async () => {
    const { tab, context, errors } = await open("12-2-briefing-ai.html");
    const r = await tab.evaluate(() => {
      const b = window.HB.briefBuilder;
      const none = {};
      const all = {};
      b.elements.forEach((el) => { all[el.id] = true; });
      return {
        elements: b.elements.map((el) => el.id),
        none: b.score(none),
        all: b.score(all),
        tasks: b.tasks.map((task) => ({
          id: task.id,
          ask: task.ask,
          composedNone: b.compose(task.id, none),
          composedAll: b.compose(task.id, all),
          parts: b.elements.map((el) => task.parts[el.id]),
        })),
      };
    });
    assert.equal(r.elements.length, 7, "seven elements of a strong brief");
    assert.deepEqual({ ...r.none }, { count: 0, left: 7, verdict: "Weak", checkable: false });
    assert.deepEqual({ ...r.all }, { count: 7, left: 0, verdict: "Strong", checkable: true });
    for (const task of r.tasks) {
      assert.equal(task.composedNone, task.ask, `${task.id}: with nothing on, the brief is the one-line ask`);
      assert.ok(task.parts.every((p) => typeof p === "string" && p.length > 20), `${task.id}: every element has text`);
      assert.equal(task.composedAll, [task.ask, ...task.parts].join("\n\n"), `${task.id}: elements appear in template order`);
    }
    // The UI starts from the one-line ask of the first task; switching the
    // first element on adds its paragraph, and "Add all" gives the full brief.
    const demo = tab.locator('[data-demo="brief-builder"]');
    const body = async () => (await demo.locator("pre.prompt-body").textContent()).trim();
    const first = r.tasks[0];
    assert.equal(await body(), first.ask, "the brief starts as one line");
    await demo.locator(`#bb2-${r.elements[0]}`).check();
    assert.equal(await body(), [first.ask, first.parts[0]].join("\n\n"), "one element adds one paragraph");
    await demo.getByRole("button", { name: "Add all", exact: true }).click();
    assert.equal(await body(), first.composedAll, "Add all assembles the full brief");
    await demo.getByRole("button", { name: "Back to one line", exact: true }).click();
    assert.equal(await body(), first.ask, "Back to one line resets the brief");
    assert.deepEqual(errors, []);
    await context.close();
  });
}

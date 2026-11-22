# Learnings

Things this codebase taught us the hard way. Read before changing the
related area.

## CSS and layout

- **Auto-fit grids overflow phones unless the minimum can shrink.**
  `repeat(auto-fit, minmax(220px, 1fr))` made a 390px page scroll sideways to
  480px. Always write `minmax(min(220px, 100%), 1fr)`.
- **`display: grid` or `flex` on a component beats the browser's `[hidden]`
  rule**, so `el.hidden = true` did nothing on the term card. `site.css` has
  a global `[hidden] { display: none !important; }`; keep it.
- **Unsized inline SVG icons render at 300 × 150.** A search icon inside a
  flex row squeezed the input to 0px wide. The shell's `icon()` sets
  `width`/`height` attributes; any new SVG icon needs a size too.

## SVG diagrams

- **SVG `<text>` collapses runs of spaces**, so column-aligned text in one
  string does not line up. Use one `<text>` per column with its own `x`.
- **Stroke classes must not reset fill on shapes that also have a fill
  class.** `diagrams.css` sets `fill: none` only for elements with an `s-*`
  class token and no `f-*` token, matched on class-token boundaries so names
  such as `is-wide` are not caught.
- **Text classes on a `<g>` do nothing.** `svg.dg text` sets font, size
  and fill on every `<text>` directly, so `<g class="t-small t-muted">`
  does not reach its children. Put `t-*` classes on each `<text>`.
- When a figure claims numbers (angles, bytes, percentages), compute them
  rather than eyeballing. Two early drafts had a 128-byte bracket spanning
  2.5 vertices and a "same corner" marked at a point that was not shared.

## Tests and tooling

- **Arrays from a `vm` sandbox fail `assert.deepStrictEqual`** against
  normal arrays, because their prototype belongs to another realm. Spread
  them (`[...x]`) before comparing.
- **ES `import` ignores `NODE_PATH`.** The cloud session's Playwright is
  global, so tests load it with `createRequire(import.meta.url)("playwright")`.
- **Chromium keeps `file://` localStorage across Playwright contexts and
  launches.** A theme saved by one test leaked into the next run. Browser
  tests clear storage with `context.addInitScript` before every page.
- **Headless Chromium can report a stale computed style for a moment** after
  a root attribute change (seen with `data-theme`). Wait for the style with
  `waitForFunction` rather than reading it once.
- **`has-text("On")` matches "Hexagon fan"** (case-insensitive substring).
  Use `getByRole("button", { name, exact: true })`.
- **`<input type="search">` spends the first Escape clearing itself**, so
  the search dialog did not close. The shell handles Escape on the input.

## Content accuracy

- Engine setting names drift between versions. Check them against current
  docs for every chapter and print the versions checked in the `.stamp`.
  Epic's documentation pages only render with `?application_version=X.Y` in
  the URL; Unity's documentation has moved to `docs.unity.com`.
- Epic's own docs disagree on the bit depth behind "Use High Precision
  Tangent Basis", so the handbook does not print one.
- HDRP's documentation does not say its AO is GTAO; only its source does.
  Say so, rather than presenting it as documented.
- In the horizon explorer, GTAO's hard radius cut-off can skip a tall
  feature whose top sits just outside the radius, which hid the very
  artifact the demo exists to show. The default position of P was moved
  beside the table so the halo is visible on load.

## WebGL (courtyard renderer)

- GLSL ES reserves `half` as an identifier, and `#if` on an undefined macro
  is a compile error; use `#ifdef`.
- `getExtension()` returns null once a context is lost, so keep the
  `WEBGL_lose_context` object obtained before the loss.
- Point-sampling the sky, sun disc included, for rough reflections put a
  warm haze over the whole image; reflections must leave out the sun disc.
- `replaceChildren(null)` inserts the text "null"; filter nulls first.

## Writing chapters in parallel

- Writers work in the shared tree but must not touch shared files; they
  put new glossary terms in draft JSON files, and `tools/merge-drafts.mjs`
  refuses an id already owned by another chapter. Two drafts still claimed
  `command-buffer` and `unified-memory` after earlier chapters owned them,
  so check every draft for conflicts before merging.
- While other drafts sit untracked in `docs/`, the whole-site tests fail
  locally ("page exists but chapter planned"). Verify each batch in a
  clean `git worktree` of the commit, which is what CI sees, and stage
  exact paths, never `git add -A`.
- About nine parallel writers exhausted the 5-hour usage window in roughly
  an hour; the agents stop cleanly and resume with `SendMessage`.
- Writers sharing one scratch folder overwrote each other's generator
  scripts; give each its own.

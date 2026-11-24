# Architecture

The Graphics Handbook is a static website with no build step and no server.
The `docs/` folder is the site: GitHub Pages serves it as-is, and the same
files open straight from disk by double-clicking `docs/index.html`. Node is
used only by authors, for tests and for regenerating the search index.

## Big picture

```
            authors edit                          readers load (file:// or Pages)
   ┌──────────────────────────────┐        ┌───────────────────────────────────────┐
   │ docs/<chapter>.html           │──────▶ │ static content: prose, SVG diagrams   │
   │ docs/assets/js/data/nav.js    │──┐     │                                       │
   │ docs/assets/js/data/glossary.js│─┼───▶ │ shell.js builds the chrome from data: │
   └──────────────────────────────┘  │     │  header, sidebar, rail, pager, footer, │
                                     │     │  term cards, search, theme, progress   │
   tools/build-search-index.mjs ◀────┘     │                                       │
        │ reads nav, glossary, pages       │ demos/kit.js + demos/<name>.js        │
        ▼                                  │  mount interactives on [data-demo]    │
   docs/assets/js/data/search-index.js ──▶ │                                       │
   (generated, committed)                  └───────────────────────────────────────┘
```

- **Content is static HTML.** Each chapter is one hand-written page. Prose,
  tables and diagrams are in the HTML, so a page reads fine without
  JavaScript.
- **Chrome is generated.** Navigation, cross-references, glossary cards and
  search are built at load time by `shell.js` from `nav.js` and
  `glossary.js`. There is one source of truth for the table of contents and
  one for definitions; no page repeats them.
- **Interactives are progressive.** A `<div class="demo" data-demo="name">`
  holds a no-JS fallback sentence; the demo script replaces it.

## Why the file:// constraints exist

Browsers treat a page opened from disk more strictly than one served over
HTTP. Every rule below is enforced by `tests/structure.test.mjs`.

| Rule | Reason |
| --- | --- |
| Classic `<script src>` only, no `type="module"`, no `import` | Module scripts are blocked on `file://`. |
| No `fetch()` or XHR | Requests to `file://` URLs are blocked. Data ships as `.js` files that assign `window.HB.*`. |
| Pages sit flat in `docs/`, links are relative and end in `.html` | Works from disk and under a GitHub Pages project path (`/graphics-handbook/`). No leading `/`. |
| No CDN, fonts self-hosted in `docs/assets/fonts/` | Works offline; nothing third-party is loaded. |
| WebGL textures must be generated in code (future courtyard renderer) | Images loaded from `file://` taint WebGL. |
| `localStorage` is a convenience only | It can be blocked; every access is wrapped in try/catch. |

## Key files

| Path | Role |
| --- | --- |
| `docs/index.html`, `docs/assets/js/home.js` | Cover, learning path, rendered contents with filters. |
| `docs/glossary.html`, `docs/assets/js/glossary-page.js` | Glossary rendered from data, with a filter and `#id` anchors. |
| `docs/NN-C-slug.html` | One chapter. The name comes from `HB.nav.fileOf()`: two-digit part, chapter, slug. |
| `docs/assets/js/data/nav.js` | Parts and chapters: number, slug, title, terms, `core`, `status`. |
| `docs/assets/js/data/glossary.js` | Terms keyed by id: `term`, `aka`, `def`, `ch` (the chapter that teaches it). |
| `docs/assets/js/data/search-index.js` | Generated. Never edit by hand. |
| `docs/assets/js/theme-init.js` | Loaded in `<head>`; applies a saved theme before first paint. |
| `docs/assets/js/log.js` | Levelled logger (`HB.log.scope(name)`). |
| `docs/assets/js/shell.js` | Header tools, sidebar, rail, pager, footer, term cards, search, theme toggle, progress, copy buttons, cross-references. |
| `docs/assets/demos/kit.js` | Demo helpers: `HB.demos.register`, `HB.svg`, `HB.html`, `HB.segmented`, `HB.slider`, `HB.draggable`, `HB.rng`, `HB.fmt`. |
| `docs/assets/demos/*.js` | One script per interactive. |
| `docs/assets/demos/courtyard*.js` | The Lantern Courtyard WebGL2 renderer (see below). |
| `tools/check-chapter.mjs` | Draft check: structure and browser page tests for named chapters with draft glossary entries. |
| `tools/merge-drafts.mjs` | Merges draft glossary JSON into `glossary.js` and publishes chapters in `nav.js`. |
| `tools/link-terms.mjs` | Links the first plain-text mention of each multi-word or acronym glossary term on every published chapter (`data-forward` when the term is taught later). Idempotent; exports `linkTerms()` for the tests. |
| `tools/build-sources-page.mjs` | Writes `docs/sources.html` from each chapter's `#sources` list; exports `buildSourcesPage()` for the tests. |
| `tools/screenshot.mjs` | Screenshots pages or figures for visual review. |
| `tools/dev/courtyard.html` | Development harness for the courtyard renderer (not part of the site). |
| `docs/assets/css/tokens.css` | Every colour, font, size and space token, plus `@font-face`. |
| `docs/assets/css/site.css` | Layout, shell and content components. |
| `docs/assets/css/diagrams.css` | The class vocabulary for SVG diagrams and demo UI. |
| `tools/lib/site.mjs` | Loads `nav.js`/`glossary.js` in a Node `vm` sandbox; small HTML helpers. |
| `tools/build-search-index.mjs` | Writes `search-index.js`; exports `buildIndex()` for the tests. |
| `plan/handbook-plan.html` | The approved build plan (body of a published Claude artifact). |

## Page templates

Every page shares the same head (theme-init, three stylesheets) and the
same script order at the end of `<body>`:
`log.js → nav.js → glossary.js → search-index.js → shell.js`, then page
scripts (`kit.js` before any demo or `home.js`).

`<body data-page="4.2">` tells the shell which chapter it is on (`home`
and `glossary` for the other pages). Shell containers: `#header-tools`,
`#sidebar`, `#rail`, `#pager`, `#site-footer`.

### Chapter structure

A chapter is an `<article class="chapter">` with a `chapter-head` and then
exactly eight sections, in this order, each written as
`<section class="beat" id="X" data-beat="X">`:

`picture` · `plain` · `how` · `cost` · `breaks` · `engines` · `ai` · `check`

followed by `<section class="sources" id="sources">`. "How it works" is split
into `.step` blocks whose `h3` carries an `id`; those headings become search
entries. `#check` needs at least three `.quiz` questions; reaching it marks
the chapter read.

### Markup conventions

| Markup | Meaning |
| --- | --- |
| `<dfn class="term" data-term="id">` | This chapter introduces the term. Must match `glossary[id].ch`. |
| `<a class="term" data-term="id" href="glossary.html#id">` | Mention of a term taught elsewhere. |
| `... data-forward` on that link | The term is taught in a **later** chapter. Required, and only allowed, when it is. |
| `<a class="xref" data-ch="4.3">` | Cross-reference. The shell links it, or points it at the contents if unwritten. |
| `.note[data-kind=lead\|simplified\|warning]` | Callouts. "simplified" flags where the story hides detail. |
| `details.fold` | Optional maths or code. |
| `.prompt` with `.prompt-head` / `.prompt-body` / `.prompt-why` | "Say it to your AI" brief; the shell adds the copy button. |
| `.symptoms > .symptom` | Failure gallery card: thumbnail, cause, what to ask for. |
| `table.engines` | Unreal / Unity / Godot comparison, followed by a `.stamp` with the docs versions checked. |

### Diagram conventions

- Inline `<svg class="dg">` inside `<figure>` with a `<figcaption>`.
  Add `role="img"` and an `aria-label` that states the same claim.
- Colours only through `diagrams.css` classes: `t-*` text, `f-*` fills,
  `s-*` strokes, `stop-*` gradient stops. A literal colour fails the tests.
  Colour meaning is fixed: accent blue = this chapter's idea, teal = geometry,
  amber = light, rose = screen-space data.
- Pictures of GPU buffers use `--buffer-hi` / `--buffer-lo`, which do not
  change with theme.
- `is-wide` (min 680px) diagrams scroll inside `.fig-frame` on phones rather
  than shrinking their text.
- Ids in `<defs>` must be unique per page; prefix them per figure
  (`pic-`, `lay-`, `gt-`...).

## Adding things

**A chapter.** Copy an existing chapter page, keep the head, body
attributes, shell containers and script order. Write the eight beats. Set
its `status` to `"published"` in `nav.js`. Add glossary entries for every
term it introduces, with `ch` set to the chapter. Run
`node tools/link-terms.mjs` (links first mentions of terms other chapters
own), then `npm run build` (sources page and search index), then `npm test`.

**A glossary term.** Add it to `glossary.js` with the chapter that teaches
it. If that chapter is published, the page must have a matching `<dfn>`.

**An interactive.** Create `docs/assets/demos/<name>.js` that calls
`HB.demos.register("<name>", init)`, place
`<div class="demo" data-demo="<name>">fallback text</div>` in a figure, and
load the script after `kit.js`. Build vector demos as SVG with diagram
classes (they theme for free); per-pixel demos would use a canvas, read
colours with `HB.demos.color()` and redraw on `hb:themechange`. Add a
browser test that drives it.

## The Lantern Courtyard renderer

`docs/assets/demos/courtyard-gl.js`, `courtyard-shaders.js` and
`courtyard.js` (loaded in that order, after `kit.js`) are a small WebGL2
deferred renderer that chapters embed to show a real scene and its buffers.

- **Scene:** a stone courtyard at dusk (arch, crates, lantern on a post,
  puddle, banner animated in the vertex shader, back wall). All geometry and
  textures are generated in code; images loaded from `file://` would taint
  WebGL.
- **Passes:** `shadow, gbuffer, ao, lighting, ssr, fog, bloom, tonemap,
  final` (plus `geometry` for wireframe and triangle views). Each view runs
  only the passes it needs, so "No AO" really skips AO.
- **Embedding:** `<div class="demo" data-demo="courtyard" data-view="final"
  data-views="final,albedo,normals" data-passes="off" data-orbit="off">`.
  Views: `final, wireframe, albedo, normals, depth, roughness, shadow-map,
  ao, lighting, no-ao, no-shadows, ssr, fog-off, bloom, hdr-clipped,
  triangles`. `data-passes="on"` adds the pass scrubber (chapter 10.1).
  `data-orbit="on"` lets readers drag or use arrow keys to move the camera.
- **Without WebGL2** (some headless browsers, old devices) it shows a
  designed SVG fallback and still reaches `data-demo-ready`; lost contexts
  recover. It renders only while visible and only on change, except the
  banner animation, which respects reduced motion.
- **Development:** `tools/dev/courtyard.html` is a harness with three
  instances; `tests/courtyard.test.mjs` checks every view renders a
  distinct, non-blank image, the scrubber, orbit, context loss and every
  fallback path. `window.HB.courtyard` exposes `{ views, passes, labels }`.

## Workflows

```bash
npm ci                     # author tooling only (Playwright)
node tools/link-terms.mjs  # link first mentions of glossary terms (--dry-run to preview)
npm run build              # regenerate docs/sources.html, then the search index
npm run build:search       # only the search index
npm test                   # structure + browser tests
npm run test:structure     # fast, no browser
npm run test:browser       # Chromium by default; page, courtyard and interactive tests
BROWSERS=chromium,firefox,webkit npm run test:browser   # what CI runs
LOG_LEVEL=debug npm run build:search
```

`tests/demos.test.mjs` drives the interactives that expose a model as
`window.HB.<name>` (BVH, cascades, tone curves, TAA, bounce room, hitch
gallery, brief builder) or a readout (budget builder). Where a chapter
quotes a number an interactive produces (11.1's budget, 11.4's hitch
session), the test asserts that number, so prose and model cannot drift
apart. Expose a model the same way when a new interactive computes
something a chapter quotes.

In the browser, add `?log=debug` to any page URL (or set
`localStorage["hb.log"] = "debug"`) to see the shell's and demos' logs.
The default level is `warn`.

CI (`.github/workflows/ci.yml`) runs both suites on every push and pull
request, with all three browser engines.

## Theme and storage

Three theme states: no `data-theme` (follow the OS), `data-theme="light"`,
`data-theme="dark"`. All colours are tokens in `tokens.css`, defined on bare
`:root` and redefined in the two dark blocks. The toggle dispatches
`hb:themechange` for canvas-based demos.

`localStorage` keys: `hb.theme`, `hb.read` (chapter numbers reached to
"Check yourself"), `hb.contentsFilter`, `hb.log`. All optional.

## Deployment

GitHub Pages, "Deploy from a branch", branch `main`, folder `/docs`.
`docs/.nojekyll` stops Pages running Jekyll over the files.

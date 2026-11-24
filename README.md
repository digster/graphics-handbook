# Graphics Handbook

A highly visual handbook that takes someone new to graphics and game development from
"what is a frame?" to reading a renderer's feature list with confidence. It is written for a
game developer or manager who will direct AI to do much of the hands-on work, so it teaches
recognition and judgement first: what a technique is, why it exists, what it costs, how it
fails, and how to brief and review work on it.

## Status

**Complete: 64 chapters in 13 parts, 787 glossary terms, 36 interactives.** The core path
(34 chapters, marked on the home page) is enough to read a renderer's feature list; the rest
goes deeper.

| Part | Chapters |
| --- | --- |
| 0 · Start here | the whole journey on one page, what a frame is |
| 1 · How games get made | idea to gold master, who does what, the content pipeline, platforms |
| 2 · Inside a game engine | engine anatomy, the game loop and threads, scenes and components, the engine landscape |
| 3 · Foundations | pixels and displays, colour, vectors, spaces and transforms, CPU, GPU and graphics APIs |
| 4 · Geometry | meshes, vertex and index buffers, draw calls, culling, level of detail, moving geometry |
| 5 · The GPU pipeline | the pipeline in one picture, vertex shaders, rasterization, pixel shaders, depth and blending, shaders in practice |
| 6 · Textures and materials | textures and UVs, filtering and mipmaps, texture memory, normal maps, PBR materials |
| 7 · Lighting and shadows | lights, shading models, forward/deferred/clustered, shadow maps, shadows at scale, reflections |
| 8 · Global illumination and AO | direct and indirect light, baked lighting, SSAO to GTAO, screen-space tricks, real-time GI, ray tracing, path tracing |
| 9 · Post-processing and image quality | tone mapping, anti-aliasing, upscaling and frame generation, camera effects, atmosphere, special surfaces |
| 10 · Anatomy of a frame | a deferred frame pass by pass, a mobile frame, a modern feature stack |
| 11 · Performance | frame budgets, GPU time, CPU time, memory and hitches, profilers and the settings menu |
| 12 · Working with AI | where AI fits, briefing AI, reviewing AI-written code, a visual bug field guide, decision guides |

Reference pages: the [glossary](docs/glossary.html), an [acronym decoder](docs/acronyms.html),
four printable [cheat sheets](docs/cheat-sheets.html) (the pipeline, the anatomy of a frame,
budgets, the settings menu decoded) and every [source](docs/sources.html) the chapters cite.

Many chapters embed the **Lantern Courtyard**, a small WebGL2 deferred renderer of one scene
that shows its G-buffer, shadow map, AO, lighting, SSR, fog, bloom and tone mapping as
separate views, with a pass scrubber. Without WebGL2 it shows a drawn sketch instead.

## Reading it

- **From disk:** open `docs/index.html` in any modern browser. Nothing to install, no server,
  works offline.
- **On the web:** GitHub Pages serves the `docs/` folder. To turn it on: repository
  **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder
  `/docs`.

Every chapter follows the same eight parts: the picture, in plain words, how it works, what it
costs, how it breaks, in the engines, say it to your AI, and check yourself.

## Developing

Node 20 or newer is needed for the author tools and tests only; readers never need it.

```bash
npm ci
```

```bash
npm test
```

```bash
npm run build
```

| Script | What it does |
| --- | --- |
| `npm run build` | Regenerates the two generated files: `docs/sources.html` and `docs/assets/js/data/search-index.js`. Run it after editing a chapter or the glossary. |
| `node tools/link-terms.mjs` | Links the first mention of each glossary term in every chapter (`--dry-run` to preview). Run it after adding chapters or terms; a test fails if a link is missing. |
| `npm test` | Structure tests and browser tests. |
| `npm run test:structure` | Fast checks without a browser: nav and pages agree, eight beats per chapter, links and anchors resolve, `file://` rules, glossary rules, term links, diagram rules, generated files are current. |
| `npm run test:browser` | Opens every page from `file://` in Playwright at phone and desktop widths in both themes, and drives the shell, the courtyard renderer and the interactives. Chromium by default; set `BROWSERS=chromium,firefox,webkit` for all three, as CI does. |

Environment variables for the tools are listed in [`.env.example`](.env.example). In the
browser, add `?log=debug` to a page URL to see the scripts' logs.

CI (`.github/workflows/ci.yml`) runs both test suites in all three browser engines, but only
when started by hand from the repository's Actions tab: automatic runs on pushes and pull
requests are turned off. Run `BROWSERS=chromium,firefox,webkit npm test` locally before
merging instead.

## Project layout

```
docs/                    the site (GitHub Pages serves this folder)
  index.html             cover, learning path, contents
  glossary.html          every term, with the chapter that teaches it
  acronyms.html          every acronym spelled out
  cheat-sheets.html      four printable one-page sheets
  sources.html           every cited source, by chapter (generated)
  NN-C-slug.html         one file per chapter, e.g. 04-2-vertex-buffers.html
  assets/css/            tokens, site layout and components, diagram classes
  assets/js/             shell, logger, theme init, page scripts
  assets/js/data/        nav.js, glossary.js, search-index.js (generated)
  assets/demos/          kit.js plus one script per interactive
  assets/fonts/          self-hosted IBM Plex Sans, IBM Plex Mono, Space Grotesk
tools/                   generators (search index, sources page), term linker, draft checks
tests/                   structure and browser tests
plan/                    the build plan
```

How the pieces fit, the chapter template and the conventions for terms, cross-references and
diagrams are in [ARCHITECTURE.md](ARCHITECTURE.md). Pitfalls already found are in
[LEARNINGS.md](LEARNINGS.md).

## Repository files

| File | Purpose |
| --- | --- |
| `ARCHITECTURE.md` | How the site is built and how to add chapters, terms and interactives |
| `LEARNINGS.md` | Bugs and traps found so far, and how they were avoided |
| `PROMPT.md` | Log of the prompts given for this project |
| `memory/` | Dated summaries of the work done, for context between sessions |
| `CLAUDE.md` | Project instructions for Claude Code (empty for now) |

## License

Code and text: [MIT](LICENSE) © digster.
Fonts: SIL Open Font License, see `docs/assets/fonts/OFL-*.txt`.

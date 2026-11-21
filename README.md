# Graphics Handbook

A highly visual handbook that takes someone new to graphics and game development from
"what is a frame?" to reading a renderer's feature list with confidence. It is written for a
game developer or manager who will direct AI to do much of the hands-on work, so it teaches
recognition and judgement first: what a technique is, why it exists, what it costs, how it
fails, and how to brief and review work on it.

## Status

**Early access: 2 of 64 chapters written.** Phase 0 of the [build plan](plan/handbook-plan.html)
is done: the site shell, design system, tests and two pilot chapters.

| Chapter | Interactive |
| --- | --- |
| [4.2 Vertex buffers and index buffers](docs/04-2-vertex-buffers.html) | Vertex buffer inspector |
| [8.3 Ambient occlusion: SSAO to GTAO](docs/08-3-ambient-occlusion.html) | Horizon explorer |

The home page lists all 64 planned chapters, the glossary has 79 terms, and search covers
chapters, sections and terms.

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
npm run build:search
```

| Script | What it does |
| --- | --- |
| `npm run build:search` | Regenerates `docs/assets/js/data/search-index.js` from the pages and data. Run it after editing a chapter or the glossary. |
| `npm test` | Structure tests and browser tests. |
| `npm run test:structure` | Fast checks without a browser: nav and pages agree, eight beats per chapter, links and anchors resolve, `file://` rules, glossary rules, diagram rules, search index is current. |
| `npm run test:browser` | Opens every page from `file://` in Playwright and drives the shell and the interactives. Chromium by default; set `BROWSERS=chromium,firefox,webkit` for all three, as CI does. |

Environment variables for the tools are listed in [`.env.example`](.env.example). In the
browser, add `?log=debug` to a page URL to see the scripts' logs.

CI runs both test suites on every push and pull request (`.github/workflows/ci.yml`).

## Project layout

```
docs/                    the site (GitHub Pages serves this folder)
  index.html             cover, learning path, contents
  glossary.html          every term, with the chapter that teaches it
  NN-C-slug.html         one file per chapter, e.g. 04-2-vertex-buffers.html
  assets/css/            tokens, site layout and components, diagram classes
  assets/js/             shell, logger, theme init, page scripts
  assets/js/data/        nav.js, glossary.js, search-index.js (generated)
  assets/demos/          kit.js plus one script per interactive
  assets/fonts/          self-hosted IBM Plex Sans, IBM Plex Mono, Space Grotesk
tools/                   search index generator and shared helpers
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

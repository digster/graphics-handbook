# Graphics Handbook

A highly visual handbook that takes someone new to graphics and game development from
"what is a frame?" to reading a renderer's feature list with confidence. It is written for a
game developer or manager who will direct AI to do much of the hands-on work, so it teaches
recognition and judgement first: what a technique is, why it exists, what it costs, how it
fails, and how to brief and review work on it.

By the end the reader understands the game development pipeline, how a game engine is put
together, and terms such as vertex buffers, G-buffers, CSM, TAA, GTAO and SSGI.

## Status

**Planning.** No handbook pages exist yet. The build plan is awaiting review.

- Plan source: [`plan/handbook-plan.html`](plan/handbook-plan.html). This is the body of a
  published Claude artifact, so it has no `<html>` wrapper of its own; it still opens in a
  browser.
- Scope in the plan: 13 parts, 64 chapters, 4 reference pages, about 250 diagrams and
  34 interactives, delivered in 8 phases starting with a site shell and two pilot chapters.

## Planned shape

- Static HTML with no build step and no server. The `docs/` folder will be the site: what is
  in git is what GitHub Pages serves, and it also opens from a double-click on `index.html`.
- Node is used by authors only (tests and search-index generation). Readers never need it.

Viewing, development and test instructions will be added here when Phase 0 lands.

## Repository files

| File | Purpose |
| --- | --- |
| `plan/` | The build plan |
| `PROMPT.md` | Log of the prompts given for this project |
| `memory/` | Dated summaries of the work done, for context between sessions |
| `CLAUDE.md` | Project instructions for Claude Code (empty for now) |

## License

[MIT](LICENSE) © digster

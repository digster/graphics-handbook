# Chapter writing guide

How to write one chapter of the Graphics Handbook so it matches the rest.
Read this, then read `docs/04-2-vertex-buffers.html` end to end: it is the
reference chapter. `ARCHITECTURE.md` explains how the site works.

## The reader

A sharp game lead or developer who has never opened a renderer and will
direct AI agents to do much of the hands-on work. They need to recognise
techniques, know what they cost, spot how they fail, and brief and review
the work. They do not need to write a renderer. Explain everything they need
to follow the chapter; never assume graphics knowledge the book has not given
them yet.

## Voice

- Plain, direct, short sentences. Active voice. A knowledgeable colleague
  explaining at a whiteboard.
- Concrete over abstract: real numbers, real units, real engine names.
  "A 1080p frame has 2,073,600 pixels" beats "a frame has many pixels".
- No em-dash asides, no "not X but Y" constructions, no colon-then-reveal
  sentences, no scare quotes around invented labels, no stock phrases
  ("worth noting", "it's important to", "dive into", "in today's world").
- British spelling, matching the existing chapters (colour, optimise, grey).
- Every claim about an engine, a GPU, a paper or a number must be true.
  Check engine setting names, defaults and version details against the
  official documentation with web search before writing them, and record
  the versions checked in the engines `.stamp`. If you cannot verify
  something, leave it out rather than guess.
- When a simplification hides detail, say so in a `.note[data-kind="simplified"]`.

## Structure (enforced by the tests)

Copy the head, body attributes, shell containers and script tags exactly
from the reference chapter. Then:

1. `<header class="chapter-head">`: eyebrow `Part N · Part title`, `<h1>` with
   `<span class="ch-num">N.M</span>` then the title from `nav.js`, a one or
   two sentence `.lead`, and a `.chapter-meta` list: Builds on, Leads to
   (cross-references), Reading time, Interactive (if any).
2. Eight sections, in this order, each exactly
   `<section class="beat" id="X" data-beat="X">` with
   `<h2 class="beat-title"><span class="beat-num">K</span> Name</h2>`
   (beat 1 uses `class="beat-title is-quiet"`):

   | # | id | Name | What goes in it |
   | --- | --- | --- | --- |
   | 1 | `picture` | The picture | One figure that holds the whole idea. |
   | 2 | `plain` | In plain words | The idea without jargon, an `.analogy` block (everyday comparison + the problem it solves), and a `.note[data-kind="lead"]` "Why a lead cares". |
   | 3 | `how` | How it works | Numbered `.step` blocks, each with `<h3 class="step-title" id="...">`. The mechanism, step by step, with a figure for each important idea. Optional `details.fold` for maths or code. |
   | 4 | `cost` | What it costs | Milliseconds, memory, bandwidth, people-time or money as fits the topic. Worked numbers. A `.grows` list of what makes the cost grow. |
   | 5 | `breaks` | How it breaks | A `.symptoms` gallery: each `.symptom` has a small SVG thumbnail, a Cause and an Ask for. |
   | 6 | `engines` | In the engines | A `table.engines` comparing Unreal Engine 5, Unity 6 and Godot 4 (add URP/HDRP columns if they differ), then a `.stamp` with the doc versions checked. |
   | 7 | `ai` | Say it to your AI | Two `.prompt` briefs (head, body, why) and a `.review-list` of questions to ask when reviewing AI work on this topic. |
   | 8 | `check` | Check yourself | `ol.quiz` with three questions and `details` answers, a "Terms introduced" `.chips` list, and a `.next-card`. |

3. `<section class="sources" id="sources">` with real links (papers, talks,
   official docs). Every link must be one you opened.

For non-technical chapters (production, roles, platforms) keep all eight
beats and interpret them sensibly: "What it costs" is time, money,
headcount or risk; "How it breaks" is how projects and pipelines fail;
"In the engines" compares how each engine handles the topic.

## Visuals

The handbook is highly visual. Aim for one figure per important idea: a
typical chapter has 8 to 12 figures, including the symptom thumbnails.

- Inline SVG only, inside `<figure>` with `<figcaption>`. Start the caption
  with a bold one-line claim (`<b>...</b>`), then explain.
- `<svg class="dg is-wide" viewBox="0 0 900 H" role="img" aria-label="...">`.
  The aria-label states what the picture shows, as a sentence.
- Use only the classes in `docs/assets/css/diagrams.css`: `t-*` text roles,
  `f-*` fills, `s-*` strokes, `w2 w3 w15 dash dot-dash round`, `mid end`
  for text anchoring, `stop-*` for gradient stops. Never a literal colour.
- Colour meaning is fixed across the book: accent (blue) = the idea this
  chapter is about; geo (teal) = geometry and vertex data; lit (amber) =
  light; pix (rose) = screen-space data (depth, G-buffer, post). Neutral
  shapes use `f-surface s-strong`, `f-solid`, `f-sunken`.
- Text at 10.5 to 13px in the viewBox. SVG collapses spaces, so align
  columns with separate `<text>` elements.
- Ids inside `<defs>` (markers, gradients, filters, patterns) must be unique
  in the page: prefix them per figure (`pic-arr`, `lay-arr`).
- Compute positions that encode numbers (bars to scale, angles, byte
  offsets). Check every number in a figure against the prose.
- Pictures of GPU buffers (depth images, AO textures) use `f-buf-hi`,
  `f-buf-lo`, `stop-buf-lo`, which stay the same in both themes.
- Soft shading and blur: SVG filters (`feGaussianBlur`, `feTurbulence`) are
  fine; see the ambient occlusion chapter for examples.

## Terms and links

- Introduce each new term once with `<dfn class="term" data-term="id">`.
  Every glossary entry whose `ch` is your chapter must be introduced this way.
- Mention a term from another chapter with
  `<a class="term" data-term="id" href="glossary.html#id">text</a>`.
  If that term's chapter comes after yours in the book, add `data-forward`.
  Only link ids that exist in `docs/assets/js/data/glossary.js` or in your
  own draft file. Otherwise write the word as plain text.
- Link other chapters with `<a class="xref" data-ch="N.M">N.M Title</a>`;
  the shell turns it into a link or points it at the contents. This also
  works for an `<a class="xref" data-ch="N.M">` wrapping `<text>` inside an
  SVG diagram.
- External links use full `https://` URLs. Never link to local files outside
  `docs/`.

## Interactives

Chapters marked interactive in the plan get one. Build it as
`docs/assets/demos/<name>.js`, registered with
`HB.demos.register("<name>", init)` and placed in the page as
`<div class="demo" data-demo="<name>"><p class="demo-hint">no-JS fallback sentence</p></div>`
inside a figure. Load `assets/demos/kit.js` then your script after
`shell.js`. Read `docs/assets/demos/kit.js` and one existing demo first.

- Prefer SVG built with `HB.svg.el` and diagram classes; it themes itself.
  Use a canvas only for per-pixel work; read colours with
  `HB.demos.color("ink")` and redraw on the `hb:themechange` event.
- Controls: `HB.segmented`, `HB.slider`, checkboxes with labels. Dragging:
  `HB.draggable` (it adds keyboard arrows).
- Open in a meaningful state that already shows the point, with a readout
  (`.demo-readout`).
- No `fetch`, no modules, no timers that run while off screen, respect
  `HB.demos.reducedMotion()`. Log with `HB.log.scope("<name>")`.
- Must not throw or log errors; it must reach `data-demo-ready`.

## The Lantern Courtyard

Chapters from Part 4 onward can show the shared 3D scene and its buffers:

```html
<figure>
  <div class="demo" data-demo="courtyard" data-view="normals" data-views="final,normals,depth">
    <p class="demo-hint">Fallback sentence describing what the view shows.</p>
  </div>
  <figcaption><b>Claim.</b> Explanation.</figcaption>
</figure>
```

Load `assets/demos/kit.js`, then `courtyard-gl.js`, `courtyard-shaders.js`
and `courtyard.js`, in that order. Views: `final, wireframe, albedo,
normals, depth, roughness, shadow-map, ao, lighting, no-ao, no-shadows,
ssr, fog-off, bloom, hdr-clipped, triangles`. Use `data-views` to let the
reader switch between the views your chapter discusses (keep it to the
relevant few), `data-orbit="on"` when moving the camera helps, and
`data-passes="on"` only in 10.1. Each instance costs GPU time, so embed at
most two per chapter. Write the caption for the default view.

## Glossary drafts

Do not edit `glossary.js`. Put the terms your chapter introduces in a JSON
draft file (the path is given in your brief):

```json
{
  "game-loop": { "term": "Game loop", "aka": ["main loop"], "def": "One or two plain sentences.", "ch": "0.2" }
}
```

Ids are lowercase-hyphenated. Check the existing glossary first: if a term
you need is already there with `ch` set to your chapter, introduce it with a
`<dfn>` and do not redefine it. Definitions must stand alone in one or two
sentences.

## Checking your work

```bash
node tools/check-chapter.mjs 1.1 1.2 --glossary /path/to/draft.json
```

```bash
node tools/screenshot.mjs 01-1-idea-to-gold.html --each "main figure" --out /path/to/shots
```

Fix every failure. Look at every figure in light mode and at least the
complex ones with `--dark`, and fix overlaps, clipping, off-by-one geometry
and unreadable labels. Check `--phone` once for sideways overflow. Delete the
screenshots when you are done.

## Do not touch

Shared files are merged by the editor: `nav.js`, `glossary.js`,
`search-index.js`, the CSS files, `shell.js`, `kit.js`, the tests, other
chapters. Do not run git. If you need a new shared CSS component, say so in
your report instead.

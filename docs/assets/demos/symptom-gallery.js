/*
 * symptom-gallery.js: chapter 12.4's interactive.
 *
 * A field guide to 29 common rendering artefacts. Each bug has a small SVG
 * thumbnail drawn with the diagram classes, a family (where you see it), a
 * tell-tale cue (what changes it: the camera, the light, time, or nothing),
 * and four lines of advice: what you see, the likely cause, what to check
 * first and what to ask an AI or a colleague for, plus the chapter that
 * explains it and its glossary term.
 *
 * The reader filters by family and by cue, which mirrors the chapter's
 * diagnosis flow, and selects a thumbnail to read its entry. The grid is a
 * set of buttons with a roving tab stop: Tab enters the grid, the arrow keys
 * move between thumbnails, Home and End jump to the ends, and Enter or Space
 * selects. Nothing animates and no timers run.
 */
(function () {
  "use strict";

  var HB = window.HB;
  var log = HB.log.scope("symptom-gallery");
  var h = HB.html;
  var svgEl = HB.svg.el;

  /* ---------- Model ---------- */

  var FAMILIES = [
    { id: "shadows", label: "Shadows" },
    { id: "lighting", label: "Lighting" },
    { id: "geometry", label: "Geometry" },
    { id: "textures", label: "Textures" },
    { id: "motion", label: "Motion" },
    { id: "screen", label: "Whole screen" }
  ];

  var CUES = [
    { id: "camera", label: "Camera", long: "It changes as the camera moves, even with everything else still." },
    { id: "light", label: "Light", long: "It shifts when the sun or a lamp moves, and holds still otherwise." },
    { id: "time", label: "Time", long: "It changes from one frame to the next: in motion, over time or after a cut." },
    { id: "none", label: "Nothing", long: "It stays put on the model or the screen, whatever moves." }
  ];

  /* Each entry: id, name, family, cue, glossary term, chapter, and the advice.
     The causes and requests summarise each chapter's "How it breaks" cards. */
  var BUGS = [
    { id: "acne", name: "Shadow acne", family: "shadows", cue: "light", term: "shadow-acne", ch: "7.4",
      see: "Stripes or speckles of false shadow across lit surfaces, worst when the sun is low.",
      cause: "Not enough shadow bias for the surface's angle to the light, coarse shadow texels, or low depth precision in the shadow map.",
      check: "The light's slope-scaled bias and normal offset, and the shadow map's texel size at that spot.",
      ask: "Slope-scaled bias and normal offset tuned before any extra constant bias, with before-and-after shots at a low sun." },
    { id: "peter", name: "Peter-panning", family: "shadows", cue: "light", term: "peter-panning", ch: "7.4",
      see: "Shadows start a gap away from whatever casts them, so objects seem to float.",
      cause: "Too much shadow bias or normal offset, usually raised to hide acne. Thin casters such as walls and legs show it first.",
      check: "The bias values on the light, and whether the caster is single-sided or very thin.",
      ask: "A smaller constant bias with slope bias added, and thickness or back faces on thin casters." },
    { id: "crawl", name: "Crawling shadow edges", family: "shadows", cue: "camera", term: "shadow-map", ch: "7.4",
      see: "Stair-stepped shadow edges that shimmer and crawl while the camera moves, and settle when it stops.",
      cause: "The light's view is refitted every frame as the camera moves, so shadow texels slide across the world.",
      check: "Whether the shadow view snaps to whole texels, and the texel size where the player looks.",
      ask: "Texel snapping for the light's view, and a slow camera pan recorded at full frame rate before and after." },
    { id: "cascade", name: "A line where shadow detail jumps", family: "shadows", cue: "camera", term: "cascade-split", ch: "7.5",
      see: "A line on the ground, a fixed distance ahead of the camera, where shadows turn blurrier or flicker.",
      cause: "A boundary between shadow cascades with no blend band, or one too narrow.",
      check: "A cascade debug view that colours each split, to see where the line falls.",
      ask: "Blend or border settings per cascade, and split distances moved away from where players look most." },
    { id: "shadowpop", name: "Shadows pop in ahead", family: "shadows", cue: "camera", term: "shadow-distance", ch: "7.5",
      see: "Shadows appear a few steps ahead as you walk, always at the same distance from the camera.",
      cause: "The shadow distance ends where players can clearly see, with a short fade or none.",
      check: "The shadow distance and fade at each quality level.",
      ask: "A longer fade, or a method for the far range: distance-field shadows, baked shadows, or fog." },
    { id: "leak", name: "Light leaking through walls", family: "lighting", cue: "light", term: "light-leaking", ch: "8.5",
      see: "Bright patches inside a closed room, along the base of walls and in corners.",
      cause: "Walls thinner than the global illumination method's cells or probe spacing, or single-sided walls.",
      check: "Wall thickness against the method's minimum (10 cm for Lumen), and where the probes sit.",
      ask: "Thicker or double-sided walls, the method's leak settings, and probes kept out of walls." },
    { id: "halo", name: "Dark halos around objects", family: "lighting", cue: "camera", term: "thickness-heuristic", ch: "8.3",
      see: "A dark outline on the wall behind characters and props, even when they stand well clear of it.",
      cause: "Screen-space ambient occlusion cannot tell an object in front of a wall from one touching it.",
      check: "The AO buffer in a debug view, and the AO radius and thickness settings.",
      ask: "A thickness heuristic or distance falloff, a smaller radius, and a comparison with AO switched off." },
    { id: "dirtyao", name: "Dirty, over-dark corners", family: "lighting", cue: "none", term: "ambient-occlusion", ch: "8.3",
      see: "Everything looks grimy: black creases, and darkening even on surfaces in full sun.",
      cause: "AO applied to direct light, set too strong, or counted twice: baked AO, screen-space AO and GI occlusion together.",
      check: "Which AO sources are switched on, and whether AO multiplies direct light.",
      ask: "AO on ambient light only, one source per scale of detail, and settings compared side by side." },
    { id: "fireflies", name: "Fireflies", family: "lighting", cue: "time", term: "fireflies", ch: "8.7",
      see: "Isolated, very bright specks that flicker, often near glossy metal or glass.",
      cause: "Rare light paths that reach a small, bright light, with too few samples to average them out.",
      check: "Which light and which material the specks come from, and the firefly clamp settings.",
      ask: "Better sampling for that light, a firefly clamp at the lowest value that does not darken the scene, and the denoiser's outlier rejection." },
    { id: "ssrfade", name: "Reflections fade at the edges", family: "lighting", cue: "camera", term: "screen-edge-fade", ch: "8.4",
      see: "Reflections in floors and water fade near the screen edges, or vanish as the camera tilts down.",
      cause: "Screen-space reflections have no data for what is off screen, and the fallback behind them is missing or does not match.",
      check: "The reflection probe that should cover the area, and the screen edge fade setting.",
      ask: "A box-projected probe fitted to the area as the fallback, or ray-traced reflections where it matters." },
    { id: "zfight", name: "Z-fighting", family: "geometry", cue: "camera", term: "z-fighting", ch: "5.5",
      see: "Flickering stripes where two surfaces overlap: a decal, a road on terrain, two walls in the same place.",
      cause: "The surfaces are closer together than one step of stored depth at that distance, often because the near plane is tiny.",
      check: "The camera's near and far planes, whether reversed-Z is on, and whether the surfaces are coplanar.",
      ask: "Surfaces separated, a depth bias for decals, a larger near plane, and reversed-Z where the engine supports it." },
    { id: "spikes", name: "Exploding vertices", family: "geometry", cue: "none", term: "vertex-layout", ch: "4.2",
      see: "Long spikes shooting out of a mesh in every direction.",
      cause: "The vertex layout does not match the buffer: wrong stride, offset or format. On skinned meshes, bone indices that do not match the skeleton.",
      check: "The mesh in a frame capture's mesh viewer, and the declared layout against what the importer wrote.",
      ask: "The layout compared field by field for every mesh variant; for characters, mesh and skeleton from the same export." },
    { id: "stretched", name: "Triangles stretched across the model", family: "geometry", cue: "none", term: "index-format", ch: "4.2",
      see: "Long thin triangles joining distant parts of one large mesh.",
      cause: "A mesh with more than 65,536 vertices was given 16-bit indices, so the large ones wrap around.",
      check: "The mesh's vertex count and index format.",
      ask: "32-bit indices or a split mesh, and an import check that flags meshes over the limit." },
    { id: "missing", name: "Missing or inside-out faces", family: "geometry", cue: "none", term: "winding-order", ch: "4.1",
      see: "Faces you should see are missing, and you see the inside of the model instead.",
      cause: "Winding order flipped by a mirror, a negative scale or an axis conversion, so backface culling removes the front faces.",
      check: "The importer's axis and handedness settings, negative scales in the scene, and single-sided materials on thin surfaces.",
      ask: "One agreed place for axis conversion, a test asset with lettering, and two-sided materials only where needed." },
    { id: "pop", name: "LOD popping", family: "geometry", cue: "camera", term: "lod-popping", ch: "4.5",
      see: "An object visibly changes shape or shading in one frame as you approach or back away.",
      cause: "A switch distance where players look closely, or a next level of detail too different from the last.",
      check: "Switch distances at the target resolution and field of view, with LOD colouring switched on.",
      ask: "Thresholds tuned in game, a cross-fade for large objects, and levels that keep the outline." },
    { id: "cracks", name: "Sparkling cracks along seams", family: "geometry", cue: "camera", term: "fill-rule", ch: "5.3",
      see: "Single pixels of background flicker along edges where pieces of geometry meet.",
      cause: "Neighbouring triangles do not share exact corner positions: T-junctions, or modular pieces that do not quite meet.",
      check: "The seam in wireframe: welded vertices and no T-junctions.",
      ask: "Welded seams, and matching vertex positions wherever modular pieces join." },
    { id: "shimmer", name: "Shimmer and moiré", family: "textures", cue: "camera", term: "texture-aliasing", ch: "6.2",
      see: "Fine patterns that crawl, sparkle or form false stripes on distant surfaces while the camera moves.",
      cause: "The texture has no mipmaps, so each distant pixel reads a few texels out of many.",
      check: "A mip-level debug view, and the texture's import settings.",
      ask: "Mipmaps on every texture used in 3D, set by an import preset, and anisotropic filtering on floors and roads." },
    { id: "seam", name: "A line where the texture breaks", family: "textures", cue: "none", term: "uv-seam", ch: "6.1",
      see: "A hard line across a surface where the pattern or the lighting does not continue.",
      cause: "A UV seam where players look, or islands packed so close that they bleed into each other in smaller mips.",
      check: "A checker texture on the asset, and the gaps between UV islands.",
      ask: "Seams moved to hidden edges, texturing painted across seams, and gaps filled with each island's edge colour." },
    { id: "blurry", name: "Blurry, then sharp", family: "textures", cue: "time", term: "streaming-starvation", ch: "11.4",
      see: "Textures stay soft for a moment after a load or a camera cut, then pop sharp.",
      cause: "Texture streaming is catching up, or the streaming pool is too small for what the view needs.",
      check: "Streaming statistics at that spot, and the time from the cut to sharp textures.",
      ask: "Preloading around cuts and spawn points, and the pool size measured against what the view wants." },
    { id: "dents", name: "Bumps look like dents", family: "textures", cue: "light", term: "green-channel", ch: "6.4",
      see: "Raised details look sunken when lit from above, and raised when lit from below.",
      cause: "The normal map was made for the other green-channel convention.",
      check: "The texture's flip-green setting, and the export preset of the baking or texturing tool.",
      ask: "One agreed convention for every tool, and the engine's flip setting on the maps that need it." },
    { id: "stretchtex", name: "Stretched or smeared texture", family: "textures", cue: "none", term: "uv-unwrap", ch: "6.1",
      see: "Texture detail smeared in one direction across part of a model.",
      cause: "A UV island squashed in one direction, or a planar projection on a side that faces away from it.",
      check: "A checker texture on the model: the squares should stay square.",
      ask: "A re-unwrap of the stretched islands, with the modelling tool's stretch view switched on." },
    { id: "ghost", name: "Ghosting", family: "motion", cue: "time", term: "ghosting", ch: "9.2",
      see: "Faint trails behind moving objects, gone as soon as everything stops.",
      cause: "Temporal history blended in from where the object used to be, or an object that writes no motion vectors.",
      check: "A motion-vector debug view: does the moving object write vectors?",
      ask: "Motion vectors on every moving object, tighter history rejection, and slow-motion captures of the trail." },
    { id: "thin", name: "Flicker on thin detail", family: "motion", cue: "camera", term: "taa", ch: "9.2",
      see: "Wires, fences, grass blades and small highlights blink on and off as the camera moves.",
      cause: "Detail thinner than a pixel is missing from some frames, so temporal anti-aliasing clamps it away.",
      check: "How wide the detail is on screen at that distance, and the TAA's anti-flicker settings.",
      ask: "Thicker LODs or cards for distant thin geometry, specular anti-aliasing for small highlights, and anti-flicker tuning." },
    { id: "tear", name: "Tearing", family: "motion", cue: "time", term: "screen-tearing", ch: "3.1",
      see: "A horizontal break across the picture during fast camera pans.",
      cause: "The frame was swapped while the display was still reading it out: vsync off and no variable refresh rate.",
      check: "The vsync and VRR settings, and whether VRR actually engages.",
      ask: "Vsync and VRR options in the settings menu, and a frame cap just under the refresh rate for VRR players." },
    { id: "hitch", name: "Hitches", family: "motion", cue: "time", term: "hitch", ch: "11.4",
      see: "The picture freezes for a moment, then jumps ahead.",
      cause: "Work done in the middle of a frame: shader compilation, a synchronous load, garbage collection or streaming.",
      check: "A frame-time graph, and a profiler capture of the slow frame.",
      ask: "The cause named from the capture, and that work moved to loading or spread over many frames." },
    { id: "washed", name: "Washed-out or too-dark colours", family: "screen", cue: "none", term: "colour-space-mix-up", ch: "3.2",
      see: "The whole image looks milky and grey, or dark and over-saturated, and tuning lights never fixes it.",
      cause: "An sRGB and linear mix-up: a colour decoded twice, never decoded, or encoded twice.",
      check: "The sRGB flag on colour textures, render-target formats, and any pow 2.2 in shaders.",
      ask: "A swatch scene with known values compared against a golden image, and one place for each conversion." },
    { id: "banding", name: "Colour banding", family: "screen", cue: "none", term: "colour-banding", ch: "3.2",
      see: "Visible steps in skies, fog and soft gradients, worst in dark, smooth areas.",
      cause: "Too few levels somewhere in the chain: an 8-bit intermediate target, compression, or output without dither.",
      check: "Which buffer the steps first appear in, from a frame capture.",
      ask: "A higher-precision target for the step that bands, and dithering on the final output." },
    { id: "nan", name: "Black squares that spread", family: "screen", cue: "time", term: "nan", ch: "12.3",
      see: "A black block that appears on one spot and grows over a few frames.",
      cause: "A NaN from a division by zero or a zero-length normalize, spread by blurs and temporal history.",
      check: "Which pass first produces the bad pixel, from a frame capture.",
      ask: "The shader and its inputs at that pixel, and a guard on the division rather than a clamp that hides it." },
    { id: "grey", name: "A flat, grey image", family: "screen", cue: "none", term: "tone-mapping", ch: "9.1",
      see: "Low contrast and lifted blacks across the whole picture, often after a post-processing change.",
      cause: "Tone mapping or a gamma step applied twice, or a colour-grading LUT built for a different stage.",
      check: "The order of post-processing passes, and a capture before and after the final pass.",
      ask: "One tone curve, LUTs authored for the stage that uses them, and captures before and after the fix." }
  ];

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* The bugs that pass both filters, in gallery order. Exposed for tests. */
  function filter(family, cue) {
    return BUGS.filter(function (b) {
      return (family === "all" || b.family === family) && (cue === "all" || b.cue === cue);
    });
  }

  HB.symptomGallery = { bugs: BUGS, families: FAMILIES, cues: CUES, filter: filter };

  /* ---------- Thumbnails: each draws into a 120 × 80 viewBox ---------- */

  function add(g, tag, attrs) {
    return svgEl(tag, attrs, g);
  }
  function rect(g, x, y, w, hh, cls, extra) {
    var a = { x: x, y: y, width: w, height: hh, "class": cls };
    if (extra) Object.keys(extra).forEach(function (k) { a[k] = extra[k]; });
    return add(g, "rect", a);
  }
  function poly(g, pts, cls, extra) {
    var a = { points: pts, "class": cls };
    if (extra) Object.keys(extra).forEach(function (k) { a[k] = extra[k]; });
    return add(g, "polygon", a);
  }
  function line(g, x1, y1, x2, y2, cls, extra) {
    var a = { x1: x1, y1: y1, x2: x2, y2: y2, "class": cls };
    if (extra) Object.keys(extra).forEach(function (k) { a[k] = extra[k]; });
    return add(g, "line", a);
  }
  function circle(g, cx, cy, r, cls, extra) {
    var a = { cx: cx, cy: cy, r: r, "class": cls };
    if (extra) Object.keys(extra).forEach(function (k) { a[k] = extra[k]; });
    return add(g, "circle", a);
  }
  function blurFilter(svg, id, sd) {
    var defs = add(svg, "defs", null);
    var f = add(defs, "filter", { id: id, x: "-50%", y: "-50%", width: "200%", height: "200%" });
    add(f, "feGaussianBlur", { stdDeviation: sd });
    return "url(#" + id + ")";
  }

  var DRAW = {
    acne: function (g) {
      rect(g, 0, 0, 120, 30, "f-sunken");
      rect(g, 0, 30, 120, 50, "f-buf-hi");
      for (var x = -24; x < 124; x += 9) poly(g, x + ",80 " + (x + 3) + ",80 " + (x + 25) + ",30 " + (x + 22) + ",30", "f-buf-lo", { "fill-opacity": "0.7" });
    },
    peter: function (g) {
      rect(g, 0, 0, 120, 36, "f-sunken");
      rect(g, 0, 36, 120, 44, "f-buf-hi");
      rect(g, 40, 10, 9, 54, "f-surface s-strong");
      poly(g, "62,62 112,72 114,66 64,57", "f-buf-lo", { "fill-opacity": "0.85" });
      line(g, 50, 61, 61, 61, "s-pix w2");
    },
    crawl: function (g) {
      rect(g, 0, 0, 120, 80, "f-buf-hi");
      add(g, "path", { d: "M8,64 L28,64 L28,54 L48,54 L48,44 L68,44 L68,34 L88,34 L88,24 L112,24 L112,80 L8,80 Z", "class": "f-buf-lo", "fill-opacity": "0.8" });
      add(g, "path", { d: "M8,58 L34,58 L34,48 L54,48 L54,38 L74,38 L74,28 L94,28 L94,18 L112,18", "class": "s-pix w15 dash" });
    },
    cascade: function (g) {
      rect(g, 0, 0, 120, 24, "f-sunken");
      poly(g, "0,80 120,80 104,24 16,24", "f-buf-hi");
      poly(g, "38,80 58,80 56,46 42,46", "f-buf-lo", { "fill-opacity": "0.8" });
      add(g, "path", { d: "M42,46 L42,40 L45,40 L45,34 L48,34 L48,28 L52,28 L52,34 L55,34 L55,40 L56,40 L56,46 Z", "class": "f-buf-lo", "fill-opacity": "0.8" });
      line(g, 6, 46, 114, 46, "s-pix w15 dash");
    },
    shadowpop: function (g) {
      rect(g, 0, 0, 120, 30, "f-sunken");
      rect(g, 0, 30, 120, 50, "f-buf-hi");
      [[22, 62, 1], [52, 50, 1], [82, 40, 0], [104, 34, 0]].forEach(function (t) {
        var s = t[1] / 62;
        if (t[2]) add(g, "ellipse", { cx: t[0] + 9 * s, cy: t[1] + 2, rx: 11 * s, ry: 3 * s, "class": "f-buf-lo", "fill-opacity": "0.75" });
        line(g, t[0], t[1], t[0], t[1] - 16 * s, "s-strong w2");
        circle(g, t[0], t[1] - 20 * s, 8 * s, "f-paint-green");
      });
      line(g, 66, 30, 66, 80, "s-pix w15 dash");
    },
    leak: function (g) {
      rect(g, 0, 0, 120, 80, "f-buf-hi");
      rect(g, 20, 14, 80, 60, "f-buf-lo");
      rect(g, 14, 8, 92, 6, "f-surface s-strong");
      rect(g, 14, 8, 6, 66, "f-surface s-strong");
      rect(g, 100, 8, 6, 66, "f-surface s-strong");
      rect(g, 20, 66, 80, 8, "f-lit", { "fill-opacity": "0.85" });
      poly(g, "20,14 34,14 20,40", "f-lit", { "fill-opacity": "0.55" });
    },
    halo: function (g, uid) {
      var svg = g.ownerSVGElement || g;
      var fl = blurFilter(svg, uid + "-halo", 4);
      rect(g, 0, 0, 120, 80, "f-buf-hi");
      rect(g, 0, 64, 120, 16, "f-buf-lo", { "fill-opacity": "0.18" });
      add(g, "path", { d: "M60,12 C70,12 71,22 69,28 C77,31 79,44 77,64 L43,64 C41,44 43,31 51,28 C49,22 50,12 60,12 Z", "class": "f-buf-lo", "fill-opacity": "0.7", filter: fl, transform: "translate(60 40) scale(1.25) translate(-60 -40)" });
      add(g, "path", { d: "M60,12 C70,12 71,22 69,28 C77,31 79,44 77,70 L43,70 C41,44 43,31 51,28 C49,22 50,12 60,12 Z", "class": "f-strong s-ink" });
    },
    dirtyao: function (g, uid) {
      var svg = g.ownerSVGElement || g;
      var fl = blurFilter(svg, uid + "-dirt", 5);
      rect(g, 0, 0, 120, 80, "f-buf-lo");
      poly(g, "0,0 60,16 60,62 0,80", "f-buf-hi");
      poly(g, "120,0 60,16 60,62 120,80", "f-buf-hi", { "fill-opacity": "0.82" });
      poly(g, "0,80 60,62 120,80", "f-buf-hi", { "fill-opacity": "0.68" });
      rect(g, 50, 12, 20, 56, "f-buf-lo", { "fill-opacity": "0.75", filter: fl });
      poly(g, "4,80 60,58 116,80", "f-buf-lo", { "fill-opacity": "0.6", filter: fl });
      rect(g, 8, 26, 28, 20, "f-buf-lo", { "fill-opacity": "0.35", filter: fl });
    },
    fireflies: function (g, uid) {
      var svg = g.ownerSVGElement || g;
      var fl = blurFilter(svg, uid + "-ff", 2.5);
      rect(g, 0, 0, 120, 80, "f-buf-lo");
      poly(g, "0,58 120,58 120,80 0,80", "f-buf-hi", { "fill-opacity": "0.12" });
      [[18, 20], [46, 44], [76, 14], [96, 64], [34, 70], [108, 30], [62, 60], [10, 50]].forEach(function (p) {
        rect(g, p[0], p[1], 2.5, 2.5, "f-paint-daylight");
      });
      circle(g, 63, 61, 5, "f-paint-daylight", { "fill-opacity": "0.5", filter: fl });
    },
    ssrfade: function (g) {
      rect(g, 0, 0, 120, 44, "f-surface");
      rect(g, 0, 44, 120, 36, "f-sunken");
      [[20, 14], [56, 14], [92, 14]].forEach(function (p, i) {
        rect(g, p[0], p[1], 10, 30, "f-solid s-strong");
        var o = [0.75, 0.45, 0.12][i];
        rect(g, p[0], 46, 10, 26, "f-solid", { "fill-opacity": String(o) });
      });
      line(g, 112, 0, 112, 80, "s-pix w15 dash");
    },
    zfight: function (g) {
      rect(g, 0, 0, 120, 80, "f-solid");
      poly(g, "36,80 84,80 70,6 50,6", "f-strong");
      [[44, 14, 70, 20], [40, 34, 78, 40], [38, 54, 82, 62], [46, 24, 66, 27], [36, 70, 84, 74]].forEach(function (s) {
        poly(g, s[0] + "," + s[1] + " " + s[2] + "," + (s[1] + 3) + " " + s[2] + "," + (s[3] + 2) + " " + s[0] + "," + s[3], "f-solid");
      });
    },
    spikes: function (g) {
      poly(g, "50,30 64,26 74,34 73,48 61,53 49,47", "f-solid s-strong");
      poly(g, "64,26 74,34 114,4", "f-pix-soft s-pix");
      poly(g, "73,48 61,53 108,78", "f-pix-soft s-pix");
      poly(g, "49,47 50,30 6,74", "f-pix-soft s-pix");
      poly(g, "50,30 64,26 20,3", "f-pix-soft s-pix");
      poly(g, "74,34 73,48 118,40", "f-pix-soft s-pix");
    },
    stretched: function (g) {
      poly(g, "20,40 32,22 52,18 64,30 60,52 40,58 24,54", "f-solid s-strong");
      poly(g, "70,28 92,20 106,34 100,56 78,58", "f-solid s-strong");
      poly(g, "32,22 100,56 106,34", "f-pix-soft s-pix");
      poly(g, "24,54 92,20 70,28", "f-pix-soft s-pix");
    },
    missing: function (g) {
      poly(g, "36,24 84,24 84,66 36,66", "f-sunken s-strong");
      poly(g, "24,32 36,24 36,66 24,74", "f-solid s-strong");
      poly(g, "24,32 72,32 84,24 36,24", "f-surface s-strong");
      poly(g, "24,32 72,32 72,74 24,74", "s-pix w15 dash");
      line(g, 72, 32, 72, 74, "s-pix w15 dash");
    },
    pop: function (g) {
      poly(g, "14,52 18,38 28,30 40,28 50,34 54,46 50,56 38,60 24,60", "f-solid s-strong");
      add(g, "path", { d: "M58,44 L68,44", "class": "s-muted w15" });
      poly(g, "66,40 72,44 66,48", "f-muted");
      poly(g, "78,56 84,32 104,28 114,48 102,60", "f-solid s-strong");
    },
    cracks: function (g) {
      rect(g, 0, 0, 120, 80, "f-paint-sky");
      poly(g, "6,10 60,8 60,72 6,70", "f-solid s-strong");
      poly(g, "61,9 114,12 114,74 61,73", "f-solid s-strong");
      [[59.5, 18], [60, 31], [59.5, 44], [60, 57], [59.5, 66]].forEach(function (p) {
        rect(g, p[0], p[1], 2, 2.5, "f-paint-sky");
      });
    },
    shimmer: function (g) {
      rect(g, 0, 0, 120, 26, "f-sunken");
      rect(g, 0, 26, 120, 54, "f-surface");
      for (var i = -10; i <= 10; i++) line(g, 60 + i * 1.6, 26, 60 + i * 13, 80, "s-ink");
      for (var k = 0; k < 9; k++) {
        var y = 26 + 54 * Math.pow(k / 8, 2);
        line(g, 0, y, 120, y, "s-ink", { "stroke-opacity": "0.7" });
      }
    },
    seam: function (g) {
      rect(g, 0, 0, 120, 80, "f-sunken");
      for (var r = 0; r < 6; r++) {
        for (var c = 0; c < 6; c++) {
          var off = (r % 2) * 10;
          var x = c * 20 - off;
          if (x + 18 > 60) continue;
          rect(g, Math.max(x, 0), r * 14 + 1, Math.min(18, 60 - Math.max(x, 0)), 12, "f-solid");
        }
        for (var c2 = 0; c2 < 6; c2++) {
          var off2 = (r % 2) * 10 + 6;
          var x2 = 60 + c2 * 20 - off2;
          var x0 = Math.max(x2, 61);
          var w = Math.min(x2 + 18, 120) - x0;
          if (w > 1) rect(g, x0, r * 14 + 4, w, 12, "f-solid");
        }
      }
      line(g, 60.5, 0, 60.5, 80, "s-pix w2");
    },
    blurry: function (g) {
      var greys = ["f-sunken", "f-solid", "f-strong"];
      for (var i = 0; i < 4; i++) for (var j = 0; j < 3; j++) rect(g, 4 + i * 12, 16 + j * 16, 12, 16, greys[(i + j * 2) % 3]);
      line(g, 56, 40, 64, 40, "s-muted w15");
      poly(g, "62,36 68,40 62,44", "f-muted");
      for (var a = 0; a < 12; a++) for (var b2 = 0; b2 < 9; b2++) rect(g, 72 + a * 4, 16 + b2 * 5.33, 4, 5.33, greys[(a * 3 + b2 * 5) % 3]);
    },
    dents: function (g) {
      rect(g, 0, 0, 120, 80, "f-surface");
      circle(g, 60, 46, 22, "f-buf-hi");
      add(g, "path", { d: "M38,46 A22,22 0 0 1 82,46 Z", "class": "f-buf-lo", "fill-opacity": "0.8" });
      circle(g, 60, 46, 22, "s-strong");
      line(g, 60, 2, 60, 16, "s-lit w2");
      poly(g, "56,14 60,21 64,14", "f-lit");
    },
    stretchtex: function (g) {
      rect(g, 0, 0, 120, 80, "f-surface");
      for (var r = 0; r < 8; r++) {
        for (var c = 0; c < 6; c++) if ((r + c) % 2 === 0) rect(g, 4 + c * 9, 4 + r * 9, 9, 9, "f-solid");
        for (var c3 = 0; c3 < 2; c3++) if ((r + c3) % 2 === 0) rect(g, 60 + c3 * 28, 4 + r * 9, 28, 9, "f-solid");
      }
      rect(g, 4, 4, 112, 72, "s-strong");
    },
    ghost: function (g) {
      rect(g, 0, 0, 120, 80, "f-buf-hi");
      [0.12, 0.22, 0.35].forEach(function (o, i) { circle(g, 30 + i * 14, 44, 13, "f-buf-lo", { "fill-opacity": String(o) }); });
      circle(g, 84, 44, 13, "f-buf-lo");
      line(g, 100, 44, 114, 44, "s-muted w15");
      poly(g, "112,40 118,44 112,48", "f-muted");
    },
    thin: function (g) {
      rect(g, 0, 0, 120, 80, "f-paint-sky");
      rect(g, 0, 60, 120, 20, "f-solid");
      [18, 54, 90].forEach(function (x) { rect(g, x, 20, 4, 44, "f-strong"); });
      line(g, 0, 28, 120, 26, "s-ink dot-dash");
      line(g, 0, 40, 120, 38, "s-ink dash");
      line(g, 0, 52, 120, 50, "s-ink dot-dash");
    },
    tear: function (g) {
      rect(g, 0, 0, 120, 80, "f-paint-sky");
      rect(g, 0, 60, 120, 20, "f-solid");
      rect(g, 40, 8, 14, 32, "f-strong");
      rect(g, 26, 40, 14, 20, "f-strong");
      rect(g, 82, 14, 18, 26, "f-solid s-strong");
      rect(g, 68, 40, 18, 20, "f-solid s-strong");
      line(g, 0, 40, 120, 40, "s-pix w15 dash");
    },
    hitch: function (g) {
      rect(g, 0, 0, 120, 80, "f-surface");
      line(g, 6, 70, 114, 70, "s-strong");
      line(g, 6, 52, 114, 52, "s-acc dash");
      var pts = [];
      for (var i = 0; i < 27; i++) {
        var x = 6 + i * 4;
        var y = i === 17 ? 8 : 58 + ((i * 7) % 5);
        pts.push(x + "," + y);
      }
      add(g, "polyline", { points: pts.join(" "), "class": "s-acc w15" });
      line(g, 74, 70, 74, 8, "s-pix w2");
    },
    washed: function (g) {
      rect(g, 0, 0, 120, 80, "f-buf-lo");
      circle(g, 40, 42, 22, "f-buf-hi", { "fill-opacity": "0.85" });
      rect(g, 70, 20, 36, 44, "f-buf-hi", { "fill-opacity": "0.45" });
      rect(g, 0, 0, 120, 80, "f-buf-hi", { "fill-opacity": "0.55" });
    },
    banding: function (g) {
      rect(g, 0, 0, 120, 80, "f-buf-lo");
      for (var i = 0; i < 7; i++) rect(g, 0, i * 11.5, 120, 11.5, "f-paint-sky", { "fill-opacity": String((0.95 - i * 0.13).toFixed(2)) });
      poly(g, "0,80 30,60 56,70 84,54 120,66 120,80", "f-solid");
    },
    nan: function (g) {
      rect(g, 0, 0, 120, 80, "f-buf-hi");
      [[20, 1.6], [60, 7], [100, 15]].forEach(function (p) {
        circle(g, p[0], 40, 16, "f-paint-candle", { "fill-opacity": "0.35" });
        rect(g, p[0] - p[1] / 2, 40 - p[1] / 2, p[1], p[1], "f-buf-lo");
      });
    },
    grey: function (g) {
      rect(g, 0, 0, 120, 80, "f-buf-lo");
      rect(g, 0, 0, 120, 52, "f-paint-sky", { "fill-opacity": "0.6" });
      rect(g, 0, 52, 120, 28, "f-solid");
      rect(g, 30, 24, 18, 28, "f-strong");
      rect(g, 72, 30, 24, 22, "f-strong");
      rect(g, 0, 0, 120, 80, "f-buf-hi", { "fill-opacity": "0.42" });
    }
  };

  /* Draws one bug's thumbnail into a fresh SVG; uid keeps filter ids unique. */
  function thumb(bug, uid, cls) {
    var svg = svgEl("svg", { "class": cls || "dg", viewBox: "0 0 120 80", role: "img", "aria-label": bug.name + ": " + bug.see, focusable: "false" });
    var g = svgEl("g", null, svg);
    var draw = DRAW[bug.id];
    if (draw) draw(g, uid);
    else log.warn("no thumbnail for", bug.id);
    return svg;
  }

  /* ---------- Links ---------- */

  function chapterLink(num) {
    var ch = HB.nav && HB.nav.byNum ? HB.nav.byNum(num) : null;
    if (!ch) return h("span", { text: num });
    var href = ch.status === "published" ? ch.file : "index.html#ch-" + num.replace(".", "-");
    return h("a", { href: href }, [num + " " + ch.title]);
  }

  function termLink(id, text) {
    var g = HB.glossary && HB.glossary[id];
    if (!g) return h("span", { text: text });
    return h("a", { "class": "term", "data-term": id, href: "glossary.html#" + id }, [text || g.term]);
  }

  /* ---------- Demo ---------- */

  function init(root) {
    var state = { family: "all", cue: "all", selected: "acne" };

    root.replaceChildren();
    root.appendChild(h("div", { "class": "demo-head" }, [
      h("span", { "class": "label", text: "Interactive" }),
      h("span", { "class": "demo-title", text: "Symptom gallery" }),
      h("span", { "class": "demo-hint", text: "Filter by where you see the bug and by what changes it, then pick a thumbnail to read its likely cause, what to check first and what to ask for. Arrow keys move between thumbnails." })
    ]));

    var controls = h("div", { "class": "demo-controls" });
    controls.appendChild(HB.segmented("Where you see it", [{ value: "all", label: "All" }].concat(FAMILIES.map(function (f) { return { value: f.id, label: f.label }; })), "all", function (v) {
      state.family = v;
      render(true);
    }));
    controls.appendChild(HB.segmented("What changes it", [{ value: "all", label: "Anything" }].concat(CUES.map(function (c) { return { value: c.id, label: c.label }; })), "all", function (v) {
      state.cue = v;
      render(true);
    }));
    root.appendChild(controls);

    /* Detail first, so on a phone it sits above the grid it describes. */
    var body = h("div", { style: "display:flex;flex-wrap:wrap;gap:var(--sp-4);align-items:flex-start" });
    var detail = h("div", { "class": "demo-panel", "aria-live": "polite", style: "flex:1 1 250px;min-width:0" });
    var gridWrap = h("div", { style: "flex:1.8 1 340px;min-width:0" });
    var grid = h("div", { role: "group", "aria-label": "Visual bugs", style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(min(96px,100%),1fr));gap:8px" });
    var empty = h("p", { "class": "demo-hint", hidden: true, text: "No bug in this gallery matches both filters. Try Anything or All." });
    gridWrap.append(grid, empty);
    body.append(detail, gridWrap);
    root.appendChild(body);

    var readout = h("div", { "class": "demo-readout", "aria-live": "polite" });
    root.appendChild(readout);

    /* One button per bug, built once; filtering hides and shows them. */
    var buttons = {};
    BUGS.forEach(function (bug) {
      var b = h("button", {
        type: "button",
        "aria-pressed": "false",
        "data-bug": bug.id,
        tabindex: "-1",
        style: "display:grid;gap:4px;align-content:start;padding:4px 4px 6px;border:1px solid var(--line-strong);border-radius:var(--radius-m);background:var(--surface);color:var(--ink);font:inherit;font-size:0.74rem;line-height:1.25;text-align:left;cursor:pointer;min-width:0"
      });
      var svg = thumb(bug, "sg-t-" + bug.id, "dg");
      svg.setAttribute("aria-hidden", "true");
      svg.removeAttribute("role");
      svg.style.borderRadius = "4px";
      b.append(svg, h("span", { text: bug.name }));
      b.addEventListener("click", function () { select(bug.id, true); });
      b.addEventListener("keydown", onKey);
      buttons[bug.id] = b;
      grid.appendChild(b);
    });

    function visibleButtons() {
      return filter(state.family, state.cue).map(function (bug) { return buttons[bug.id]; });
    }

    /* Roving tab stop: exactly one visible thumbnail is in the tab order. */
    function setTabStop(id) {
      Object.keys(buttons).forEach(function (k) { buttons[k].setAttribute("tabindex", k === id ? "0" : "-1"); });
    }

    function columns(list) {
      if (list.length < 2) return 1;
      var top = list[0].offsetTop;
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i].offsetTop !== top) break;
        n++;
      }
      return Math.max(1, n);
    }

    function onKey(event) {
      var list = visibleButtons();
      var i = list.indexOf(event.currentTarget);
      if (i < 0) return;
      var cols = columns(list);
      var j = i;
      if (event.key === "ArrowRight") j = Math.min(list.length - 1, i + 1);
      else if (event.key === "ArrowLeft") j = Math.max(0, i - 1);
      else if (event.key === "ArrowDown") j = Math.min(list.length - 1, i + cols);
      else if (event.key === "ArrowUp") j = Math.max(0, i - cols);
      else if (event.key === "Home") j = 0;
      else if (event.key === "End") j = list.length - 1;
      else return;
      event.preventDefault();
      var next = list[j];
      setTabStop(next.getAttribute("data-bug"));
      next.focus();
    }

    function select(id, fromClick) {
      state.selected = id;
      Object.keys(buttons).forEach(function (k) {
        var on = k === id;
        buttons[k].setAttribute("aria-pressed", on ? "true" : "false");
        buttons[k].style.borderColor = on ? "var(--accent)" : "var(--line-strong)";
        buttons[k].style.boxShadow = on ? "0 0 0 1px var(--accent)" : "none";
        buttons[k].style.background = on ? "var(--accent-soft)" : "var(--surface)";
      });
      setTabStop(id);
      drawDetail();
      drawReadout();
      if (fromClick) {
        var r = detail.getBoundingClientRect();
        if (r.top < 0 || r.top > window.innerHeight) detail.scrollIntoView({ block: "nearest" });
      }
      log.debug("select", id);
    }

    function row(label, text) {
      return h("p", { "class": "demo-hint" }, [h("strong", { text: label + " " }), text]);
    }

    function drawDetail() {
      var bug = byId(BUGS, state.selected);
      detail.replaceChildren();
      if (!bug) return;
      var fam = byId(FAMILIES, bug.family);
      var cue = byId(CUES, bug.cue);
      var big = thumb(bug, "sg-d-" + bug.id, "dg");
      big.style.maxWidth = "320px";
      big.style.border = "1px solid var(--line-strong)";
      big.style.borderRadius = "var(--radius-m)";
      detail.append(
        big,
        h("p", { "class": "label", text: fam.label + " · changes with " + cue.label.toLowerCase() }),
        h("p", { style: "font-family:var(--font-display);font-weight:600;font-size:1.1rem;margin:0" }, [bug.name]),
        row("What you see:", bug.see),
        row("Tell-tale:", cue.long),
        row("Likely cause:", bug.cause),
        row("Check first:", bug.check),
        row("Ask for:", bug.ask),
        h("p", { "class": "demo-hint" }, [h("strong", { text: "Explained in " }), chapterLink(bug.ch), " · term: ", termLink(bug.term)])
      );
    }

    function drawReadout() {
      var list = filter(state.family, state.cue);
      var bug = byId(BUGS, state.selected);
      function cell(label, value) {
        return h("span", { "class": "r" }, [h("span", { "class": "label", text: label }), h("span", { "class": "v", text: value })]);
      }
      readout.replaceChildren(
        cell("Showing", list.length + " of " + BUGS.length),
        cell("Selected", bug ? bug.name : "none"),
        cell("Where", bug ? byId(FAMILIES, bug.family).label : "–"),
        cell("Explained in", bug ? bug.ch : "–")
      );
    }

    /* Applies the filters. If the selected bug is filtered out, the first
       visible one is selected, so the detail always matches the grid. */
    function render(filtersChanged) {
      var list = filter(state.family, state.cue);
      BUGS.forEach(function (bug) { buttons[bug.id].hidden = list.indexOf(bug) < 0; });
      empty.hidden = list.length > 0;
      if (list.length && list.indexOf(byId(BUGS, state.selected)) < 0) {
        select(list[0].id, false);
        return;
      }
      if (filtersChanged) {
        setTabStop(state.selected);
        drawReadout();
        return;
      }
      select(state.selected, false);
    }

    render(false);
  }

  HB.demos.register("symptom-gallery", init);
})();

/*
 * nav.js: the book's table of contents. Single source of truth for parts,
 * chapters, their order, file names and publication status.
 *
 * Read by: shell.js (sidebar, pager, cross-references, progress), the home
 * page contents, the glossary page, tools/build-search-index.mjs and the
 * structure tests (which evaluate this file in a Node sandbox).
 *
 * To publish a chapter: write docs/<file>.html (see fileOf below), then set
 * its status to "published". The structure tests fail if a published
 * chapter has no page, or a page exists for a chapter still marked planned.
 *
 * Fields per chapter:
 *   num     "4.2"  part.chapter; also the page's <body data-page>
 *   slug    used to build the file name
 *   title   chapter title
 *   terms   the main terms it covers (shown in contents and search)
 *   core    on the short reading path
 *   status  "published" | "planned"
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});

  var parts = [
    {
      n: 0, title: "Start here", blurb: "The whole route in one sitting, before any detail.",
      chapters: [
        { num: "0.1", slug: "whole-journey", title: "The whole journey on one page", terms: "asset, draw call, frame, pass", core: true, status: "published" },
        { num: "0.2", slug: "what-a-frame-is", title: "What a frame is", terms: "fps, frame time, 16.6 ms, game loop, vsync", core: true, status: "published" }
      ]
    },
    {
      n: 1, title: "How games get made", blurb: "How a game moves from an idea to a shipped build, and who touches it on the way.",
      chapters: [
        { num: "1.1", slug: "idea-to-gold", title: "From idea to gold master", terms: "concept, prototype, vertical slice, production, alpha, beta, gold, live ops", core: true, status: "published" },
        { num: "1.2", slug: "who-does-what", title: "Who does what", terms: "concept, 3D and technical artists; designers; gameplay, engine and graphics programmers; producers; QA", core: false, status: "published" },
        { num: "1.3", slug: "content-pipeline", title: "The content pipeline", terms: "DCC tool, source and cooked assets, FBX, glTF, USD, baking, import, build, Perforce, Git LFS", core: true, status: "published" },
        { num: "1.4", slug: "platforms", title: "Platforms and what they change", terms: "PC, console, mobile, VR, web; fixed and variable hardware; certification", core: false, status: "published" }
      ]
    },
    {
      n: 2, title: "Inside a game engine", blurb: "What an engine is made of and how it spends each frame.",
      chapters: [
        { num: "2.1", slug: "engine-anatomy", title: "Anatomy of an engine", terms: "renderer, physics, animation, audio, scripting, asset system, editor, RHI", core: true, status: "published" },
        { num: "2.2", slug: "game-loop-threads", title: "The game loop and threads", terms: "update, fixed timestep, game thread, render thread, GPU queue, frame latency", core: true, status: "published" },
        { num: "2.3", slug: "scenes-objects", title: "Scenes, objects and components", terms: "scene graph, Actor, GameObject, Node, component, ECS, prefab, transform hierarchy", core: false, status: "published" },
        { num: "2.4", slug: "engine-landscape", title: "The engine landscape", terms: "Unreal, Unity URP and HDRP, Godot, custom engines; Nanite, Lumen, VSM by name", core: false, status: "published" }
      ]
    },
    {
      n: 3, title: "Foundations", blurb: "The small set of ideas everything else leans on.",
      chapters: [
        { num: "3.1", slug: "pixels-displays", title: "Pixels and displays", terms: "framebuffer, resolution, refresh rate, tearing, vsync, VRR, double buffering", core: false, status: "published" },
        { num: "3.2", slug: "colour", title: "Colour done right", terms: "RGB, linear and sRGB, gamma, HDR, bit depth, banding", core: true, status: "published" },
        { num: "3.3", slug: "vectors", title: "Vectors you can see", terms: "vector, normalise, dot product, cross product", core: false, status: "published" },
        { num: "3.4", slug: "spaces-transforms", title: "Spaces and transforms", terms: "object, world, view, clip and screen space; matrix, MVP, frustum, FOV, near and far planes", core: true, status: "published" },
        { num: "3.5", slug: "cpu-gpu-apis", title: "CPU, GPU and graphics APIs", terms: "parallelism, VRAM, DirectX 12, Vulkan, Metal, WebGPU, driver, tile-based GPU", core: true, status: "published" }
      ]
    },
    {
      n: 4, title: "Geometry", blurb: "What actually gets sent to the GPU, and how engines avoid sending too much.",
      chapters: [
        { num: "4.1", slug: "meshes", title: "Meshes", terms: "vertex, triangle, normal, tangent, UV, winding order, topology", core: true, status: "published" },
        { num: "4.2", slug: "vertex-buffers", title: "Vertex buffers and index buffers", terms: "vertex attribute, layout, stride, interleaving, index buffer, 16 and 32-bit indices, static and dynamic buffers", core: true, status: "published" },
        { num: "4.3", slug: "draw-calls", title: "Draw calls, batching and instancing", terms: "draw call, pipeline state, material sorting, static and dynamic batching, GPU instancing, indirect draws", core: true, status: "published" },
        { num: "4.4", slug: "culling", title: "Culling", terms: "frustum, backface and occlusion culling, bounding volumes, Hi-Z, PVS", core: true, status: "published" },
        { num: "4.5", slug: "level-of-detail", title: "Level of detail", terms: "LOD, popping, HLOD, impostor, meshlet, cluster, Nanite, tessellation", core: true, status: "published" },
        { num: "4.6", slug: "moving-geometry", title: "Moving geometry", terms: "skeleton, skin weights, skinning, blend shapes, vertex animation textures", core: false, status: "published" }
      ]
    },
    {
      n: 5, title: "The GPU pipeline", blurb: "The fixed route every triangle takes through the GPU.",
      chapters: [
        { num: "5.1", slug: "pipeline-overview", title: "The pipeline in one picture", terms: "input assembly, vertex shader, rasterizer, pixel shader, output merger; programmable and fixed stages", core: true, status: "published" },
        { num: "5.2", slug: "vertex-shaders", title: "Vertex shaders", terms: "transform, clip space, interpolators, vertex animation", core: false, status: "published" },
        { num: "5.3", slug: "rasterization", title: "Rasterization", terms: "coverage, sample point, barycentric interpolation, perspective correction, fill rule", core: true, status: "published" },
        { num: "5.4", slug: "pixel-shaders", title: "Pixel shaders and overdraw", terms: "fragment, early-Z, depth pre-pass, overdraw, quad overdraw, derivatives", core: true, status: "published" },
        { num: "5.5", slug: "depth-blending", title: "Depth, stencil and blending", terms: "z-buffer, z-fighting, reversed-Z, stencil, alpha blend, premultiplied alpha, alpha test, sort order, OIT", core: true, status: "published" },
        { num: "5.6", slug: "shaders-in-practice", title: "Shaders in practice", terms: "HLSL, GLSL, constant buffer, shader variant, PSO, compile stutter, compute shader, render target, render pass, frame graph", core: false, status: "published" }
      ]
    },
    {
      n: 6, title: "Textures and materials", blurb: "How flat triangles get their surface detail.",
      chapters: [
        { num: "6.1", slug: "textures-uvs", title: "Textures and UVs", terms: "texel, UV unwrap, seams, texel density, wrap modes, atlas, cubemap", core: true, status: "published" },
        { num: "6.2", slug: "filtering-mipmaps", title: "Filtering and mipmaps", terms: "nearest, bilinear, trilinear, anisotropic, mip chain, LOD bias, shimmer", core: true, status: "published" },
        { num: "6.3", slug: "texture-memory", title: "Texture memory", terms: "BC1 to BC7, ASTC, block compression, streaming, virtual textures", core: false, status: "published" },
        { num: "6.4", slug: "normal-maps", title: "Normal maps and fake detail", terms: "tangent space, normal map, baking, height map, parallax occlusion, displacement, detail maps", core: false, status: "published" },
        { num: "6.5", slug: "pbr-materials", title: "PBR materials", terms: "base colour, metallic, roughness, F0, Fresnel, microfacets, GGX, BRDF, energy conservation, material instance, shader graph", core: true, status: "published" }
      ]
    },
    {
      n: 7, title: "Lighting and shadows", blurb: "How surfaces get lit and shadowed, and the main ways renderers organise that work.",
      chapters: [
        { num: "7.1", slug: "lights", title: "Lights", terms: "directional, point, spot, area, sky and emissive lights; attenuation; lumen, lux, nit, EV", core: false, status: "published" },
        { num: "7.2", slug: "shading-models", title: "Shading models", terms: "diffuse, specular, Lambert, Blinn-Phong, Cook-Torrance, N·L", core: false, status: "published" },
        { num: "7.3", slug: "render-paths", title: "Forward, deferred and clustered", terms: "forward, deferred, G-buffer, multiple render targets, tiled and clustered (Forward+), visibility buffer", core: true, status: "published" },
        { num: "7.4", slug: "shadow-maps", title: "Shadow maps", terms: "light-space depth, shadow bias, acne, peter-panning, PCF, PCSS", core: true, status: "published" },
        { num: "7.5", slug: "shadows-at-scale", title: "Shadows at scale", terms: "cascades (CSM), shadow atlas, virtual shadow maps, contact shadows, distance-field shadows, ray-traced shadows", core: false, status: "published" },
        { num: "7.6", slug: "reflections-ibl", title: "Reflections and image-based lighting", terms: "environment map, reflection probe, box projection, irradiance, SSR, planar reflection", core: false, status: "published" }
      ]
    },
    {
      n: 8, title: "Global illumination and ambient occlusion", blurb: "Bounced light and contact darkening: the home of most graphics acronyms.",
      chapters: [
        { num: "8.1", slug: "indirect-light", title: "Direct and indirect light", terms: "bounce, colour bleeding, the rendering equation in pictures, diffuse and specular GI", core: true, status: "published" },
        { num: "8.2", slug: "baked-lighting", title: "Baked lighting", terms: "lightmap, lightmap UVs, light probes, spherical harmonics, irradiance volume; static, stationary, movable", core: false, status: "published" },
        { num: "8.3", slug: "ambient-occlusion", title: "Ambient occlusion: SSAO to GTAO", terms: "AO, SSAO, HBAO, GTAO, horizon angle, bent normal, multi-bounce, specular occlusion, RTAO", core: true, status: "published" },
        { num: "8.4", slug: "screen-space", title: "Screen-space tricks and their blind spots", terms: "ray marching, Hi-Z tracing, SSR, SSGI, thickness, off-screen misses, fallbacks", core: true, status: "published" },
        { num: "8.5", slug: "realtime-gi", title: "Real-time GI families", terms: "LPV, VXGI, SDFGI, DDGI probes, Lumen surface cache, radiance cascades, light leaking", core: true, status: "published" },
        { num: "8.6", slug: "ray-tracing", title: "Ray tracing", terms: "ray, BVH, BLAS and TLAS, DXR, hybrid rendering; ray-traced shadows, reflections and GI", core: false, status: "published" },
        { num: "8.7", slug: "path-tracing", title: "Path tracing and denoising", terms: "samples per pixel, noise, fireflies, importance sampling, ReSTIR, SVGF, ray reconstruction", core: false, status: "published" }
      ]
    },
    {
      n: 9, title: "Post-processing and image quality", blurb: "Everything done to the image after the scene is lit.",
      chapters: [
        { num: "9.1", slug: "tone-mapping", title: "HDR, exposure and tone mapping", terms: "scene-referred light, exposure, auto-exposure, tone curve, ACES, AgX, LUT, colour grading", core: true, status: "published" },
        { num: "9.2", slug: "anti-aliasing", title: "Anti-aliasing", terms: "jaggies, specular aliasing, SSAA, MSAA, FXAA, SMAA, TAA, jitter, history, motion vectors, ghosting", core: true, status: "published" },
        { num: "9.3", slug: "upscaling", title: "Upscaling and frame generation", terms: "DLSS, FSR, XeSS, TSR, internal resolution, dynamic resolution, VRS, frame generation, latency", core: true, status: "published" },
        { num: "9.4", slug: "camera-effects", title: "Camera effects", terms: "bloom, depth of field, circle of confusion, bokeh, motion blur, velocity buffer, grain, vignette", core: false, status: "published" },
        { num: "9.5", slug: "atmosphere", title: "Atmosphere", terms: "height fog, volumetric fog, froxels, god rays, sky scattering, volumetric clouds", core: false, status: "published" },
        { num: "9.6", slug: "special-surfaces", title: "Special surfaces and effects", terms: "particles, flipbooks, soft particles, decals, water, foliage, subsurface scattering, hair, terrain", core: false, status: "published" }
      ]
    },
    {
      n: 10, title: "Anatomy of a frame", blurb: "Every earlier chapter replayed, in order, on real frames.",
      chapters: [
        { num: "10.1", slug: "deferred-frame", title: "A deferred frame, pass by pass", terms: "shadow pass, depth pre-pass, G-buffer, AO, lighting, SSR and SSGI, fog, transparents, post, UI", core: true, status: "published" },
        { num: "10.2", slug: "mobile-frame", title: "A mobile frame", terms: "forward rendering, tile-based deferred rendering, load and store actions, bandwidth, heat", core: false, status: "planned" },
        { num: "10.3", slug: "modern-feature-stack", title: "A modern feature stack", terms: "Nanite, Lumen, virtual shadow maps, TSR; how to read a feature list", core: false, status: "planned" }
      ]
    },
    {
      n: 11, title: "Performance", blurb: "Where the milliseconds go and how to find out.",
      chapters: [
        { num: "11.1", slug: "frame-budgets", title: "Frame budgets", terms: "fps and ms, CPU-bound and GPU-bound, 1% lows, frame pacing, input latency", core: true, status: "planned" },
        { num: "11.2", slug: "gpu-time", title: "Where GPU time goes", terms: "resolution, fill rate, overdraw, shader cost, bandwidth, VRAM", core: false, status: "planned" },
        { num: "11.3", slug: "cpu-time", title: "Where CPU time goes", terms: "draw calls, culling, animation, physics, scripts, garbage collection, job systems", core: false, status: "planned" },
        { num: "11.4", slug: "memory-hitches", title: "Memory, streaming and hitches", terms: "texture pool, mesh streaming, loading, shader compile stutter, PSO cache", core: false, status: "planned" },
        { num: "11.5", slug: "profilers-settings", title: "Profilers and the settings menu", terms: "RenderDoc, PIX, Unreal Insights, Unity Profiler; scalability tiers", core: false, status: "planned" }
      ]
    },
    {
      n: 12, title: "Working with AI", blurb: "Turning the vocabulary into briefs, reviews and decisions.",
      chapters: [
        { num: "12.1", slug: "where-ai-fits", title: "Where AI fits today", terms: "shaders, engine code, tools, asset generation, review, log and capture analysis; where it falls short", core: false, status: "planned" },
        { num: "12.2", slug: "briefing-ai", title: "Briefing AI on graphics work", terms: "engine and version, render pipeline, target platform, budget, reproduction steps, acceptance criteria", core: true, status: "planned" },
        { num: "12.3", slug: "reviewing-ai-code", title: "Reviewing AI-written graphics code", terms: "colour-space mix-ups, wrong coordinate space, API and version mismatch, per-frame allocation, precision, missing fallbacks", core: false, status: "planned" },
        { num: "12.4", slug: "visual-bug-guide", title: "Visual bug field guide", terms: "acne, peter-panning, z-fighting, light leaks, ghosting, banding, fireflies, shimmer, seams, popping", core: true, status: "planned" },
        { num: "12.5", slug: "decision-guides", title: "Decision guides", terms: "choosing a render path, shadows, GI and anti-aliasing per platform and team size", core: false, status: "planned" }
      ]
    }
  ];

  /* "4.2" -> "04-2-vertex-buffers.html". Two-digit part keeps files sorted. */
  function fileOf(ch) {
    var bits = ch.num.split(".");
    var part = bits[0].length === 1 ? "0" + bits[0] : bits[0];
    return part + "-" + bits[1] + "-" + ch.slug + ".html";
  }

  /* Numeric order for chapter numbers: "4.2" < "4.10" < "10.1". */
  function compare(a, b) {
    var x = a.split(".").map(Number);
    var y = b.split(".").map(Number);
    return x[0] - y[0] || x[1] - y[1];
  }

  var chapters = [];
  parts.forEach(function (part) {
    part.chapters.forEach(function (ch) {
      ch.part = part.n;
      ch.file = fileOf(ch);
      chapters.push(ch);
    });
  });

  HB.nav = {
    parts: parts,
    chapters: chapters,
    fileOf: fileOf,
    compare: compare,
    byNum: function (num) {
      for (var i = 0; i < chapters.length; i++) {
        if (chapters[i].num === num) return chapters[i];
      }
      return null;
    },
    partOf: function (num) {
      var n = Number(num.split(".")[0]);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].n === n) return parts[i];
      }
      return null;
    },
    /* Contents anchor on the home page, used for chapters not yet written. */
    contentsHref: function (num) {
      return "index.html#ch-" + num.replace(".", "-");
    },
    /* Look-up pages, read out of order. Shown after the parts in the
       sidebar and the contents, and indexed for search. */
    reference: [
      { id: "glossary", title: "Glossary", file: "glossary.html", blurb: "Every term the handbook defines, with the chapter that teaches it." },
      { id: "acronyms", title: "Acronym decoder", file: "acronyms.html", blurb: "Every acronym in the handbook, spelled out, in one sorted list." }
    ]
  };
})();

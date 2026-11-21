/*
 * glossary.js: every term the handbook defines, keyed by a stable id.
 *
 * Used by: the hover card on any `.term` / `dfn.term` element, the glossary
 * page, the search index, and the structure tests.
 *
 * Fields:
 *   term  display name
 *   aka   other names readers will meet in engines, docs or AI output
 *   def   one or two plain sentences; no term used here should need its own
 *         lookup to make sense
 *   ch    the chapter that teaches it ("4.2"). The tests use this to enforce
 *         "no term before its chapter": a page that mentions a term taught
 *         later must mark that mention data-forward.
 *
 * Keep ids lowercase-hyphenated; they are also the glossary page anchors.
 */
(function () {
  "use strict";

  var HB = (window.HB = window.HB || {});

  HB.glossary = {
    "albedo": { term: "Albedo", aka: ["base colour","diffuse colour"], def: "The colour a surface reflects under white light, with no lighting or shadow baked in. Light-coloured surfaces bounce more light around a scene.", ch: "6.5" },
    "ambient-occlusion": { term: "Ambient occlusion", aka: ["AO"], def: "How much of the surrounding sky or environment a point can see. Creases, corners and contact points see less of it, so they receive less ambient light and look darker.", ch: "8.3" },
    "backface-culling": { term: "Backface culling", aka: ["face culling"], def: "Skipping triangles that face away from the camera. The GPU decides which way a triangle faces from the order of its corners on screen.", ch: "4.4" },
    "baked-lighting": { term: "Baked lighting", aka: ["precomputed lighting","light baking"], def: "Lighting calculated ahead of time, usually in the editor, and stored in textures or probes. Cheap at runtime and high quality, but it cannot react to things that move.", ch: "8.2" },
    "bent-normal": { term: "Bent normal", aka: [], def: "The average direction of open sky seen from a point. Where a surface is partly enclosed it leans away from the occluders, and engines use it to light and reflect more convincingly.", ch: "8.3" },
    "bilateral-filter": { term: "Bilateral filter", aka: ["depth-aware blur","edge-aware blur"], def: "A blur that only mixes neighbouring pixels at a similar depth and facing. It smooths noise without smearing one object's values onto another.", ch: "8.3" },
    "compute-shader": { term: "Compute shader", aka: [], def: "A GPU program that is not tied to drawing triangles. Renderers use compute shaders for post effects, AO, culling and simulation.", ch: "5.6" },
    "cpu": { term: "CPU", aka: ["processor"], def: "The general-purpose processor that runs game logic and the engine, and prepares the work the GPU will do each frame.", ch: "3.5" },
    "deferred-rendering": { term: "Deferred rendering", aka: ["deferred shading"], def: "A way of organising a frame that first writes each pixel's surface properties to a G-buffer and lights them in a later pass. It handles many lights well.", ch: "7.3" },
    "denoising": { term: "Denoising", aka: ["denoiser"], def: "Turning a noisy, under-sampled image into a clean one by blending neighbouring pixels and previous frames. Most real-time AO, GI and ray tracing depends on it.", ch: "8.7" },
    "depth-buffer": { term: "Depth buffer", aka: ["z-buffer","depth texture"], def: "A screen-sized image storing, for every pixel, how far the nearest visible surface is from the camera. It is the renderer's only record of the scene's shape after geometry is drawn.", ch: "5.5" },
    "diffuse": { term: "Diffuse reflection", aka: ["diffuse"], def: "Light that a surface scatters evenly in all directions, so it looks the same from any viewing angle. Matte paint is mostly diffuse.", ch: "7.2" },
    "direct-light": { term: "Direct light", aka: ["direct lighting"], def: "Light that travels straight from a light source to a surface without bouncing off anything else first.", ch: "8.1" },
    "disocclusion": { term: "Disocclusion", aka: [], def: "Pixels that become visible this frame after being hidden last frame. Temporal techniques have no history for them, so they often show noise or ghosting there.", ch: "9.2" },
    "draw-call": { term: "Draw call", aka: ["draw","DrawIndexed"], def: "One instruction from the CPU telling the GPU to draw a set of triangles with a given mesh, material and settings. Each one has a CPU cost, so engines try to need fewer.", ch: "4.3" },
    "dynamic-buffer": { term: "Dynamic buffer", aka: ["dynamic vertex buffer","streaming buffer"], def: "A GPU buffer the CPU rewrites often, sometimes every frame. Used for particles, UI and procedurally generated geometry.", ch: "4.2" },
    "forward-rendering": { term: "Forward rendering", aka: ["forward shading"], def: "A way of organising a frame where each object is lit as it is drawn. Simple and good for transparency and mobile GPUs.", ch: "7.3" },
    "frame": { term: "Frame", aka: [], def: "One complete image drawn by the game. At 60 frames per second each frame has about 16.7 milliseconds.", ch: "0.2" },
    "frame-budget": { term: "Frame budget", aka: ["budget"], def: "The time available to produce one frame at the target frame rate, split between systems: 16.7 ms at 60 fps, 11.1 ms at 90 fps, 33.3 ms at 30 fps.", ch: "11.1" },
    "g-buffer": { term: "G-buffer", aka: ["geometry buffer"], def: "A set of screen-sized images holding each pixel's surface data, such as colour, normal, roughness and depth, written before lighting in deferred rendering.", ch: "7.3" },
    "ghosting": { term: "Ghosting", aka: ["smearing","trails"], def: "Faint trails behind moving objects, left when a temporal technique blends in history from a place the object has already left.", ch: "9.2" },
    "global-illumination": { term: "Global illumination", aka: ["GI","indirect lighting"], def: "Lighting that includes light bouncing between surfaces, not only light arriving straight from sources.", ch: "8.1" },
    "gpu": { term: "GPU", aka: ["graphics card"], def: "The graphics processor: thousands of simple cores running the same small program on many vertices or pixels at once.", ch: "3.5" },
    "gtao": { term: "GTAO", aka: ["ground-truth ambient occlusion","XeGTAO"], def: "A screen-space AO method that finds the two horizons in a few slices around each pixel and integrates the visible sky between them exactly, so it closely matches ray-traced AO for what the depth buffer shows.", ch: "8.3" },
    "hbao": { term: "HBAO", aka: ["horizon-based ambient occlusion","HBAO+"], def: "A screen-space AO method that marches outward from each pixel in a few directions and records how high the surrounding surfaces rise above it.", ch: "8.3" },
    "horizon-angle": { term: "Horizon angle", aka: ["horizon"], def: "In one direction from a point, the steepest angle at which surrounding geometry rises above it. Everything below that angle is blocked; everything above is open sky.", ch: "8.3" },
    "index-buffer": { term: "Index buffer", aka: ["IBO","element buffer","element array"], def: "A GPU buffer listing which vertices form each triangle, by row number in the vertex buffer. It lets triangles share corners instead of storing them again.", ch: "4.2" },
    "index-format": { term: "Index format", aka: ["16-bit indices","32-bit indices","UInt16","UInt32"], def: "How many bytes each index uses. 16-bit indices are half the size but can only address 65,536 vertices; bigger meshes need 32-bit indices or splitting.", ch: "4.2" },
    "indirect-light": { term: "Indirect light", aka: ["bounce light","indirect lighting"], def: "Light that reaches a surface after bouncing off at least one other surface. It is why shadows are rarely pure black.", ch: "8.1" },
    "input-assembler": { term: "Input assembler", aka: ["input assembly","vertex fetch"], def: "The fixed GPU stage that reads the index buffer, fetches the vertex rows it points to and groups them into triangles for the vertex shader.", ch: "5.1" },
    "instancing": { term: "GPU instancing", aka: ["instancing","instanced drawing"], def: "Drawing many copies of the same mesh in one draw call, each with its own position and small per-copy data.", ch: "4.3" },
    "interleaved": { term: "Interleaved layout", aka: ["array of structures","AoS"], def: "Storing all of a vertex's attributes next to each other in one row, then the next vertex's row, and so on.", ch: "4.2" },
    "internal-resolution": { term: "Internal resolution", aka: ["render resolution","half resolution"], def: "The resolution an effect or the whole frame is actually computed at, before being scaled to the output. Half resolution means a quarter of the pixels.", ch: "9.3" },
    "lightmap": { term: "Lightmap", aka: [], def: "A texture holding precomputed lighting for static surfaces, laid out with its own UV coordinates.", ch: "8.2" },
    "lod": { term: "Level of detail", aka: ["LOD"], def: "Simpler versions of a mesh swapped in as it gets smaller on screen, so distant objects cost less to draw.", ch: "4.5" },
    "lumen": { term: "Lumen", aka: [], def: "Unreal Engine 5's real-time global illumination and reflection system. It computes bounced light, and short-range occlusion, without baking.", ch: "8.5" },
    "mesh": { term: "Mesh", aka: ["model","geometry"], def: "The shape of an object as a set of triangles joined at shared corners, plus the per-corner data needed to draw it.", ch: "4.1" },
    "meshlet": { term: "Meshlet", aka: ["cluster"], def: "A small chunk of a mesh, typically 64 to 128 triangles, that modern renderers cull and process as a unit.", ch: "4.5" },
    "multi-bounce-ao": { term: "Multi-bounce AO", aka: ["multi-bounce approximation"], def: "A correction that brightens AO on light-coloured surfaces, because light bounces several times in a bright crease before it is absorbed.", ch: "8.3" },
    "nanite": { term: "Nanite", aka: ["virtualized geometry"], def: "Unreal Engine 5's geometry system. It splits meshes into clusters and streams and draws only the detail each part of the screen needs.", ch: "4.5" },
    "noise": { term: "Sampling noise", aka: ["noise","grain"], def: "Random speckle in an effect that was computed from too few samples per pixel. More samples, or denoising, removes it.", ch: "8.7" },
    "normal": { term: "Normal", aka: ["surface normal","vertex normal"], def: "A direction pointing straight out of a surface. Lighting uses it to work out how directly light hits that point.", ch: "4.1" },
    "pixel": { term: "Pixel", aka: [], def: "One dot of the final image. A 1920 by 1080 frame has about 2.07 million of them.", ch: "3.1" },
    "pixel-shader": { term: "Pixel shader", aka: ["fragment shader"], def: "The GPU program that runs for every pixel a triangle covers and decides that pixel's colour.", ch: "5.4" },
    "profiler": { term: "Frame capture tool", aka: ["profiler","RenderDoc","PIX"], def: "A tool that records one frame so you can inspect every draw call, buffer and texture, and how long each pass took.", ch: "11.5" },
    "quantization": { term: "Vertex quantization", aka: ["vertex compression","mesh compression","packing"], def: "Storing vertex attributes with fewer bits, for example 16-bit instead of 32-bit numbers, to save memory and bandwidth at a small loss of precision.", ch: "4.2" },
    "ray-marching": { term: "Ray marching", aka: ["screen-space tracing"], def: "Following a ray in small steps and checking at each step whether it has gone behind a surface, often using the depth buffer.", ch: "8.4" },
    "ray-tracing": { term: "Ray tracing", aka: ["RT","hardware ray tracing"], def: "Finding what a ray hits by testing it against the actual scene geometry, using acceleration structures that GPUs can now traverse in hardware.", ch: "8.6" },
    "render-pass": { term: "Render pass", aka: ["pass"], def: "One step in drawing a frame that reads some images and writes others, such as the shadow pass, the AO pass or the lighting pass.", ch: "5.6" },
    "rtao": { term: "RTAO", aka: ["ray-traced ambient occlusion"], def: "Ambient occlusion computed by tracing short rays against the real scene geometry instead of reading the depth buffer, so it sees hidden and off-screen objects.", ch: "8.3" },
    "screen-space": { term: "Screen space", aka: ["image space"], def: "Working from the rendered image and its depth rather than the 3D scene. Screen-space techniques are fast, but they only know about what the camera currently sees.", ch: "3.4" },
    "shader": { term: "Shader", aka: ["shader program"], def: "A small program that runs on the GPU for every vertex, pixel or work item, in parallel.", ch: "5.1" },
    "sky-light": { term: "Sky light", aka: ["ambient light","environment light"], def: "Light arriving from the whole surrounding environment rather than one point, such as the blue sky on a sunny day or a uniform grey overcast.", ch: "7.1" },
    "slice": { term: "Slice", aka: ["slice direction"], def: "In GTAO, one direction across the screen through a pixel. The pixel's hemisphere is examined one thin vertical slice at a time.", ch: "8.3" },
    "specular": { term: "Specular reflection", aka: ["specular","highlights"], def: "Light reflected in a preferred direction, like a mirror or a highlight on polished metal. It changes as the viewer moves.", ch: "7.2" },
    "specular-occlusion": { term: "Specular occlusion", aka: ["GTSO"], def: "Darkening reflections in creases and cavities where the reflected direction is blocked by nearby geometry.", ch: "8.3" },
    "split-vertex": { term: "Split vertex", aka: ["seam","hard edge","duplicated vertex"], def: "A corner stored as two or more vertices at the same position because the triangles meeting there need different normals, UVs or colours.", ch: "4.2" },
    "ssao": { term: "SSAO", aka: ["screen-space ambient occlusion"], def: "Ambient occlusion estimated from the depth buffer by testing a handful of nearby sample points per pixel. Fast, noisy, and limited to what is on screen.", ch: "8.3" },
    "ssgi": { term: "SSGI", aka: ["screen-space global illumination","SSIL"], def: "Bounced light estimated by tracing rays through the depth buffer and picking up colour from the lit image. It inherits every screen-space blind spot.", ch: "8.4" },
    "ssr": { term: "SSR", aka: ["screen-space reflections"], def: "Reflections found by tracing rays through the depth buffer and reusing the colour of whatever on-screen pixel they hit.", ch: "7.6" },
    "static-buffer": { term: "Static buffer", aka: ["static vertex buffer","immutable buffer"], def: "A GPU buffer filled once, usually at load time, and then only read. Most level geometry and props use static buffers.", ch: "4.2" },
    "stride": { term: "Stride", aka: ["vertex size"], def: "The number of bytes from the start of one vertex to the start of the next in a buffer. It is the size of one row.", ch: "4.2" },
    "taa": { term: "TAA", aka: ["temporal anti-aliasing"], def: "Anti-aliasing that jitters the camera slightly every frame and blends each new frame with the reprojected previous ones.", ch: "9.2" },
    "tangent": { term: "Tangent", aka: ["tangent vector","tangent frame"], def: "A direction lying along a surface, aligned with its texture's horizontal axis. Normal maps need it to know which way is which.", ch: "4.1" },
    "temporal-accumulation": { term: "Temporal accumulation", aka: ["history","temporal filter","temporal reprojection"], def: "Spreading work over several frames: each frame computes a few new samples and blends them with the result from previous frames, moved to account for motion.", ch: "9.2" },
    "texture": { term: "Texture", aka: ["map"], def: "An image the GPU reads while shading, such as a colour, normal or roughness map. Also used to store data like depth or AO.", ch: "6.1" },
    "thickness-heuristic": { term: "Thickness heuristic", aka: ["thickness"], def: "A guess that surfaces in the depth buffer are only so thick, so geometry behind them is treated as open. It reduces dark halos around thin foreground objects.", ch: "8.3" },
    "triangle": { term: "Triangle", aka: ["polygon","face","primitive"], def: "The basic shape GPUs draw. Three corners always lie on one flat plane, which makes triangles fast and unambiguous to fill.", ch: "4.1" },
    "triangle-list": { term: "Triangle list", aka: ["primitive topology","topology"], def: "The most common way to read indices: every three indices form one independent triangle.", ch: "4.2" },
    "uv": { term: "UV coordinates", aka: ["UVs","texture coordinates","texcoords"], def: "Two numbers per vertex saying which point of a 2D texture lands on that corner of the 3D surface.", ch: "4.1" },
    "vertex": { term: "Vertex", aka: ["vertices","vert"], def: "One corner of a mesh together with everything stored about it: position, normal, UVs and more.", ch: "4.1" },
    "vertex-attribute": { term: "Vertex attribute", aka: ["attribute","vertex channel","vertex element"], def: "One piece of data stored per vertex, such as position, normal, UV, colour or bone weights.", ch: "4.2" },
    "vertex-buffer": { term: "Vertex buffer", aka: ["VBO","vertex array"], def: "A block of GPU memory holding a mesh's vertices as rows of numbers, one row per vertex, ready for the GPU to read.", ch: "4.2" },
    "vertex-cache": { term: "Post-transform vertex cache", aka: ["vertex cache","post-transform cache"], def: "A small GPU cache of recently processed vertices. When an index repeats soon after, the GPU reuses the result instead of running the vertex shader again.", ch: "4.2" },
    "vertex-layout": { term: "Vertex layout", aka: ["input layout","vertex declaration","vertex format","vertex descriptor"], def: "The description that tells the GPU how to read a vertex buffer: which attributes it holds, their formats, and their byte offsets inside each row.", ch: "4.2" },
    "vertex-shader": { term: "Vertex shader", aka: [], def: "The GPU program that runs once per vertex, typically to move it from the model's own coordinates to its place on screen.", ch: "5.2" },
    "vertex-stream": { term: "Vertex stream", aka: ["separate streams","structure of arrays","SoA"], def: "One of several vertex buffers that together describe a mesh, each holding some of the attributes, such as positions in one buffer and everything else in another.", ch: "4.2" },
    "vram": { term: "VRAM", aka: ["video memory","GPU memory"], def: "The GPU's own memory. Meshes and textures live here so the GPU can read them fast without asking the CPU.", ch: "3.5" },
    "winding-order": { term: "Winding order", aka: ["front face","CW","CCW"], def: "Whether a triangle's corners go clockwise or anticlockwise on screen. The GPU uses it to decide which side of the triangle is the front.", ch: "4.1" }
  };
})();

# Relief Generator

Turn a **photograph** into a machinable **bas-relief** and export it as a **STEP B-spline surface** (or closed solid) that Fusion 360 CAM can toolpath directly, plus **STL** for 3D printing.

Everything runs in the browser (WebGPU, with a WASM fallback). Photos never leave the machine. After the first load the app works offline. G-code is out of scope; tooling, stock and toolpaths stay in Fusion.

```
photo ─► subject mask ─► depth (Depth Anything V2 Small) ─► relief compression ─► edge falloff
      ─► machining grid (tied to the finishing tool) ─► B-spline fit ─► STEP surface / STEP solid / STL
```

## Using it

1. `npm install`, then `npm run dev` and open the printed URL in Chrome or Edge (WebGPU). You can also use the GitHub Pages build.
2. Drop a photo. On the first run the models download (about 140 MB) and are cached by the browser after that. **Crop / rotate…** under the drop area turns the photo or keeps only part of it (free or fixed shapes such as square).
3. Pick a preset (Portrait / Pet / Object / Landscape / Illustration), set the width and relief height, and judge the result in the 3D view by moving the raking light. Use **Landscape** for scenes with no single subject (sunsets, trees, buildings): it keeps the whole picture instead of cutting out a subject. A plain border around the picture (poster matte, black bars) is trimmed off automatically so it doesn't become a raised frame.
4. Export:
   - **STEP surface**: one smooth B-spline face (top only). Define stock in Fusion.
   - **STEP solid**: B-spline top, 4 planar walls and a planar bottom, sewn into one closed body (needs base thickness > 0).
   - **STL**: watertight mesh straight from the grid.
   - **Height map**: 16-bit greyscale PNG (black = lowest, white = highest, one pixel per grid point) for Vectric Aspire, Carveco or laser software. The export info gives the Z range to enter there.

### What the cutter will leave

Set **Finishing tool** (ball end mill, tapered ball nose, or V-bit / engraver), its **Tool Ø** (ball Ø, tapered-ball tip Ø, or the V-bit's flat tip, 0 = sharp) and, for tapered and V tools, the **Included angle**. The 3D view's **Show** menu then offers:

- **As cut** (default): the surface the tool actually leaves. It can't get into corners tighter than its tip, so those come out filleted.
- **Design**: the exported surface.
- **Missed areas**: the design with the spots the tool can't reach in red (full red = 0.5 mm or more left). The info box gives the share of the surface and the most material left.

This is a full-coverage finishing pass (no stepover scallops). The exported STEP / STL is always the design; Fusion does the cutting. The tool also sets the auto grid spacing (tool Ø / 4, at least 0.2 mm for tapered and V tools).

Units in the files are mm. The bottom of the part is Z = 0, the base top is at Z = base thickness, and the highest point is at base + relief height. X/Y run from 0 to width/height, with the image's bottom-left corner at the origin.

## Lithophanes (3D printing)

Set **Make** to **Lithophane (3D print)**. Instead of a carved shape, the tool makes a thin plate whose thickness follows the photo's darkness: dark areas print thick, light areas thin, so the picture appears when the plate is lit from behind. Depth and the subject mask are not used.

| Setting | Default | What it does |
|---|---|---|
| Max thickness | 3 mm | Thickness of the darkest areas. 2.5–4 mm for white PLA; above 4 mm shadows go solid and lose detail. Lower it if the print is too dark. |
| Min thickness | 0.8 mm | Thickness of the lightest areas. 0.6–0.8 mm with a 0.4 mm nozzle; below 0.6 mm it can break or print with pinholes. Raise it if highlights look washed out. |
| Brightness / Contrast | 0 / 1 | Adjust the picture before it becomes thickness. |
| Midtone darkness | 1 | Above 1 makes midtones thicker (darker when lit), below 1 lighter. |
| Hanging hole | 0 | Hole near the top centre (below the dip on a heart) with a solid ring around it. |
| Shape | Flat rectangle | **Rounded corners**, **Oval / circle** and **Heart** cut the plate to that outline (it fits inside the picture; crop the photo square for a circle). **Curved (arc)** bends the plate around a vertical axis: picture on the outside, light goes inside, and it stands on its own. **Lamp shade**: see below. |
| Radius | 80 mm | Curved only: radius of the inside face. Smaller = more curved. The width is measured along the curve; the info box shows the arc angle and footprint. Radii so small the ends would touch are raised automatically. |
| Frame | 3 mm | Solid full-thickness border; stiffens the plate. 0 = none. |
| Mesh resolution (Advanced) | 0.2 mm | STL point spacing, about half the nozzle diameter. |

### Lamp shade

Pick **Shape → Lamp shade** and add pictures (button or drag and drop; reorder with ◀ ▶). They wrap all the way around a cylinder in that order, each one centre-cropped to an equal slice (π × diameter ÷ number of pictures). For a flip-book effect as it turns, use 6 or more frames of a scene that changes a little each time; frames from a short video work well. Settings: **Lamp diameter** (inside), **Lamp height**, **Divider** (solid strip between pictures), **Frame** (solid bands top and bottom) and **Bottom lip** (2 mm inward ledge to rest on a puck light; the info box shows the opening). **Spin** in the 3D view turns it. It is exported standing up, ready to print without supports.

The 3D view switches to a **Backlit** finish that simulates light shining through; pick Clay to see the geometry. Export is STL or **3MF** (the same mesh in a much smaller file that slicers open directly). Flat: back at Z = 0, picture side up. Curved and lamp shades: exported standing up (bottom edge at Z = 0), ready to print upright. Flat shapes also get a **Stand STL**: a block with a slot tilted 10° back, sized to the plate's max thickness plus 0.4 mm. A lithophane needs only the photo's brightness, so no models are downloaded or run in this mode.

The panel warns when min thickness is under 0.6 mm, max is over 4 mm, or the two are less than 1.5 mm apart.

**Printing tips** (also in the app under *Printing tips*): plain white or natural PLA (heavily pigmented bright white can block light; coloured and silk filaments wash out the picture), 100 % infill, 0.12–0.16 mm layers, slow outer walls, printed upright on its bottom edge with a brim. Light it with a white LED of roughly 300–600 lumens a few centimetres behind. Print a small test piece (about 2" wide) first to check your filament.

## Parameters

| Parameter | What it does |
|---|---|
| Relief height / Base thickness | Z range of the carving / flat material underneath (mm) |
| Compression method | **Gradient domain** (Weyrich-style, the most "carved" look; default) or **Base/detail split** (fast) |
| Depth compression | How hard the large-scale depth is flattened (0 = keep, 1 = coin-flat) |
| Detail boost | Gain on fine detail (eyes, folds, fur) |
| Edge falloff | Width of the smooth fillet from the subject edge down to the base, so there is no vertical cliff |
| Background | Flat base, or keep the background compressed (`Background level`) |
| Intaglio | Cut-in relief (subject recessed below the top surface) |
| Tone carving | Cuts areas that are clearly darker than their surroundings into the surface (and raises lighter ones) by this many mm, e.g. pupils and highlights. Depth estimation can't see painted features: a black pupil is the same distance away as the white of the eye. Presets: **Illustration** 0.8 mm, **Landscape** 0.5 mm (brings out the sun, clouds and silhouettes that depth misses), **Portrait** 0.4 mm (eyes, teeth, beard); off for Pet and Object, where dark fur and shadows would turn into dents. *Raise dark areas* flips it; *Tone carving scale* (Advanced) sets how big an area each pixel is compared against. |
| Advanced → Finishing tool Ø | Default 1/16" ball. Sets the grid spacing (auto = tool radius / 2) |
| Advanced → B-spline tolerance | Max deviation of the STEP surface from the grid (default 0.01 mm) |
| Advanced → Mask cleanup | Removes mask slivers thinner than the cutter can reproduce (whiskers, stray hair) |
| Advanced → others | Base/detail scale, discontinuity threshold, photo texture, smoothing, guided-upsampling ε, mask threshold |

Presets live in [`presets/*.json`](presets/). They set the "look" only, so size and machining settings are kept when you switch presets.

## Development

```bash
npm test            # unit tests (Poisson solver, B-spline fit, STEP import via OpenCascade, STL watertightness, pipeline)
npm run typecheck
npm run build       # static site in dist/
npm run tune -- --images samples/ --grid params/grid.json     # contact sheets for preset tuning
npm run export -- --image photo.jpg --preset pet --width-in 6  # headless photo → STEP/STL
```

The core pipeline (`src/core/`) is pure TypeScript with no DOM, so it runs unchanged in the browser workers and in Node.

| Path | Contents |
|---|---|
| `src/core/relief.ts` | Guided upsampling, base/detail compression (v1), gradient-domain compression (v2), edge falloff |
| `src/core/poisson.ts` | Screened Poisson solver (Jacobi-PCG, coarse-to-fine) |
| `src/core/resample.ts` | Tool-driven machining grid, pre-fit smoothing |
| `src/core/bspline.ts` | Separable least-squares bicubic B-spline fit, tolerance-driven control net |
| `src/core/step.ts` | STEP AP214 writer (surface body or closed solid) |
| `src/core/mesh.ts` | Closed meshes: heightfield, outline-cut shapes, lamp shade, stand; binary STL |
| `src/core/litho.ts` | Lithophane thickness mapping, outlines (rounded, oval, heart, hanging hole) |
| `src/core/cutter.ts` | Finishing-tool simulation (ball, tapered ball, V-bit) |
| `src/core/files.ts` | 3MF (zip) and 16-bit PNG height map writers |
| `src/models/` | transformers.js model stage, BiRefNet WebGPU graph patch |
| `src/workers/` | Model worker (WebGPU/WASM) and compute worker (relief, fit, export) |
| `src/ui/` | UI, three.js preview with raking light |
| `tools/` | Tuning harness and export CLI (Node) |

### Tuning presets

`npm run tune` runs the models once per photo (cached in `.cache/`). It then renders a raking-light preview of the machining heightfield for every combination in the parameter grid (`params/grid.json`) and writes one labelled contact sheet per photo to `out/tune/`. Pick the winners and copy their values into `presets/<name>.json`.

## Design decisions (deviations from the original brief)

- **No opencascade.js.** The B-spline fit and STEP writer are our own code. Reasons:
  - The machining grid is regular, so the least-squares surface fit separates into two banded 1-D solves. That is exact and takes about 0.1 s for a 6"×8" relief. `GeomAPI_PointsToBSplineSurface` on ~190 k points is very slow and memory-hungry, and opencascade.js is a ~60 MB WASM download that hasn't been released since 2023.
  - Control points sit at the Greville abscissae, so the surface is a true height field and its boundary curves lie exactly in the side planes. That makes the closed solid a clean 6-face BRep.
  - OpenCascade is still used **in the tests** to check that every STEP we write imports correctly (`occt-import-js`). A manual `BRepCheck_Analyzer` run on a 6"-wide portrait reported both files valid, with a positive solid volume.
- **BiRefNet runs in the browser thanks to two build-time / load-time workarounds** (both verified to give identical outputs in `test/onnxPatch.test.ts`):
  - `src/models/onnxPatch.ts` rewrites the downloaded model: 16-way `Concat`/`Split` become trees (WebGPU allows 16 storage buffers per shader), `Sum` becomes `Add`s, and `Slice(Cast→int64)` becomes `Cast(Slice)`. Those last ops had no WebGPU kernel and fell back to the CPU, where BiRefNet's deformable convolutions ran out of WASM memory.
  - A small Vite plugin (`vite.config.ts`) lets onnxruntime-web pass the `enableInt64` WebGPU option, which its JS layer otherwise drops. The build fails loudly if a future onnxruntime-web changes the code it patches.
  - If BiRefNet still fails on a given GPU, the app falls back to ormbg automatically.
- **Mask sanity check.** `src/core/maskQuality.ts` flags masks that are mostly grey, fall apart into pieces, or cover almost nothing, and the UI offers a one-click retry with another mask model. That is what turns a photo the mask model doesn't understand into a warning instead of a fragmented relief.
- **Edge-aware depth upsampling** uses a guided filter steered by the photo. Lower ε snaps depth edges tighter to photo edges but lets more photo texture into the depth.

## Status vs. milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Photo → depth + mask → shaded preview on WebGPU | ✅ (≈0.5 s warm on WebGPU; ~10 s first time while the GPU kernels compile) |
| 2 | Compression v1 + edge falloff + parameters UI | ✅ |
| 3 | Tuning harness + first presets | ✅ harness; presets are a first pass from 3 public test photos and need the owner's samples |
| 4 | STEP surface export | ✅ written and validated in OpenCascade; **needs a Fusion import + scallop toolpath test** |
| 5 | STEP solid + STL | ✅ |
| 6 | Gradient-domain compression (v2) | ✅ (default for Portrait/Pet) |
| 7 | Nice-to-haves | Offline service worker ✅ (fresh cache per deploy); crop/rotate ✅; mask brush and saved sessions not started |

## Open questions for the owner

- Typical finished size and max relief depth?
- Usual material (hardwood, MDF, aluminum, plastic)? This affects default smoothing and tool size.
- Main machine (router vs. VMC)? This affects default tool diameter and size limits.

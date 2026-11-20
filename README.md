# Relief Generator

Turn a **photograph** into a machinable **bas-relief** and export it as a **STEP B-spline surface** (or closed solid) that Fusion 360 CAM can toolpath directly, plus **STL** for 3D printing.

Everything runs in the browser (WebGPU, with a WASM fallback). Photos never leave the machine. After the first load the app works offline. For a 3-axis router it can also write raster G-code directly (roughing, finishing, a detail pass with a smaller tool, and a cutout with tabs) plus a printable setup sheet; for anything more involved, use the STEP in Fusion.

```
photo ─► subject mask ─► depth (Depth Anything V2 Small) ─► relief compression ─► edge falloff
      ─► machining grid (tied to the finishing tool) ─► B-spline fit ─► STEP surface / STEP solid / STL
```

## Using it

1. `npm install`, then `npm run dev` and open the printed URL in Chrome or Edge (WebGPU). You can also use the GitHub Pages build.
2. Drop a photo. On the first run the models download (about 140 MB) and are cached by the browser after that. **Crop / rotate…** under the drop area turns the photo or keeps only part of it (free or fixed shapes such as square).
Every slider has a box next to it for typing an exact value (lengths in the current units; press Enter). The tool Ø, fitter hole and angle boxes also offer common sizes in their drop-down (1/64"–1/2", metric mills, 30/60/90° V-bits).

3. Pick a preset (Portrait / Pet / Object / Landscape / Illustration), set the width and relief height, and judge the result in the 3D view by moving the raking light. Use **Landscape** for scenes with no single subject (sunsets, trees, buildings): it keeps the whole picture instead of cutting out a subject. A plain border around the picture (poster matte, black bars) is trimmed off automatically so it doesn't become a raised frame.
4. Export:
   - **STEP surface**: one smooth B-spline face (top only). Define stock in Fusion.
   - **STEP solid**: B-spline top, 4 planar walls and a planar bottom, sewn into one closed body (needs base thickness > 0).
   - **STL**: watertight mesh straight from the grid.
   - **Height map**: 16-bit greyscale PNG (black = lowest, white = highest, one pixel per grid point) for Vectric Aspire, Carveco or laser software. The export info gives the Z range to enter there.

### Stock & border (CNC relief)

The **Stock & border** section lays the picture out on the board you are cutting from, with a top view you can drag the picture around in (it snaps to the centre lines; with the view selected, arrow keys nudge it, Shift for 10×).

- **Width (X) / Height (Y)**: the board size (drop-down: common sizes, including the real widths of 1× boards). 0 = just big enough for the picture, plus the border and gap. **Thickness**: the board thickness (Z0 and roughing use it).
- **Shape**: rectangle, rounded corners, oval / circle (square stock for a circle) or arched top. The picture fades out inside it and the cutout follows it, so an oval plaque comes out oval. **Edge margin** keeps a plain strip between the board edge and the shape.
- **Picture X / Y**: where the picture's centre sits relative to the middle of the board. **Centre**, **Fit** (as big as fits inside the border) and **Fill** (fills the space inside the border; what hangs over fades out, for an oval vignette) need a board size set.
- **Border**, from a library:
  - Basic profiles, like a router bit or picture frame: flat band, bead, cove, bevel, ogee, bead & cove, stepped, reeded, flat with a V-groove.
  - Decorative patterns that repeat along it: rope, pearls, dentil blocks, scalloped, egg & dart, Greek key, fluted.
  - Patterns fit a whole number of times so they meet without a seam; on a rectangle each side starts at a corner and the pattern mirrors at the mitre, like a carved frame.
  - **Border width**, **Border height** (it may be taller than the relief), **Gap to picture** and **Pattern size** (0 = sized to the border).
  - With Intaglio the border is cut in.

Changing the layout or the border doesn't recompute the relief, so it updates in a fraction of a second.

### G-code for a 3-axis router

The **G-code** section (CNC relief mode) writes plain G-code that GRBL, Mach3/4, LinuxCNC, UCCNC and most hobby controllers run (G20/G21 follows the inch/mm setting). It is split into groups:

- **Job**: **Material** (sets the recommended speeds and feeds), **Z zero** (top of the stock, or the spoilboard) and the **Safe height** for moves across.
- **Roughing** (optional, T1): Z-level raster with a flat or ball end mill. It takes the material down level by level (**Stepdown**), lines **Stepover** apart, and stops **Leave for finish** above the surface, cutting only where material is left. With a flat end mill, flat floor (the base round the picture and border) is cut to its final depth, and the finishing pass leaves it out: it rapids across instead of feeding over it.
- **Finishing** (T2): zig-zag raster with the **Finishing tool** from the Relief section (ball, tapered ball, V-bit or flat), along X, Y or both (cross-hatch). The tool rides on the surface without gouging, using the same tool shape as the "As cut" view. The info shows the ridge height the stepover leaves and the recommended stepover (10 % of the ball / tip Ø, or a 0.004 mm ridge for tiny tips).
- **Detail (rest machining)** (optional, T3): after finishing, a smaller tapered ball, ball or V-bit goes over only the spots the finishing tool could not get into (eyes, hair, tight creases; see them with Show → Missed areas). It hops between them just over the finished surface instead of going up to the safe height. With it on, **As cut** and **Missed areas** show what is left after both tools.
- **Cutout** (optional, T1 again): cuts the part free with the roughing tool, round the outline (the stock edge, or the shape and edge margin under Stock & border) at the tool radius in one continuous spiral (no plunging), down to **Cut below** into the spoilboard, with **Tabs per side** to hold the part. Climb (clockwise) or conventional.
- **Machine**: spindle speed range and max feed (the recommendations stay inside them), **Ramp angle** (each cut starts by going back and forth along its start while going down, instead of plunging; 0 = plunge), **Spindle spin-up** (G4 wait after M3) and the **Tool change** style for the all-in-one file.

Every cut starts with a rapid down to 1 mm above the material that is actually there (roughing knows the level above), then the ramp, so the tool doesn't feed slowly through air.

**My tools**: each tool group has a tool library (kept in the browser, seeded with common router bits). Pick one to fill in type, Ø, angle and flutes; **Save** adds the current tool.

**Use recommended speeds & feeds** fills in spindle speed, feeds, plunge, stepdown and stepovers for all tools from chip-load charts. When the feed for the chart chip load is more than the machine's max feed, it slows the spindle instead (down to the machine's minimum), so the tool still takes a proper chip. The info box shows each tool's chip load against the chart and warns about anything that will burn (too little chip), break a tool (too much), exceed the machine, leave visible ridges, or leave ridges of material between roughing lines.

Exports:

- **Roughing / Finishing / Detail / Cutout**: one file per operation (re-zero Z after each tool change).
- **All in one file**: every operation in order with a tool change between tools: `T# M6` (Mach3/4, LinuxCNC, UCCNC, gSender, UGS) or an `M0` pause (plain GRBL, which doesn't know M6; there the separate files are easier).
- **Setup sheet**: a printable page with stock size, zero, the tool list, each operation's speeds, feeds, steps, chip load and run time, and the setup steps.

**Zero**: X0 Y0 is the front-left corner of the stock (without a stock layout, the bottom-left of the picture). **Toolpaths** in the 3D view draws the paths (roughing orange, finishing blue, detail pink, cutout green), the stock outline and the X0 Y0 Z0 origin (X red, Y green, Z blue), and shows estimated run times.

Changing only G-code settings never recomputes the relief.

Air-cut a new file above the stock first.

**Settings file** (under Advanced): **Save…** writes every setting to a JSON file, **Load…** reads it back. Use it to keep a job's settings with its photo or to move your setup to another computer. **Reset all** keeps the G-code and machine settings.

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

**Test strip** prints a 100 × 20 mm strip of 10 grey steps, white to black, made with your thickness settings. Hold it to your light: you should see 10 distinct steps. If the darkest few look the same, lower Max thickness; if the lightest few look the same or show pinholes, raise Min thickness.

### Lamp shade

Pick **Shape → Lamp shade** and add pictures (button or drag and drop; reorder with ◀ ▶). They wrap all the way around a cylinder in that order, each one centre-cropped to an equal slice (π × diameter ÷ number of pictures). For a flip-book effect as it turns, use 6 or more frames of a scene that changes a little each time; frames from a short video work well. Settings: **Lamp diameter** (inside), **Lamp height**, **Divider** (solid strip between pictures), **Frame** (solid bands top and bottom) and **Lamp hardware**:

| Hardware | For | Notes |
|---|---|---|
| None | LED puck light, tea light, battery candle | Set it over the light. |
| Lip for a puck light | Puck lights | 2 mm inward ledge at the bottom; **Lip width** sets the opening (shown in the info box). |
| Ring fitter | Lamps with a harp (spider washer, ~7/16" / 11 mm hole), E12/E14 sockets (~29 mm shade ring), E26/E27 sockets (~40 mm shade ring), pendant cord sets | A hub with a centre hole on three spokes in the solid band. **Fitter at** top (harp, pendant) or bottom (sits on a table-lamp socket). The fitter is always printed on the bed, so a top fitter prints the shade upside down (pictures turned to suit). Measure your harp stud or socket and add a little clearance. |

Use an LED bulb: PLA softens at about 60 °C. **Spin** in the 3D view turns the lamp about its axis at the set **rpm**. **Animate (strobe)** simulates a strobe light that flashes each time the next picture faces you, so the pictures play like a flip book (pictures per second = rpm × pictures ÷ 60; about 10–12 looks smooth). In real life that needs a strobe synced to the turntable (or a zoetrope with slits); under steady light the pictures just slide past. It is exported standing up, ready to print without supports.

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
| `src/core/cutter.ts` | Tool simulation (ball, tapered ball, V-bit, flat) |
| `src/core/cam.ts` | Roughing / finishing toolpaths, G-code writer, speeds and feeds |
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

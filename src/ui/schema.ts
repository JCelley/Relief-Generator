import type { ReliefParams } from '../core/params';

export type Field =
  | {
      key: keyof ReliefParams;
      label: string;
      kind: 'range';
      min: number;
      max: number;
      step: number;
      unit?: string;
      length?: boolean;
      advanced?: boolean;
      litho?: boolean;
      help?: string;
      /** a feed rate (mm/min): shown per minute in the current units */
      rate?: boolean;
      cam?: boolean;
      /** common values offered in the number box's drop-down (mm for lengths) */
      presets?: [number, string][];
    }
  | { key: keyof ReliefParams; label: string; kind: 'select'; options: [string, string][]; advanced?: boolean; litho?: boolean; cam?: boolean; help?: string }
  | { key: keyof ReliefParams; label: string; kind: 'check'; advanced?: boolean; litho?: boolean; cam?: boolean; help?: string };

/** `length: true` fields are lengths in mm and follow the mm/inch toggle. */
export const FIELDS: Field[] = [
  // lithophane (3D print)
  {
    key: 'lithoShape',
    label: 'Shape',
    kind: 'select',
    options: [
      ['flat', 'Flat rectangle'],
      ['rounded', 'Rounded corners'],
      ['oval', 'Oval / circle'],
      ['heart', 'Heart'],
      ['curved', 'Curved (arc)'],
      ['lamp', 'Lamp shade (several pictures)'],
    ],
    litho: true,
    help: 'Oval and heart fit inside the picture (crop the photo square for a circle). Curved: bent into an arc with the picture outside, so it stands on its own. Lamp shade: a full cylinder with your pictures wrapped around it, to go over an LED puck light.',
  },
  { key: 'lithoRadius', label: 'Radius', kind: 'range', min: 15, max: 400, step: 1, unit: 'mm', length: true, litho: true, help: 'Radius of the inside of the arc. Smaller = more curved. The width is measured along the curve.' },
  { key: 'lithoCorner', label: 'Corner radius', kind: 'range', min: 1, max: 40, step: 0.5, unit: 'mm', length: true, litho: true },
  { key: 'lampDiameter', label: 'Lamp diameter', kind: 'range', min: 40, max: 250, step: 1, unit: 'mm', length: true, litho: true, help: 'Inside diameter of the lamp shade. Each picture gets an equal slice of the circumference (π × diameter ÷ number of pictures).' },
  { key: 'lampHeight', label: 'Lamp height', kind: 'range', min: 30, max: 250, step: 1, unit: 'mm', length: true, litho: true, help: 'Height of the lamp shade. Pictures are centre-cropped to fit their slice.' },
  { key: 'lithoMax', label: 'Max thickness', kind: 'range', min: 1.5, max: 6, step: 0.1, unit: 'mm', length: true, litho: true, help: 'Thickness of the darkest areas. 2.5–4 mm for white PLA, 3 mm is typical. Above 4 mm the shadows go solid black and lose detail. If the whole print looks too dark, lower this (e.g. 2.6 mm).' },
  { key: 'lithoMin', label: 'Min thickness', kind: 'range', min: 0.4, max: 2, step: 0.05, unit: 'mm', length: true, litho: true, help: 'Thickness of the lightest areas. 0.6–0.8 mm with a 0.4 mm nozzle. Thinner is brighter but can break or print with pinholes; if highlights look washed out, raise it a little (0.8 → 1.0 mm).' },
  { key: 'lithoBrightness', label: 'Brightness', kind: 'range', min: -0.5, max: 0.5, step: 0.01, litho: true, help: 'Lightens (+) or darkens (−) the picture before it becomes thickness.' },
  { key: 'lithoContrast', label: 'Contrast', kind: 'range', min: 0.5, max: 2, step: 0.01, litho: true, help: 'Above 1 spreads light and dark further apart; below 1 softens.' },
  { key: 'lithoGamma', label: 'Midtone darkness', kind: 'range', min: 0.3, max: 3, step: 0.05, litho: true, help: 'Above 1 makes midtones thicker (darker when lit); below 1 makes them lighter.' },
  { key: 'lithoBorder', label: 'Frame', kind: 'range', min: 0, max: 15, step: 0.5, unit: 'mm', length: true, litho: true, help: 'Solid border at full thickness around the picture (for a lamp shade: the bands at top and bottom). Stiffens the part. 0 = none.' },
  { key: 'lampDivider', label: 'Divider', kind: 'range', min: 0, max: 10, step: 0.5, unit: 'mm', length: true, litho: true, help: 'Solid strip between neighbouring pictures on the lamp shade. 0 = pictures run straight into each other.' },
  {
    key: 'lampFitter',
    label: 'Lamp hardware',
    kind: 'select',
    options: [
      ['none', 'None (open both ends)'],
      ['lip', 'Lip for a puck light'],
      ['ring', 'Ring fitter (harp / socket)'],
    ],
    litho: true,
    help: 'None: set it over a puck light or LED candle. Lip: a ledge at the bottom that rests on a puck light. Ring fitter: a hub with a centre hole on three spokes, for a lamp harp (spider washer) or an E12/E14 / E26/E27 socket ring.',
  },
  { key: 'lampLip', label: 'Lip width', kind: 'range', min: 2, max: 30, step: 0.5, unit: 'mm', length: true, litho: true, help: 'How far the 2 mm thick ledge reaches in. The opening left is shown in the info box; make it a little smaller than your puck light.' },
  {
    key: 'lampHole',
    label: 'Fitter hole Ø',
    kind: 'range',
    min: 6,
    max: 60,
    step: 0.1,
    unit: 'mm',
    length: true,
    litho: true,
    help: 'Centre hole of the fitter. Harp spider washer about 7/16" (11 mm); E12/E14 shade ring about 29 mm; E26/E27 shade ring about 40 mm. Measure your socket or harp stud and add a little clearance.',
    presets: [
      [11.1, 'harp / spider washer 7/16"'],
      [29, 'E12 / E14 socket ring'],
      [40, 'E26 / E27 socket ring'],
    ],
  },
  {
    key: 'lampFitterEnd',
    label: 'Fitter at',
    kind: 'select',
    options: [
      ['top', 'Top (harp, pendant)'],
      ['bottom', 'Bottom (sits on a table socket)'],
    ],
    litho: true,
    help: 'Which end the fitter is on when in use. It is always printed on the bed, so a top fitter means the shade prints upside down (the pictures are turned to suit).',
  },
  { key: 'lithoHole', label: 'Hanging hole', kind: 'range', min: 0, max: 10, step: 0.5, unit: 'mm', length: true, litho: true, help: 'Hole near the top centre for a string or hook, with a solid ring around it. 0 = none.' },
  { key: 'lithoGrid', label: 'Mesh resolution', kind: 'range', min: 0.1, max: 1, step: 0.05, unit: 'mm', length: true, litho: true, advanced: true, help: 'Point spacing of the STL. About half the nozzle diameter (0.2 mm for a 0.4 mm nozzle). Smaller = bigger file.' },
  { key: 'reliefHeight', label: 'Relief height', kind: 'range', min: 0.5, max: 40, step: 0.1, unit: 'mm', length: true, help: 'Total Z range of the carving above the base.' },
  { key: 'baseThickness', label: 'Base thickness', kind: 'range', min: 0, max: 30, step: 0.1, unit: 'mm', length: true, help: 'Flat material under the relief. Must be > 0 for the solid export.' },
  {
    key: 'toolType',
    label: 'Finishing tool',
    kind: 'select',
    options: [
      ['ball', 'Ball end mill'],
      ['taperedBall', 'Tapered ball nose'],
      ['vbit', 'V-bit / engraver'],
      ['flat', 'Flat end mill'],
    ],
    help: 'The tool for the finishing pass. Used to show what will actually be cut (Show: As cut / Missed areas in the 3D view) and to set the grid spacing. The exported surface is the design itself; Fusion does the cutting.',
  },
  { key: 'toolDiameter', label: 'Tool Ø', kind: 'range', min: 0, max: 12.7, step: 0.0125, unit: 'mm', length: true, presets: [[0.3969, '1/64"'], [0.79375, '1/32"'], [1.5875, '1/16"'], [3.175, '1/8"'], [4.7625, '3/16"'], [6.35, '1/4"'], [9.525, '3/8"'], [12.7, '1/2"'], [0.5, '0.5 mm'], [1, '1 mm'], [2, '2 mm'], [3, '3 mm'], [6, '6 mm']], help: 'Ball end mill: ball diameter. Tapered ball: tip (ball) diameter. V-bit / engraver: flat tip diameter, 0 for a sharp point. Default 1/16".' },
  { key: 'toolAngle', label: 'Included angle', kind: 'range', min: 5, max: 150, step: 0.5, unit: '°', presets: [[6, ''], [10, ''], [15, ''], [20, ''], [30, ''], [60, ''], [90, ''], [120, '']], help: 'Full included angle of the cutter (twice the angle per side). Tapered ball nose: typically 6–20°. V-bit: 30°, 60° or 90°.' },
  {
    key: 'method',
    label: 'Compression',
    kind: 'select',
    options: [
      ['gradient', 'Gradient domain (carved look)'],
      ['baseDetail', 'Base / detail split (fast)'],
    ],
    help: 'How the photo depth is squashed into a shallow relief.',
  },
  { key: 'compression', label: 'Depth compression', kind: 'range', min: 0, max: 1, step: 0.01, help: 'How hard large-scale depth is flattened. Higher = flatter, more like a coin.' },
  { key: 'detailGain', label: 'Detail boost', kind: 'range', min: 0, max: 4, step: 0.05, help: 'Amplifies fine surface detail (eyes, folds, fur).' },
  { key: 'falloffWidth', label: 'Edge falloff', kind: 'range', min: 0, max: 20, step: 0.1, unit: 'mm', length: true, help: 'Distance over which the subject blends down to the base (no vertical cliffs).' },
  {
    key: 'bgMode',
    label: 'Background',
    kind: 'select',
    options: [
      ['flat', 'Flat base'],
      ['keep', 'Keep (compressed)'],
    ],
  },
  { key: 'bgLevel', label: 'Background level', kind: 'range', min: 0, max: 1, step: 0.01, help: 'Keep mode: background height relative to the subject.' },
  { key: 'invert', label: 'Intaglio (cut-in)', kind: 'check' },
  {
    key: 'toneDepth',
    label: 'Tone carving',
    kind: 'range',
    min: 0,
    max: 3,
    step: 0.05,
    unit: 'mm',
    length: true,
    help: 'Cuts clearly dark areas in (and raises light ones) by this depth, e.g. pupils and highlights in drawings. Depth from a photo cannot see painted features. Keep 0 for photos: shadows and dark hair would become dents.',
  },
  { key: 'toneDarkUp', label: 'Raise dark areas', kind: 'check', help: 'Tone carving: raise dark areas instead of cutting them in.' },

  // G-code (cam: true → the G-code section)
  {
    key: 'camMaterial',
    label: 'Material',
    kind: 'select',
    options: [
      ['softwood', 'Softwood (pine, cedar)'],
      ['hardwood', 'Hardwood (oak, maple, walnut)'],
      ['mdf', 'MDF / plywood'],
      ['plastic', 'Plastic (acrylic, HDPE)'],
      ['aluminum', 'Aluminum'],
    ],
    cam: true,
    help: 'Sets the recommended speeds and feeds (Use recommended).',
  },
  { key: 'roughOn', label: 'Roughing pass', kind: 'check', cam: true, help: 'Clears the bulk of the material level by level with a larger tool first, leaving a little for the finishing pass. Needed unless the relief is shallow and the material soft.' },
  {
    key: 'roughType',
    label: 'Roughing tool',
    kind: 'select',
    options: [
      ['flat', 'Flat end mill'],
      ['ball', 'Ball end mill'],
    ],
    cam: true,
  },
  { key: 'roughDiameter', label: 'Roughing Ø', kind: 'range', min: 1, max: 25.4, step: 0.0125, unit: 'mm', length: true, cam: true, presets: [[3.175, '1/8"'], [6.35, '1/4"'], [9.525, '3/8"'], [12.7, '1/2"'], [3, '3 mm'], [6, '6 mm'], [8, '8 mm']] },
  { key: 'roughFlutes', label: 'Roughing flutes', kind: 'range', min: 1, max: 4, step: 1, cam: true },
  { key: 'roughStepdown', label: 'Stepdown', kind: 'range', min: 0.1, max: 12, step: 0.05, unit: 'mm', length: true, cam: true, help: 'Depth per roughing level. About half the tool Ø in wood, a quarter or less in aluminium.' },
  { key: 'roughStepover', label: 'Rough stepover', kind: 'range', min: 0.1, max: 20, step: 0.05, unit: 'mm', length: true, cam: true, help: 'Distance between roughing lines. About 40 % of the tool Ø.' },
  { key: 'roughAllowance', label: 'Leave for finish', kind: 'range', min: 0, max: 3, step: 0.05, unit: 'mm', length: true, cam: true, help: 'Material the roughing pass leaves on the surface for the finishing pass to clean up.' },
  { key: 'roughRpm', label: 'Rough spindle', kind: 'range', min: 1000, max: 30000, step: 100, unit: 'rpm', cam: true },
  { key: 'roughFeed', label: 'Rough feed', kind: 'range', min: 50, max: 10000, step: 10, unit: 'mm', length: true, rate: true, cam: true },
  { key: 'roughPlunge', label: 'Rough plunge', kind: 'range', min: 20, max: 5000, step: 10, unit: 'mm', length: true, rate: true, cam: true },
  { key: 'finStepover', label: 'Finish stepover', kind: 'range', min: 0.02, max: 5, step: 0.005, unit: 'mm', length: true, cam: true, help: 'Distance between finishing lines (uses the finishing tool above). Smaller = smoother but longer. Recommended: 10 % of the ball / tip Ø; the ridge height it leaves is shown below.' },
  {
    key: 'finDir',
    label: 'Finish direction',
    kind: 'select',
    options: [
      ['x', 'Along X'],
      ['y', 'Along Y'],
      ['xy', 'X then Y (cross-hatch)'],
    ],
    cam: true,
    help: 'Cross-hatch runs a second pass at 90° for a finer finish (twice the time).',
  },
  { key: 'finFlutes', label: 'Finish flutes', kind: 'range', min: 1, max: 4, step: 1, cam: true },
  { key: 'finRpm', label: 'Finish spindle', kind: 'range', min: 1000, max: 30000, step: 100, unit: 'rpm', cam: true },
  { key: 'finFeed', label: 'Finish feed', kind: 'range', min: 50, max: 10000, step: 10, unit: 'mm', length: true, rate: true, cam: true },
  { key: 'finPlunge', label: 'Finish plunge', kind: 'range', min: 20, max: 5000, step: 10, unit: 'mm', length: true, rate: true, cam: true },
  { key: 'safeZ', label: 'Safe height', kind: 'range', min: 1, max: 50, step: 0.5, unit: 'mm', length: true, cam: true, help: 'Height above the top of the part for rapid moves. Raise it if clamps stick up.' },
  {
    key: 'zZero',
    label: 'Z zero',
    kind: 'select',
    options: [
      ['top', 'Top of the part'],
      ['bottom', 'Bottom (spoilboard)'],
    ],
    cam: true,
    help: 'Top: touch off on the top of the stock (the stock must be exactly the part height: base + relief). Bottom: touch off on the spoilboard; works with any stock thickness ≥ the part height and is easier to repeat after the tool change.',
  },

  // advanced
  { key: 'baseScale', label: 'Base/detail scale', kind: 'range', min: 0.005, max: 0.2, step: 0.005, advanced: true, help: 'Size of what counts as "large-scale" shape, as a fraction of the image diagonal.' },
  { key: 'baseGamma', label: 'Base gamma', kind: 'range', min: 0.3, max: 3, step: 0.05, advanced: true, help: 'Base/detail method: curve applied to the compressed base.' },
  { key: 'gradThreshold', label: 'Discontinuity threshold', kind: 'range', min: 2, max: 200, step: 1, advanced: true, help: 'Gradient method: depth jumps steeper than this are cut.' },
  { key: 'textureGain', label: 'Photo texture', kind: 'range', min: 0, max: 1, step: 0.01, advanced: true, help: 'Adds a little high-pass photo texture (fur). Keep low; it is brightness, not shape.' },
  { key: 'toneScale', label: 'Tone carving scale', kind: 'range', min: 0.02, max: 0.5, step: 0.01, advanced: true, help: 'How large an area each pixel is compared against (fraction of the image diagonal). Should be bigger than the features you want to carve.' },
  { key: 'smoothing', label: 'Pre-fit smoothing', kind: 'range', min: 0, max: 3, step: 0.05, unit: 'mm', length: true, advanced: true },
  { key: 'maskCleanup', label: 'Mask cleanup radius', kind: 'range', min: 0, max: 5, step: 0.05, unit: 'mm', length: true, advanced: true, help: 'Removes mask slivers thinner than about twice this (whiskers, stray hair).' },
  { key: 'maskThreshold', label: 'Mask threshold', kind: 'range', min: 0.05, max: 0.95, step: 0.01, advanced: true },
  { key: 'guideEps', label: 'Edge snapping (guided ε)', kind: 'range', min: 0.0001, max: 0.05, step: 0.0001, advanced: true, help: 'Lower = depth edges follow photo edges more tightly (but more photo texture leaks in).' },
  { key: 'gridSpacing', label: 'Grid spacing (0 = auto)', kind: 'range', min: 0, max: 3, step: 0.01, unit: 'mm', length: true, advanced: true, help: 'Auto = tool Ø / 4 (at least 0.2 mm for a V-bit or tapered ball).' },
  { key: 'fitTolerance', label: 'B-spline tolerance', kind: 'range', min: 0.001, max: 0.2, step: 0.001, unit: 'mm', length: true, advanced: true },
];

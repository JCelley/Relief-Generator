import type { ReliefParams } from '../core/params';

export type Field =
  | { key: keyof ReliefParams; label: string; kind: 'range'; min: number; max: number; step: number; unit?: string; length?: boolean; advanced?: boolean; litho?: boolean; help?: string }
  | { key: keyof ReliefParams; label: string; kind: 'select'; options: [string, string][]; advanced?: boolean; litho?: boolean; help?: string }
  | { key: keyof ReliefParams; label: string; kind: 'check'; advanced?: boolean; litho?: boolean; help?: string };

/** `length: true` fields are lengths in mm and follow the mm/inch toggle. */
export const FIELDS: Field[] = [
  // lithophane (3D print)
  { key: 'lithoMax', label: 'Max thickness', kind: 'range', min: 1.5, max: 6, step: 0.1, unit: 'mm', length: true, litho: true, help: 'Thickness of the darkest areas. 2.5–4 mm for white PLA, 3 mm is typical. Above 4 mm the shadows go solid black and lose detail. If the whole print looks too dark, lower this (e.g. 2.6 mm).' },
  { key: 'lithoMin', label: 'Min thickness', kind: 'range', min: 0.4, max: 2, step: 0.05, unit: 'mm', length: true, litho: true, help: 'Thickness of the lightest areas. 0.6–0.8 mm with a 0.4 mm nozzle. Thinner is brighter but can break or print with pinholes; if highlights look washed out, raise it a little (0.8 → 1.0 mm).' },
  { key: 'lithoGamma', label: 'Midtone darkness', kind: 'range', min: 0.3, max: 3, step: 0.05, litho: true, help: 'Above 1 makes midtones thicker (darker when lit); below 1 makes them lighter.' },
  {
    key: 'lithoShape',
    label: 'Shape',
    kind: 'select',
    options: [
      ['flat', 'Flat'],
      ['curved', 'Curved (arc)'],
    ],
    litho: true,
    help: 'Curved: bent into an arc with the picture outside, so it stands on its own with a light inside. Print it standing up.',
  },
  { key: 'lithoRadius', label: 'Radius', kind: 'range', min: 15, max: 400, step: 1, unit: 'mm', length: true, litho: true, help: 'Radius of the inside of the arc. Smaller = more curved. The width is measured along the curve.' },
  { key: 'lithoBorder', label: 'Frame', kind: 'range', min: 0, max: 15, step: 0.5, unit: 'mm', length: true, litho: true, help: 'Solid border at full thickness around the picture. Stiffens the plate. 0 = none.' },
  { key: 'lithoGrid', label: 'Mesh resolution', kind: 'range', min: 0.1, max: 1, step: 0.05, unit: 'mm', length: true, litho: true, advanced: true, help: 'Point spacing of the STL. About half the nozzle diameter (0.2 mm for a 0.4 mm nozzle). Smaller = bigger file.' },
  { key: 'reliefHeight', label: 'Relief height', kind: 'range', min: 0.5, max: 40, step: 0.1, unit: 'mm', length: true, help: 'Total Z range of the carving above the base.' },
  { key: 'baseThickness', label: 'Base thickness', kind: 'range', min: 0, max: 30, step: 0.1, unit: 'mm', length: true, help: 'Flat material under the relief. Must be > 0 for the solid export.' },
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
  { key: 'toolDiameter', label: 'Finishing tool Ø', kind: 'range', min: 0.2, max: 12.7, step: 0.0125, unit: 'mm', length: true, advanced: true, help: 'Ball end mill used for the finishing pass. Default 1/16".' },
  { key: 'gridSpacing', label: 'Grid spacing (0 = auto)', kind: 'range', min: 0, max: 3, step: 0.01, unit: 'mm', length: true, advanced: true, help: 'Auto = tool radius / 2.' },
  { key: 'fitTolerance', label: 'B-spline tolerance', kind: 'range', min: 0.001, max: 0.2, step: 0.001, unit: 'mm', length: true, advanced: true },
];

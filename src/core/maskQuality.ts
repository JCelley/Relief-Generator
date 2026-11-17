import type { Grid } from './grid';

export interface MaskQuality {
  /** fraction of pixels the model is unsure about (alpha between 0.15 and 0.85) */
  uncertain: number;
  /** fraction of pixels at or above the threshold */
  subject: number;
  /** connected subject regions bigger than 0.5 % of the image */
  regions: number;
  /** share of the subject area in the biggest connected piece */
  largestShare: number;
  /** true when the mask probably missed the subject */
  suspect: boolean;
  reason?: string;
}

/**
 * Cheap sanity check of a soft subject mask. A good mask is almost binary
 * (only the outline is grey) and forms one or two solid regions; a model that
 * does not recognise the subject returns a large grey area that falls apart
 * into fragments when thresholded.
 */
export function maskQuality(mask: Grid, threshold = 0.5): MaskQuality {
  const { w, h, data } = mask;
  const n = w * h;
  let unc = 0;
  let sub = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (v > 0.15 && v < 0.85) unc++;
    if (v >= threshold) sub++;
  }
  // connected components (4-neighbour) of the thresholded mask
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const minSize = 0.005 * n;
  let regions = 0;
  let largest = 0;
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] || data[s] < threshold) continue;
    next++;
    let top = 0;
    let size = 0;
    stack[top++] = s;
    label[s] = next;
    while (top) {
      const i = stack[--top];
      size++;
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of nb) {
        if (j < 0 || j >= n || label[j] || data[j] < threshold) continue;
        label[j] = next;
        stack[top++] = j;
      }
    }
    if (size >= minSize) regions++;
    if (size > largest) largest = size;
  }
  const q: MaskQuality = { uncertain: unc / n, subject: sub / n, regions, largestShare: sub ? largest / sub : 0, suspect: false };
  if (q.subject < 0.02) {
    q.suspect = true;
    q.reason = 'the mask found almost no subject';
  } else if (q.uncertain > 0.2) {
    q.suspect = true;
    q.reason = `the mask model is unsure about ${Math.round(q.uncertain * 100)}% of the image`;
  } else if (q.regions > 1 && q.largestShare < 0.7) {
    q.suspect = true;
    q.reason = `the subject breaks into ${q.regions} separate pieces`;
  } else if (q.subject < 0.1) {
    q.suspect = true;
    q.reason = `the subject covers only ${Math.round(q.subject * 100)}% of the picture`;
  }
  return q;
}

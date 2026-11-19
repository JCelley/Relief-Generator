import type { MachGrid } from './resample';
import { heightfieldMesh, meshToStl, type PointMap } from './mesh';

export { cylinderMap, type PointMap } from './mesh';

/**
 * Closed, watertight, manifold binary STL straight from the machining grid (see heightfieldMesh).
 * An optional map bends the part (see cylinderMap). Units are mm. Outward-facing triangles.
 */
export function writeStl(g: MachGrid, map?: PointMap): Uint8Array {
  return meshToStl(heightfieldMesh(g, map));
}

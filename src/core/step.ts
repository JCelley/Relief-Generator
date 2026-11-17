import { BSplineSurface, knotMultiplicities } from './bspline';

/**
 * Minimal ISO 10303-21 (STEP AP214, AUTOMOTIVE_DESIGN) writer for a relief:
 *  - 'surface': one trimmed-to-boundary B-spline ADVANCED_FACE in an OPEN_SHELL
 *    (SHELL_BASED_SURFACE_MODEL)  → imports as a surface body.
 *  - 'solid':   that face + 4 planar side faces + planar bottom in a CLOSED_SHELL
 *    (MANIFOLD_SOLID_BREP)        → imports as a solid body.
 * Units: millimetres. Bottom of the part is z = 0.
 *
 * The surface's control points have x/y at Greville abscissae, so its boundary
 * curves lie exactly in the planes x=0, x=W, y=0, y=H, which lets the side
 * faces be simple planes sharing those B-spline edges.
 */

export type StepKind = 'surface' | 'solid';

export interface StepOptions {
  name?: string;
  /** ISO timestamp for the header (defaults to now) */
  timestamp?: string;
}

/** STEP REAL: must contain a decimal point; avoid exponent forms for readability. */
export function fmt(x: number): string {
  if (!Number.isFinite(x)) throw new Error('non-finite coordinate');
  if (Math.abs(x) < 5e-7) return '0.';
  let s = x.toFixed(6);
  s = s.replace(/0+$/, '');
  if (s.endsWith('.')) return s;
  return s;
}

class StepBuilder {
  private lines: string[] = [];
  private next = 1;
  add(entity: string): string {
    const id = `#${this.next++}`;
    this.lines.push(`${id}=${entity};`);
    return id;
  }
  body(): string {
    return this.lines.join('\n');
  }
}

function strEsc(s: string): string {
  return s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_');
}

export function writeStep(s: BSplineSurface, kind: StepKind, opts: StepOptions = {}): string {
  const b = new StepBuilder();
  const name = strEsc(opts.name ?? 'relief');
  const ts = (opts.timestamp ?? new Date().toISOString()).replace(/\.\d+Z$/, '');

  // --- product / context boilerplate ---------------------------------------------------------
  const appCtx = b.add(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
  b.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = b.add(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const pdCtx = b.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const product = b.add(`PRODUCT('${name}','${name}','',(${prodCtx}))`);
  b.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${product}))`);
  const pdf = b.add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const pd = b.add(`PRODUCT_DEFINITION('design','',${pdf},${pdCtx})`);
  const pds = b.add(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);

  const mm = b.add(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))`);
  const rad = b.add(`(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))`);
  const sr = b.add(`(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())`);
  const unc = b.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),${mm},'distance_accuracy_value','confusion accuracy')`);
  const geomCtx = b.add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`,
  );

  // --- geometry helpers -----------------------------------------------------------------------
  const pt = (x: number, y: number, z: number) => b.add(`CARTESIAN_POINT('',(${fmt(x)},${fmt(y)},${fmt(z)}))`);
  const dir = (x: number, y: number, z: number) => b.add(`DIRECTION('',(${fmt(x)},${fmt(y)},${fmt(z)}))`);
  const axis = (o: [number, number, number], zDir: [number, number, number], xDir: [number, number, number]) =>
    b.add(`AXIS2_PLACEMENT_3D('',${pt(...o)},${dir(...zDir)},${dir(...xDir)})`);
  const vertex = (x: number, y: number, z: number) => b.add(`VERTEX_POINT('',${pt(x, y, z)})`);
  const line = (a: [number, number, number], c: [number, number, number]) => {
    const dx = c[0] - a[0];
    const dy = c[1] - a[1];
    const dz = c[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    const v = b.add(`VECTOR('',${dir(dx / len, dy / len, dz / len)},${fmt(len)})`);
    return b.add(`LINE('',${pt(...a)},${v})`);
  };
  const edge = (v1: string, v2: string, curve: string) => b.add(`EDGE_CURVE('',${v1},${v2},${curve},.T.)`);
  const oriented = (e: string, sense: boolean) => b.add(`ORIENTED_EDGE('',*,*,${e},${sense ? '.T.' : '.F.'})`);
  const face = (edges: [string, boolean][], surface: string) => {
    const loop = b.add(`EDGE_LOOP('',(${edges.map(([e, s]) => oriented(e, s)).join(',')}))`);
    const bound = b.add(`FACE_OUTER_BOUND('',${loop},.T.)`);
    return b.add(`ADVANCED_FACE('',(${bound}),${surface},.T.)`);
  };
  const plane = (o: [number, number, number], n: [number, number, number], xDir: [number, number, number]) =>
    b.add(`PLANE('',${axis(o, n, xDir)})`);

  const { nu, nv, ctrl, degree } = s;
  const W = s.widthMm;
  const H = s.heightMm;
  const cp = (k: number, m: number): [number, number, number] => {
    const o = (k * nv + m) * 3;
    return [ctrl[o], ctrl[o + 1], ctrl[o + 2]];
  };
  const ku = knotMultiplicities(s.knotsU);
  const kv = knotMultiplicities(s.knotsV);
  const ptIdCache = new Map<number, string>();
  const ctrlPt = (k: number, m: number) => {
    const key = k * nv + m;
    let id = ptIdCache.get(key);
    if (!id) {
      id = pt(...cp(k, m));
      ptIdCache.set(key, id);
    }
    return id;
  };
  const bsCurve = (ids: string[], km: { knots: number[]; mults: number[] }) =>
    b.add(
      `B_SPLINE_CURVE_WITH_KNOTS('',${degree},(${ids.join(',')}),.UNSPECIFIED.,.F.,.F.,(${km.mults.join(',')}),(${km.knots
        .map(fmt)
        .join(',')}),.UNSPECIFIED.)`,
    );

  // --- top surface ----------------------------------------------------------------------------
  const rows: string[] = [];
  for (let k = 0; k < nu; k++) {
    const r: string[] = [];
    for (let m = 0; m < nv; m++) r.push(ctrlPt(k, m));
    rows.push(`(${r.join(',')})`);
  }
  const surf = b.add(
    `B_SPLINE_SURFACE_WITH_KNOTS('',${degree},${degree},(${rows.join(',')}),.UNSPECIFIED.,.F.,.F.,.F.,(${ku.mults.join(
      ',',
    )}),(${kv.mults.join(',')}),(${ku.knots.map(fmt).join(',')}),(${kv.knots.map(fmt).join(',')}),.UNSPECIFIED.)`,
  );

  // corners of the top face
  const c00 = cp(0, 0);
  const c10 = cp(nu - 1, 0);
  const c11 = cp(nu - 1, nv - 1);
  const c01 = cp(0, nv - 1);
  const P00 = vertex(...c00);
  const P10 = vertex(...c10);
  const P11 = vertex(...c11);
  const P01 = vertex(...c01);

  // boundary curves (exactly the boundary rows/columns of the control net)
  const rowIds = (m: number) => Array.from({ length: nu }, (_, k) => ctrlPt(k, m));
  const colIds = (k: number) => Array.from({ length: nv }, (_, m) => ctrlPt(k, m));
  const Cb = edge(P00, P10, bsCurve(rowIds(0), ku)); // y = 0
  const Cr = edge(P10, P11, bsCurve(colIds(nu - 1), kv)); // x = W
  const Ct = edge(P01, P11, bsCurve(rowIds(nv - 1), ku)); // y = H
  const Cl = edge(P00, P01, bsCurve(colIds(0), kv)); // x = 0

  // outward normal of the surface is +z (∂S/∂u = +x, ∂S/∂v = +y); loop CCW seen from above
  const top = face(
    [
      [Cb, true],
      [Cr, true],
      [Ct, false],
      [Cl, false],
    ],
    surf,
  );

  let shapeRep: string;
  if (kind === 'surface') {
    const shell = b.add(`OPEN_SHELL('',(${top}))`);
    const model = b.add(`SHELL_BASED_SURFACE_MODEL('',(${shell}))`);
    const origin = axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    shapeRep = b.add(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION('${name}',(${origin},${model}),${geomCtx})`);
  } else {
    const Q00 = vertex(0, 0, 0);
    const Q10 = vertex(W, 0, 0);
    const Q11 = vertex(W, H, 0);
    const Q01 = vertex(0, H, 0);
    const V00 = edge(Q00, P00, line([0, 0, 0], c00));
    const V10 = edge(Q10, P10, line([W, 0, 0], c10));
    const V11 = edge(Q11, P11, line([W, H, 0], c11));
    const V01 = edge(Q01, P01, line([0, H, 0], c01));
    const Lb = edge(Q00, Q10, line([0, 0, 0], [W, 0, 0]));
    const Lr = edge(Q10, Q11, line([W, 0, 0], [W, H, 0]));
    const Lt = edge(Q01, Q11, line([0, H, 0], [W, H, 0]));
    const Ll = edge(Q00, Q01, line([0, 0, 0], [0, H, 0]));

    const front = face(
      [
        [Lb, true],
        [V10, true],
        [Cb, false],
        [V00, false],
      ],
      plane([0, 0, 0], [0, -1, 0], [1, 0, 0]),
    );
    const right = face(
      [
        [Lr, true],
        [V11, true],
        [Cr, false],
        [V10, false],
      ],
      plane([W, 0, 0], [1, 0, 0], [0, 1, 0]),
    );
    const back = face(
      [
        [Lt, false],
        [V01, true],
        [Ct, true],
        [V11, false],
      ],
      plane([0, H, 0], [0, 1, 0], [-1, 0, 0]),
    );
    const left = face(
      [
        [Ll, false],
        [V00, true],
        [Cl, true],
        [V01, false],
      ],
      plane([0, 0, 0], [-1, 0, 0], [0, -1, 0]),
    );
    const bottom = face(
      [
        [Ll, true],
        [Lt, true],
        [Lr, false],
        [Lb, false],
      ],
      plane([0, 0, 0], [0, 0, -1], [1, 0, 0]),
    );
    const shell = b.add(`CLOSED_SHELL('',(${[top, front, right, back, left, bottom].join(',')}))`);
    const brep = b.add(`MANIFOLD_SOLID_BREP('${name}',${shell})`);
    const origin = axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    shapeRep = b.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(${origin},${brep}),${geomCtx})`);
  }
  b.add(`SHAPE_DEFINITION_REPRESENTATION(${pds},${shapeRep})`);

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('Bas-relief ${kind} generated by Relief Generator'),'2;1');`,
    `FILE_NAME('${name}.stp','${ts}',(''),(''),'Relief Generator','Relief Generator','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`,
    'ENDSEC;',
    'DATA;',
  ].join('\n');
  return `${header}\n${b.body()}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

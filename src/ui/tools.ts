import type { ToolType } from '../core/cutter';

/** a cutter in the user's tool library (kept in this browser) */
export interface LibTool {
  name: string;
  type: ToolType;
  /** mm: ball Ø, tip Ø (tapered ball, V-bit) or cutting Ø */
  diameter: number;
  /** included angle (degrees) for tapered ball and V-bit */
  angle: number;
  flutes: number;
}

const KEY = 'relief-generator:tools';
const IN = 25.4;

/** 1/16" style for exact 64ths of an inch, else mm */
export function sizeName(mm: number): string {
  const n = (mm / IN) * 64;
  if (mm > 0 && Math.abs(n - Math.round(n)) < 1e-3) {
    let a = Math.round(n), b = 64;
    while (a % 2 === 0 && b > 1) {
      a /= 2;
      b /= 2;
    }
    return b === 1 ? `${a}"` : `${a}/${b}"`;
  }
  return `${Number(mm.toFixed(3))} mm`;
}

export function defaultName(t: Omit<LibTool, 'name'>): string {
  const fl = `${t.flutes} fl`;
  if (t.type === 'flat') return `${sizeName(t.diameter)} flat, ${fl}`;
  if (t.type === 'ball') return `${sizeName(t.diameter)} ball, ${fl}`;
  if (t.type === 'taperedBall') return `${sizeName(t.diameter)} tip ${t.angle}° tapered ball`;
  return `${t.angle}° V-bit${t.diameter > 0 ? ` ${sizeName(t.diameter)} tip` : ''}`;
}

/** common router bits, as a starting library */
const SEED: Omit<LibTool, 'name'>[] = [
  { type: 'flat', diameter: 6.35, angle: 0, flutes: 2 },
  { type: 'flat', diameter: 3.175, angle: 0, flutes: 2 },
  { type: 'ball', diameter: 6.35, angle: 0, flutes: 2 },
  { type: 'ball', diameter: 3.175, angle: 0, flutes: 2 },
  { type: 'ball', diameter: 1.5875, angle: 0, flutes: 2 },
  { type: 'ball', diameter: 0.79375, angle: 0, flutes: 2 },
  { type: 'taperedBall', diameter: 0.5, angle: 10, flutes: 2 },
  { type: 'taperedBall', diameter: 1, angle: 7, flutes: 2 },
  { type: 'vbit', diameter: 0, angle: 60, flutes: 2 },
  { type: 'vbit', diameter: 0, angle: 90, flutes: 2 },
];

export function loadTools(): LibTool[] {
  try {
    const s = localStorage.getItem(KEY);
    if (s) {
      const list = JSON.parse(s);
      if (Array.isArray(list)) return list;
    }
  } catch {
    /* storage unavailable */
  }
  return SEED.map((t) => ({ ...t, name: defaultName(t) }));
}

export function saveTools(list: LibTool[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

export const sameTool = (a: Omit<LibTool, 'name'>, b: Omit<LibTool, 'name'>) =>
  a.type === b.type &&
  Math.abs(a.diameter - b.diameter) < 1e-4 &&
  (a.type === 'ball' || a.type === 'flat' || Math.abs(a.angle - b.angle) < 1e-4) &&
  a.flutes === b.flutes;

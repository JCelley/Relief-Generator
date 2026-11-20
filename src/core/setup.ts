import { toolLabel } from './cam';
import type { Cutter } from './cutter';

/** everything the printable setup sheet shows (lengths in mm, rates in mm/min) */
export interface SetupInfo {
  name: string;
  units: 'mm' | 'in';
  material: string;
  widthMm: number;
  heightMm: number;
  partTop: number;
  base: number;
  stockTop: number;
  zZero: 'top' | 'bottom';
  safeZ: number;
  toolChange: 'm6' | 'm0';
  cutout: { tabs: number; tabW: number; tabH: number; through: number } | null;
  /** the stock was set under Stock & border: its size is exact; `room` = space from the outline
   *  (where the cutout runs) to the stock edge, `tool` = cutout tool Ø */
  layout?: { room: number; tool: number; shape: string; border: string };
  ops: {
    name: string;
    number: number;
    tool: Cutter;
    flutes: number;
    rpm: number;
    feed: number;
    plunge: number;
    seconds: number;
    lines: number;
    chip: { actual: number; chart: number; ratio: number };
    stepdown?: number;
    stepover?: number;
  }[];
  total: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** a one-page job sheet to print and keep at the machine */
export function setupSheet(s: SetupInfo): string {
  const inch = s.units === 'in';
  const len = (mm: number) => (inch ? `${(mm / 25.4).toFixed(mm < 2.54 ? 4 : 3)}"` : `${mm.toFixed(mm < 1 ? 3 : 2)} mm`);
  const rate = (mm: number) => (inch ? `${(mm / 25.4).toFixed(1)} in/min` : `${Math.round(mm)} mm/min`);
  const chip = (mm: number) => (inch ? `${(mm / 25.4).toFixed(4)}"` : `${mm.toFixed(3)} mm`);
  const time = (sec: number) => {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
  };
  const tools = new Map<number, (typeof s.ops)[number]>();
  for (const o of s.ops) if (!tools.has(o.number)) tools.set(o.number, o);
  const chipNote = (r: number) => (r < 0.5 ? ' <b class="warn">low: may rub and burn</b>' : r > 1.5 ? ' <b class="warn">high: risk of breaking the tool</b>' : '');
  const fileName = (o: (typeof s.ops)[number]) => `${s.name}_${o.name}.nc`;
  const rows = s.ops
    .map(
      (o, i) => `<tr>
  <td>${i + 1}</td><td><b>${esc(o.name)}</b><br><span class="small">${esc(fileName(o))}</span></td><td>T${o.number}</td>
  <td>${esc(toolLabel(o.tool, len))}, ${o.flutes} fl</td>
  <td>${o.rpm} rpm<br>${rate(o.feed)}<br>plunge ${rate(o.plunge)}</td>
  <td>${o.stepdown !== undefined ? `down ${len(o.stepdown)}<br>` : ''}${o.stepover !== undefined ? `over ${len(o.stepover)}` : ''}</td>
  <td>${chip(o.chip.actual)} <span class="small">(chart ${chip(o.chip.chart)})</span>${chipNote(o.chip.ratio)}</td>
  <td>${time(o.seconds)}<br><span class="small">${o.lines.toLocaleString()} lines</span></td>
</tr>`,
    )
    .join('\n');
  const toolRows = [...tools.values()]
    .map((o) => `<tr><td>T${o.number}</td><td>${esc(toolLabel(o.tool, len))}, ${o.flutes} flute${o.flutes === 1 ? '' : 's'}</td><td>${s.ops.filter((q) => q.number === o.number).map((q) => esc(q.name)).join(', ')}</td></tr>`)
    .join('\n');
  const stockNote = s.stockTop > s.partTop + 0.01 ? ` (the part is ${len(s.partTop)} tall; roughing faces the extra ${len(s.stockTop - s.partTop)} off)` : ' (exactly the part height)';
  const L = s.layout;
  const over = L && s.cutout ? Math.max(0, L.tool + 1 - L.room) : 0;
  const steps = [
    L
      ? `Stock ${len(s.widthMm)} × ${len(s.heightMm)}, ${len(s.stockTop)} thick${stockNote}.` +
        (over > 0 ? ` The cutout runs past its edge: use a board ${len(over)} bigger all round and set X0 Y0 that far in, or add an Edge margin under Stock & border.` : '') +
        ` Hold it flat and clamp ${s.cutout ? 'outside the cutout' : 'where nothing is cut'}.`
      : `Stock at least ${len(s.widthMm + (s.cutout ? 25 : 0))} × ${len(s.heightMm + (s.cutout ? 25 : 0))}, ${len(s.stockTop)} thick${stockNote}. Hold it flat and clamp outside the part${s.cutout ? ' and outside the cutout' : ''}.`,
    L
      ? `X0 Y0 = front-left corner of the stock. X to the right, Y away from you.`
      : `X0 Y0 = front-left corner of the part (bottom-left of the picture as you look down at it). X to the right, Y away from you.${s.cutout ? ' Leave room around it for the cutout tool.' : ''}`,
    s.zZero === 'top' ? `Z0 = top of the stock. Touch off on the stock surface.` : `Z0 = bottom of the part: the spoilboard (or the bed the stock sits on).`,
    `Rapids at ${len(s.safeZ)} above the stock. Check that clamps are lower than that.`,
    `Change tools between operations and set Z0 again for each tool, the same way. ${s.toolChange === 'm6' ? 'The all-in-one file stops with T# M6.' : 'The all-in-one file pauses with M0.'}`,
    ...(s.cutout ? [`Cutout: ${s.cutout.tabs ? `${s.cutout.tabs} tab${s.cutout.tabs === 1 ? '' : 's'} per side, ${len(s.cutout.tabW)} long, ${len(s.cutout.tabH)} tall` : 'no tabs: the part comes loose at the end, hold it down'}; cuts ${len(s.cutout.through)} into the spoilboard.`] : []),
    'Air-cut the first file above the stock if this is a new setup.',
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Setup sheet - ${esc(s.name)}</title>
<style>
body { font: 13px/1.4 system-ui, sans-serif; color: #111; margin: 24px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.small { color: #555; font-size: 11px; }
table { border-collapse: collapse; width: 100%; margin: 10px 0 16px; }
th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #eee; }
.warn { color: #b00; }
.grid { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 10px 0; }
ol li { margin: 3px 0; }
button { margin: 8px 0; }
@media print { button { display: none; } body { margin: 0; } }
</style></head><body>
<button onclick="print()">Print</button>
<h1>${esc(s.name)}</h1>
<div class="small">Relief Generator setup sheet · ${new Date().toLocaleString()}</div>
<div class="grid">
<b>${L ? 'Stock' : 'Part'}</b><span>${len(s.widthMm)} × ${len(s.heightMm)}, ${len(s.partTop)} tall (base ${len(s.base)})${L ? `; ${esc(L.shape)}${L.border !== 'None' ? `, ${esc(L.border)} border` : ''}` : ''}</span>
<b>Stock</b><span>${len(s.stockTop)} thick, ${esc(s.material)}</span>
<b>Zero</b><span>X0 Y0 front-left corner · Z0 ${s.zZero === 'top' ? 'top of the stock' : 'spoilboard'}</span>
<b>Total time</b><span>about ${time(s.total)} plus tool changes</span>
</div>
<h2>Tools</h2>
<table><tr><th>#</th><th>Tool</th><th>Used for</th></tr>
${toolRows}
</table>
<h2>Operations</h2>
<table><tr><th></th><th>Operation</th><th>Tool</th><th></th><th>Speed / feed</th><th>Steps</th><th>Chip load</th><th>Time</th></tr>
${rows}
</table>
<h2>Setup</h2>
<ol>${steps.map((t) => `<li>${t}</li>`).join('')}</ol>
<p class="small">Feeds are conservative starting points from chip-load charts. Listen to the cut and adjust. Times leave out acceleration, so real runs take longer.</p>
</body></html>
`;
}

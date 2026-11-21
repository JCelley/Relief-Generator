/**
 * The Text section: a row of text items to pick from, Add text, and an editor for the picked one
 * (wording, font, size, spacing, arc, rotation, position, style, height). Lengths follow the
 * mm / inch setting.
 */
import { TEXT_STYLES, isCarved, type TextItem, type TextStyle } from '../core/text';
import { FONTS } from './fonts';

const MM_PER_IN = 25.4;

export interface TextPanelDeps {
  items: () => TextItem[];
  setItems: (t: TextItem[]) => void;
  units: () => 'mm' | 'in';
  /** something changed (re-carve); `layout` = only the position moved */
  changed: () => void;
  /** default raised height for a new item */
  defaultHeight: () => number;
}

type Num = { key: keyof TextItem; label: string; length?: boolean; min: number; max: number; step: number; unit?: string; range?: boolean; help: string };

const NUMS: Num[] = [
  { key: 'size', label: 'Letter height', length: true, min: 1, max: 400, step: 0.5, help: 'Height of the capital letters. Small letters need a small tool: a 1/16" ball does letters down to about 1/2" well; smaller wants a V-bit detail pass.' },
  { key: 'spacing', label: 'Letter spacing', length: true, min: -20, max: 50, step: 0.1, help: 'Extra space between letters (negative = tighter). 0 = the font\'s own spacing and kerning.' },
  { key: 'arc', label: 'Arc', min: -360, max: 360, step: 1, unit: '°', range: true, help: 'Bends the text along a circle by this many degrees: + arches it up (top of a badge), − curves it down like a smile (bottom of a badge). 0 = straight. 180 = a half circle.' },
  { key: 'rotation', label: 'Rotation', min: -180, max: 180, step: 1, unit: '°', range: true, help: 'Turns the text counter-clockwise.' },
  { key: 'x', label: 'Text X', length: true, min: -1000, max: 1000, step: 0.5, help: 'Centre of the text, right (+) or left (−) of the middle of the stock. Or drag the text in the top view under Stock & border.' },
  { key: 'y', label: 'Text Y', length: true, min: -1000, max: 1000, step: 0.5, help: 'Centre of the text, up (+) or down (−) from the middle of the stock. Or drag it in the top view.' },
  { key: 'height', label: 'Height', length: true, min: 0.1, max: 30, step: 0.1, help: 'How high raised letters stand above the base, or how deep carved letters go into the surface.' },
];

export class TextPanel {
  selected: number | null = null;
  private inputs = new Map<keyof TextItem, HTMLInputElement | HTMLSelectElement>();

  constructor(
    private list: HTMLElement,
    private editor: HTMLElement,
    private d: TextPanelDeps,
  ) {}

  private item(): TextItem | undefined {
    return this.d.items().find((t) => t.id === this.selected);
  }

  add() {
    const items = this.d.items();
    const t: TextItem = {
      id: Date.now(),
      text: 'Your text',
      font: 'Cinzel',
      size: 15,
      spacing: 0,
      arc: 0,
      rotation: 0,
      x: 0,
      y: 0,
      style: 'dome',
      height: this.d.defaultHeight(),
    };
    this.d.setItems([...items, t]);
    this.selected = t.id;
    this.render();
    this.d.changed();
    (this.inputs.get('text') as HTMLInputElement | undefined)?.select();
  }

  select(id: number | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.render();
  }

  /** rebuilds the item list and the editor (the picked item's values) */
  render() {
    const items = this.d.items();
    if (this.selected !== null && !items.some((t) => t.id === this.selected)) this.selected = null;
    this.list.replaceChildren(
      ...items.map((t) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'small text-chip' + (t.id === this.selected ? ' on' : '');
        b.textContent = t.text.trim() || '(empty)';
        b.title = 'Edit this text';
        b.addEventListener('click', () => this.select(t.id));
        return b;
      }),
    );
    this.inputs.clear();
    const t = this.item();
    this.editor.replaceChildren();
    if (!t) return;
    const row = (label: string, el: HTMLElement, help: string, unit?: HTMLElement, range?: HTMLInputElement) => {
      const r = document.createElement('div');
      r.className = 'row' + (range ? ' range' : unit ? ' range' : '');
      r.title = help;
      const l = document.createElement('label');
      l.textContent = label;
      r.appendChild(l);
      if (range) r.appendChild(range);
      if (unit) {
        const w = document.createElement('span');
        w.className = 'num-wrap';
        w.append(el, unit);
        if (!range) r.appendChild(document.createElement('span'));
        r.appendChild(w);
      } else r.appendChild(el);
      this.editor.appendChild(r);
    };
    // wording
    const tx = document.createElement('input');
    tx.type = 'text';
    tx.value = t.text;
    tx.className = 'text-input';
    tx.addEventListener('input', () => this.update({ text: tx.value }, true));
    this.inputs.set('text', tx);
    row('Text', tx, 'The wording. Add more text items for more lines or separate words.');
    // font
    const fs = document.createElement('select');
    let og: HTMLOptGroupElement | null = null;
    for (const f of FONTS) {
      if (og?.label !== f.group) {
        og = document.createElement('optgroup');
        og.label = f.group;
        fs.appendChild(og);
      }
      const o = new Option(f.label, f.family);
      o.style.fontFamily = `"${f.family}"`;
      og.appendChild(o);
    }
    fs.value = t.font;
    fs.addEventListener('change', () => this.update({ font: fs.value }, true));
    this.inputs.set('font', fs);
    row('Font', fs, 'Free fonts built into the app (SIL Open Font License / Apache). System fonts depend on the computer; if one is missing, the browser uses a similar font.');
    // style
    const st = document.createElement('select');
    for (const [v, l] of TEXT_STYLES) st.appendChild(new Option(l, v));
    st.value = t.style;
    st.addEventListener('change', () => {
      this.update({ style: st.value as TextStyle }, false);
      this.render();
    });
    this.inputs.set('style', st);
    row('Style', st, 'Raised letters stand on the base (round the picture, in the gap or on a banner). Carved letters go into whatever surface they are on, including uncut board. V-carved letters look sharpest with a V-bit: turn on the Detail pass with a 60° V-bit.');
    // numbers
    for (const n of NUMS) {
      const num = document.createElement('input');
      num.type = 'number';
      num.step = 'any';
      num.className = 'num';
      const unit = document.createElement('em');
      unit.textContent = n.length ? this.d.units() : (n.unit ?? '');
      const toD = (v: number) => (n.length && this.d.units() === 'in' ? +(v / MM_PER_IN).toFixed(4) : +v.toFixed(3));
      const fromD = (v: number) => (n.length && this.d.units() === 'in' ? v * MM_PER_IN : v);
      num.value = String(toD(t[n.key] as number));
      let range: HTMLInputElement | undefined;
      if (n.range) {
        range = document.createElement('input');
        range.type = 'range';
        range.min = String(n.min);
        range.max = String(n.max);
        range.step = String(n.step);
        range.value = String(t[n.key]);
        const r = range;
        r.addEventListener('input', () => {
          num.value = r.value;
          this.update({ [n.key]: Number(r.value) } as Partial<TextItem>, n.key === 'arc');
        });
      }
      num.addEventListener('change', () => {
        const v = Number(num.value);
        if (!Number.isFinite(v) || num.value.trim() === '') return;
        const mm = Math.min(n.max, Math.max(n.min, fromD(v)));
        num.value = String(toD(mm));
        if (range) range.value = String(mm);
        this.update({ [n.key]: mm } as Partial<TextItem>, n.key === 'size' || n.key === 'spacing' || n.key === 'arc');
      });
      num.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') num.blur();
      });
      this.inputs.set(n.key, num);
      const label = n.key === 'height' ? (isCarved(t.style) ? 'Depth' : 'Height') : n.label;
      row(label, num, n.help, unit, range);
    }
    // centre / delete
    const r = document.createElement('div');
    r.className = 'row';
    const sp = document.createElement('span');
    const btns = document.createElement('span');
    btns.className = 'preset-mod';
    const centre = document.createElement('button');
    centre.type = 'button';
    centre.className = 'small';
    centre.textContent = 'Centre';
    centre.title = 'Put this text in the middle of the stock, left to right';
    centre.addEventListener('click', () => {
      this.update({ x: 0 }, false);
      this.syncPos();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'small';
    del.textContent = 'Delete';
    del.title = 'Remove this text';
    del.addEventListener('click', () => {
      this.d.setItems(this.d.items().filter((q) => q.id !== this.selected));
      this.selected = null;
      this.render();
      this.d.changed();
    });
    btns.append(centre, ' ', del);
    r.append(sp, btns);
    this.editor.appendChild(r);
  }

  /** writes the picked item's position back into its boxes (after dragging) */
  syncPos() {
    const t = this.item();
    if (!t) return;
    for (const k of ['x', 'y'] as const) {
      const el = this.inputs.get(k) as HTMLInputElement | undefined;
      if (el && document.activeElement !== el) el.value = String(this.d.units() === 'in' ? +(t[k] / MM_PER_IN).toFixed(4) : +t[k].toFixed(3));
    }
  }

  /** changes the picked item; `relist` = its label in the list changes too */
  update(patch: Partial<TextItem>, relist: boolean) {
    const items = this.d.items().map((t) => (t.id === this.selected ? { ...t, ...patch } : t));
    this.d.setItems(items);
    if (relist) {
      const t = this.item();
      const chip = this.list.querySelector('.text-chip.on');
      if (chip && t) chip.textContent = t.text.trim() || '(empty)';
    }
    this.d.changed();
  }

  /** moves an item (dragging in the layout view) */
  move(id: number, x: number, y: number) {
    this.d.setItems(this.d.items().map((t) => (t.id === id ? { ...t, x, y } : t)));
    if (id === this.selected) this.syncPos();
  }
}

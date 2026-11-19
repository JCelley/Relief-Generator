import type { Grid } from '../core/grid';
import type { RawInputs } from '../core/relief';
import { findPlainBorder } from '../core/trim';

const lum = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Photo luminance (0..1) computed in the page, for a lithophane: no depth or mask models needed.
 * A plain border is trimmed off like in the model stage. Longest side ≤ maxSide.
 */
export async function photoLuminance(file: Blob, maxSide = 1024): Promise<RawInputs> {
  const bmp = await createImageBitmap(file);
  // border detection on a copy no bigger than 1600 px
  const s0 = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w0 = Math.round(bmp.width * s0), h0 = Math.round(bmp.height * s0);
  const c0 = new OffscreenCanvas(w0, h0);
  const x0 = c0.getContext('2d')!;
  x0.drawImage(bmp, 0, 0, w0, h0);
  const box = findPlainBorder(x0.getImageData(0, 0, w0, h0).data, w0, h0, 4);
  const crop = box ? { x: box.x / s0, y: box.y / s0, w: box.w / s0, h: box.h / s0 } : { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const s = Math.min(1, maxSide / Math.max(crop.w, crop.h));
  const w = Math.max(2, Math.round(crop.w * s)), h = Math.max(2, Math.round(crop.h * s));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = lum(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  const out: RawInputs = {
    luminance: { w, h, data },
    depth: { w: 0, h: 0, data: new Float32Array(0) },
    mask: null,
    crop: box ? { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h), srcW: bmp.width, srcH: bmp.height } : undefined,
  };
  bmp.close();
  return out;
}

export interface LampImage {
  name: string;
  bmp: ImageBitmap;
  thumb: string;
}

/**
 * The pictures wrapped around a lamp shade, in order. Each one fills an equal slice of the
 * circumference (centre-cropped to the slice's shape).
 */
export class LampImages {
  list: LampImage[] = [];
  version = 0;
  constructor(private host: HTMLElement, private onChange: () => void) {}

  async add(files: Iterable<File>) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const bmp = await createImageBitmap(f);
      const s = 96 / Math.max(bmp.width, bmp.height);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s);
      c.height = Math.round(bmp.height * s);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      this.list.push({ name: f.name, bmp, thumb: c.toDataURL('image/jpeg', 0.8) });
    }
    this.changed();
  }

  private changed() {
    this.version++;
    this.render();
    this.onChange();
  }

  clear() {
    for (const im of this.list) im.bmp.close();
    this.list = [];
    this.changed();
  }

  render() {
    this.host.replaceChildren();
    this.list.forEach((im, k) => {
      const item = document.createElement('div');
      item.className = 'lamp-item';
      const img = document.createElement('img');
      img.src = im.thumb;
      img.alt = im.name;
      img.title = `${k + 1}. ${im.name}`;
      const bar = document.createElement('div');
      const btn = (label: string, title: string, fn: () => void, disabled = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'small';
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.onclick = fn;
        bar.appendChild(b);
      };
      btn('◀', 'Move earlier', () => this.move(k, -1), k === 0);
      btn('✕', 'Remove', () => this.remove(k));
      btn('▶', 'Move later', () => this.move(k, 1), k === this.list.length - 1);
      const n = document.createElement('span');
      n.textContent = String(k + 1);
      n.className = 'lamp-n';
      item.append(n, img, bar);
      this.host.appendChild(item);
    });
  }

  private move(k: number, d: number) {
    const j = k + d;
    if (j < 0 || j >= this.list.length) return;
    [this.list[k], this.list[j]] = [this.list[j], this.list[k]];
    this.changed();
  }

  private remove(k: number) {
    this.list[k].bmp.close();
    this.list.splice(k, 1);
    this.changed();
  }

  /**
   * All pictures side by side as one luminance strip whose aspect matches the unrolled lamp
   * (circumference π·D × height H). Row 0 = top.
   */
  compose(diameter: number, height: number, pxPerMm = 4): Grid {
    const n = this.list.length;
    const W = Math.PI * diameter;
    const h = Math.max(16, Math.min(1400, Math.round(height * pxPerMm)));
    const w = Math.max(16, Math.min(8000, Math.round((h * W) / height)));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < n; k++) {
      const bmp = this.list[k].bmp;
      const x0 = Math.round((k * w) / n), x1 = Math.round(((k + 1) * w) / n);
      const pw = x1 - x0;
      // cover: centre-crop the picture to the slice's aspect
      const sa = bmp.width / bmp.height, da = pw / h;
      let sw = bmp.width, sh = bmp.height, sx = 0, sy = 0;
      if (sa > da) { sw = bmp.height * da; sx = (bmp.width - sw) / 2; }
      else { sh = bmp.width / da; sy = (bmp.height - sh) / 2; }
      ctx.drawImage(bmp, sx, sy, sw, sh, x0, 0, pw, h);
    }
    const px = ctx.getImageData(0, 0, w, h).data;
    const data = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = lum(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    return { w, h, data };
  }
}

/**
 * Crop / rotate dialog. Resolves with the edited picture (or null when cancelled).
 */
export function cropDialog(file: File): Promise<File | null> {
  return new Promise(async (resolve) => {
    const src = await createImageBitmap(file);
    let rot = 0; // quarter turns clockwise
    let aspect = 0; // 0 = free
    let sel: { x: number; y: number; w: number; h: number } | null = null; // in rotated-image pixels

    const dlg = document.createElement('dialog');
    dlg.className = 'crop';
    dlg.innerHTML = `
      <div class="crop-bar">
        <button type="button" class="small" data-a="l" title="Rotate left">⟲ Rotate</button>
        <button type="button" class="small" data-a="r" title="Rotate right">⟳ Rotate</button>
        <label>Shape <select data-a="aspect">
          <option value="0">Free</option><option value="1">Square</option><option value="1.3333">4 : 3</option>
          <option value="0.75">3 : 4</option><option value="1.5">3 : 2</option><option value="0.6667">2 : 3</option>
          <option value="1.7778">16 : 9</option>
        </select></label>
        <span class="crop-hint">Drag on the picture to choose the part to keep.</span>
      </div>
      <canvas></canvas>
      <div class="crop-bar end">
        <button type="button" class="small" data-a="reset">Whole picture</button>
        <button type="button" class="small" data-a="cancel">Cancel</button>
        <button type="button" data-a="ok">Use this</button>
      </div>`;
    document.body.appendChild(dlg);
    const cv = dlg.querySelector('canvas')!;
    const ctx = cv.getContext('2d')!;

    const rw = () => (rot % 2 ? src.height : src.width);
    const rh = () => (rot % 2 ? src.width : src.height);
    let scale = 1;
    const rotated = () => {
      const c = new OffscreenCanvas(rw(), rh());
      const x = c.getContext('2d')!;
      x.translate(rw() / 2, rh() / 2);
      x.rotate((rot * Math.PI) / 2);
      x.drawImage(src, -src.width / 2, -src.height / 2);
      return c;
    };
    let img = rotated();
    const draw = () => {
      const maxW = Math.min(window.innerWidth * 0.85, 1100), maxH = window.innerHeight * 0.7;
      scale = Math.min(maxW / rw(), maxH / rh(), 1);
      cv.width = Math.round(rw() * scale);
      cv.height = Math.round(rh() * scale);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      if (sel) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        const s = { x: sel.x * scale, y: sel.y * scale, w: sel.w * scale, h: sel.h * scale };
        ctx.fillRect(0, 0, cv.width, s.y);
        ctx.fillRect(0, s.y + s.h, cv.width, cv.height - s.y - s.h);
        ctx.fillRect(0, s.y, s.x, s.h);
        ctx.fillRect(s.x + s.w, s.y, cv.width - s.x - s.w, s.h);
        ctx.strokeStyle = '#e0b070';
        ctx.lineWidth = 2;
        ctx.strokeRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
      }
    };
    /** largest centred selection with the chosen aspect */
    const fitAspect = () => {
      if (!aspect) { sel = null; return; }
      let w = rw(), h = w / aspect;
      if (h > rh()) { h = rh(); w = h * aspect; }
      sel = { x: (rw() - w) / 2, y: (rh() - h) / 2, w, h };
    };

    let drag: { x: number; y: number; moving?: { dx: number; dy: number } } | null = null;
    const pt = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: Math.min(rw(), Math.max(0, ((e.clientX - r.left) / r.width) * rw())), y: Math.min(rh(), Math.max(0, ((e.clientY - r.top) / r.height) * rh())) };
    };
    cv.addEventListener('pointerdown', (e) => {
      const p = pt(e);
      cv.setPointerCapture(e.pointerId);
      // inside the current selection: move it; otherwise start a new one
      if (sel && p.x > sel.x && p.x < sel.x + sel.w && p.y > sel.y && p.y < sel.y + sel.h) drag = { ...p, moving: { dx: p.x - sel.x, dy: p.y - sel.y } };
      else drag = p;
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pt(e);
      if (drag.moving && sel) {
        sel.x = Math.min(rw() - sel.w, Math.max(0, p.x - drag.moving.dx));
        sel.y = Math.min(rh() - sel.h, Math.max(0, p.y - drag.moving.dy));
      } else {
        let w = Math.abs(p.x - drag.x), h = Math.abs(p.y - drag.y);
        if (aspect) {
          if (w / h > aspect) w = h * aspect;
          else h = w / aspect;
        }
        const x = p.x < drag.x ? drag.x - w : drag.x, y = p.y < drag.y ? drag.y - h : drag.y;
        sel = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(w, rw() - Math.max(0, x)), h: Math.min(h, rh() - Math.max(0, y)) };
      }
      draw();
    });
    cv.addEventListener('pointerup', () => {
      drag = null;
      if (sel && (sel.w < 8 || sel.h < 8)) { sel = null; draw(); }
    });

    const finish = async (ok: boolean) => {
      dlg.close();
      dlg.remove();
      if (!ok) { src.close(); resolve(null); return; }
      const s = sel ?? { x: 0, y: 0, w: rw(), h: rh() };
      const out = new OffscreenCanvas(Math.round(s.w), Math.round(s.h));
      out.getContext('2d')!.drawImage(img, s.x, s.y, s.w, s.h, 0, 0, out.width, out.height);
      src.close();
      const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
      resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
    };
    dlg.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'l' || a === 'r') {
        rot = (rot + (a === 'r' ? 1 : 3)) % 4;
        img = rotated();
        fitAspect();
        draw();
      } else if (a === 'reset') { sel = null; fitAspect(); draw(); }
      else if (a === 'cancel') finish(false);
      else if (a === 'ok') finish(true);
    });
    dlg.querySelector<HTMLSelectElement>('select')!.addEventListener('change', (e) => {
      aspect = Number((e.target as HTMLSelectElement).value);
      fitAspect();
      draw();
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    dlg.showModal();
    draw();
  });
}

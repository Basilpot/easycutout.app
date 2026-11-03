// Manual touch-up of a cutout: paint parts back from the original photo ("restore") or
// remove leftovers ("erase"). With `smart` on, a stroke only affects pixels whose color is
// close to the color where the stroke started, so a loose swipe over a missing arm brings
// back the arm but not the background around it (and the reverse for erasing).

const TILE = 64;
/** RGB distance (0–441) where "same color as the seed" fades out completely. */
const SMART_TOLERANCE = 70;

export type Mode = 'restore' | 'erase';

interface Patch {
  tiles: Map<number, { x: number; y: number; w: number; h: number; data: Uint8ClampedArray }>;
}

export class Refiner {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private img: ImageData;
  private photo: Uint8ClampedArray;
  private undoStack: Patch[] = [];
  private stroke: Patch | null = null;
  private seed: [number, number, number] = [0, 0, 0];
  private last: { x: number; y: number } | null = null;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  mode: Mode = 'restore';
  smart = true;
  /** Brush radius in image pixels. */
  radius = 30;

  constructor(cut: CanvasImageSource & { width: number; height: number }, photo: CanvasImageSource) {
    const { width: w, height: h } = cut;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.g = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.g.drawImage(cut, 0, 0);
    this.img = this.g.getImageData(0, 0, w, h);
    const p = document.createElement('canvas');
    p.width = w;
    p.height = h;
    const pg = p.getContext('2d', { willReadFrequently: true })!;
    pg.drawImage(photo, 0, 0, w, h);
    this.photo = pg.getImageData(0, 0, w, h).data;
    p.width = p.height = 0;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  dispose() {
    this.canvas.width = this.canvas.height = 0;
    this.undoStack = [];
  }

  begin(x: number, y: number) {
    this.stroke = { tiles: new Map() };
    this.last = null;
    // Seed color: average of the original photo around the first touch.
    const { width: w, height: h } = this.img;
    const cx = Math.min(w - 1, Math.max(0, Math.round(x)));
    const cy = Math.min(h - 1, Math.max(0, Math.round(y)));
    const r = Math.max(2, Math.round(this.radius * 0.25));
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let yy = Math.max(0, cy - r); yy <= Math.min(h - 1, cy + r); yy++) {
      for (let xx = Math.max(0, cx - r); xx <= Math.min(w - 1, cx + r); xx++) {
        const i = (yy * w + xx) * 4;
        sr += this.photo[i];
        sg += this.photo[i + 1];
        sb += this.photo[i + 2];
        n++;
      }
    }
    this.seed = [sr / n, sg / n, sb / n];
    this.moveTo(x, y);
  }

  moveTo(x: number, y: number) {
    if (!this.stroke) return;
    const from = this.last ?? { x, y };
    const dist = Math.hypot(x - from.x, y - from.y);
    const step = Math.max(1, this.radius / 4);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) this.stamp(from.x + ((x - from.x) * i) / n, from.y + ((y - from.y) * i) / n);
    this.last = { x, y };
  }

  /** Finish the stroke. Returns true if anything changed. */
  end(): boolean {
    const s = this.stroke;
    this.stroke = null;
    this.last = null;
    if (!s || !s.tiles.size) return false;
    this.undoStack.push(s);
    if (this.undoStack.length > 30) this.undoStack.shift();
    return true;
  }

  undo(): boolean {
    const patch = this.undoStack.pop();
    if (!patch) return false;
    const { width: w } = this.img;
    const d = this.img.data;
    for (const t of patch.tiles.values()) {
      for (let row = 0; row < t.h; row++) {
        d.set(t.data.subarray(row * t.w * 4, (row + 1) * t.w * 4), ((t.y + row) * w + t.x) * 4);
      }
      this.mark(t.x, t.y, t.x + t.w, t.y + t.h);
    }
    this.flush();
    return true;
  }

  private mark(x0: number, y0: number, x1: number, y1: number) {
    const d = this.dirty;
    this.dirty = d ? { x0: Math.min(d.x0, x0), y0: Math.min(d.y0, y0), x1: Math.max(d.x1, x1), y1: Math.max(d.y1, y1) } : { x0, y0, x1, y1 };
  }

  /** Push changed pixels to the canvas. Call once per frame. */
  flush() {
    const d = this.dirty;
    if (!d) return;
    this.dirty = null;
    this.g.putImageData(this.img, 0, 0, d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
  }

  /** Copy a tile's pixels before the stroke first touches it (for undo and for erase's base alpha). */
  private tile(tx: number, ty: number) {
    const key = ty * 100000 + tx;
    let t = this.stroke!.tiles.get(key);
    if (t) return t;
    const { width: w, height: h } = this.img;
    const x = tx * TILE, y = ty * TILE;
    const tw = Math.min(TILE, w - x), th = Math.min(TILE, h - y);
    const data = new Uint8ClampedArray(tw * th * 4);
    for (let row = 0; row < th; row++) {
      data.set(this.img.data.subarray(((y + row) * w + x) * 4, ((y + row) * w + x + tw) * 4), row * tw * 4);
    }
    t = { x, y, w: tw, h: th, data };
    this.stroke!.tiles.set(key, t);
    return t;
  }

  private stamp(cx: number, cy: number) {
    const { width: w, height: h } = this.img;
    const r = this.radius;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    if (x1 < x0 || y1 < y0) return;
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) this.tile(tx, ty);
    }
    const d = this.img.data;
    const restore = this.mode === 'restore';
    const tol = SMART_TOLERANCE;
    const [sr, sg, sb] = this.seed;
    const soft = Math.max(1, r * 0.3); // Soft edge width
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist > r) continue;
        let k = Math.min(1, (r - dist) / soft);
        const i = (y * w + x) * 4;
        if (this.smart) {
          const dc = Math.hypot(this.photo[i] - sr, this.photo[i + 1] - sg, this.photo[i + 2] - sb);
          // Full effect up to 55% of the tolerance, then fades out.
          const t = Math.min(1, Math.max(0, (dc - tol * 0.55) / (tol * 0.45)));
          k *= 1 - t * t * (3 - 2 * t);
        }
        if (k <= 0) continue;
        if (restore) {
          const a = Math.round(k * 255);
          if (a > d[i + 3]) {
            d[i] = this.photo[i];
            d[i + 1] = this.photo[i + 1];
            d[i + 2] = this.photo[i + 2];
            d[i + 3] = a;
          }
        } else {
          // Relative to the alpha before this stroke, so a slow drag doesn't compound.
          const t = this.stroke!.tiles.get(Math.floor(y / TILE) * 100000 + Math.floor(x / TILE))!;
          const base = t.data[((y - t.y) * t.w + (x - t.x)) * 4 + 3];
          const a = Math.round(base * (1 - k));
          if (a < d[i + 3]) d[i + 3] = a;
        }
      }
    }
    this.mark(x0, y0, x1 + 1, y1 + 1);
  }
}

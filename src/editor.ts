// Non-destructive edits on top of a background-removed image ("cutout"):
// background (color, or the original photo), crop (may extend past the image to add
// padding, which is how "make square" works), rounded corners and output size.
// Everything renders from the untouched cutout, so edits can change or reset at any time.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Edits {
  bg: string | null; // CSS color, PHOTO_BG for the original photo, or null for transparent
  crop: Rect | null; // In cutout pixels; null = whole image
  width: number | null; // Output width in px; null = crop width (height follows the crop's aspect)
  radius?: number; // Corner radius as % of the shorter output side (0–50; 50 = circle/pill)
}

/** `bg` value meaning "keep the original photo's background". */
export const PHOTO_BG = 'photo';

export const DEFAULT_EDITS: Edits = { bg: null, crop: null, width: null, radius: 0 };

/** What gets drawn: the cutout, plus the original photo for PHOTO_BG. Same pixel grid. */
export interface Sources {
  cut: CanvasImageSource & Size;
  photo?: CanvasImageSource | null;
}

// Keeps exports inside what every browser (incl. iOS Safari) can put on a canvas.
export const MAX_OUTPUT_PIXELS = 16_000_000;
export const MAX_OUTPUT_SIDE = 6000;

export interface Size {
  width: number;
  height: number;
}

export const cropOf = (img: Size, e: Edits): Rect => e.crop ?? { x: 0, y: 0, w: img.width, h: img.height };

/** Final output size in px, clamped to safe canvas limits. */
export function outputSize(img: Size, e: Edits): Size {
  const c = cropOf(img, e);
  let w = e.width ?? c.w;
  let h = (w * c.h) / c.w;
  const scale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(w, h), Math.sqrt(MAX_OUTPUT_PIXELS / (w * h)));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  return { width: w, height: h };
}

export const isDefault = (e: Edits) => !e.bg && !e.crop && !e.width && !e.radius;

/** Is the output fully opaque (so JPEG makes sense)? */
export const isOpaque = (e: Edits) => !!e.bg && !e.radius;

function roundedClip(g: CanvasRenderingContext2D, w: number, h: number, r: number) {
  g.beginPath();
  if (g.roundRect) g.roundRect(0, 0, w, h, r);
  else {
    g.moveTo(r, 0);
    g.arcTo(w, 0, w, h, r);
    g.arcTo(w, h, 0, h, r);
    g.arcTo(0, h, 0, 0, r);
    g.arcTo(0, 0, w, 0, r);
    g.closePath();
  }
  g.clip();
}

/**
 * Draw the edited result into `canvas`, optionally limited to `maxSide` for previews.
 * `matte` fills everything first (used for JPEG, which has no transparency).
 * `noCorners` skips rounding (used while cropping, where the full frame matters).
 */
export function renderTo(
  canvas: HTMLCanvasElement,
  src: Sources,
  e: Edits,
  maxSide = Infinity,
  opts: { matte?: string; noCorners?: boolean } = {},
): void {
  const { cut, photo } = src;
  const c = cropOf(cut, e);
  const out = outputSize(cut, e);
  const fit = Math.min(1, maxSide / Math.max(out.width, out.height));
  const w = Math.max(1, Math.round(out.width * fit));
  const h = Math.max(1, Math.round(out.height * fit));
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  if (opts.matte) {
    g.fillStyle = opts.matte;
    g.fillRect(0, 0, w, h);
  }
  g.save();
  const r = opts.noCorners ? 0 : (Math.min(w, h) * Math.min(50, Math.max(0, e.radius ?? 0))) / 100;
  if (r > 0) roundedClip(g, w, h, r);
  if (e.bg && e.bg !== PHOTO_BG) {
    g.fillStyle = e.bg;
    g.fillRect(0, 0, w, h);
  }
  const s = w / c.w;
  const dx = -c.x * s, dy = -c.y * s, dw = cut.width * s, dh = cut.height * s;
  g.imageSmoothingQuality = 'high';
  if (e.bg === PHOTO_BG && photo) g.drawImage(photo, dx, dy, dw, dh);
  g.drawImage(cut, dx, dy, dw, dh);
  g.restore();
}

/** Full-resolution export. JPEG has no transparency, so transparent areas become white. */
export async function exportImage(src: Sources, e: Edits, type: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Blob> {
  const canvas = document.createElement('canvas');
  renderTo(canvas, src, e, Infinity, { matte: type === 'image/jpeg' ? '#ffffff' : undefined });
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92));
  canvas.width = canvas.height = 0; // Free memory early (Safari).
  if (!blob) throw new Error('export failed');
  return blob;
}

/** Bounding box of the visible subject (alpha > threshold), in cutout pixels. */
export function subjectBounds(cut: CanvasImageSource & Size): Rect | null {
  // Analyse a small copy: plenty accurate for a crop box and fast even for 16 MP.
  const scale = Math.min(1, 512 / Math.max(cut.width, cut.height));
  const w = Math.max(1, Math.round(cut.width * scale));
  const h = Math.max(1, Math.round(cut.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(cut, 0, 0, w, h);
  const { data } = g.getImageData(0, 0, w, h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const inv = 1 / scale;
  const x = Math.max(0, Math.floor(x0 * inv));
  const y = Math.max(0, Math.floor(y0 * inv));
  return { x, y, w: Math.min(cut.width, Math.ceil((x1 + 1) * inv)) - x, h: Math.min(cut.height, Math.ceil((y1 + 1) * inv)) - y };
}

/** Grow `r` around its center to the given aspect ratio (w/h). */
export function expandToAspect(r: Rect, aspect: number): Rect {
  let { w, h } = r;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** Largest rect of `aspect` that fits inside `r`, centered. */
export function fitAspectInside(r: Rect, aspect: number): Rect {
  let { w, h } = r;
  if (w / h > aspect) w = h * aspect;
  else h = w / aspect;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

export const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Round to whole pixels while keeping an exact aspect ratio (e.g. a true square). */
export function roundToAspect(r: Rect, aspect: number): Rect {
  const w = Math.max(1, Math.round(r.w));
  const h = Math.max(1, Math.round(w / aspect));
  return { x: Math.round(r.x + (r.w - w) / 2), y: Math.round(r.y + (r.h - h) / 2), w, h };
}

export const roundRect = (r: Rect): Rect => {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, w: Math.max(1, Math.round(r.x + r.w) - x), h: Math.max(1, Math.round(r.y + r.h) - y) };
};

/**
 * Fit-to-subject crop with padding (fraction of the subject's larger side).
 * Sides where the subject is cut off by the photo edge (e.g. a portrait cut at the
 * shoulders) stay flush with that edge instead of getting padding.
 */
export function subjectCrop(cut: CanvasImageSource & Size, aspect: number | null, padding = 0.06): Rect | null {
  const b = subjectBounds(cut);
  if (!b) return null;
  const tol = Math.max(2, Math.round(Math.max(cut.width, cut.height) * 0.005));
  const touch = { l: b.x <= tol, t: b.y <= tol, r: b.x + b.w >= cut.width - tol, b: b.y + b.h >= cut.height - tol };
  const pad = Math.max(b.w, b.h) * padding;
  const x0 = touch.l ? b.x : b.x - pad;
  const y0 = touch.t ? b.y : b.y - pad;
  const x1 = touch.r ? b.x + b.w : b.x + b.w + pad;
  const y1 = touch.b ? b.y + b.h : b.y + b.h + pad;
  let r: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (aspect) {
    const e = expandToAspect(r, aspect);
    // Grow away from cut-off edges rather than past them.
    if (e.h > r.h) e.y = touch.b && !touch.t ? y1 - e.h : touch.t && !touch.b ? y0 : e.y;
    if (e.w > r.w) e.x = touch.r && !touch.l ? x1 - e.w : touch.l && !touch.r ? x0 : e.x;
    return roundToAspect(e, aspect);
  }
  return roundRect(r);
}

/**
 * Square crop that pads instead of cutting. "image" keeps the whole picture,
 * "subject" fits around the cut-out subject. `margin` is a fraction of the larger side.
 * The extra space is filled with the background color (or left transparent).
 */
export function squareCrop(cut: CanvasImageSource & Size, mode: 'image' | 'subject', margin: number): Rect | null {
  if (mode === 'subject') return subjectCrop(cut, 1, margin);
  const pad = Math.max(cut.width, cut.height) * margin;
  return roundToAspect(expandToAspect({ x: -pad, y: -pad, w: cut.width + 2 * pad, h: cut.height + 2 * pad }, 1), 1);
}

// ---------------------------------------------------------------------------
// Crop box interaction. Positions are percentages of the "view" rect (the image
// plus any crop area outside it), so the overlay scales with the preview.

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
const MIN = 16;

export class CropBox {
  readonly el: HTMLDivElement;
  private view: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  aspect: number | null = null;

  constructor(
    private host: HTMLElement, // Element the overlay is positioned over (same box as the preview canvas)
    private onChange: (r: Rect, done: boolean) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'crop-box';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Crop area. Drag to move, drag corners to resize, or use arrow keys (Shift for bigger steps).');
    this.el.innerHTML = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map((h) => `<span class="crop-handle h-${h}" data-handle="${h}"></span>`).join('');
    this.el.addEventListener('pointerdown', (e) => this.start(e));
    this.el.addEventListener('keydown', (e) => this.key(e));
    host.append(this.el);
  }

  set(view: Rect, rect: Rect) {
    this.view = view;
    this.rect = { ...rect };
    this.el.classList.toggle('locked', this.aspect !== null);
    this.paint();
  }

  private paint() {
    const { view: v, rect: r } = this;
    Object.assign(this.el.style, {
      left: `${((r.x - v.x) / v.w) * 100}%`,
      top: `${((r.y - v.y) / v.h) * 100}%`,
      width: `${(r.w / v.w) * 100}%`,
      height: `${(r.h / v.h) * 100}%`,
    });
  }

  private clamp(r: Rect): Rect {
    const v = this.view;
    const w = Math.min(Math.max(r.w, MIN), v.w);
    const h = Math.min(Math.max(r.h, MIN), v.h);
    return { x: Math.min(Math.max(r.x, v.x), v.x + v.w - w), y: Math.min(Math.max(r.y, v.y), v.y + v.h - h), w, h };
  }

  private start(e: PointerEvent) {
    e.preventDefault();
    const handle = ((e.target as HTMLElement).dataset.handle ?? 'move') as Handle;
    const startRect = { ...this.rect };
    const scale = this.view.w / this.host.clientWidth; // image px per screen px
    const sx = e.clientX;
    const sy = e.clientY;
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add('dragging');

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) * scale;
      const dy = (ev.clientY - sy) * scale;
      this.rect = this.resize(startRect, handle, dx, dy);
      this.paint();
      this.onChange(this.rect, false);
    };
    const end = () => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', end);
      this.el.removeEventListener('pointercancel', end);
      this.el.classList.remove('dragging');
      this.rect = roundRect(this.rect);
      this.onChange(this.rect, true);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  private resize(r: Rect, handle: Handle, dx: number, dy: number): Rect {
    if (handle === 'move') return this.clamp({ ...r, x: r.x + dx, y: r.y + dy });
    const v = this.view;
    let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    if (handle.includes('w')) x0 = Math.min(Math.max(v.x, x0 + dx), x1 - MIN);
    if (handle.includes('e')) x1 = Math.max(Math.min(v.x + v.w, x1 + dx), x0 + MIN);
    if (handle.includes('n')) y0 = Math.min(Math.max(v.y, y0 + dy), y1 - MIN);
    if (handle.includes('s')) y1 = Math.max(Math.min(v.y + v.h, y1 + dy), y0 + MIN);
    if (this.aspect && handle.length === 2) {
      // Corner drag with locked aspect: follow the dominant axis, anchor the opposite corner.
      const a = this.aspect;
      let w = x1 - x0;
      let h = y1 - y0;
      if (w / h > a) w = h * a;
      else h = w / a;
      // Respect the view bounds on the anchored side.
      const maxW = handle.includes('w') ? x1 - v.x : v.x + v.w - x0;
      const maxH = handle.includes('n') ? y1 - v.y : v.y + v.h - y0;
      const fit = Math.min(1, maxW / w, maxH / h);
      w *= fit;
      h *= fit;
      if (handle.includes('w')) x0 = x1 - w;
      else x1 = x0 + w;
      if (handle.includes('n')) y0 = y1 - h;
      else y1 = y0 + h;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private key(e: KeyboardEvent) {
    const step = (e.shiftKey ? 10 : 1) * Math.max(1, this.view.w / 200);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    this.rect = roundRect(this.clamp({ ...this.rect, x: this.rect.x + d[0], y: this.rect.y + d[1] }));
    this.paint();
    this.onChange(this.rect, true);
  }
}

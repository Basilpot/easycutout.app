import {
  CropBox,
  DEFAULT_EDITS,
  cropOf,
  exportImage,
  PHOTO_BG,
  squareCrop,
  fitAspectInside,
  isDefault,
  outputSize,
  renderTo,
  roundRect,
  roundToAspect,
  isOpaque,
  subjectCrop,
  union,
  MAX_OUTPUT_SIDE,
  type Edits,
  type Rect,
} from './editor';
import { addHistory, clearHistory, deleteHistory, listHistory, updateHistory, type HistoryItem } from './history';
import type { ErrorCode, FromWorker, ToWorker } from './protocol';
import './shutdown';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const drop = $<HTMLDivElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const pickBtn = $<HTMLButtonElement>('pick');
const pasteBtn = $<HTMLButtonElement>('paste');
const samples = $<HTMLDivElement>('samples');
const work = $<HTMLDivElement>('work');
const stage = $<HTMLDivElement>('stage');
const canvasWrap = $<HTMLDivElement>('canvas-wrap');
const canvas = $<HTMLCanvasElement>('canvas');
const progress = $<HTMLDivElement>('progress');
const progressBar = $<HTMLDivElement>('progress-bar');
const statusEl = $<HTMLParagraphElement>('status');
const editor = $<HTMLDivElement>('editor');
const toggle = $<HTMLDivElement>('toggle');
const downloadBtn = $<HTMLButtonElement>('download');
const downloadJpgBtn = $<HTMLButtonElement>('download-jpg');
const resetBtn = $<HTMLButtonElement>('reset');
const retryBtn = $<HTMLButtonElement>('retry');
const redoBtn = $<HTMLButtonElement>('redo');
const editsResetBtn = $<HTMLButtonElement>('edits-reset');
const outSizeEl = $<HTMLParagraphElement>('out-size');
const bgCustom = $<HTMLInputElement>('bg-custom');
const bgHex = $<HTMLInputElement>('bg-hex');
const sizeW = $<HTMLInputElement>('size-w');
const sizeH = $<HTMLInputElement>('size-h');
const squareMargin = $<HTMLInputElement>('square-margin');
const squareMarginOut = $<HTMLSpanElement>('square-margin-out');
const radiusInput = $<HTMLInputElement>('radius');
const radiusOut = $<HTMLSpanElement>('radius-out');
const photoSwatch = editor_q('[data-bg="photo"]');
function editor_q(sel: string) {
  return document.querySelector<HTMLButtonElement>(`#editor ${sel}`)!;
}
const historySection = $<HTMLElement>('history');
const historyList = $<HTMLUListElement>('history-list');
const historyClear = $<HTMLButtonElement>('history-clear');
$('year').textContent = String(new Date().getFullYear());

const preview = document.createElement('img');
preview.alt = '';
stage.prepend(preview);

const ERRORS: Record<ErrorCode, string> = {
  decode: 'This file couldn’t be opened as an image. Try a JPG, PNG or WebP file. (iPhone HEIC photos only open in Safari.)',
  'too-large': 'This image is too large. Please use a file under 40 MB.',
  'model-download': 'The AI model couldn’t be downloaded. Check your connection and try again.',
  'model-init': 'Your browser couldn’t start the AI model, possibly due to low memory. Close other tabs and try again, or use another browser.',
  inference: 'Something went wrong while removing the background. Try again, or try a smaller image.',
  unsupported: 'Your browser is too old for this tool. Please update it or use a recent Chrome, Edge, Firefox or Safari.',
};

// Crash guard: a GPU driver bug or out-of-memory can kill the whole tab, which no
// try/catch can see. We flag "GPU job in progress" before each job and clear it on
// success. If the flag is still set on the next page load, the tab died mid-job, so
// use the CPU backend for a while.
const GPU_PENDING = 'cutly.gpuPending';
const GPU_BLOCKED = 'cutly.gpuBlockedAt';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
if (store.get(GPU_PENDING)) {
  store.del(GPU_PENDING);
  store.set(GPU_BLOCKED, String(Date.now()));
}
const gpuBlocked = Date.now() - Number(store.get(GPU_BLOCKED) ?? 0) < 7 * 24 * 3600 * 1000;
const forceWasm = gpuBlocked || new URLSearchParams(location.search).get('backend') === 'wasm';

// --- State ---------------------------------------------------------------------

// Which page we're on. The homepage removes the background right away; the square and
// corners pages open the photo as-is (no AI download) and offer removal as a button.
type Tool = 'remove' | 'square' | 'corners';
const TOOL: Tool = (['square', 'corners'] as const).find((t) => t === document.body.dataset.tool) ?? 'remove';
const AI_FIRST = TOOL === 'remove';

/** Starting edits for a new image on each page. */
function presetEdits(): Edits {
  if (TOOL === 'square') return { ...DEFAULT_EDITS, bg: '#ffffff' };
  if (TOOL === 'corners') return { ...DEFAULT_EDITS, radius: 10 };
  return { ...DEFAULT_EDITS };
}

/**
 * The image being edited. `cut` is the base bitmap edits apply to: the background-removed
 * cutout, or the plain photo when the background hasn't been removed (`removed: false`).
 */
interface Doc {
  historyId: string | null;
  name: string; // Base name for downloads
  original: Blob | null; // Source photo (cropped if "Redo removal" ran on a crop)
  png: Blob | null;
  cut: ImageBitmap | null;
  photo: ImageBitmap | null; // Original photo at the cutout's size, decoded on demand for PHOTO_BG
  edits: Edits;
  removed: boolean; // Has the background been removed?
}

let doc: Doc = { historyId: null, name: 'image', original: null, png: null, cut: null, photo: null, edits: { ...DEFAULT_EDITS }, removed: false };
let view: 'result' | 'original' = 'result';
let tab: 'bg' | 'crop' | 'square' | 'corners' | 'size' = TOOL === 'remove' ? 'bg' : TOOL;
let squareMode: 'image' | 'subject' | null = null;
let aspect: number | null = null; // Locked crop aspect (w/h)
let cropView: Rect | null = null; // Area shown while cropping (image + crop overlap)

let worker: Worker | null = null;
let jobId = 0;
let jobSource: Blob | null = null; // What the current/last job processes (for "Try again")
let pendingRedo: { ix: Rect } | null = null; // Area of the cutout being refined by "Redo removal"
let originalUrl = '';
let modelReady = false;
let jobStart = 0;

function getWorker(): Worker {
  if (worker) return worker;
  // `?backend=wasm` forces the CPU backend (handy for debugging and comparing).
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: forceWasm ? 'wasm' : 'auto' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onWorkerMessage(e.data);
  worker.onerror = (e) => {
    console.error(e);
    showError(ERRORS['model-init']);
    worker?.terminate();
    worker = null;
  };
  return worker;
}

const send = (msg: ToWorker) => getWorker().postMessage(msg);

/** Start downloading the model as soon as the user shows intent, so it's ready sooner. */
let warmedUp = false;
function warmup() {
  if (warmedUp) return;
  warmedUp = true;
  send({ type: 'warmup' });
}

function setProgress(fraction: number | null) {
  progress.hidden = fraction === null;
  if (fraction !== null) progressBar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, fraction))})`;
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

const mb = (n: number) => (n / 1048576).toFixed(0);

function onWorkerMessage(msg: FromWorker) {
  if ('id' in msg && msg.id !== undefined && msg.id !== jobId) return; // Stale job.
  switch (msg.type) {
    case 'download':
      if (!jobSource || work.dataset.state !== 'working') return; // Background warm-up: stay quiet.
      setProgress(msg.loaded / msg.total);
      setStatus(`Downloading AI model (first time only)… ${mb(msg.loaded)} / ${mb(msg.total)} MB`);
      break;
    case 'ready':
      modelReady = true;
      console.info(`[cutly] model ready on ${msg.backend}${msg.threads ? ` (${msg.threads} threads)` : ''}`);
      if (work.dataset.state === 'working') {
        setProgress(null);
        setStatus('Removing background…');
      }
      break;
    case 'stage':
      if (msg.stage === 'inferring' || (msg.stage === 'decoding' && modelReady)) {
        setProgress(null);
        setStatus('Removing background…');
      }
      break;
    case 'result':
      console.info(`[cutly] processed ${msg.width}×${msg.height} in ${msg.ms} ms`);
      void onResult(msg.png, msg.downscaled, msg.id);
      break;
    case 'error':
      if (msg.id === undefined && work.dataset.state !== 'working') {
        warmedUp = false; // Warm-up failed quietly; retry when an image arrives.
        return;
      }
      console.error('[cutly]', msg.code, msg.detail);
      if (msg.code === 'model-download' || msg.code === 'model-init') warmedUp = false;
      showError(ERRORS[msg.code]);
      break;
  }
}

// --- Processing ----------------------------------------------------------------

function baseName(file: Blob): string {
  const name = file instanceof File && file.name ? file.name : 'image';
  return name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'image';
}

function setOriginal(blob: Blob | null) {
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  originalUrl = blob ? URL.createObjectURL(blob) : '';
}

function freeCut() {
  doc.cut?.close();
  doc.cut = null;
  doc.photo?.close();
  doc.photo = null;
}

/** Decode the original photo at the cutout's size (EXIF-rotated, same pixel grid). */
async function decodePhoto(original: Blob, size: { width: number; height: number }): Promise<ImageBitmap> {
  return createImageBitmap(original, { imageOrientation: 'from-image', resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
}

/** Make sure doc.photo exists when the original background is selected. */
async function ensurePhoto(): Promise<boolean> {
  if (doc.photo) return true;
  if (!doc.original || !doc.cut) return false;
  const d = doc;
  try {
    const photo = await decodePhoto(d.original!, d.cut!);
    if (doc !== d) return photo.close(), false;
    d.photo = photo;
    return true;
  } catch {
    return false;
  }
}

const srcOf = () => ({ cut: doc.cut!, photo: doc.photo });

/** New image from the user. */
function start(file: Blob) {
  freeCut();
  pendingRedo = null;
  doc = { historyId: null, name: baseName(file), original: file, png: null, cut: null, photo: null, edits: presetEdits(), removed: false };
  aspect = null;
  squareMode = null;
  if (!file.type.startsWith('image/') && file.type !== '') {
    jobSource = file;
    enterWork();
    showError(ERRORS.decode);
    return;
  }
  setOriginal(file);
  if (AI_FIRST) process(file);
  else void openPlain(file);
}

// Same limits as the worker, so a later "Remove background" result lines up pixel for pixel.
const PLAIN_MAX_PIXELS = 16_000_000;
const PLAIN_MAX_SIDE = 4096;

/** Open the photo for editing without removing the background (square/corners pages). */
async function openPlain(file: Blob) {
  const id = ++jobId;
  jobSource = file;
  enterWork();
  work.dataset.state = 'working';
  editor.hidden = true;
  setProgress(null);
  setStatus('Opening image…');
  let cut: ImageBitmap;
  let downscaled = false;
  try {
    if (file.size > 40 * 1024 * 1024) return showError(ERRORS['too-large']);
    const full = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, PLAIN_MAX_SIDE / Math.max(full.width, full.height), Math.sqrt(PLAIN_MAX_PIXELS / (full.width * full.height)));
    downscaled = scale < 1;
    if (downscaled) {
      cut = await createImageBitmap(full, {
        resizeWidth: Math.max(1, Math.round(full.width * scale)),
        resizeHeight: Math.max(1, Math.round(full.height * scale)),
        resizeQuality: 'high',
      });
      full.close();
    } else cut = full;
  } catch {
    return showError(ERRORS.decode);
  }
  if (id !== jobId) return cut.close();
  // Store a re-encoded copy (EXIF rotation applied) as the base image for history.
  const c = document.createElement('canvas');
  c.width = cut.width;
  c.height = cut.height;
  c.getContext('2d')!.drawImage(cut, 0, 0);
  const alpha = /png|webp|gif|avif/.test(file.type);
  const base = await new Promise<Blob | null>((r) => c.toBlob(r, alpha ? 'image/png' : 'image/jpeg', 0.95));
  c.width = c.height = 0;
  if (id !== jobId) return cut.close();
  if (!base) return showError(ERRORS.decode);
  doc.cut = cut;
  doc.png = base;
  if (TOOL === 'square') {
    squareMode = 'image';
    aspect = 1;
    doc.edits.crop = squareCrop(cut, 'image', Number(squareMargin.value) / 100);
  }
  showDone(downscaled ? 'Large image was reduced to 16 megapixels.' : 'Ready. Adjust it below, then download.');
  void saveToHistory(true);
}

/** Send `source` to the worker and show the working state. */
function process(source: Blob) {
  jobId++;
  jobSource = source;
  jobStart = performance.now();
  enterWork();
  preview.src = URL.createObjectURL(source);
  preview.onload = () => URL.revokeObjectURL(preview.src);
  preview.alt = 'Your image, being processed';
  preview.hidden = false;
  canvasWrap.hidden = true;
  editor.hidden = true;
  outSizeEl.hidden = true;
  work.dataset.state = 'working';
  toggle.hidden = true;
  downloadBtn.hidden = downloadJpgBtn.hidden = true;
  retryBtn.hidden = true;
  setProgress(modelReady ? null : 0);
  setStatus(modelReady ? 'Removing background…' : 'Preparing AI model…');
  if (!forceWasm) store.set(GPU_PENDING, '1');
  send({ type: 'process', id: jobId, file: source });
}

async function onResult(png: Blob, downscaled: boolean, id: number) {
  store.del(GPU_PENDING);
  let cut = await createImageBitmap(png);
  if (id !== jobId) return cut.close(); // Superseded while decoding.

  if (pendingRedo && doc.cut) {
    // Paste the refined crop area back into the full cutout, so the crop, the
    // original and "Reset edits" all keep working on the whole image.
    const { ix } = pendingRedo;
    const full = document.createElement('canvas');
    full.width = doc.cut.width;
    full.height = doc.cut.height;
    const g = full.getContext('2d')!;
    g.drawImage(doc.cut, 0, 0);
    g.clearRect(ix.x, ix.y, ix.w, ix.h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(cut, ix.x, ix.y, ix.w, ix.h);
    cut.close();
    const merged = await new Promise<Blob | null>((r) => full.toBlob(r, 'image/png'));
    if (id !== jobId) return;
    if (!merged) return showError(ERRORS.inference);
    png = merged;
    cut = await createImageBitmap(full);
    full.width = full.height = 0;
    pendingRedo = null;
  }
  doc.cut?.close(); // Keep doc.photo: same image, same pixel grid.
  doc.cut = cut;
  doc.png = png;
  doc.removed = true;

  const secs = ((performance.now() - jobStart) / 1000).toFixed(1);
  showDone(`Done in ${secs}s.${downscaled ? ' Large image was reduced to 16 megapixels.' : ''}`);
  void saveToHistory(true);
}

/** "Redo removal": run the model again, only on the cropped area when there is a crop. */
async function redo() {
  if (!doc.original || !doc.cut) return;
  if (!doc.removed) {
    // First removal on the square/corners pages: whole photo, edits kept.
    pendingRedo = null;
    warmup();
    return process(doc.original);
  }
  const cut = doc.cut;
  const crop = doc.edits.crop;
  pendingRedo = null;
  let source: Blob = doc.original;

  if (crop) {
    // Part of the crop that lies on the image (the rest is padding).
    const x0 = Math.max(0, crop.x), y0 = Math.max(0, crop.y);
    const x1 = Math.min(cut.width, crop.x + crop.w), y1 = Math.min(cut.height, crop.y + crop.h);
    const ix = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const whole = ix.w >= cut.width - 1 && ix.h >= cut.height - 1;
    if (ix.w >= 8 && ix.h >= 8 && !whole) {
      try {
        const ob = await createImageBitmap(doc.original, { imageOrientation: 'from-image' });
        const k = ob.width / cut.width; // Original may be bigger than the (downscaled) cutout.
        let w = ix.w * k, h = ix.h * k;
        const fit = Math.min(1, Math.sqrt(16_000_000 / (w * h)));
        w = Math.max(1, Math.round(w * fit));
        h = Math.max(1, Math.round(h * fit));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')!.drawImage(ob, ix.x * k, ix.y * k, ix.w * k, ix.h * k, 0, 0, w, h);
        ob.close();
        const keepAlpha = /png|webp|gif/.test(doc.original.type);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, keepAlpha ? 'image/png' : 'image/jpeg', 0.95));
        if (blob) {
          source = blob;
          pendingRedo = { ix };
        }
      } catch (err) {
        console.warn('[cutly] crop for redo failed, re-running on the whole image', err);
      }
    }
  }
  process(source);
}

// --- Views ---------------------------------------------------------------------

function enterWork() {
  drop.hidden = true;
  samples.hidden = true;
  work.hidden = false;
  work.focus({ preventScroll: true });
  const top = work.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight * 0.6) {
    work.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
}

function showDone(status: string) {
  work.dataset.state = 'done';
  setProgress(null);
  setStatus(status);
  editor.hidden = false;
  toggle.hidden = !doc.original;
  redoBtn.disabled = !doc.original;
  $('redo-label').textContent = doc.removed ? 'Redo removal' : 'Remove background';
  redoBtn.title = !doc.original
    ? 'Not available: the original photo wasn’t saved for this image.'
    : doc.removed
      ? 'Run background removal again. After cropping, it only looks at the cropped area, which often gives finer edges.'
      : 'Cut out the main subject with AI. The first time downloads a ~100 MB model.';
  retryBtn.hidden = true;
  downloadBtn.hidden = false;
  view = 'result';
  selectTab(tab); // Editor is visible now, so the tab strip can scroll.
  syncControls();
  render();
  downloadBtn.focus({ preventScroll: true });
}

function showError(text: string) {
  store.del(GPU_PENDING);
  work.dataset.state = 'error';
  setProgress(null);
  setStatus(text);
  retryBtn.hidden = !jobSource;
  downloadBtn.hidden = downloadJpgBtn.hidden = true;
  toggle.hidden = true;
  editor.hidden = true;
}

const PREVIEW_MAX = Math.min(2000, Math.round(1100 * Math.min(2, devicePixelRatio || 1)));

/** Redraw the stage for the current view/tab/edits. */
function render() {
  const cut = doc.cut;
  for (const b of toggle.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  if (!cut || view === 'original') {
    preview.hidden = false;
    preview.src = originalUrl;
    preview.alt = 'Original image';
    canvasWrap.hidden = true;
    return;
  }
  preview.hidden = true;
  preview.removeAttribute('src');
  canvasWrap.hidden = false;
  const e = doc.edits;
  canvasWrap.classList.toggle('opaque', isOpaque(e)); // Checkerboard shows through transparent corners.

  if (tab === 'crop') {
    cropView ??= union({ x: 0, y: 0, w: cut.width, h: cut.height }, cropOf(cut, e));
    renderTo(canvas, srcOf(), { bg: e.bg, crop: cropView, width: null }, PREVIEW_MAX, { noCorners: true });
    cropBox.aspect = aspect;
    cropBox.set(cropView, cropOf(cut, e));
    cropBox.el.hidden = false;
    canvasWrap.classList.add('cropping');
  } else {
    renderTo(canvas, srcOf(), e, PREVIEW_MAX);
    cropBox.el.hidden = true;
    canvasWrap.classList.remove('cropping');
  }
  updateOutputInfo();
}

function updateOutputInfo() {
  if (!doc.cut) return;
  const out = outputSize(doc.cut, doc.edits);
  outSizeEl.hidden = false;
  const notes = [!doc.edits.bg && 'transparent', doc.edits.radius && 'rounded corners'].filter(Boolean);
  outSizeEl.textContent = `Download size: ${out.width} × ${out.height} px${notes.length ? `, ${notes.join(', ')}` : ''}`;
  if (document.activeElement !== sizeW) sizeW.value = String(out.width);
  if (document.activeElement !== sizeH) sizeH.value = String(out.height);
  downloadJpgBtn.hidden = !doc.edits.bg;
  editsResetBtn.disabled = isDefault(doc.edits);
}

/** Reflect the edit state in the editor controls. */
function syncControls() {
  const bg = doc.edits.bg ?? '';
  let matched = false;
  for (const b of editor.querySelectorAll<HTMLButtonElement>('[data-bg]')) {
    const on = b.dataset.bg === bg;
    matched ||= on;
    b.setAttribute('aria-checked', String(on));
  }
  const custom = bgCustom.closest('.sw-custom')!;
  custom.classList.toggle('checked', !matched);
  if (!matched && bg) bgCustom.value = bg;
  if (document.activeElement !== bgHex) bgHex.value = bg && bg !== PHOTO_BG ? bg.toUpperCase() : bgCustom.value.toUpperCase();
  bgHex.removeAttribute('aria-invalid');
  photoSwatch.disabled = !doc.original;
  photoSwatch.title = doc.original ? 'Original background' : 'Not available: the original photo wasn’t saved for this image.';
  for (const b of editor.querySelectorAll<HTMLButtonElement>('[data-square]')) b.setAttribute('aria-checked', String(b.dataset.square === squareMode));
  const radius = doc.edits.radius ?? 0;
  radiusInput.value = String(radius);
  radiusOut.textContent = `${radius}%`;
  for (const b of editor.querySelectorAll<HTMLButtonElement>('[data-radius]')) b.setAttribute('aria-pressed', String(Number(b.dataset.radius) === radius));
  squareMarginOut.textContent = `${squareMargin.value}%`;
  for (const b of editor.querySelectorAll<HTMLButtonElement>('[data-aspect]')) {
    b.setAttribute('aria-checked', String(aspectValue(b.dataset.aspect!) === aspect && (b.dataset.aspect !== 'original' || aspect !== null)));
  }
  // "Original" and a numeric chip could both match; prefer the explicit one.
  const checked = editor.querySelectorAll('[data-aspect][aria-checked="true"]');
  if (checked.length > 1) checked.forEach((c, i) => i > 0 && c.setAttribute('aria-checked', 'false'));
  if (!checked.length) editor.querySelector('[data-aspect="free"]')!.setAttribute('aria-checked', 'true');
}

function aspectValue(key: string): number | null {
  if (key === 'free') return null;
  if (key === 'original') return doc.cut ? doc.cut.width / doc.cut.height : null;
  return Number(key);
}

function selectTab(next: typeof tab, scroll = true) {
  tab = next;
  for (const t of editor.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const on = t.id === `tab-${next}`;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    // Scroll only the tab strip (never the page) so the selected tab is visible on phones.
    if (on && scroll) {
      const list = t.parentElement!;
      list.scrollTo({ left: t.offsetLeft - (list.clientWidth - t.offsetWidth) / 2 });
    }
    $(t.getAttribute('aria-controls')!).hidden = !on;
  }
}
selectTab(tab, false); // Square/corners pages open on their own tab.

function setTab(next: typeof tab) {
  selectTab(next);
  cropView = null;
  if (view === 'original') view = 'result';
  render();
}

/** Apply an edit, redraw, and save it to history shortly after. */
function edit(patch: Partial<Edits>, opts: { resetView?: boolean } = {}) {
  doc.edits = { ...doc.edits, ...patch };
  if (opts.resetView) cropView = null;
  syncControls();
  render();
  scheduleSave();
}

// --- Crop ----------------------------------------------------------------------

const cropBox = new CropBox(canvasWrap, (r, done) => {
  if (!doc.cut) return;
  const full = r.x === 0 && r.y === 0 && r.w === doc.cut.width && r.h === doc.cut.height;
  doc.edits = { ...doc.edits, crop: full ? null : r };
  if (done) {
    updateOutputInfo();
    scheduleSave();
  }
});
cropBox.el.hidden = true;

editor.querySelector('[aria-label="Aspect ratio"]')!.addEventListener('click', (e) => {
  const key = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-aspect]')?.dataset.aspect;
  if (!key || !doc.cut) return;
  aspect = aspectValue(key);
  squareMode = null;
  const crop = aspect ? roundToAspect(fitAspectInside(cropOf(doc.cut, doc.edits), aspect), aspect) : doc.edits.crop;
  edit({ crop }, { resetView: true });
});

$('crop-fit').addEventListener('click', () => {
  if (!doc.cut) return;
  const crop = subjectCrop(doc.cut, aspect);
  if (!crop) return setStatus('No subject found to fit to.');
  squareMode = null;
  edit({ crop }, { resetView: true });
});

$('crop-clear').addEventListener('click', () => {
  aspect = null;
  squareMode = null;
  edit({ crop: null }, { resetView: true });
});

// --- Background ----------------------------------------------------------------

editor.querySelector('[aria-label="Background color"]')!.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-bg]');
  if (!b || b.disabled) return;
  const bg = b.dataset.bg || null;
  if (bg === PHOTO_BG && !(await ensurePhoto())) return setStatus('The original photo couldn’t be loaded.');
  edit({ bg });
});
bgCustom.addEventListener('input', () => edit({ bg: bgCustom.value }));
bgCustom.addEventListener('click', () => edit({ bg: bgCustom.value }));

// Hex input: accepts "#3a49d9", "3a49d9" or the short "#fff" form.
function parseHex(v: string): string | null {
  const m = v.trim().replace(/^#/, '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}
bgHex.addEventListener('input', () => {
  const hex = parseHex(bgHex.value);
  if (hex) {
    bgCustom.value = hex;
    edit({ bg: hex });
  }
});
bgHex.addEventListener('change', () => {
  const hex = parseHex(bgHex.value);
  if (hex) bgHex.value = hex.toUpperCase();
  else bgHex.setAttribute('aria-invalid', 'true');
});
bgHex.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') bgHex.blur();
});

// --- Square --------------------------------------------------------------------

function applySquare() {
  if (!doc.cut || !squareMode) return;
  const crop = squareCrop(doc.cut, squareMode, Number(squareMargin.value) / 100);
  if (!crop) return setStatus('No subject found. Try “Whole image”.');
  aspect = 1;
  edit({ crop }, { resetView: true });
}
editor.querySelector('[aria-label="Square mode"]')!.addEventListener('click', (e) => {
  const mode = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-square]')?.dataset.square;
  if (mode !== 'image' && mode !== 'subject') return;
  squareMode = mode;
  applySquare();
});
squareMargin.addEventListener('input', () => {
  squareMarginOut.textContent = `${squareMargin.value}%`;
  applySquare();
});

// --- Corners -------------------------------------------------------------------

radiusInput.addEventListener('input', () => edit({ radius: Number(radiusInput.value) }));
$('panel-corners').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-radius]');
  if (b) edit({ radius: Number(b.dataset.radius) });
});

// --- Resize --------------------------------------------------------------------

function setWidth(w: number | null) {
  if (!doc.cut) return;
  const c = cropOf(doc.cut, doc.edits);
  if (w !== null) w = Math.round(Math.min(Math.max(1, w), MAX_OUTPUT_SIDE));
  edit({ width: w === null || w === Math.round(c.w) ? null : w });
}

sizeW.addEventListener('change', () => setWidth(Number(sizeW.value) || null));
sizeH.addEventListener('change', () => {
  if (!doc.cut) return;
  const c = cropOf(doc.cut, doc.edits);
  const h = Number(sizeH.value);
  if (h > 0) setWidth((h * c.w) / c.h);
});
$('panel-size').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-scale],[data-long]');
  if (!b || !doc.cut) return;
  const c = cropOf(doc.cut, doc.edits);
  if (b.dataset.scale) setWidth(Number(b.dataset.scale) === 1 ? null : c.w * Number(b.dataset.scale));
  else {
    const long = Number(b.dataset.long);
    setWidth(c.w >= c.h ? long : (long * c.w) / c.h);
  }
});

// --- Tabs, toggle, misc --------------------------------------------------------

const tabs = [...editor.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
editor.querySelector('[role="tablist"]')!.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
  if (t) setTab(t.id.replace('tab-', '') as typeof tab);
});
editor.querySelector('[role="tablist"]')!.addEventListener('keydown', (e) => {
  const ke = e as KeyboardEvent;
  if (ke.key !== 'ArrowLeft' && ke.key !== 'ArrowRight') return;
  const i = tabs.findIndex((t) => t.id === `tab-${tab}`);
  const next = tabs[(i + (ke.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  setTab(next.id.replace('tab-', '') as typeof tab);
});

toggle.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest('button')?.dataset.view;
  if (v === 'result' || v === 'original') {
    view = v;
    render();
  }
});

editsResetBtn.addEventListener('click', () => {
  aspect = null;
  squareMode = null;
  bgCustom.value = '#a3d8ff';
  edit({ ...DEFAULT_EDITS }, { resetView: true });
});
redoBtn.addEventListener('click', () => void redo());

// --- Downloads -----------------------------------------------------------------

function fileName(name: string, e: Edits | undefined, ext: 'png' | 'jpg', removed = true) {
  const suffix = removed && !e?.bg ? 'no-background' : TOOL === 'square' ? 'square' : TOOL === 'corners' ? 'rounded' : 'edited';
  return `${name}-${suffix}.${ext}`;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function download(type: 'image/png' | 'image/jpeg', btn: HTMLButtonElement) {
  if (!doc.cut || !doc.png) return;
  const ext = type === 'image/png' ? 'png' : 'jpg';
  btn.disabled = true;
  try {
    // Unedited PNG: hand over the exact model output without re-encoding.
    const exact = isDefault(doc.edits) && type === 'image/png' && doc.png.type === 'image/png';
    const blob = exact ? doc.png : await exportImage(srcOf(), doc.edits, type);
    saveBlob(blob, fileName(doc.name, doc.edits, ext, doc.removed));
  } catch (err) {
    console.error(err);
    setStatus('The download couldn’t be created. Try a smaller size.');
  } finally {
    btn.disabled = false;
  }
}
downloadBtn.addEventListener('click', () => void download('image/png', downloadBtn));
downloadJpgBtn.addEventListener('click', () => void download('image/jpeg', downloadJpgBtn));

// --- History -------------------------------------------------------------------

let thumbUrls: string[] = [];
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// Items saved by older versions stored the full download name.
const itemBase = (item: HistoryItem) => item.name.replace(/-no-background\.png$/, '');

async function makeThumb(src: { cut: ImageBitmap; photo: ImageBitmap | null }, e: Edits): Promise<Blob> {
  const c = document.createElement('canvas');
  renderTo(c, src, e, 320);
  // WebP keeps transparency and is small; Safari can't encode it and returns PNG instead.
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.85));
  if (!blob) throw new Error('thumb');
  return blob;
}

const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Save the current doc: create a history item for new results, otherwise update it. */
async function saveToHistory(full: boolean) {
  const d = doc; // Snapshot: "New image" may replace `doc` while we await.
  const { cut, png } = d;
  if (!cut || !png) return;
  try {
    const thumb = await makeThumb({ cut, photo: d.photo }, d.edits); // Draws synchronously before awaiting.
    if (!d.historyId) {
      d.historyId = newId();
      await addHistory({
        id: d.historyId,
        name: d.name,
        createdAt: Date.now(),
        width: cut.width,
        height: cut.height,
        png,
        thumb,
        original: d.original ?? undefined,
        edits: d.edits,
        removed: d.removed,
      });
    } else if (full) {
      await updateHistory(d.historyId, { png, thumb, width: cut.width, height: cut.height, original: d.original ?? undefined, edits: d.edits, removed: d.removed });
    } else {
      await updateHistory(d.historyId, { thumb, edits: d.edits });
    }
    await renderHistory();
  } catch (err) {
    console.warn('[cutly] history save failed', err);
  }
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveToHistory(false), 500);
}

async function openFromHistory(item: HistoryItem) {
  jobId++; // Ignore any in-flight job.
  store.del(GPU_PENDING);
  pendingRedo = null;
  jobSource = null;
  freeCut();
  const cut = await createImageBitmap(item.png);
  doc = { historyId: item.id, name: itemBase(item), original: item.original ?? null, png: item.png, cut, photo: null, edits: { ...DEFAULT_EDITS, ...item.edits }, removed: item.removed ?? true };
  aspect = null;
  squareMode = null;
  cropView = null;
  if (doc.edits.bg === PHOTO_BG && !(await ensurePhoto())) doc.edits.bg = null;
  setOriginal(doc.original);
  enterWork();
  showDone(`From your history · ${dateFmt.format(item.createdAt)}`);
}

function icon(path: string) {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
const ICON_DOWNLOAD = icon('<path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16" />');
const ICON_DELETE = icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />');

async function downloadFromHistory(item: HistoryItem) {
  const e: Edits = { ...DEFAULT_EDITS, ...item.edits };
  const removed = item.removed ?? true;
  if (isDefault(e) && item.png.type === 'image/png') return saveBlob(item.png, fileName(itemBase(item), e, 'png', removed));
  const cut = await createImageBitmap(item.png);
  const photo = e.bg === PHOTO_BG && item.original ? await decodePhoto(item.original, cut).catch(() => null) : null;
  try {
    saveBlob(await exportImage({ cut, photo }, e, 'image/png'), fileName(itemBase(item), e, 'png', removed));
  } finally {
    cut.close();
    photo?.close();
  }
}

async function renderHistory() {
  const items = await listHistory();
  for (const u of thumbUrls) URL.revokeObjectURL(u);
  thumbUrls = [];
  historyList.replaceChildren();
  historySection.hidden = items.length === 0;

  for (const item of items) {
    const thumbUrl = URL.createObjectURL(item.thumb);
    thumbUrls.push(thumbUrl);
    const when = dateFmt.format(item.createdAt);
    const base = itemBase(item);
    const label = `${base}, ${when}`;
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <button type="button" class="history-thumb" data-act="open">
        <img src="${thumbUrl}" alt="" width="160" height="120" loading="lazy" decoding="async" />
      </button>
      <div class="history-meta">
        <span class="history-name"></span>
        <span class="history-when"></span>
      </div>
      <div class="history-actions">
        <button type="button" class="dl-btn" data-act="download">${ICON_DOWNLOAD}<span aria-hidden="true">Download</span><span class="sr-only"></span></button>
        <button type="button" class="icon-btn" data-act="delete" title="Delete">${ICON_DELETE}<span class="sr-only"></span></button>
      </div>`;
    li.querySelector('.history-thumb')!.setAttribute('aria-label', `Open ${label}`);
    li.querySelector('.history-name')!.textContent = base;
    const whenEl = li.querySelector('.history-when')!;
    whenEl.textContent = shortDateFmt.format(item.createdAt);
    whenEl.setAttribute('title', `${when} · ${item.width}×${item.height} px`);
    li.querySelector('[data-act=download] .sr-only')!.textContent = `Download ${label}`;
    li.querySelector('[data-act=delete] .sr-only')!.textContent = `Delete ${label}`;
    li.addEventListener('click', async (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.act;
      if (act === 'open') await openFromHistory(item);
      else if (act === 'download') await downloadFromHistory(item);
      else if (act === 'delete') {
        await deleteHistory(item.id);
        if (doc.historyId === item.id) doc.historyId = null;
        await renderHistory();
        (historyList.querySelector('button') ?? pickBtn).focus();
      }
    });
    historyList.append(li);
  }
}

historyClear.addEventListener('click', async () => {
  if (!confirm('Delete all saved images from this device? This can’t be undone.')) return;
  await clearHistory();
  doc.historyId = null;
  await renderHistory();
  pickBtn.focus();
});

void renderHistory();

// --- New image / reset ---------------------------------------------------------

function reset() {
  store.del(GPU_PENDING);
  clearTimeout(saveTimer);
  if (doc.historyId && doc.cut) void saveToHistory(false); // Flush pending edits.
  jobId++; // Ignore any in-flight result.
  pendingRedo = null;
  jobSource = null;
  freeCut();
  setOriginal(null);
  doc = { historyId: null, name: 'image', original: null, png: null, cut: null, photo: null, edits: { ...DEFAULT_EDITS }, removed: false };
  preview.removeAttribute('src');
  work.hidden = true;
  drop.hidden = false;
  samples.hidden = false;
  fileInput.value = '';
  pickBtn.focus();
}

// --- Input methods -------------------------------------------------------------

pickBtn.addEventListener('click', () => {
  warmup();
  fileInput.click();
});
drop.addEventListener('click', (e) => {
  if (e.target === drop) {
    warmup();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) start(f);
});

// Pre-load the model on intent, but only on the homepage: the other tools don't need it.
if (AI_FIRST) for (const ev of ['pointerenter', 'focusin', 'touchstart'] as const) {
  drop.addEventListener(ev, warmup, { once: true, passive: true });
  samples.addEventListener(ev, warmup, { once: true, passive: true });
}

samples.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-sample]');
  if (!btn) return;
  warmup();
  const url = btn.dataset.sample!;
  const res = await fetch(url);
  const blob = await res.blob();
  start(new File([blob], url.split('/').pop()!, { type: blob.type || 'image/jpeg' }));
});

// Drag and drop anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', (e: DragEvent) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  warmup();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e: DragEvent) => e.preventDefault());
window.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/')) ?? e.dataTransfer?.files[0];
  if (f) start(f);
});

// Paste (Ctrl/Cmd+V) anywhere, except into form fields.
window.addEventListener('paste', (e: ClipboardEvent) => {
  if ((e.target as HTMLElement).closest?.('input, textarea')) return;
  const items = [...(e.clipboardData?.items ?? [])];
  const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  const f = item?.getAsFile();
  if (f) {
    e.preventDefault();
    start(f);
  }
});

// Explicit paste button for touch devices / browsers with the async clipboard API.
if (navigator.clipboard && 'read' in navigator.clipboard && matchMedia('(pointer: coarse)').matches) {
  pasteBtn.hidden = false;
}
pasteBtn.addEventListener('click', async () => {
  warmup();
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return start(new File([await item.getType(type)], 'pasted.png', { type }));
    }
    alert('There’s no image on your clipboard. Copy an image first, then try again.');
  } catch {
    alert('Clipboard access was blocked. Use “Upload image” instead.');
  }
});

if (/Mac|iPhone|iPad/.test(navigator.platform)) {
  document.querySelectorAll('kbd').forEach((k) => k.textContent === 'Ctrl' && (k.textContent = '⌘'));
}

resetBtn.addEventListener('click', reset);
retryBtn.addEventListener('click', () => {
  if (!jobSource) return;
  if (doc.cut || pendingRedo) process(jobSource);
  else start(jobSource);
});

// Keep the preview sharp after big layout changes (rotation, window resize).
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => work.dataset.state === 'done' && render(), 200);
});

// Release the worker (and its GPU device) when leaving the page. Some WebKit builds
// crash when a page with an active WebGPU worker unloads. On back/forward cache
// restore a fresh worker is created on demand.
window.addEventListener('pagehide', () => {
  store.del(GPU_PENDING); // Normal navigation away is not a crash.
  worker?.postMessage({ type: 'dispose' } satisfies ToWorker);
  worker = null;
  modelReady = false;
  warmedUp = false;
});

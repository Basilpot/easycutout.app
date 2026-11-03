/// <reference lib="webworker" />
// Runs entirely in the user's browser: decode → ISNet segmentation → alpha mask → PNG.
// Nothing is sent to a server.

import assets from './generated/assets.json';
import { loadAsset, pruneCache } from './loader';
import type { Backend, ErrorCode, FromWorker, ToWorker } from './protocol';

type Ort = typeof import('onnxruntime-web');
type Session = import('onnxruntime-web').InferenceSession;

// Two flavours of this worker. "quick": small U²-Net-P (4.6 MB) on the CPU backend, so a first
// cut-out appears after a ~19 MB download. Otherwise: IS-Net at 1024², WebGPU when available.
const QUICK = self.name === 'quick';
const SIZE = QUICK ? 320 : 1024; // Model input resolution.
// iOS Safari refuses canvases above ~16.7 MP; also keeps memory sane on phones.
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 4096;
const MAX_FILE_BYTES = 40 * 1024 * 1024;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

class AppError extends Error {
  constructor(public code: ErrorCode, detail?: string) {
    super(detail ?? code);
  }
}

let ready: Promise<{ ort: Ort; session: Session; backend: Backend }> | null = null;

async function webgpuAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function init() {
  if (typeof OffscreenCanvas === 'undefined' || typeof WebAssembly === 'undefined') {
    throw new AppError('unsupported');
  }
  const useGpu = !QUICK && ctx.name !== 'wasm' && (await webgpuAvailable());
  const wasmAsset = useGpu ? assets.wasmWebgpu : assets.wasmCpu;
  void pruneCache([...assets.model.parts, ...assets.quick.parts, ...assets.wasmWebgpu.parts, ...assets.wasmCpu.parts]);

  const modelAsset = QUICK ? assets.quick : assets.model;
  const total = modelAsset.size + wasmAsset.size;
  let loaded = 0;
  let lastPost = 0;
  const onBytes = (n: number) => {
    loaded += n;
    const now = performance.now();
    if (now - lastPost > 100 || loaded >= total) {
      lastPost = now;
      post({ type: 'download', loaded, total });
    }
  };

  let ort: Ort;
  let model: Uint8Array;
  let wasmBinary: Uint8Array;
  try {
    [ort, model, wasmBinary] = await Promise.all([
      useGpu ? import('onnxruntime-web/webgpu') : import('onnxruntime-web/wasm'),
      loadAsset(modelAsset, onBytes),
      loadAsset(wasmAsset, onBytes),
    ]);
  } catch (err) {
    throw new AppError('model-download', String(err));
  }

  ort.env.wasm.wasmBinary = wasmBinary;
  // Multi-threading needs cross-origin isolation (COOP/COEP headers). Without it we run single-threaded.
  const threads = ctx.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.wasm.numThreads = threads;

  const create = (ep: Backend) =>
    ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all' });

  let session: Session | null = null;
  let backend: Backend = 'wasm';
  if (useGpu) {
    try {
      session = await create('webgpu');
      backend = 'webgpu';
    } catch (err) {
      console.warn('WebGPU unavailable, falling back to WASM', err);
    }
  }
  try {
    session ??= await create('wasm');
  } catch (err) {
    throw new AppError('model-init', String(err));
  }
  // The runtime is compiled now; drop our copy of the bytes to save memory on phones.
  ort.env.wasm.wasmBinary = undefined;
  post({ type: 'ready', backend, threads: backend === 'wasm' ? threads : 0 });
  return { ort, session, backend };
}

function getReady() {
  ready ??= init().catch((err) => {
    ready = null; // Allow a retry.
    throw err;
  });
  return ready;
}

/** Decode with EXIF orientation applied, and shrink oversized images right away to free memory. */
async function decode(file: Blob): Promise<{ bitmap: ImageBitmap; downscaled: boolean }> {
  if (file.size > MAX_FILE_BYTES) throw new AppError('too-large');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new AppError('decode');
  }
  const { width, height, downscaled } = fitSize(bitmap.width, bitmap.height);
  if (!downscaled) return { bitmap, downscaled };
  try {
    const small = await createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    return { bitmap: small, downscaled };
  } catch {
    throw new AppError('too-large');
  } finally {
    bitmap.close();
  }
}

function fitSize(w: number, h: number) {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), downscaled: scale < 1 };
}

function toTensorData(bitmap: ImageBitmap): Float32Array {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const { data } = g.getImageData(0, 0, SIZE, SIZE);
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  // CHW layout. IS-Net: x / 255 - 0.5. U²-Net-P: ImageNet mean/std.
  const mean = QUICK ? [0.485, 0.456, 0.406] : [0.5, 0.5, 0.5];
  const std = QUICK ? [0.229, 0.224, 0.225] : [1, 1, 1];
  for (let i = 0, p = 0; p < plane; i += 4, p++) {
    out[p] = (data[i] / 255 - mean[0]) / std[0];
    out[p + plane] = (data[i + 1] / 255 - mean[1]) / std[1];
    out[p + 2 * plane] = (data[i + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

/** Min-max normalise the raw prediction into a 1024² alpha mask canvas. */
function maskCanvas(pred: Float32Array): OffscreenCanvas {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pred.length; i++) {
    const v = pred[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new AppError('inference', 'non-finite output');
  const range = max - min || 1;
  const img = new ImageData(SIZE, SIZE);
  const d = img.data;
  for (let p = 0, i = 3; p < pred.length; p++, i += 4) {
    let v = (pred[p] - min) / range;
    // The 320² model gives soft, haloed edges after upscaling: tighten them a little.
    if (QUICK) v = v <= 0.2 ? 0 : v >= 0.8 ? 1 : ((v - 0.2) / 0.6) ** 2 * (3 - (2 * (v - 0.2)) / 0.6);
    d[i] = v * 255;
  }
  const c = new OffscreenCanvas(SIZE, SIZE);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

async function processImage(id: number, file: Blob) {
  const start = performance.now();
  post({ type: 'stage', id, stage: 'decoding' });
  const { bitmap, downscaled } = await decode(file);
  const { session, ort } = await getReady();
  const { width, height } = bitmap;

  post({ type: 'stage', id, stage: 'inferring' });
  let pred: Float32Array;
  try {
    const input = new ort.Tensor('float32', toTensorData(bitmap), [1, 3, SIZE, SIZE]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const t = out[session.outputNames[0]];
    pred = (await t.getData()) as Float32Array;
    input.dispose();
    t.dispose();
  } catch (err) {
    throw err instanceof AppError ? err : new AppError('inference', String(err));
  }

  post({ type: 'stage', id, stage: 'compositing' });
  const mask = maskCanvas(pred);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  if (!g) throw new AppError('too-large');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, width, height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(mask, 0, 0, width, height); // Upscale the mask and keep pixels where it's opaque.
  bitmap.close();
  const png = await canvas.convertToBlob({ type: 'image/png' });
  post({ type: 'result', id, png, width, height, ms: Math.round(performance.now() - start), downscaled });
}

/** Free the session and GPU device synchronously-ish before the page goes away. */
function dispose() {
  const r = ready;
  ready = null;
  void r?.then(async ({ ort, session, backend }) => {
    await session.release().catch(() => {});
    if (backend === 'webgpu') {
      const device = (await ort.env.webgpu.device) as { destroy?: () => void } | undefined;
      device?.destroy?.();
    }
    ctx.close();
  });
}

ctx.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === 'dispose') return dispose();
    if (msg.type === 'warmup') await getReady();
    else if (msg.type === 'process') await processImage(msg.id, msg.file);
  } catch (err) {
    const id = msg.type === 'process' ? msg.id : undefined;
    if (err instanceof AppError) post({ type: 'error', id, code: err.code, detail: err.message });
    else post({ type: 'error', id, code: 'inference', detail: String(err) });
  }
};

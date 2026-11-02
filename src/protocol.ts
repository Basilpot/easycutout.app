// Messages exchanged between the page and the inference worker.

export type ToWorker =
  | { type: 'warmup' }
  | { type: 'process'; id: number; file: Blob }
  | { type: 'dispose' };

export type Backend = 'webgpu' | 'wasm';

export type FromWorker =
  | { type: 'download'; loaded: number; total: number }
  | { type: 'ready'; backend: Backend; threads: number }
  | { type: 'stage'; id: number; stage: 'decoding' | 'inferring' | 'compositing' }
  | { type: 'result'; id: number; png: Blob; width: number; height: number; ms: number; downscaled: boolean }
  | { type: 'error'; id?: number; code: ErrorCode; detail?: string };

export type ErrorCode = 'decode' | 'too-large' | 'model-download' | 'model-init' | 'inference' | 'unsupported';

// Splits large binaries (the ONNX model and the onnxruntime-web WASM files) into
// chunks below the 25 MiB per-file limit of Cloudflare Workers static assets,
// writes them to public/m/ with content-hashed names, and generates
// src/generated/assets.json for the inference worker.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ortPkg = join(root, 'node_modules/onnxruntime-web');
const ortDist = join(ortPkg, 'dist');
const ortVersion = JSON.parse(readFileSync(join(ortPkg, 'package.json'), 'utf8')).version;

const CHUNK = 20 * 1024 * 1024; // 20 MiB, well under the 25 MiB cap
const outDir = join(root, 'public/m');
const modelPath = join(root, 'models-src/isnet-fp16.onnx');

if (!existsSync(modelPath)) {
  console.error(`Missing ${modelPath}. Run scripts/convert_model.py first (see README).`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Extension only affects Content-Type: .wasm parts get compressed by Cloudflare's edge.
function emit(name, file, ext = 'bin') {
  const buf = readFileSync(file);
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const parts = [];
  for (let i = 0, n = 0; i < buf.length; i += CHUNK, n++) {
    const part = `${name}.${hash}.${n}.${ext}`;
    writeFileSync(join(outDir, part), buf.subarray(i, i + CHUNK));
    parts.push(`/m/${part}`);
  }
  console.log(`${name}: ${(buf.length / 1048576).toFixed(1)} MiB -> ${parts.length} part(s)`);
  return { size: buf.length, chunkSize: CHUNK, parts };
}

const assets = {
  ortVersion,
  model: emit('isnet-fp16', modelPath),
  // Used with the WebGPU build of onnxruntime-web (also runs the WASM backend).
  wasmWebgpu: emit('ort-asyncify', join(ortDist, 'ort-wasm-simd-threaded.asyncify.wasm'), 'wasm'),
  // Smaller CPU-only build for browsers without WebGPU.
  wasmCpu: emit('ort-cpu', join(ortDist, 'ort-wasm-simd-threaded.wasm'), 'wasm'),
};

mkdirSync(join(root, 'src/generated'), { recursive: true });
writeFileSync(join(root, 'src/generated/assets.json'), JSON.stringify(assets, null, 2) + '\n');
console.log('Files in public/m:', readdirSync(outDir).length);

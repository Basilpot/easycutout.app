// Downloads a chunked binary asset, reporting progress, and keeps the chunks in
// Cache Storage so repeat visits load instantly (and offline).
// Chunk URLs contain a content hash, so a cached chunk never goes stale.

export interface ChunkedAsset {
  size: number;
  chunkSize: number;
  parts: string[];
}

const CACHE_NAME = 'bgr-assets-v1';

async function openCache(): Promise<Cache | null> {
  try {
    return (await caches?.open(CACHE_NAME)) ?? null;
  } catch {
    return null; // Private mode, blocked storage, or insecure context.
  }
}

/** Remove chunks from older deployments so they don't pile up on users' devices. */
export async function pruneCache(keep: string[]): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  try {
    const wanted = new Set(keep.map((p) => new URL(p, self.location.origin).href));
    for (const req of await cache.keys()) {
      if (!wanted.has(req.url)) await cache.delete(req);
    }
  } catch {
    /* best effort */
  }
}

/** Download one part straight into its slice of the output buffer (no extra copies). */
async function fetchPart(url: string, out: Uint8Array, cache: Cache | null, onBytes: (n: number) => void): Promise<void> {
  const cached = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (cached) {
    const buf = new Uint8Array(await cached.arrayBuffer());
    if (buf.byteLength === out.byteLength) {
      out.set(buf);
      onBytes(buf.byteLength);
      return;
    }
    await cache?.delete(url).catch(() => {}); // Corrupt entry: refetch.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let received = 0;
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > out.byteLength) throw new Error(`Unexpected size for ${url}`);
        out.set(value, received);
        received += value.byteLength;
        onBytes(value.byteLength);
      }
      if (received !== out.byteLength) throw new Error(`Truncated download for ${url}`);
      if (cache) {
        // Response needs its own copy; quota errors etc. just skip caching.
        cache.put(url, new Response(out.slice(), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
      }
      return;
    } catch (err) {
      lastError = err;
      onBytes(-received); // Roll back progress for the failed attempt.
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Fetch every part in parallel into one preallocated buffer. */
export async function loadAsset(asset: ChunkedAsset, onBytes: (n: number) => void): Promise<Uint8Array> {
  const cache = await openCache();
  const out = new Uint8Array(asset.size);
  await Promise.all(
    asset.parts.map((p, i) => {
      const start = i * asset.chunkSize;
      return fetchPart(p, out.subarray(start, Math.min(start + asset.chunkSize, asset.size)), cache, onBytes);
    }),
  );
  return out;
}

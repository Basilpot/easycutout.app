import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// onnxruntime-web references its .wasm files, so Vite copies them into dist/.
// We ship those binaries as hashed <25 MiB chunks in public/m/ (see scripts/prepare-model.mjs)
// and hand the bytes to ORT via env.wasm.wasmBinary, so the copies are dead weight —
// and the 26 MB one would exceed the Workers static-asset size limit.
// Tiny HTML include system so every page shares one header, footer and tool:
//   <!--#include name-->            → contents of src/partials/name.html
//   <!--#define x-->…<!--/define-->  → page-specific block, inserted at <!--#slot x--> in a partial
const htmlIncludes = (): Plugin => ({
  name: 'html-includes',
  transformIndexHtml: {
    order: 'pre',
    handler(html) {
      const defs = new Map<string, string>();
      html = html.replace(/[ \t]*<!--#define (\w+)-->\n?([\s\S]*?)[ \t]*<!--\/define-->\n?/g, (_, name, body) => {
        defs.set(name, body);
        return '';
      });
      html = html.replace(/<!--#include (\w+)-->/g, (_, name) => readFileSync(resolve(__dirname, `src/partials/${name}.html`), 'utf8'));
      return html.replace(/[ \t]*<!--#slot (\w+)-->\n?/g, (_, name) => defs.get(name) ?? '');
    },
  },
});

// sitemap.xml and robots.txt, built from VITE_SITE_URL so they always match the canonical links.
const PAGES = ['/', '/square-image-maker', '/round-corners', '/remove-bg-alternative', '/about', '/contact', '/privacy', '/terms'];
const seoFiles = (siteUrl: string): Plugin => ({
  name: 'seo-files',
  apply: 'build',
  generateBundle() {
    const urls = PAGES.map((p) => `  <url><loc>${siteUrl}${p === '/' ? '/' : p}</loc></url>`).join('\n');
    this.emitFile({
      type: 'asset',
      fileName: 'sitemap.xml',
      source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    });
    this.emitFile({
      type: 'asset',
      fileName: 'robots.txt',
      source: `User-agent: *\nAllow: /\nDisallow: /m/\n\nSitemap: ${siteUrl}/sitemap.xml\n`,
    });
  },
});

const dropOrtWasm = (): Plugin => ({
  name: 'drop-ort-wasm',
  apply: 'build',
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
  },
});

// Dev server sends the same isolation headers as production (public/_headers)
// so multi-threaded WASM behaves identically.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname);
  if (!env.VITE_SITE_URL || !env.VITE_CONTACT_EMAIL) throw new Error('Set VITE_SITE_URL and VITE_CONTACT_EMAIL in .env');
  return {
  server: { headers: isolation },
  preview: { headers: isolation },
  plugins: [htmlIncludes(), seoFiles(env.VITE_SITE_URL.replace(/\/$/, '')), dropOrtWasm()],
  worker: { format: 'es', plugins: () => [dropOrtWasm()] },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    target: 'es2022',
    // The ONNX Runtime JS glue is large-ish; it is lazy-loaded inside the worker.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        about: resolve(__dirname, 'about.html'),
        contact: resolve(__dirname, 'contact.html'),
        terms: resolve(__dirname, 'terms.html'),
        notFound: resolve(__dirname, '404.html'),
        compare: resolve(__dirname, 'remove-bg-alternative.html'),
        square: resolve(__dirname, 'square-image-maker.html'),
        corners: resolve(__dirname, 'round-corners.html'),
      },
    },
  },
  };
});

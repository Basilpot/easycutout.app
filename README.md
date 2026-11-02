# EasyCutout – free background remover

A single-page website that removes image backgrounds **entirely in the visitor's browser** and exports a transparent PNG. There's no sign-up and no server-side processing, and it costs nothing to run on Cloudflare's Free plan.

> Brand: **EasyCutout**, domain `easycutout.app`. The domain looked unregistered on 2026-10-31 (RDAP), but it is **not registered yet**. Register it before launch, or change the name (see [Before launch](#before-launch)).

## How it works

```
Browser                                                     Cloudflare (static files only)
───────                                                     ──────────────────────────────
index.html + 7 KB JS ────────────────────────────────────── Workers static assets
  │  user picks / drops / pastes an image                     (free, unlimited requests)
  ▼
Web Worker
  ├─ downloads model (86 MiB) + ONNX Runtime WASM ───────── /m/*.bin, /m/*.wasm  (hashed, ≤20 MiB chunks)
  │    → stored in Cache Storage, reused on later visits
  ├─ decode image (EXIF-rotated, capped at 16 MP)
  ├─ IS-Net @1024×1024 via onnxruntime-web
  │    WebGPU if available, else multi-threaded WASM
  ├─ upscale mask → apply as alpha at full resolution
  └─ PNG blob → preview + download link
                 └─ saved to "Your recent images" (IndexedDB, this device only)
```

- **Model:** [IS-Net general-use](https://github.com/xuebinqin/DIS) (Apache-2.0), using the ONNX export from rembg. It's converted to fp16 weights (86 MiB), and the extra side outputs are removed.
- **Runtime:** [onnxruntime-web](https://onnxruntime.ai/) 1.30.0 (MIT).
- **Hosting:** Workers static assets only. No Worker script runs, so the Workers request and CPU limits don't apply.
- **History:** the last 30 images (original photo, full cut-out PNG, edit settings and a thumbnail) are kept in IndexedDB on the visitor's device so they can be downloaded again later. They're stored as raw bytes, not Blobs, because WebKit's private-mode IndexedDB rejects Blobs. If storage is full, the oldest items are dropped. If IndexedDB is unavailable, history lasts only for the current session. Users can delete single items or clear everything.
- **Files over 25 MiB:** Workers static assets cap each file at 25 MiB. `scripts/prepare-model.mjs` splits the model and the ORT WASM binaries into hashed chunks of 20 MiB or less. The worker downloads them in parallel into one buffer and passes the bytes to ORT through `env.wasm.wasmBinary`.

### Why browser-side inference

| Option | Verdict |
| --- | --- |
| **Browser inference (chosen)** | $0 per image, images never leave the device, no server limits. The costs are a first-use download of ~100–112 MB, and speed that depends on the visitor's device. |
| Cloudflare Images `segment=foreground` (BiRefNet) | Good quality, but limited on the Free plan: 5,000 unique transformations per month, and after that new transformations fail with error 9422. Paid usage is $0.50 per 1,000. Images would also have to be uploaded and stored somewhere it can reach (for example R2), which hurts privacy and adds work. Worth keeping as an optional paid fallback later. |
| Running the model inside a Worker | Not possible. The Free plan allows 10 ms CPU per request and Workers have 128 MB memory, while the model alone is 86 MiB. |
| `@imgly/background-removal` | Uses the same IS-Net model, but the library is AGPL-3.0, which needs a commercial license or open-sourcing. We call ORT directly instead. |
| BRIA RMBG-1.4 / 2.0 | Their licenses don't allow commercial use without an agreement. |
| BiRefNet-lite (MIT) | Better edges, but heavier, and others have reported problems with its browser ONNX exports. A possible upgrade later. |
| int8-quantized IS-Net (46 MB) | Rejected. On one test image its mask overlapped the full-precision mask by only 29% (IoU 0.29). The fp16 version gave the same output as full precision on all 8 test images. |

## Run locally

Requires Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env   # required — vite refuses to start without VITE_SITE_URL / VITE_CONTACT_EMAIL
pnpm dev          # Vite dev server at http://localhost:5173
pnpm preview      # production build served by `wrangler dev` (real headers & asset limits)
pnpm test:e2e     # Playwright end-to-end tests (builds and serves via wrangler)
```

The model chunks in `public/m/` and `src/generated/assets.json` are committed, so a fresh checkout builds without Python.

### Regenerating the model chunks

You only need this to change the model or upgrade `onnxruntime-web`. The ORT WASM files are copied from `node_modules`, so you must run `prepare-model` after every ORT upgrade.

```bash
uv venv -p 3.12 .venv-tools && VIRTUAL_ENV=.venv-tools uv pip install onnx onnxconverter-common
.venv-tools/bin/python scripts/convert_model.py   # downloads + verifies + converts → models-src/isnet-fp16.onnx
pnpm prepare-model                                 # splits into public/m/, writes src/generated/assets.json
```

Chunk names include a content hash. Old chunks in visitors' caches are removed automatically.

## Site address and contact email

Both live in `.env`:

```
VITE_SITE_URL=https://easycutout.basilpot.com   # canonical links, Open Graph, sitemap.xml, robots.txt
VITE_CONTACT_EMAIL=hello@easycutout.app          # About / Privacy / Terms (must be a real inbox)
```

The site currently runs on **https://easycutout.basilpot.com**, set up as a Workers custom domain in `wrangler.jsonc`. Because a custom domain is set, the `workers.dev` address is off.

**Moving to the real domain later:** add it to the `routes` in `wrangler.jsonc`, set `VITE_SITE_URL` to it, and run `pnpm run deploy`. Keep the basilpot route for a while and add a redirect from it, so links and search rankings carry over (Cloudflare → basilpot.com → Rules → Redirect Rules: `easycutout.basilpot.com/*` → `https://<new domain>/${1}`, 301). Then add the new domain in Search Console.

## Deploy to Cloudflare

```bash
pnpm exec wrangler login     # once
pnpm run deploy              # = pnpm build && wrangler deploy (plain `pnpm deploy` is a pnpm built-in)
```

This publishes to `https://bg-remover.<your-subdomain>.workers.dev`. To use your own domain, add it under **Workers & Pages → bg-remover → Settings → Domains & Routes**, or add a `routes` entry in `wrangler.jsonc`. The domain must be on Cloudflare DNS.

For automatic deploys, connect the Git repo with **Workers Builds**. Build command `pnpm build`, deploy command `npx wrangler deploy`. Python isn't needed.

## Before launch

These need your decision, account or access:

1. **Domain.** Register `easycutout.app` (or change the name: search the HTML files, `public/robots.txt` and `public/sitemap.xml` for `EasyCutout` / `easycutout.app`). `.app` domains require HTTPS, which Cloudflare provides.
2. **Contact email.** Set up `hello@easycutout.app` (Cloudflare Email Routing can forward it for free) or change it. AdSense and users expect a working contact.
3. **Legal pages.** The privacy policy and terms are reasonable drafts, not legal advice. Have them reviewed for your jurisdiction.
4. **Social image.** Add a 1200×630 `public/og.png` and restore `og:image` and `twitter:card=summary_large_image`.
5. **Search Console.** After deploying, verify the domain and submit `sitemap.xml`.
6. **Test on real devices.** At least one iPhone (Safari) and one mid-range Android. See the known issues.

## Costs and limits (checked October 2026)

| Item | Free plan | Notes |
| --- | --- | --- |
| Workers static-asset requests | Free and unlimited | No Worker script runs, so the 100k requests/day limit doesn't apply. |
| Bandwidth | No egress charge | Each new visitor downloads ~100–112 MB once. It's cached in the browser after that. |
| Per-file limit | 25 MiB | Handled by chunking. The largest file is 20 MiB. |
| Files per deploy | 20,000 | We deploy ~30. |
| Image processing | $0 | Runs on the visitor's device. |
| Custom domain | ~$10/yr (registrar) | Optional; `workers.dev` is free. |

Cloudflare's terms say large files like video should be served through paid services or the Developer Platform rather than the plain CDN. Workers static assets are part of the Developer Platform. If traffic gets very large, contact Cloudflare. Nothing here bills automatically on the Free plan.

## Measured performance

Tested on an Apple-silicon Mac with a 1200×800 image after the model was loaded:

| Browser / backend | Time per image |
| --- | --- |
| Chrome, WebGPU | ~0.5 s |
| WebKit (Safari engine), WebGPU | ~0.75–1.0 s |
| Chromium, WASM, 4 threads | ~4.5–6.5 s |
| WebKit, WASM, 1 thread (crash-guard fallback) | ~8 s including model init |

The first image also waits for the model download. Speed on low-end phones was not measured, and slow phones running on the CPU could take tens of seconds.

## Known issues and limitations

- **Big first download.** ~112 MB on browsers with WebGPU, ~100 MB without. On slow mobile connections that takes minutes. The page shows a progress bar and saves the files for later. The download starts only when the user shows intent (hovering or tapping the upload area, or dragging a file) so visitors who just bounce don't pay for it.
- **WebKit WebGPU crash after reload.** In Playwright's WebKit, running the model, reloading the page and running it again crashes the tab. A fresh tab works. It's not verified on real Safari. Guard: if the tab dies mid-job, the next load uses the CPU backend for 7 days (`cutly.gpuBlockedAt` in localStorage). `?backend=wasm` forces the CPU backend for testing.
- **Firefox untested.** Playwright's Firefox wouldn't launch in this environment. It should work on the WASM path (and on WebGPU where Firefox supports it), but check by hand.
- **Safari is single-threaded on CPU.** We use `COEP: credentialless` to get multi-threaded WASM, and Safari doesn't support it. This only matters when WebGPU isn't available.
- **Ads and cross-origin isolation.** `public/_headers` sets `COOP: same-origin` and `COEP: credentialless`. Before adding AdSense, test that ads render. If they don't, remove those two headers. The only cost is slower CPU-only processing; WebGPU is unaffected.
- **Quality.** IS-Net handles people, pets and products well. Fine hair, glass, smoke and busy group photos give rough edges. It isn't remove.bg quality on hard cases. Upgrade paths: BiRefNet-lite in the browser, or Cloudflare Images `segment` as an optional server-side "HD" mode.
- **HEIC** only decodes in Safari. Other browsers show a friendly error.
- **Memory.** Images over 16 MP (or with a side over 4096 px) are scaled down before processing. Very old phones may still run out of memory, and the user sees an error.
- **History storage use.** A 16 MP result PNG can be 20–40 MB plus the original photo, so 30 large items can use several hundred MB of the visitor's browser storage. Browsers enforce their own quotas and may clear it under storage pressure. Lower `MAX_ITEMS` in `src/history.ts` if this becomes a problem.
- The model files live in Cache Storage, which browsers may clear when storage is low. The site then downloads them again.

## Pages

| Page | Search target | Behaviour |
| --- | --- | --- |
| `/` | free background remover, remove.bg alternative | Removes the background as soon as an image is added. |
| `/square-image-maker` | square image maker, make photo square without cropping | Opens the photo as-is (no AI download) as a white-padded square of the whole image. "Remove background" is optional. |
| `/round-corners` | round image corners, rounded corners, circle crop | Opens the photo as-is with medium rounded corners. "Remove background" is optional. |
| `/remove-bg-alternative` | remove.bg alternative | Comparison page (see below). |

All three tool pages share one editor and one history. The page's `<body data-tool>` sets the starting tab and defaults (`TOOL` in `src/main.ts`). On the square and corners pages the AI model is downloaded only when "Remove background" is pressed, so those pages are instant and light.

Pages share their header, footer and tool markup through a small include step in `vite.config.ts`: `<!--#include name-->` inserts `src/partials/name.html`, and a page can fill a partial's `<!--#slot x-->` with `<!--#define x-->…<!--/define-->`.

## Editor

After removal, the result can be edited without touching the cut-out itself (`src/editor.ts`):

- **Background:** transparent, **Original background** (brings back the photo's own background, so the other tools also work on ordinary photos), 11 preset colors, a color wheel and a **hex code** field (`#3a49d9`, `3a49d9` or `#fff`). With a background, a JPG download is offered too.
- **Square:** makes the image square *without cropping*, around the whole image or around the subject, with a 0–30 % margin. The extra space uses the background color, or stays transparent. Results are exactly square.
- **Corners:** radius slider (0–50 % of the shorter side) with None/Small/Medium/Large/Circle presets. Corners are transparent in PNG and white in JPG. Square + Circle gives a round profile picture.
- **Crop:** drag box with corner/edge handles (keyboard: arrow keys), aspect presets (Free, Original, 1:1, 4:5, 3:4, 16:9, 9:16), and **Fit to subject**, which adds even margins but stays flush with edges where the subject is cut off by the photo.
- **Resize:** width/height in proportion, 25/50/100 % and 512/1080/2048 px presets. Output is capped at 6000 px per side and 16 MP.
- **Redo removal:** runs the AI again. With a crop, only the cropped area of the original photo goes to the model, and the refined result is pasted back into the full cut-out. Small subjects in big photos get noticeably finer edges this way.
- **Reset edits** returns to the plain transparent cut-out.

Edits and the original photo are saved with the history item, so reopening an item restores everything.

## Search positioning: remove.bg alternative

remove.bg's standalone website closes on **December 1, 2026 at 9:00 CET**, and its background removal is moving into Canva (see the [remove.bg FAQ](https://www.remove.bg/faq) and [AlternativeTo's report](https://alternativeto.net/news/2026/9/end-of-an-era-remove-bg-shuts-down-standalone-service-and-moves-to-the-canva-ecosystem/)). The site doesn't announce this. It only gives search engines enough to match people looking for a replacement:

- **Homepage:** the `<title>` ("Free Background Remover – remove.bg Alternative") and the meta description mention remove.bg. On the page itself there's only one FAQ entry and a footer link. The visible copy is about the tool.
- **`/remove-bg-alternative`:** the landing page for "remove.bg alternative" searches. It has a short intro, one factual sentence about the closure (with a link to remove.bg's FAQ), a comparison table and usage steps. It's linked from the footer and the sitemap, not from the main navigation.
- **Wording after the date:** the one sentence about the closure has a `data-after-shutdown` attribute, and `src/shutdown.ts` switches it to the past tense from 2026-12-01 09:00 CET.
- **Facts:** the credit price (1 credit per full-resolution image) and the 0.25 MP free preview come from remove.bg's help center. The closing date comes from remove.bg's FAQ via news reports. Checked 2026-10-31.
- **Trademark:** "remove.bg" and "Canva" are used only descriptively, and the footer says EasyCutout isn't affiliated with either. Keep both names out of the brand, domain and logo. In Google Ads, bid on generic terms.
- **Timing:** search interest will peak around December 1, so deploy and submit the sitemap in Search Console early.

## Monetization and SEO notes

- The page already has useful content (how it works, privacy, tips, FAQ), plus privacy, terms and about pages, a sitemap, a canonical URL and `WebApplication` structured data. AdSense also looks for substantial original content and steady traffic, so apply once the site has both.
- Add ads below the tool, never between the upload button and the result. Keep the download button clear of ad placements.
- Before ads go live, update the privacy policy (its advertising section is already drafted) and add a consent banner (CMP) for visitors in the EEA and UK.

## Project layout

```
index.html, square-image-maker.html, round-corners.html, remove-bg-alternative.html,
about.html, privacy.html, terms.html, 404.html
src/partials/        shared header, footer and tool markup
src/main.ts          UI: input methods, states, editor wiring, history grid, crash guard
src/editor.ts        non-destructive edits: render/export, crop box, fit to subject
src/history.ts       on-device history (IndexedDB)
src/worker.ts        model loading + inference (Web Worker)
src/loader.ts        chunked download with progress + Cache Storage
src/protocol.ts      page ↔ worker messages
src/styles.css       all styles (light/dark)
public/_headers      COOP/COEP, caching, security headers
public/m/            model + WASM chunks (generated, committed)
scripts/             model conversion + chunking
tests/               Playwright end-to-end tests
```

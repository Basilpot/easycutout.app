import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** Decode the downloaded PNG in the page and measure transparency in a few regions. */
async function analyse(page: Page, path: string) {
  const b64 = readFileSync(path).toString('base64');
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
    const alphaAt = (fx: number, fy: number) => data[(Math.floor(fy * bmp.height) * bmp.width + Math.floor(fx * bmp.width)) * 4 + 3];
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 10) transparent++;
    return {
      width: bmp.width,
      height: bmp.height,
      transparentShare: transparent / (bmp.width * bmp.height),
      corner: alphaAt(0.02, 0.02),
      cornerRGB: [0, 1, 2].map((k) => data[k]),
      center: alphaAt(0.5, 0.5),
    };
  }, b64);
}

test('sample image → transparent PNG download', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Sample: dog/ }).click();
  await expect(page.getByRole('status')).toContainText(/Downloading|Removing|Preparing/);

  const download = page.getByRole('button', { name: 'Download PNG' });
  await expect(download).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toBe('dog-no-background.png');
  const stats = await analyse(page, await file.path());
  console.log(test.info().project.name, JSON.stringify(stats), logs.filter((l) => l.includes('[cutly]')).join(' | '));

  expect(stats.width).toBe(1200);
  expect(stats.height).toBe(800);
  expect(stats.corner).toBeLessThan(10); // background gone
  expect(stats.center).toBeGreaterThan(200); // subject kept
  expect(stats.transparentShare).toBeGreaterThan(0.3);
  // Images must never be sent anywhere: only same-origin static files are requested.
  expect(requests.filter((u) => !u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
  // ORT must not fetch its default wasm (we provide the bytes ourselves).
  expect(requests.filter((u) => /\/assets\/[^?]*\.wasm($|\?)/.test(u))).toEqual([]);

  // Second image reuses the loaded model.
  await page.getByRole('button', { name: 'New image' }).click();
  await page.locator('#file').setInputFiles('public/samples/person.jpg');
  await expect(download).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Done');
  console.log(test.info().project.name, 'warm:', logs.filter((l) => l.includes('processed')).at(-1));
});

test('non-image file shows a friendly error', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByRole('status')).toContainText('couldn’t be opened');
});

test('static pages load', async ({ page }) => {
  for (const path of ['/privacy', '/about', '/terms']) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
  }
  const res = await page.goto('/nope');
  expect(res?.status()).toBe(404);
});

test('huge image is downscaled, model is cached across visits', async ({ page }) => {
  await page.goto('/?model=full');
  await page.locator('#file').setInputFiles(process.env.HUGE_IMAGE ?? 'public/samples/bear.jpg');
  await expect(page.getByRole('button', { name: 'Download PNG' })).toBeVisible();
  if (process.env.HUGE_IMAGE) await expect(page.getByRole('status')).toContainText('reduced to 16 megapixels');

  // New tab rather than reload: Playwright's WebKit crashes when a reloaded page
  // re-creates a WebGPU device (see README "Known issues").
  const modelRequests: string[] = [];
  const page2 = await page.context().newPage();
  page2.on('request', (r) => r.url().includes('/m/') && modelRequests.push(r.url()));
  await page2.goto('/?model=full');
  await page2.locator('#file').setInputFiles('public/samples/dog.jpg');
  await expect(page2.getByRole('button', { name: 'Download PNG' })).toBeVisible();
  expect(modelRequests).toEqual([]); // Served from Cache Storage.
});

test('history keeps results across visits; download, delete, clear', async ({ page }) => {
  await page.goto('/');
  const history = page.getByRole('region', { name: 'Your recent images' });
  await expect(history).toBeHidden();

  for (const name of ['dog', 'bear']) {
    await page.locator('#file').setInputFiles(`public/samples/${name}.jpg`);
    await expect(page.getByRole('status')).toContainText('Done');
    await page.getByRole('button', { name: 'New image' }).click();
  }
  await expect(history.getByRole('listitem')).toHaveCount(2);

  // Persists in a new tab (IndexedDB), newest first.
  const page2 = await page.context().newPage();
  await page2.goto('/');
  const h2 = page2.getByRole('region', { name: 'Your recent images' });
  await expect(h2.getByRole('listitem')).toHaveCount(2);
  await expect(h2.getByRole('listitem').first()).toContainText('bear');

  // Download straight from the grid.
  const [file] = await Promise.all([page2.waitForEvent('download'), h2.getByRole('button', { name: /^Download dog/ }).click()]);
  expect(file.suggestedFilename()).toBe('dog-no-background.png');

  // Open into the main view.
  await h2.getByRole('button', { name: /^Open bear/ }).click();
  await expect(page2.getByRole('status')).toContainText('From your history');
  const [file2] = await Promise.all([page2.waitForEvent('download'), page2.getByRole('button', { name: 'Download PNG' }).click()]);
  expect(file2.suggestedFilename()).toBe('bear-no-background.png');

  // Delete one, then clear all.
  await h2.getByRole('button', { name: /^Delete dog/ }).click();
  await expect(h2.getByRole('listitem')).toHaveCount(1);
  page2.once('dialog', (d) => d.accept());
  await h2.getByRole('button', { name: 'Clear all' }).click();
  await expect(h2).toBeHidden();
});

test('editor: background color, crop, resize, redo, and edits persist in history', async ({ page }) => {
  await page.goto('/?model=full');
  await page.locator('#file').setInputFiles('public/samples/dog.jpg');
  const dl = page.getByRole('button', { name: 'Download PNG' });
  await expect(dl).toBeVisible();

  // Background color: white → opaque corners, JPG option appears.
  await page.getByRole('radio', { name: 'White' }).click();
  await expect(page.getByRole('button', { name: 'JPG' })).toBeVisible();
  let [file] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  expect(file.suggestedFilename()).toBe('dog-edited.png');
  let stats = await analyse(page, await file.path());
  expect(stats.corner).toBe(255);
  for (const v of stats.cornerRGB) expect(v).toBeGreaterThanOrEqual(250);

  // Crop to 1:1 → square output.
  await page.getByRole('tab', { name: 'Crop' }).click();
  await page.getByRole('radio', { name: '1:1' }).click();
  await expect(page.locator('#out-size')).toContainText('800 × 800 px');
  // Fit to subject keeps the square aspect.
  await page.getByRole('button', { name: 'Fit to subject' }).click();
  const fitted = await page.locator('#out-size').textContent();
  const [, fw, fh] = fitted!.match(/(\d+) × (\d+)/)!;
  expect(fw).toBe(fh);

  // Resize to 512 px.
  await page.getByRole('tab', { name: 'Resize' }).click();
  await page.getByRole('button', { name: '512 px' }).click();
  await expect(page.locator('#out-size')).toContainText('512 × 512 px');
  [file] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  stats = await analyse(page, await file.path());
  expect([stats.width, stats.height]).toEqual([512, 512]);
  expect(stats.center).toBeGreaterThanOrEqual(250);

  // Redo removal on the crop: still done, output size unchanged.
  await page.getByRole('button', { name: 'Redo removal' }).click();
  await expect(page.getByRole('status')).toContainText('Done');
  await expect(page.locator('#out-size')).toContainText('512 × 512 px');

  // Edits are saved with the history item and restored when reopened.
  await page.waitForTimeout(800); // Debounced save.
  await page.getByRole('button', { name: 'New image' }).click();
  const history = page.getByRole('region', { name: 'Your recent images' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await history.getByRole('button', { name: /^Open dog/ }).click();
  await expect(page.locator('#out-size')).toContainText('512 × 512 px');
  await page.getByRole('tab', { name: 'Background' }).click();
  await expect(page.getByRole('radio', { name: 'White' })).toHaveAttribute('aria-checked', 'true');
  [file] = await Promise.all([page.waitForEvent('download'), history.getByRole('button', { name: /^Download dog/ }).click()]);
  stats = await analyse(page, await file.path());
  expect([stats.width, stats.height]).toEqual([512, 512]);

  // Reset edits → back to the transparent full image.
  await page.getByRole('button', { name: 'Reset edits' }).click();
  await expect(page.locator('#out-size')).toContainText('1200 × 800 px, transparent');
});

test('remove.bg closure sentence switches tense after Dec 1, 2026', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-15T12:00:00Z'));
  await page.goto('/remove-bg-alternative');
  await expect(page.locator('main')).toContainText('closes on December 1, 2026');

  await page.clock.setFixedTime(new Date('2026-12-02T12:00:00Z'));
  await page.goto('/remove-bg-alternative');
  await expect(page.locator('main')).toContainText('closed on December 1, 2026');
  await expect(page.locator('main')).not.toContainText('closes on');
});

test('square maker, rounded corners, original background and hex color', async ({ page }) => {
  await page.goto('/?model=full');
  await page.locator('#file').setInputFiles('public/samples/dog.jpg'); // 1200×800
  const dl = page.getByRole('button', { name: 'Download PNG' });
  await expect(dl).toBeVisible();
  const download = async () => {
    const [file] = await Promise.all([page.waitForEvent('download'), dl.click()]);
    return analyse(page, await file.path());
  };

  // Hex input sets an exact background color.
  await page.getByLabel('Hex').fill('#ff0000');
  let stats = await download();
  expect(stats.cornerRGB[0]).toBeGreaterThan(245);
  expect(stats.cornerRGB[1]).toBeLessThan(10);
  await expect(page.locator('.sw-custom')).toHaveClass(/checked/);
  // Short form and invalid input.
  await page.getByLabel('Hex').fill('fff');
  await page.getByLabel('Hex').press('Enter');
  await expect(page.getByLabel('Hex')).toHaveValue('#FFFFFF');
  await page.getByLabel('Hex').fill('zzz');
  await page.getByLabel('Hex').press('Enter');
  await expect(page.getByLabel('Hex')).toHaveAttribute('aria-invalid', 'true');

  // Square of the whole image: 1200×1200, padding filled with the (white) background.
  await page.getByRole('tab', { name: 'Square' }).click();
  await page.getByRole('slider', { name: 'Margin' }).fill('0');
  await page.getByRole('radio', { name: 'Whole image' }).click();
  await expect(page.locator('#out-size')).toContainText('1200 × 1200 px');
  stats = await download();
  expect([stats.width, stats.height]).toEqual([1200, 1200]);
  expect(stats.corner).toBe(255);

  // Circle corners: corners become transparent, center stays opaque.
  await page.getByRole('tab', { name: 'Corners' }).click();
  await page.getByRole('button', { name: 'Circle' }).click();
  await expect(page.locator('#out-size')).toContainText('rounded corners');
  stats = await download();
  expect(stats.corner).toBe(0);
  expect(stats.center).toBe(255);

  // Original background: the photo comes back inside the image area.
  await page.getByRole('tab', { name: 'Corners' }).click();
  await page.getByRole('button', { name: 'None' }).click();
  await page.getByRole('tab', { name: 'Background' }).click();
  await page.getByRole('radio', { name: 'Original background' }).click();
  await page.getByRole('tab', { name: 'Square' }).click();
  await page.getByRole('radio', { name: 'Around subject' }).click();
  stats = await download();
  expect(stats.width).toBe(stats.height); // Exactly square, no off-by-one.
  expect(stats.transparentShare).toBeLessThan(0.05); // Photo fills the frame; no cut-out holes.
});

test('square image maker page: instant square, no AI download until asked', async ({ page }) => {
  const model: string[] = [];
  page.on('request', (r) => r.url().includes('/m/') && model.push(r.url()));
  await page.goto('/square-image-maker');
  await expect(page.getByRole('navigation', { name: 'Tools' }).getByRole('link', { name: /Square/ })).toHaveAttribute('aria-current', 'page');
  await page.locator('#file').setInputFiles('public/samples/dog.jpg'); // 1200×800
  await expect(page.getByRole('status')).toContainText('Ready');
  await expect(page.getByRole('tab', { name: 'Square' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('radio', { name: 'Whole image' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#out-size')).toContainText('1320 × 1320 px'); // 5% margin, white

  const dl = page.getByRole('button', { name: 'Download PNG' });
  let [file] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  expect(file.suggestedFilename()).toBe('dog-square.png');
  let stats = await analyse(page, await file.path());
  expect([stats.width, stats.height]).toEqual([1320, 1320]);
  expect(stats.corner).toBe(255);
  for (const v of stats.cornerRGB) expect(v).toBeGreaterThanOrEqual(250);
  expect(model).toEqual([]); // No AI model needed so far.

  // Optional background removal keeps the square.
  await page.getByRole('button', { name: 'Remove background' }).click();
  await expect(page.getByRole('status')).toContainText('Done');
  await expect(page.getByRole('button', { name: 'Redo removal' })).toBeVisible();
  await expect(page.locator('#out-size')).toContainText('1320 × 1320 px');
  expect(model.length).toBeGreaterThan(0);
});

test('round corners page: rounded by default, transparent corners', async ({ page }) => {
  const model: string[] = [];
  page.on('request', (r) => r.url().includes('/m/') && model.push(r.url()));
  await page.goto('/round-corners');
  await page.locator('#file').setInputFiles('public/samples/bear.jpg');
  await expect(page.getByRole('status')).toContainText('Ready');
  await expect(page.getByRole('tab', { name: 'Corners' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true');
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PNG' }).click()]);
  expect(file.suggestedFilename()).toBe('bear-rounded.png');
  const stats = await analyse(page, await file.path());
  expect([stats.width, stats.height]).toEqual([1200, 800]);
  expect(stats.corner).toBe(0);
  expect(stats.center).toBe(255);
  expect(model).toEqual([]);
});

test('refine: brush restores and erases, undo works, result is exported', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles('public/samples/dog.jpg');
  const dl = page.getByRole('button', { name: 'Download PNG' });
  await expect(dl).toBeVisible();

  await page.getByRole('tab', { name: 'Refine' }).click();
  await page.getByRole('checkbox', { name: /Smart select/ }).uncheck();
  await page.locator('#refine-size').fill('100');
  await page.locator('#canvas').scrollIntoViewIfNeeded();
  const box = (await page.locator('#canvas').boundingBox())!;
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;

  // Restore the (removed) top-left corner.
  await page.getByRole('radio', { name: 'Restore' }).click();
  await page.mouse.move(...at(0.03, 0.03));
  await page.mouse.down();
  await page.mouse.move(...at(0.08, 0.08), { steps: 5 });
  await page.mouse.up();

  // Erase the middle of the subject, then undo that stroke.
  await page.getByRole('radio', { name: 'Erase' }).click();
  await page.mouse.move(...at(0.45, 0.5));
  await page.mouse.down();
  await page.mouse.move(...at(0.55, 0.5), { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Undo stroke' }).click();

  const [file] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  const stats = await analyse(page, await file.path());
  expect(stats.corner).toBeGreaterThan(200); // restored
  expect(stats.center).toBeGreaterThan(200); // erase was undone
});

test('slow connection: quick model answers first, then "Improve quality" upgrades it', async ({ page }) => {
  const modelParts: string[] = [];
  page.on('request', (r) => /\/m\/(isnet|u2netp)/.test(r.url()) && modelParts.push(r.url()));
  await page.goto('/?model=quick');
  await page.locator('#file').setInputFiles('public/samples/dog.jpg');
  const status = page.getByRole('status');
  await expect(status).toContainText('Done');
  expect(modelParts.some((u) => u.includes('u2netp'))).toBe(true);

  // The big model is fetched in the background; the button then offers the upgrade.
  await expect(status).toContainText('Sharper AI model is ready');
  const improve = page.getByRole('button', { name: 'Improve quality' });
  await improve.click();
  await expect(status).toContainText('Done');
  await expect(page.getByRole('button', { name: 'Redo removal' })).toBeVisible();

  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PNG' }).click()]);
  const stats = await analyse(page, await file.path());
  expect(stats.corner).toBeLessThan(10);
  expect(stats.center).toBeGreaterThan(200);
});

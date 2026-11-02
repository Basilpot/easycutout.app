import { defineConfig, devices } from '@playwright/test';

const PORT = 8799;

export default defineConfig({
  testDir: 'tests',
  timeout: 240_000,
  expect: { timeout: 180_000 },
  use: { baseURL: `http://localhost:${PORT}` },
  // Serves the production build through Wrangler so headers and asset limits match Cloudflare.
  webServer: {
    command: `pnpm build && pnpm exec wrangler dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium-wasm', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium-webgpu',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] } },
    },
    // Real Chrome (if installed) to exercise the WebGPU backend on this machine's GPU.
    { name: 'chrome-webgpu', use: { channel: 'chrome', launchOptions: { args: ['--enable-unsafe-webgpu'] } } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['iPhone 15'] } },
  ],
});

import { defineConfig, devices } from '@playwright/test';

const PORT = 4213;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * E2E config.
 *
 * Runs against the built bundle (`vite preview`), i.e. the exact bytes that get
 * deployed. Two projects: desktop and a real iPhone 13 profile.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testMatch: /flow\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 940 } },
    },
    {
      name: 'iphone-13',
      testMatch: /mobile\.spec\.ts/,
      use: toChromium(devices['iPhone 13']),
    },
  ],
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

/** iPhone metrics with the Chromium engine so only one browser download is needed. */
function toChromium(device: (typeof devices)[string]) {
  return { ...device, browserName: 'chromium' as const, defaultBrowserType: 'chromium' as const };
}

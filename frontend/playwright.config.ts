// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser journeys, accessibility scans and screenshot tests (e2e/; see
 * e2e/README.md). The app runs under `next dev`; the backend does not run at
 * all — every `/api/**` request is answered by the route stubs in
 * e2e/support/backend.ts.
 *
 *   pnpm run test:e2e                 # boots next dev on E2E_PORT (default 3311)
 *   E2E_BASE_URL=http://… pnpm run test:e2e   # against an already-running app
 *
 * Two projects: `chromium` (journeys + axe) and `screenshots` (visual
 * baselines, Linux only — generated in the Playwright Docker image).
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3311);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const SCREENSHOTS = 'screenshots.spec.ts';

export default defineConfig({
  testDir: './e2e',
  // `next dev` compiles each route on first hit; the first visit to a page can
  // take several seconds on a cold runner.
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      stylePath: './e2e/support/screenshot.css',
      // Same OS, same browser build, same fonts: renders are identical, so
      // this only absorbs sub-pixel anti-aliasing noise.
      maxDiffPixelRatio: 0.001,
    },
  },
  // One baseline per image, no OS/browser suffix: baselines are Linux renders
  // by design (the spec skips elsewhere).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: false,
  // Specs are independent (each page stubs its own backend); `next dev`
  // serves two browsers at once without trouble.
  workers: process.env.CI ? 2 : 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // No real service: a stray request to anything but the app must not hang.
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'chromium', testIgnore: SCREENSHOTS, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'screenshots',
      testMatch: SCREENSHOTS,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        timezoneId: 'UTC',
        locale: 'en-US',
        reducedMotion: 'reduce',
      },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: { NEXT_TELEMETRY_DISABLED: '1' },
      },
});

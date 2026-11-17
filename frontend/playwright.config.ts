// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser smoke + accessibility suite (e2e/). The app runs under `next dev`;
 * the backend does not run at all — every `/api/**` request is answered by the
 * route stubs in e2e/support/backend.ts.
 *
 *   pnpm run test:e2e                 # boots next dev on E2E_PORT (default 3311)
 *   E2E_BASE_URL=http://… pnpm run test:e2e   # against an already-running app
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3311);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // `next dev` compiles each route on first hit; the first visit to a page can
  // take several seconds on a cold runner.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // No real service: a stray request to anything but the app must not hang.
    navigationTimeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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

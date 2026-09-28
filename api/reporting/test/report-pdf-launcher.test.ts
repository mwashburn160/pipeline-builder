// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The DEFAULT launcher — the one path `report-pdf.test.ts` replaces with a seam.
 *
 * Its own file because `puppeteer-core` has to be mocked before the module under test is
 * imported, and the other suite deliberately imports the real module with the real
 * availability probe.
 *
 * What this pins is small and worth pinning: that the launcher hands Chromium an EXPLICIT
 * executable path. `puppeteer-core` ships no browser, so if the path were ever dropped the
 * launch would either fail on every install or — worse, if someone "fixed" it by switching
 * to the full `puppeteer` package — silently start using a bundled Chrome that the alpine
 * image cannot execute and that no `apk upgrade` ever patches.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const mockLaunch = jest.fn<AnyFn>();

jest.unstable_mockModule('puppeteer-core', () => ({
  __esModule: true,
  default: { launch: (...a: unknown[]) => mockLaunch(...a) },
}));

const { renderPdf, resetPdfAvailability, setPdfLauncher } = await import('../src/services/report-pdf.js');

describe('the default launcher', () => {
  it('launches the configured Chromium with the module\'s own flags', async () => {
    process.env.REPORT_PDF_CHROMIUM_PATH = process.execPath;
    resetPdfAvailability();
    // No launcher installed, so the real `defaultLauncher` runs against the mocked module.
    setPdfLauncher(null);

    const page = {
      setContent: jest.fn<AnyFn>(async () => undefined),
      setOfflineMode: jest.fn<AnyFn>(async () => undefined),
      setRequestInterception: jest.fn<AnyFn>(async () => undefined),
      on: jest.fn<AnyFn>(),
      emulateMediaType: jest.fn<AnyFn>(async () => undefined),
      pdf: jest.fn<AnyFn>(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    };
    mockLaunch.mockResolvedValue({
      newPage: async () => page,
      close: async () => undefined,
      process: () => null,
    });

    const result = await renderPdf('<html></html>');
    expect(result.ok).toBe(true);

    const opts = mockLaunch.mock.calls[0]?.[0] as { executablePath?: string; args?: string[] };
    // The whole point: never puppeteer's own browser resolution.
    expect(opts.executablePath).toBe(process.execPath);
    expect(opts.args).toContain('--no-sandbox');

    delete process.env.REPORT_PDF_CHROMIUM_PATH;
    resetPdfAvailability();
  });
});

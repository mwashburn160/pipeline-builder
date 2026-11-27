// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The central frontend config modules: `lib/config` (build-time, client-safe)
 * keeps its documented defaults and never yields a NaN timeout, and
 * `lib/server-config` reads the runtime env at ACCESS time, not module load.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { serverConfig } from '../src/lib/server-config';

const KEYS = ['NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS', 'BILLING_INTERNAL_URL', 'ERROR_REPORT_URL', 'GOOGLE_SITE_VERIFICATION'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function loadConfig(): typeof import('../src/lib/config').config {
  let loaded!: typeof import('../src/lib/config').config;
  jest.isolateModules(() => { loaded = (require('../src/lib/config') as typeof import('../src/lib/config')).config; });
  return loaded;
}

describe('config.pluginBuildTimeoutMs', () => {
  it('defaults to 5 minutes when unset', () => {
    delete process.env.NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS;
    expect(loadConfig().pluginBuildTimeoutMs).toBe(300_000);
  });

  it('uses a positive integer override', () => {
    process.env.NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS = '600000';
    expect(loadConfig().pluginBuildTimeoutMs).toBe(600_000);
  });

  it.each(['', 'abc', '0', '-5'])('falls back to the default for %p rather than an instant abort', (raw) => {
    process.env.NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS = raw;
    expect(loadConfig().pluginBuildTimeoutMs).toBe(300_000);
  });
});

describe('serverConfig', () => {
  it('reads each value when accessed, and treats empty as unset', () => {
    delete process.env.BILLING_INTERNAL_URL;
    process.env.ERROR_REPORT_URL = '';
    delete process.env.GOOGLE_SITE_VERIFICATION;
    expect(serverConfig.billingInternalUrl).toBeUndefined();
    expect(serverConfig.errorReportUrl).toBeUndefined();
    expect(serverConfig.googleSiteVerification).toBeUndefined();

    process.env.BILLING_INTERNAL_URL = 'http://billing:3000';
    process.env.ERROR_REPORT_URL = 'http://collector/errors';
    process.env.GOOGLE_SITE_VERIFICATION = 'token-1';
    expect(serverConfig.billingInternalUrl).toBe('http://billing:3000');
    expect(serverConfig.errorReportUrl).toBe('http://collector/errors');
    expect(serverConfig.googleSiteVerification).toBe('token-1');
  });
});

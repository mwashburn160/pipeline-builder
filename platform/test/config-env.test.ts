// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integer knobs in platform config: an explicit `0` is a real value (it disables
 * the domain re-verification sweep), not "unset" — `Number(env) || default`
 * silently turned it back into the 24h default. Unset/blank/garbage fall back.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

type Cfg = typeof import('../src/config/index.js')['config'];
let config: Cfg;

const KNOBS = ['DOMAIN_REVERIFY_INTERVAL_MS', 'DOMAIN_REVERIFY_STALE_MS', 'ORG_CASCADE_HTTP_TIMEOUT_MS', 'OAUTH_MAX_PENDING_STATES', 'CLI_NPM_PACKAGE', 'CLI_NPM_URL'] as const;
const saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of KNOBS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'test-jwt-secret-config-env';
  process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
  process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
  process.env.DOMAIN_REVERIFY_INTERVAL_MS = '0';
  process.env.DOMAIN_REVERIFY_STALE_MS = '';
  process.env.ORG_CASCADE_HTTP_TIMEOUT_MS = 'not-a-number';
  process.env.OAUTH_MAX_PENDING_STATES = '250';
  // One env state proves BOTH halves of the cli url rule: a non-http(s) value
  // is rejected, and what it falls back to is the value DERIVED from the
  // (overridden) package name rather than the hardcoded public one.
  process.env.CLI_NPM_PACKAGE = '@acme/pb-cli';
  process.env.CLI_NPM_URL = 'javascript:alert(1)';
  ({ config } = await import('../src/config/index.js'));
});

describe('onboarding CLI pointers', () => {
  it('honors CLI_NPM_PACKAGE', () => {
    expect(config.cli.npmPackage).toBe('@acme/pb-cli');
  });

  it('rejects a non-http(s) CLI_NPM_URL and derives from the package instead', () => {
    // The value is rendered into an href on the onboarding step, so a
    // `javascript:` scheme must never reach the browser. Falling back to the
    // DERIVED url (not the hardcoded public one) is what keeps the link correct
    // for a deployment that renamed the package.
    expect(config.cli.npmUrl).toBe('https://www.npmjs.com/package/@acme/pb-cli');
  });
});

describe('config integer env knobs', () => {
  it('honors an explicit 0 (disables the domain re-verification sweep)', () => {
    expect(config.organization.domainReverifyIntervalMs).toBe(0);
  });

  it('falls back to the default for a blank or non-numeric value', () => {
    expect(config.organization.domainReverifyStaleMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.organization.cascadeHttpTimeoutMs).toBe(5000);
  });

  it('reads a set value once for every consumer (OAuth and SSO share the pending-state cap)', () => {
    expect(config.oauth.maxPendingStates).toBe(250);
  });
});

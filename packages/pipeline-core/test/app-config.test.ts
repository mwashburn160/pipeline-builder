// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Config.overrideScoped() — the mechanism that keeps a per-builder
 * registry override from leaking into the process-wide config cache (so
 * pipeline B's registry can't bleed into pipeline A in a multi-pipeline app).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { Config } = await import('../src/config/app-config.js');

describe('Config.overrideScoped', () => {
  beforeEach(() => {
    Config._resetForTesting();
  });

  it('applies the override, then restores the prior cached value', () => {
    // Prime the cache with the env-loaded registry (default host 'registry').
    const base = Config.get('registry');
    expect(base.host).toBe('registry');

    const restore = Config.overrideScoped('registry', { host: 'b.example.com' });
    expect(Config.get('registry').host).toBe('b.example.com');

    restore();
    expect(Config.get('registry').host).toBe('registry');
  });

  it('restores an UNLOADED section by dropping it from the cache', () => {
    // Section not yet cached — restore must delete it so the next get() re-loads.
    const restore = Config.overrideScoped('registry', { host: 'b.example.com' });
    expect(Config.get('registry').host).toBe('b.example.com');

    restore();
    // Re-loads fresh from env (default) rather than keeping the override.
    expect(Config.get('registry').host).toBe('registry');
  });

  it('two scoped overrides do not leak into each other', () => {
    const restoreA = Config.overrideScoped('registry', { host: 'a.example.com' });
    expect(Config.get('registry').host).toBe('a.example.com');
    restoreA();

    const restoreB = Config.overrideScoped('registry', { host: 'b.example.com' });
    expect(Config.get('registry').host).toBe('b.example.com');
    restoreB();

    // Neither override persists after its scope ends.
    expect(Config.get('registry').host).toBe('registry');
  });
});

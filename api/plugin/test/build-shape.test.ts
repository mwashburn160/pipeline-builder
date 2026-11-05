// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/build-shape — the class/size resolver both build-queuing
 * routes share.
 *
 * The property that matters is that an over-tier size is REFUSED rather than
 * downgraded, and that both routes get the same answer: a tenant told two
 * different stories about what their tier includes will believe the wrong one.
 */

import { afterEach, beforeEach, describe, it, expect } from '@jest/globals';
import { BUILD_SIZES, buildSizesForTier, VALID_TIERS } from '@pipeline-builder/api-core';

import { resolveBuildShape } from '../src/helpers/build-shape.js';

/**
 * Every sized pool configured, so the TIER verdict is what these assert. Without
 * it the supply gate refuses `0.5x`/`2x`/`4x`/`8x` first and the tier ladder is
 * never reached — which is the correct production behaviour and the wrong thing
 * to be testing here.
 */
const POOL_KEYS = ['HALF', '2X', '4X', '8X'].map((s) => `PLUGIN_BUILDKIT_ADDR_SIZE_${s}`);

function withPools() {
  beforeEach(() => { for (const k of POOL_KEYS) process.env[k] = 'tcp://sized:1234'; });
  afterEach(() => { for (const k of POOL_KEYS) delete process.env[k]; });
}

describe('resolveBuildShape — defaults', () => {
  withPools();

  it('defaults to standard/1x, which every tier has', () => {
    for (const tier of VALID_TIERS) {
      expect(resolveBuildShape(tier, {})).toEqual({ ok: true, buildClass: 'standard', buildSize: '1x' });
    }
  });

  it('takes the class from the SIZE when the caller names no class', () => {
    // `Small` holds its slot about twice as long, so it defaults into the class
    // with the extra headroom rather than the single standard slot a free org
    // keeps for an urgent fix.
    expect(resolveBuildShape('developer', { buildSize: '0.5x' })).toMatchObject({ ok: true, buildClass: 'flexible' });
    expect(resolveBuildShape('developer', { buildSize: '1x' })).toMatchObject({ ok: true, buildClass: 'standard' });
    // …and an explicit class still wins.
    expect(resolveBuildShape('developer', { buildSize: '0.5x', buildClass: 'standard' }))
      .toMatchObject({ ok: true, buildClass: 'standard' });
  });

  it('gates no class at all: flexible is the option the platform WANTS used', () => {
    // Gating the cheaper class would be charging for the thing that smooths
    // load, and it would leave a free account unable to defer anything.
    for (const tier of VALID_TIERS) {
      expect(resolveBuildShape(tier, { buildClass: 'flexible' })).toMatchObject({ ok: true, buildClass: 'flexible' });
    }
  });
});

describe('resolveBuildShape — the size gate', () => {
  withPools();

  it('refuses a size above the tier ceiling instead of downgrading it', () => {
    // A silent downgrade means the tenant waits twice as long as they asked
    // with nothing saying why, and a CI job pinning 4x keeps "succeeding" at
    // 1x forever.
    const refused = resolveBuildShape('developer', { buildSize: '2x' });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('not available on the developer tier');
    // The message names what the tier DOES have, so the remedy is readable.
    expect(refused.ok === false && refused.error).toContain('1x');
  });

  it('admits exactly what the tier ladder lists, tier by tier', () => {
    for (const tier of VALID_TIERS) {
      for (const size of BUILD_SIZES) {
        const allowed = buildSizesForTier(tier).includes(size);
        // A tier-allowed size can still be refused for want of a pool, which
        // the supply block below covers; here only the tier verdict is asserted.
        const outcome = resolveBuildShape(tier, { buildSize: size });
        expect(outcome.ok || (outcome as { reason: string }).reason === 'supply').toBe(allowed);
      }
    }
  });

  it('puts 2x at Team and 4x at Business, per D13', () => {
    expect(resolveBuildShape('pro', { buildSize: '2x' }).ok).toBe(false);
    expect(resolveBuildShape('team', { buildSize: '2x' }).ok).toBe(true);
    expect(resolveBuildShape('team', { buildSize: '4x' }).ok).toBe(false);
    expect(resolveBuildShape('business', { buildSize: '4x' }).ok).toBe(true);
  });

  it('gates nothing when billing is disabled', () => {
    // `unlimited` is the no-billing install; a gate there would invent a limit
    // the operator never bought into.
    expect(resolveBuildShape('unlimited', { buildSize: '4x' }).ok).toBe(true);
  });

  it('refuses a tier-allowed size that has no machine behind it, naming the variable', () => {
    // The supply gate, with the pools NOT configured. Serving an unprovisioned
    // size off the shared daemon is wrong both ways: above 1x the tenant pays
    // the multiplier for 1x speed, below it they get full speed at a fraction of
    // the price.
    for (const k of POOL_KEYS) delete process.env[k];
    const refused = resolveBuildShape('business', { buildSize: '4x' });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe('supply');
    expect(refused.ok === false && refused.error).toContain('PLUGIN_BUILDKIT_ADDR_SIZE_4X');
    // `1x` IS the shared daemon, so it never needs a pool.
    expect(resolveBuildShape('business', { buildSize: '1x' }).ok).toBe(true);
  });

  it('checks the size even when a class was asked for too', () => {
    // Order matters only in that a refused size must not be returned as an
    // accepted shape with the class attached.
    expect(resolveBuildShape('developer', { buildClass: 'flexible', buildSize: '4x' }).ok).toBe(false);
  });
});

describe('resolveBuildShape — an odd tier must not 500 an upload', () => {
  it('degrades an unrecognised tier to the default gate rather than throwing', () => {
    // Same reasoning as `tierForQueueName`: a tier lookup that came back odd
    // degrades, it does not throw inside a submission. Degrading to the DEFAULT
    // tier is also the conservative direction — the smallest allowance.
    expect(resolveBuildShape(undefined as never, {})).toMatchObject({ ok: true, buildSize: '1x' });
    const refused = resolveBuildShape('nonsense' as never, { buildSize: '4x' });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('developer');
  });
});

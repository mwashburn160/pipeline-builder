// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The arithmetic behind automatic PVC expansion.
 *
 * This is pure-function territory on purpose: `nextSizeGi` and
 * `parseQuantityToBytes` are where a mistake is expensive and invisible.
 * Expansion is irreversible — neither EBS nor Kubernetes can shrink a volume —
 * so an off-by-one in the ceiling is a bill, and a quantity misparse ("500Mi"
 * read as 500 bytes) would compute a "growth" that shrinks the request and gets
 * rejected by the API server while the disk keeps filling.
 *
 * The cases that matter are the boundaries, not the happy path:
 *   - the ceiling measured from the ORIGINAL request, never compounding;
 *   - a step that would overshoot the ceiling clamped to it;
 *   - a clamp that lands on the current size refused, because growth must be
 *     strictly positive;
 *   - the absolute maxGi winning over the factor;
 *   - every quantity suffix Kubernetes actually accepts.
 */

import { describe, expect, it } from '@jest/globals';
import { nextVolumeGi } from '../src/services/node-disk-autoexpand.js';
import { nextSizeGi, parseQuantityToBytes } from '../src/services/pvc-autoexpand.js';

const GIB = 1024 ** 3;
const cfg = { stepFactor: 1.5, ceilingFactor: 4, maxGi: 500 };

describe('parseQuantityToBytes', () => {
  it('reads the binary suffixes Kubernetes writes', () => {
    expect(parseQuantityToBytes('20Gi')).toBe(20 * GIB);
    expect(parseQuantityToBytes('500Mi')).toBe(500 * 1024 ** 2);
    expect(parseQuantityToBytes('1Ti')).toBe(1024 ** 4);
    expect(parseQuantityToBytes('256Ki')).toBe(256 * 1024);
  });

  it('reads decimal suffixes and bare byte counts, which are equally legal', () => {
    // An operator sizing a claim by hand may well write "1G", and reading that
    // as 1Gi would overstate capacity by 7%.
    expect(parseQuantityToBytes('1G')).toBe(1e9);
    expect(parseQuantityToBytes('1T')).toBe(1e12);
    expect(parseQuantityToBytes('1073741824')).toBe(1073741824);
  });

  it('tolerates whitespace and rejects nonsense rather than guessing', () => {
    expect(parseQuantityToBytes(' 20Gi ')).toBe(20 * GIB);
    expect(parseQuantityToBytes('')).toBeNull();
    expect(parseQuantityToBytes('20Gb')).toBeNull();
    expect(parseQuantityToBytes('lots')).toBeNull();
  });
});

describe('nextSizeGi', () => {
  it('grows by the step factor, rounded up to a whole GiB', () => {
    // EBS allocates whole GiB; a fractional request would be rounded by the CSI
    // driver to a size this code did not choose, which would then disagree with
    // the ceiling arithmetic.
    expect(nextSizeGi(20 * GIB, 20 * GIB, cfg)).toEqual({ toGi: 30 });
    expect(nextSizeGi(1 * GIB, 1 * GIB, cfg)).toEqual({ toGi: 2 });
    // 3 * 1.5 = 4.5 → 5, not 4.
    expect(nextSizeGi(3 * GIB, 3 * GIB, cfg)).toEqual({ toGi: 5 });
  });

  it('measures the ceiling from the ORIGINAL request, so it cannot compound', () => {
    // Original 20Gi, ceiling 80Gi. Already grown to 60Gi: the step would be
    // 90Gi, which must clamp to 80 — NOT to 4x the *current* 60Gi.
    expect(nextSizeGi(60 * GIB, 20 * GIB, cfg)).toEqual({ toGi: 80 });
  });

  it('stops at the ceiling instead of inching past it', () => {
    expect(nextSizeGi(80 * GIB, 20 * GIB, cfg)).toEqual({ atCeiling: true, ceilingGi: 80 });
    // Beyond it (an operator expanded by hand) is still "at ceiling", never negative growth.
    expect(nextSizeGi(100 * GIB, 20 * GIB, cfg)).toEqual({ atCeiling: true, ceilingGi: 80 });
  });

  it('refuses a clamp that would not actually grow the volume', () => {
    // Original 20Gi → ceiling 80Gi; current 79.5Gi clamps to 80 and that IS
    // growth. But at exactly the ceiling there is nothing to submit, and
    // submitting an equal size would be a no-op patch that burns the cooldown.
    expect(nextSizeGi(79.5 * GIB, 20 * GIB, cfg)).toEqual({ toGi: 80 });
    expect(nextSizeGi(80 * GIB, 20 * GIB, cfg)).toEqual({ atCeiling: true, ceilingGi: 80 });
  });

  it('lets the absolute maxGi win over the ceiling factor', () => {
    // 4 x 200Gi would be 800Gi, but maxGi caps the whole scheme at 500.
    expect(nextSizeGi(200 * GIB, 200 * GIB, { ...cfg, maxGi: 500 })).toEqual({ toGi: 300 });
    expect(nextSizeGi(400 * GIB, 200 * GIB, { ...cfg, maxGi: 500 })).toEqual({ toGi: 500 });
    expect(nextSizeGi(500 * GIB, 200 * GIB, { ...cfg, maxGi: 500 })).toEqual({ atCeiling: true, ceilingGi: 500 });
  });

  it('treats a ceiling factor of 1 as "never expand"', () => {
    // The configuration that disables growth without disabling the endpoint —
    // it must not somehow still submit a patch.
    expect(nextSizeGi(20 * GIB, 20 * GIB, { ...cfg, ceilingFactor: 1 })).toEqual({ atCeiling: true, ceilingGi: 20 });
  });

  it('never returns a size at or below the current one', () => {
    // The single invariant that matters most: every expansion is permanent, and
    // a non-increasing request is rejected by the API server anyway.
    for (const currentGi of [1, 3, 7, 20, 50, 79, 80, 120]) {
      const r = nextSizeGi(currentGi * GIB, 20 * GIB, cfg);
      if ('toGi' in r) expect(r.toGi).toBeGreaterThan(currentGi);
    }
  });
});

/**
 * The ec2 counterpart. Same rule, a different unit: whole GiB straight from
 * DescribeVolumes rather than a Kubernetes quantity string. It is tested
 * separately rather than assumed equivalent, because the two ceilings guard
 * different things — one claim versus the single disk the whole ec2 deployment
 * runs on, where an over-expansion is both expensive and un-shrinkable.
 */
describe('nextVolumeGi (ec2 data volume)', () => {
  // Named apart from the PVC `cfg` above: same shape, different units (whole GiB
  // from DescribeVolumes, not a Kubernetes quantity) and a far higher cap.
  const volCfg = { stepFactor: 1.5, ceilingFactor: 4, maxGi: 2000 };

  it('grows by the step factor, rounded up', () => {
    expect(nextVolumeGi(100, 100, volCfg)).toEqual({ toGi: 150 });
    expect(nextVolumeGi(3, 3, volCfg)).toEqual({ toGi: 5 });
  });

  it('measures the ceiling from the FIRST-SEEN size, not the current one', () => {
    // First seen 100Gi → ceiling 400Gi. Already at 300: the step would be 450,
    // which clamps to 400 — not to 4x the current 300.
    expect(nextVolumeGi(300, 100, volCfg)).toEqual({ toGi: 400 });
    expect(nextVolumeGi(400, 100, volCfg)).toEqual({ atCeiling: true, ceilingGi: 400 });
  });

  it('lets the absolute cap win, and never grows past it', () => {
    expect(nextVolumeGi(1800, 1000, volCfg)).toEqual({ toGi: 2000 });
    expect(nextVolumeGi(2000, 1000, volCfg)).toEqual({ atCeiling: true, ceilingGi: 2000 });
  });

  it('never returns a size at or below the current one', () => {
    for (const current of [8, 50, 100, 399, 400, 1000, 2500]) {
      const r = nextVolumeGi(current, 100, volCfg);
      if ('toGi' in r) expect(r.toGi).toBeGreaterThan(current);
    }
  });
});

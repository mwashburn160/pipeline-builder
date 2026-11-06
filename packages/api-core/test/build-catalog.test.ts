// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The build catalog: one keyed module in place of two id lists in
 * wire-vocabulary.ts, two tier tables in quota-tiers.ts, and a frontend mirror
 * of all four that a source-parsing test had to police.
 *
 * These assert the INVARIANTS the shape is supposed to make cheap — that no
 * entry can be half-declared, that the ladders cannot go backwards, and that the
 * ids stay safe for the two places they end up (a Redis key and an environment
 * variable name).
 */

import { describe, it, expect } from '@jest/globals';
import {
  BUILD_CLASSES,
  BUILD_CLASS_CATALOG,
  BUILD_SIZES,
  BUILD_SIZE_CATALOG,
  BUILD_TIER_CONCURRENCY,
  BUILD_TIER_LADDER,
  buildClassLabel,
  buildConcurrencyEnvVar,
  buildWorkerConcurrencyFor,
  buildSizeEnvSuffix,
  buildSizeLabel,
  buildSizeMultiplier,
  buildSizesForTier,
  buildSlotsByClass,
  buildSlotsFor,
  buildTimeoutFactor,
  defaultClassForSize,
  tierAllowsBuildSize,
} from '../src/types/build-catalog.js';
import { VALID_TIERS } from '../src/types/quota-tiers.js';

describe('the ids and their labels', () => {
  it('names the classes for the TRADE, not for a magnitude or a rank', () => {
    // `flexible` names what the customer gives up — a flexible start time.
    // `small` was rejected because it is a magnitude word on a latency
    // dimension: `{ buildClass: 'small', buildSize: '2x' }` is legal and
    // unreadable. `deferred` reads as broken; `batch` was the platform's word
    // for its own behaviour rather than the customer's for their trade.
    expect([...BUILD_CLASSES]).toEqual(['standard', 'flexible']);
  });

  it('keeps the multiplier IN the size id, and the words in the label', () => {
    // Arithmetic ids are what make the credit math checkable by eye, and what
    // makes a relabel free: a label is one field here, with no wire value,
    // Redis key, metric label or ledger string behind it.
    expect([...BUILD_SIZES]).toEqual(['0.5x', '1x', '2x', '4x', '8x']);
    expect(BUILD_SIZES.map(buildSizeLabel)).toEqual(['Small', 'Standard', 'Medium', 'Large', 'X-Large']);
    for (const size of BUILD_SIZES) {
      expect(buildSizeMultiplier(size)).toBe(Number(size.replace('x', '')));
    }
  });

  it('answers for an unknown id instead of throwing', () => {
    // These read values off the wire, so an id from a newer producer must
    // degrade rather than crash a build or a page.
    expect(buildSizeMultiplier('99x')).toBe(1);
    expect(buildSizeLabel('99x')).toBe('99x');
    expect(buildClassLabel('nonsense')).toBe('nonsense');
    expect(defaultClassForSize('99x')).toBe('standard');
    expect(buildSizeEnvSuffix('99x')).toBe('1X');
  });
});

describe('the size ladder', () => {
  it('puts Small and Standard on every tier, so the cheapest rung is not a paid feature', () => {
    // Small is a budget option, not a restriction. No other dimension in the
    // catalogue is ABSENT on a tier, and a one-value class reads as a crippled
    // free tier rather than the bottom of a ladder.
    for (const tier of VALID_TIERS) {
      expect(tierAllowsBuildSize(tier, '0.5x')).toBe(true);
      expect(tierAllowsBuildSize(tier, '1x')).toBe(true);
    }
  });

  it('gates Medium at Team, Large at Business and X-Large at Enterprise', () => {
    expect(tierAllowsBuildSize('pro', '2x')).toBe(false);
    expect(tierAllowsBuildSize('team', '2x')).toBe(true);
    expect(tierAllowsBuildSize('team', '4x')).toBe(false);
    expect(tierAllowsBuildSize('business', '4x')).toBe(true);
    expect(tierAllowsBuildSize('business', '8x')).toBe(false);
    expect(tierAllowsBuildSize('enterprise', '8x')).toBe(true);
  });

  it('cannot express a NON-monotonic ladder, which is why `minTier` replaced the per-tier rows', () => {
    // The old shape was a row per tier and could say "Team has 4x, Business does
    // not", so a test had to forbid it. One floor per size makes that
    // inexpressible — this asserts the consequence rather than the prohibition.
    const ordered: readonly (typeof VALID_TIERS)[number][] = ['developer', 'pro', 'team', 'business', 'enterprise'];
    for (let i = 1; i < ordered.length; i++) {
      for (const size of buildSizesForTier(ordered[i - 1]!)) {
        expect(buildSizesForTier(ordered[i]!)).toContain(size);
      }
    }
  });

  it('gates nothing when billing is disabled', () => {
    // `unlimited` sits at the top of the ladder: a gate there would invent a
    // limit the operator never bought into.
    for (const size of BUILD_SIZES) expect(tierAllowsBuildSize('unlimited', size)).toBe(true);
  });

  it('gives an unrecognised tier the FLOOR of the ladder, never everything', () => {
    expect(tierAllowsBuildSize('nonsense' as never, '1x')).toBe(true);
    expect(tierAllowsBuildSize('nonsense' as never, '8x')).toBe(false);
  });

  it('covers every tier in the ladder, so no tier can fall through the gate', () => {
    expect([...BUILD_TIER_LADDER].sort()).toEqual([...VALID_TIERS].sort());
  });
});

describe('env suffixes', () => {
  it('use only characters legal in an env var name, which the ids do not', () => {
    // A SUFFIX, so a leading digit is fine (`PLUGIN_BUILDKIT_ADDR_SIZE_1X`); what
    // matters is that no character outside [A-Z0-9_] gets in. `'0.5x'.toUpperCase()`
    // is `0.5X` and a dot cannot appear in an env var name at all — the same
    // reason `x-large` was rejected as an id. This is why the suffix is declared
    // in the catalog rather than derived from the id.
    for (const size of BUILD_SIZES) {
      expect(buildSizeEnvSuffix(size)).toMatch(/^[A-Z0-9_]+$/);
    }
    expect(buildSizeEnvSuffix('0.5x')).toBe('HALF');
    // And the composed name is a legal identifier.
    for (const size of BUILD_SIZES) {
      expect(`PLUGIN_BUILDKIT_ADDR_SIZE_${buildSizeEnvSuffix(size)}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('are distinct, so two machines cannot share one pool variable', () => {
    const suffixes = BUILD_SIZES.map(buildSizeEnvSuffix);
    expect(new Set(suffixes).size).toBe(suffixes.length);
  });
});

describe('slot defaults', () => {
  it('gives every tier both classes, so a free account can still push one urgent fix', () => {
    for (const tier of VALID_TIERS) {
      for (const cls of BUILD_CLASSES) expect(buildSlotsFor(tier, cls)).toBeGreaterThan(0);
    }
  });

  it('puts the headroom in FLEXIBLE on every tier, which is what smooths load', () => {
    for (const tier of VALID_TIERS) {
      const slots = buildSlotsByClass(tier);
      expect(slots.flexible).toBeGreaterThan(slots.standard);
    }
  });

  it('is monotonic up the ladder in both classes', () => {
    const ordered = ['developer', 'pro', 'team', 'business', 'enterprise'] as const;
    for (const cls of BUILD_CLASSES) {
      for (let i = 1; i < ordered.length; i++) {
        expect(buildSlotsFor(ordered[i]!, cls)).toBeGreaterThanOrEqual(buildSlotsFor(ordered[i - 1]!, cls));
      }
    }
  });

  it('falls back rather than returning undefined for an unknown tier or class', () => {
    expect(buildSlotsFor('nonsense' as never, 'standard')).toBe(BUILD_CLASS_CATALOG.standard.slotsByTier.developer);
    expect(buildSlotsFor('team', 'nonsense' as never)).toBe(BUILD_CLASS_CATALOG.standard.slotsByTier.team);
  });
});

describe('defaultClass and the timeout factor', () => {
  it('defers Small by default, because it holds its slot twice as long', () => {
    // On Developer's single standard slot, a half-speed build would block the
    // only urgent-fix slot for double the time.
    expect(defaultClassForSize('0.5x')).toBe('flexible');
    for (const size of ['1x', '2x', '4x', '8x'] as const) {
      expect(defaultClassForSize(size)).toBe('standard');
    }
  });

  it('scales the deadline UP below Standard and never down above it', () => {
    // The timeout is a safety bound on a runaway build, not a budget. Scaling it
    // down at Large would break I/O-bound builds that gain nothing from the CPU.
    expect(buildTimeoutFactor('0.5x')).toBe(2);
    expect(buildTimeoutFactor('1x')).toBe(1);
    expect(buildTimeoutFactor('2x')).toBe(1);
    expect(buildTimeoutFactor('8x')).toBe(1);
  });

  it('keeps the per-build credit ceiling CONSTANT below Standard', () => {
    // A consequence worth pinning: the deadline scales by 1/multiplier and the
    // charge scales by the multiplier, so the most a sub-Standard build can cost
    // is exactly what a Standard one can. Small cannot raise the worst case.
    const ceiling = (size: string) => buildTimeoutFactor(size) * buildSizeMultiplier(size);
    expect(ceiling('0.5x')).toBe(ceiling('1x'));
  });
});

describe('every entry is fully declared', () => {
  it('leaves no class or size half-filled', () => {
    // What `Record<Key, Meta>` buys: adding a member does not compile until
    // every field exists. This is the runtime echo of that, for the fields a
    // type cannot constrain (non-empty strings, positive multipliers).
    for (const cls of BUILD_CLASSES) {
      const meta = BUILD_CLASS_CATALOG[cls];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.blurb.length).toBeGreaterThan(0);
      expect(Object.keys(meta.slotsByTier).sort()).toEqual([...VALID_TIERS].sort());
    }
    for (const size of BUILD_SIZES) {
      const meta = BUILD_SIZE_CATALOG[size];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.multiplier).toBeGreaterThan(0);
      expect(BUILD_CLASSES).toContain(meta.defaultClass);
    }
  });
});

// ---------------------------------------------------------------------------
// Worker concurrency per tier
// ---------------------------------------------------------------------------

describe('BUILD_TIER_CONCURRENCY', () => {
  it('covers every tier on the ladder', () => {
    // It lived as a bare literal map inside the build worker, where nothing
    // checked it against the tier union — which is also how the docs came to
    // describe a global default the code had stopped honouring.
    for (const tier of BUILD_TIER_LADDER) {
      expect(typeof BUILD_TIER_CONCURRENCY[tier]).toBe('number');
      expect(BUILD_TIER_CONCURRENCY[tier]).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(BUILD_TIER_CONCURRENCY).sort()).toEqual([...BUILD_TIER_LADDER].sort());
  });

  it('never goes backwards up the ladder', () => {
    // A paid tier that processed FEWER builds at once than a cheaper one would
    // invert what the ladder is for.
    const values = BUILD_TIER_LADDER.map((t) => BUILD_TIER_CONCURRENCY[t]);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  it('is TIER-keyed, not class-keyed — one Worker serves both classes', () => {
    // There is one BullMQ Worker per tier queue and both scheduling classes are
    // served by it, so a per-class figure could not be honoured. Asserted so
    // nobody "improves" this into BUILD_CLASS_CATALOG[class].concurrencyByTier.
    for (const buildClass of BUILD_CLASSES) {
      expect(BUILD_CLASS_CATALOG[buildClass]).not.toHaveProperty('concurrencyByTier');
    }
  });

  it('falls back to the LOWEST row for an unrecognised tier', () => {
    // A bad tier string must not be handed the most generous figure.
    expect(buildWorkerConcurrencyFor('nonsense' as never)).toBe(BUILD_TIER_CONCURRENCY.developer);
  });

  it('derives the override variable instead of spelling it out per tier', () => {
    // The reads used to be six near-identical `envInt` lines, where a wrong
    // cross-reference (`pro: envInt('…_PRO', tierDefault.team)`) silently takes
    // another tier's default and no type can catch it.
    for (const tier of BUILD_TIER_LADDER) {
      expect(buildConcurrencyEnvVar(tier)).toBe(`PLUGIN_BUILD_CONCURRENCY_${tier.toUpperCase()}`);
      // Safe as an environment variable name, like the size suffixes.
      expect(buildConcurrencyEnvVar(tier)).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

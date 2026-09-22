// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin health score: component scoring,
 * missing-input renormalization, the < 3 components null rule, thresholds, and
 * the publisher roll-ups.
 */

import { describe, it, expect } from '@jest/globals';

import {
  ageScore,
  computeHealthScore,
  HEALTH_COMPONENTS,
  HEALTH_WEIGHTS,
  healthBand,
  publisherHealthScore,
  publisherSuccessRate,
  vulnScore,
  type HealthInputs,
} from '../src/types/plugin-health.js';

const NOW = new Date('2026-09-21T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

/** Every component available and perfect. */
const PERFECT: HealthInputs = {
  runs30d: 100,
  successRate30d: 1,
  vulnCritical: 0,
  vulnHigh: 0,
  scannedAt: daysAgo(1),
  lastReleaseAt: daysAgo(10),
  baseImageCreatedAt: daysAgo(10),
  signed: true,
  smokeTestDeclared: true,
  hasReadme: true,
  hasLicense: true,
  ratingBayes: 5,
  ratingCount: 10,
};

describe('HEALTH_WEIGHTS', () => {
  it('sums to 100 and covers every component', () => {
    expect(HEALTH_COMPONENTS.reduce((a, c) => a + HEALTH_WEIGHTS[c], 0)).toBe(100);
  });
});

describe('computeHealthScore', () => {
  it('scores a perfect listing 100 with every component at 1', () => {
    const r = computeHealthScore(PERFECT, NOW);
    expect(r.score).toBe(100);
    for (const c of HEALTH_COMPONENTS) expect(r.breakdown[c]).toEqual({ score: 1, weight: HEALTH_WEIGHTS[c] });
  });

  it('scores 0 when every available component is 0', () => {
    const r = computeHealthScore({
      runs30d: 50,
      successRate30d: 0,
      vulnCritical: 2,
      vulnHigh: 0,
      scannedAt: daysAgo(1),
      lastReleaseAt: daysAgo(600),
      baseImageCreatedAt: daysAgo(400),
      signed: false,
      smokeTestDeclared: false,
      hasReadme: false,
      hasLicense: false,
      ratingBayes: 0,
      ratingCount: 5,
    }, NOW);
    expect(r.score).toBe(0);
  });

  it('returns null with fewer than 3 components', () => {
    expect(computeHealthScore({}, NOW).score).toBeNull();
    expect(computeHealthScore({ signed: true }, NOW).score).toBeNull();
    expect(computeHealthScore({ signed: true, smokeTestDeclared: true }, NOW).score).toBeNull();
    const r = computeHealthScore({ signed: true, smokeTestDeclared: true, hasReadme: true }, NOW);
    expect(r.score).not.toBeNull();
  });

  it('keeps missing components in the breakdown with a null score', () => {
    const r = computeHealthScore({ signed: true, smokeTestDeclared: false, hasReadme: true }, NOW);
    expect(r.breakdown.runtime).toEqual({ score: null, weight: 25 });
    expect(r.breakdown.rating).toEqual({ score: null, weight: 10 });
    expect(r.breakdown.docs).toEqual({ score: 0.5, weight: 10 });
  });

  it('renormalizes over the available weights', () => {
    // signed 1 (10) + smoke 0 (10) + docs 0.5 (10) = 15 / 30 = 50.
    expect(computeHealthScore({ signed: true, smokeTestDeclared: false, hasReadme: true, hasLicense: false }, NOW).score).toBe(50);
    // Adding vulns 1 (20): (10 + 0 + 5 + 20) / 50 = 70.
    expect(computeHealthScore({
      signed: true,
      smokeTestDeclared: false,
      hasReadme: true,
      hasLicense: false,
      scannedAt: daysAgo(1),
      vulnCritical: 0,
      vulnHigh: 0,
    }, NOW).score).toBe(70);
  });

  it('rounds to an integer', () => {
    // runtime 0.9 (25) + signed/smoke/docs 1 (30) = 52.5 / 55 = 95.45… → 95.
    const r = computeHealthScore({ runs30d: 40, successRate30d: 0.9, signed: true, smokeTestDeclared: true, hasReadme: true, hasLicense: true }, NOW);
    expect(r.score).toBe(95);
    expect(Number.isInteger(r.score)).toBe(true);
  });

  describe('runtime', () => {
    it('is missing below 20 runs and present at 20', () => {
      expect(computeHealthScore({ ...PERFECT, runs30d: 19 }, NOW).breakdown.runtime.score).toBeNull();
      expect(computeHealthScore({ ...PERFECT, runs30d: 20, successRate30d: 0.75 }, NOW).breakdown.runtime.score).toBe(0.75);
    });
    it('is missing with no success rate', () => {
      expect(computeHealthScore({ ...PERFECT, successRate30d: null }, NOW).breakdown.runtime.score).toBeNull();
      expect(computeHealthScore({ ...PERFECT, runs30d: null }, NOW).breakdown.runtime.score).toBeNull();
    });
  });

  describe('vulns', () => {
    it('is missing when never scanned', () => {
      expect(computeHealthScore({ ...PERFECT, scannedAt: null }, NOW).breakdown.vulns.score).toBeNull();
    });
    it('subtracts 0.5 per critical and 0.1 per high, floored at 0', () => {
      expect(vulnScore(0, 0)).toBe(1);
      expect(vulnScore(1, 0)).toBe(0.5);
      expect(vulnScore(0, 3)).toBeCloseTo(0.7);
      expect(vulnScore(1, 2)).toBeCloseTo(0.3);
      expect(vulnScore(2, 0)).toBe(0);
      expect(vulnScore(3, 10)).toBe(0);
      expect(vulnScore(0, 10)).toBe(0);
    });
    it('treats null counts on a scanned version as 0', () => {
      expect(computeHealthScore({ ...PERFECT, vulnCritical: null, vulnHigh: null }, NOW).breakdown.vulns.score).toBe(1);
    });
  });

  describe('freshness', () => {
    it('release age: 1 up to 90 days, linear to 0 at 540', () => {
      expect(ageScore(0, 90, 540)).toBe(1);
      expect(ageScore(90, 90, 540)).toBe(1);
      expect(ageScore(315, 90, 540)).toBeCloseTo(0.5);
      expect(ageScore(540, 90, 540)).toBe(0);
      expect(ageScore(900, 90, 540)).toBe(0);
      expect(ageScore(-5, 90, 540)).toBe(1);
    });
    it('uses the release age alone when no base image is recorded', () => {
      const r = computeHealthScore({ ...PERFECT, lastReleaseAt: daysAgo(315), baseImageCreatedAt: null }, NOW);
      expect(r.breakdown.freshness.score).toBeCloseTo(0.5);
    });
    it('averages release and base-image age (base: 1 up to 60 days, 0 at 365)', () => {
      const r = computeHealthScore({ ...PERFECT, lastReleaseAt: daysAgo(10), baseImageCreatedAt: daysAgo(365) }, NOW);
      expect(r.breakdown.freshness.score).toBe(0.5);
      const mid = computeHealthScore({ ...PERFECT, lastReleaseAt: daysAgo(10), baseImageCreatedAt: daysAgo(212.5) }, NOW);
      expect(mid.breakdown.freshness.score).toBeCloseTo(0.75);
    });
    it('uses the base image alone when there is no release date, and is missing with neither', () => {
      expect(computeHealthScore({ ...PERFECT, lastReleaseAt: null, baseImageCreatedAt: daysAgo(30) }, NOW).breakdown.freshness.score).toBe(1);
      expect(computeHealthScore({ ...PERFECT, lastReleaseAt: null, baseImageCreatedAt: null }, NOW).breakdown.freshness.score).toBeNull();
    });
    it('accepts ISO strings', () => {
      expect(computeHealthScore({ ...PERFECT, lastReleaseAt: daysAgo(315).toISOString(), baseImageCreatedAt: undefined }, NOW)
        .breakdown.freshness.score).toBeCloseTo(0.5);
    });
  });

  describe('signed, smoke test, docs', () => {
    it('signed and smoke test are 1/0 flags', () => {
      const r = computeHealthScore({ ...PERFECT, signed: false, smokeTestDeclared: false }, NOW);
      expect(r.breakdown.signed.score).toBe(0);
      expect(r.breakdown.smokeTest.score).toBe(0);
      // 100 − 20 of 100 = 80.
      expect(r.score).toBe(80);
    });
    it('docs: README 0.5 + license 0.5', () => {
      expect(computeHealthScore({ ...PERFECT, hasReadme: true, hasLicense: false }, NOW).breakdown.docs.score).toBe(0.5);
      expect(computeHealthScore({ ...PERFECT, hasReadme: false, hasLicense: true }, NOW).breakdown.docs.score).toBe(0.5);
      expect(computeHealthScore({ ...PERFECT, hasReadme: false, hasLicense: false }, NOW).breakdown.docs.score).toBe(0);
    });
  });

  describe('rating', () => {
    it('is missing below 3 ratings', () => {
      expect(computeHealthScore({ ...PERFECT, ratingCount: 2 }, NOW).breakdown.rating.score).toBeNull();
      expect(computeHealthScore({ ...PERFECT, ratingCount: 3, ratingBayes: 4 }, NOW).breakdown.rating.score).toBe(0.8);
    });
    it('is missing without a Bayesian rating', () => {
      expect(computeHealthScore({ ...PERFECT, ratingBayes: null }, NOW).breakdown.rating.score).toBeNull();
    });
  });
});

describe('publisherHealthScore', () => {
  it('is null with no scored listings', () => {
    expect(publisherHealthScore([])).toBeNull();
    expect(publisherHealthScore([{ healthScore: null, installCount: 10 }])).toBeNull();
  });
  it('is the install-weighted mean, skipping unscored listings', () => {
    expect(publisherHealthScore([
      { healthScore: 90, installCount: 30 },
      { healthScore: 50, installCount: 10 },
      { healthScore: null, installCount: 100 },
    ])).toBe(80);
  });
  it('falls back to the plain mean when nothing is installed', () => {
    expect(publisherHealthScore([{ healthScore: 90, installCount: 0 }, { healthScore: 60, installCount: 0 }])).toBe(75);
  });
});

describe('publisherSuccessRate', () => {
  it('is the run-weighted rate, null with no runs', () => {
    expect(publisherSuccessRate([])).toBeNull();
    expect(publisherSuccessRate([{ successRate30d: null, runs30d: 0 }])).toBeNull();
    expect(publisherSuccessRate([{ successRate30d: 1, runs30d: 30 }, { successRate30d: 0.5, runs30d: 10 }])).toBe(0.875);
  });
});

describe('healthBand', () => {
  it('maps thresholds', () => {
    expect(healthBand(null)).toBe('unknown');
    expect(healthBand(undefined)).toBe('unknown');
    expect(healthBand(100)).toBe('good');
    expect(healthBand(80)).toBe('good');
    expect(healthBand(79)).toBe('fair');
    expect(healthBand(50)).toBe('fair');
    expect(healthBand(49)).toBe('poor');
    expect(healthBand(0)).toBe('poor');
  });
});

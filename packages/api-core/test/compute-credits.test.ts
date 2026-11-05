// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning a CodeBuild action's duration into `cpuCredits` (Phase 4's
 * measurement half).
 *
 * Two properties carry the weight: the rounding has to match the plugin-build
 * meter, because both feed one counter and a counter whose two producers round
 * differently means neither; and an unmeasurable action must come back as
 * UNKNOWN rather than as zero, because zero makes a coverage gap look like
 * idleness.
 */

import { describe, it, expect } from '@jest/globals';
import { CODEBUILD_COMPUTE_VCPU, ComputeType, computeCreditsFor, normalizeComputeType } from '../src/types/pipeline.js';

describe('CODEBUILD_COMPUTE_VCPU', () => {
  it('covers every compute size, with no gaps to fall through', () => {
    for (const size of Object.values(ComputeType)) {
      expect(CODEBUILD_COMPUTE_VCPU[size]).toBeGreaterThan(0);
    }
  });

  it('is monotonic, and records X2_LARGE at thirty-six times SMALL', () => {
    // That ratio is the reason pipeline execution cannot be charged by
    // wall-clock alone, and the reason ingesting it re-derives the ladder.
    expect(CODEBUILD_COMPUTE_VCPU.SMALL).toBe(2);
    expect(CODEBUILD_COMPUTE_VCPU.MEDIUM).toBe(4);
    expect(CODEBUILD_COMPUTE_VCPU.LARGE).toBe(8);
    expect(CODEBUILD_COMPUTE_VCPU.X2_LARGE).toBe(72);
    expect(CODEBUILD_COMPUTE_VCPU.X2_LARGE / CODEBUILD_COMPUTE_VCPU.SMALL).toBe(36);
  });
});

describe('normalizeComputeType', () => {
  it('narrows AWS\'s own spelling to ours', () => {
    expect(normalizeComputeType('BUILD_GENERAL1_SMALL')).toBe('SMALL');
    expect(normalizeComputeType('BUILD_GENERAL1_MEDIUM')).toBe('MEDIUM');
    expect(normalizeComputeType('BUILD_GENERAL1_LARGE')).toBe('LARGE');
    // AWS spells the largest `2XLARGE`; ours is `X2_LARGE`.
    expect(normalizeComputeType('BUILD_GENERAL1_2XLARGE')).toBe('X2_LARGE');
  });

  it('accepts our own spelling unchanged, and is case-insensitive', () => {
    expect(normalizeComputeType('MEDIUM')).toBe('MEDIUM');
    expect(normalizeComputeType('x2_large')).toBe('X2_LARGE');
  });

  it('returns null for anything unrecognised, rather than guessing SMALL', () => {
    // SMALL is the cheapest size and therefore the most flattering guess: a
    // wrong match here prices a build at the wrong vCPU instead of reporting it
    // as unmeasured.
    expect(normalizeComputeType('BUILD_LAMBDA_1GB')).toBeNull();
    expect(normalizeComputeType('HUGE')).toBeNull();
    expect(normalizeComputeType(undefined)).toBeNull();
    expect(normalizeComputeType(null)).toBeNull();
    expect(normalizeComputeType('')).toBeNull();
  });
});

describe('computeCreditsFor', () => {
  it('charges duration x vCPU, rounded UP like the plugin-build meter', () => {
    // Two meters feeding one counter must round the same way.
    expect(computeCreditsFor(600_000, 'SMALL')).toBe(20); // 10 min x 2 vCPU
    expect(computeCreditsFor(600_000, 'MEDIUM')).toBe(40);
    expect(computeCreditsFor(600_000, 'X2_LARGE')).toBe(720);
    expect(computeCreditsFor(1_000, 'SMALL')).toBe(1); // a second still costs a credit
  });

  it('returns NULL, not 0, when the action could not be measured', () => {
    // The distinction is the whole value of the series: zero consumption and
    // unknown consumption look identical on a graph, and a tier ladder
    // re-derived against zeros would be derived from idleness that never happened.
    expect(computeCreditsFor(null, 'SMALL')).toBeNull();
    expect(computeCreditsFor(undefined, 'SMALL')).toBeNull();
    expect(computeCreditsFor(600_000, null)).toBeNull();
    expect(computeCreditsFor(0, 'SMALL')).toBeNull();
    expect(computeCreditsFor(-5, 'SMALL')).toBeNull();
  });
});

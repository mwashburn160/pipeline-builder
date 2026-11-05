// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for queue/build-credits — the CPU-credit meter.
 *
 * The properties that matter are all about NOT charging: the four ways a build
 * must escape a charge are each a distinct defect if they regress, and three of
 * them are silent (nobody reports having been over-billed for a platform retry
 * until they read an invoice).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIncCounter = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: mockIncCounter,
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

const { creditsForBuild, buildSpendsCredits, failedBuildIsCharged, buildTrigger, chargeBuildCredits, BUILDKIT_VCPU } =
  await import('../src/queue/build-credits.js');

const SYSTEM_ORG_ID = (process.env.SYSTEM_ORG_ID || '000000000000000000000001').toLowerCase();

const mockIncrementMetered = jest.fn<AnyFn>().mockResolvedValue({ counted: 1, overshoot: 0 });
const quotaService = { incrementMetered: mockIncrementMetered } as never;

function makeJob(over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    processedOn: 1_000_000,
    finishedOn: 1_000_000 + 60_000, // one wall-minute
    data: { orgId: 'org-1', userId: 'user-1', ...data },
    ...over,
  } as never;
}

describe('creditsForBuild', () => {
  it('is wall-minutes x vCPU, rounded UP to the whole credit', () => {
    // One wall-minute at 1.5 vCPU is 1.5 credits -> 2.
    expect(creditsForBuild(0, 60_000)).toBe(Math.ceil(1 * BUILDKIT_VCPU));
    expect(creditsForBuild(0, 60_000)).toBe(2);
    // Ten wall-minutes is the plan's worked example: 15 credits exactly.
    expect(creditsForBuild(0, 600_000)).toBe(15);
  });

  it('rounds a sub-minute build up rather than to zero', () => {
    // Deliberate, and it has precedent: GitHub bills every job to the minute.
    // Charging 0 would make a fast build free and an infinite loop of fast
    // builds free with it.
    expect(creditsForBuild(0, 1_000)).toBe(1);
  });

  it('charges nothing for an unmeasurable or non-positive duration', () => {
    // A build with no timestamps was not observed. Charging for unobserved work
    // is worse than missing it, and a negative clock skew must not credit back.
    expect(creditsForBuild(undefined, 60_000)).toBe(0);
    expect(creditsForBuild(1_000, undefined)).toBe(0);
    expect(creditsForBuild(60_000, 60_000)).toBe(0);
    expect(creditsForBuild(60_000, 1_000)).toBe(0);
  });

  it('multiplies by the machine size, because that is what a size BUYS', () => {
    // A `2x` build occupies a buildkitd with twice the CPU limit, so the meter
    // charges twice the vCPU-minutes. That keeps the honest outcome in both
    // directions: a build that parallelises finishes in about half the wall
    // time and costs roughly the same, and one that does not costs twice as
    // much. Charging `1x` for a `2x` machine would make the size a free
    // speed-up and the credit a fiction.
    expect(creditsForBuild(0, 600_000, '1x')).toBe(15);
    expect(creditsForBuild(0, 600_000, '2x')).toBe(30);
    expect(creditsForBuild(0, 600_000, '4x')).toBe(60);
  });

  it('defaults to 1x, so a job enqueued without a size is charged as one', () => {
    expect(creditsForBuild(0, 600_000)).toBe(creditsForBuild(0, 600_000, '1x'));
  });
});

describe('buildSpendsCredits — the exemptions', () => {
  it('charges an ordinary org build', () => {
    expect(buildSpendsCredits({ orgId: 'org-1' })).toBe(true);
  });

  it('exempts the SYSTEM org, which is where the sample catalogue loads', () => {
    expect(buildSpendsCredits({ orgId: SYSTEM_ORG_ID })).toBe(false);
  });

  it('exempts a setup-load build, which is the install-time bake', () => {
    // Without these two a fresh install spends its own first budget on its own
    // seed data, and the first thing a new deployment does is run out.
    expect(buildSpendsCredits({ orgId: 'org-1', setupLoad: true })).toBe(false);
  });
});

describe('failedBuildIsCharged — whose fault was it', () => {
  it('charges a PERMANENT failure: tenant content that occupied the pool', () => {
    expect(failedBuildIsCharged('permanent')).toBe(true);
  });

  it('does NOT charge a retryable failure, or an unclassified one', () => {
    // A retryable failure is the platform's (Redis blip, registry timeout), and
    // BullMQ sets processedOn/finishedOn on EVERY attempt — so without this a
    // job retried to exhaustion charges once per attempt.
    expect(failedBuildIsCharged('retryable')).toBe(false);
    expect(failedBuildIsCharged(undefined)).toBe(false);
  });
});

describe('buildTrigger', () => {
  it('is automation for a key-driven build and user otherwise', () => {
    expect(buildTrigger({ publish: { caller: { principalType: 'service_account' } } } as never)).toBe('automation');
    expect(buildTrigger({ publish: { caller: { principalType: 'api_key' } } } as never)).toBe('automation');
    expect(buildTrigger({ publish: { caller: { principalType: 'user' } } } as never)).toBe('user');
    expect(buildTrigger({} as never)).toBe('user');
  });
});

describe('chargeBuildCredits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIncrementMetered.mockResolvedValue({ counted: 1, overshoot: 0 });
  });

  it('charges the credits as ONE metered increment carrying an amount', async () => {
    await chargeBuildCredits(quotaService, makeJob(), 'success');
    expect(mockIncrementMetered).toHaveBeenCalledTimes(1);
    const [orgId, type, , groups] = mockIncrementMetered.mock.calls[0] as unknown[];
    expect({ orgId, type }).toEqual({ orgId: 'org-1', type: 'cpuCredits' });
    // One call with an amount, not N calls of one unit: `incrementQuota` adds a
    // single unit per call and a build charges many.
    expect(groups).toEqual([expect.objectContaining({ amount: 2 })]);
  });

  it('attributes the spend so the ledger can answer "where did our budget go"', async () => {
    await chargeBuildCredits(quotaService, makeJob({}, { publish: { caller: { principalType: 'service_account' } } }), 'success');
    const groups = (mockIncrementMetered.mock.calls[0] as unknown[])[3] as Array<{ attribution: Record<string, unknown> }>;
    expect(groups[0].attribution).toEqual(expect.objectContaining({
      route: 'BUILD plugin',
      // Class and size ride along: a tenant surprised by their burn is usually
      // surprised by a `4x` or by automation, and the ledger answers both
      // without a second lookup.
      feature: 'build:automation:standard:1x',
    }));
  });

  it('labels the charge with class and size, so a 4x burn is separable from a 1x one', async () => {
    const data = { buildClass: 'flexible' as const, buildSize: '4x' as const };
    await chargeBuildCredits(quotaService, makeJob({}, data), 'success');

    expect(mockIncCounter).toHaveBeenCalledWith('cpu_credits_charged_total', {
      org_id: 'org-1', outcome: 'success', build_class: 'flexible', build_size: '4x',
    });
    const groups = (mockIncrementMetered.mock.calls[0] as unknown[])[3] as Array<{ amount: number; attribution: Record<string, unknown> }>;
    // 60s of wall clock at 1.5 vCPU x4 = 6 credits, not 2.
    expect(groups[0].amount).toBe(6);
    expect(groups[0].attribution.feature).toBe('build:user:flexible:4x');
  });

  it('counts the charge for comparison against the duration histogram', async () => {
    await chargeBuildCredits(quotaService, makeJob(), 'success');
    expect(mockIncCounter).toHaveBeenCalledWith('cpu_credits_charged_total', { org_id: 'org-1', outcome: 'success', build_class: 'standard', build_size: '1x' });
  });

  it('charges nothing — and counts nothing — for an exempt build', async () => {
    await chargeBuildCredits(quotaService, makeJob({}, { orgId: SYSTEM_ORG_ID }), 'success');
    await chargeBuildCredits(quotaService, makeJob({}, { setupLoad: true }), 'success');
    expect(mockIncrementMetered).not.toHaveBeenCalled();
    expect(mockIncCounter).not.toHaveBeenCalled();
  });

  it('charges a permanent failure and skips a retryable one', async () => {
    await chargeBuildCredits(quotaService, makeJob({}, { failureCategory: 'retryable' }), 'failed');
    expect(mockIncrementMetered).not.toHaveBeenCalled();

    await chargeBuildCredits(quotaService, makeJob({}, { failureCategory: 'permanent' }), 'failed');
    expect(mockIncrementMetered).toHaveBeenCalledTimes(1);
    expect(mockIncCounter).toHaveBeenCalledWith('cpu_credits_charged_total', { org_id: 'org-1', outcome: 'failed', build_class: 'standard', build_size: '1x' });
  });

  it('never throws when the quota service refuses, because a build cannot be un-run', async () => {
    mockIncrementMetered.mockRejectedValueOnce(new Error('quota down'));
    await expect(chargeBuildCredits(quotaService, makeJob(), 'success')).resolves.toBeUndefined();
    // The counter still fired, so the under-count is visible against the
    // duration histogram rather than silent.
    expect(mockIncCounter).toHaveBeenCalledWith('cpu_credits_charged_total', { org_id: 'org-1', outcome: 'success', build_class: 'standard', build_size: '1x' });
  });

  it('charges nothing for a job with no timestamps', async () => {
    await chargeBuildCredits(quotaService, makeJob({ processedOn: undefined, finishedOn: undefined }), 'success');
    expect(mockIncrementMetered).not.toHaveBeenCalled();
  });
});

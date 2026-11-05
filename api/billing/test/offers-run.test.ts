// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The seam between a decision and the copy it is stated in
 * (docs/plans/sales-agent.md Phase 3).
 *
 * `emailFactsFor` is where a decision becomes something an account can read, and
 * the failure worth guarding is quiet: facts assembled with `used`/`limit` of
 * zero render as "0 of 0 pipelines" — a sent offer that says nothing. So the
 * assertions are about the FIGURES surviving, and about the function refusing
 * when there is no priceable pack rather than inventing one.
 */

import { describe, it, expect } from '@jest/globals';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-run';

const { emailFactsFor } = await import('../src/helpers/offers-run.js');
const { offerEmailText } = await import('../src/helpers/offers-notify.js');

type Input = Parameters<typeof emailFactsFor>[0];

const PACK = {
  id: 'pipeline_pack',
  name: 'Pipeline pack',
  grants: { pipelines: 10 },
  stackable: true,
  prices: { monthly: 1199, annual: 11_990 },
  availableForTiers: ['pro', 'team'],
};

const BYTE_PACK = {
  id: 'storage_pack',
  name: 'Storage pack',
  // A byte dimension: the grant must be shown in GB, not in bytes.
  grants: { storageBytes: 50 * 1024 * 1024 * 1024 },
  stackable: true,
  prices: { monthly: 900, annual: 9_000 },
  availableForTiers: ['pro'],
};

function dim(ratio: number, used: number, limit: number) {
  return { ratio, crossed: null, used, limit };
}

function input(over: Partial<Input> = {}): Input {
  return {
    decision: {
      orgId: 'org-1',
      chosen: { offerType: 'pack', valueCents: 11_990, probability: 0.3, rationale: ['sustained_pressure'] },
      status: 'sent',
      holdout: false,
      expiresAt: new Date('2026-12-01T00:00:00Z'),
    },
    profiles: [{
      period: '2026-11-01',
      dimensions: { pipelines: dim(0.9, 9, 10) },
      addonsHeld: [],
      subscriptionAgeDays: 400,
      complete: true,
    }],
    crossover: { candidateTier: null, savingCents: 0 },
    bundles: [PACK],
    tier: 'pro',
    interval: 'monthly',
    ...over,
  } as Input;
}

describe('a decision becomes facts an account can check', () => {
  it('carries the REAL used/limit through, so the copy can name them', () => {
    const facts = emailFactsFor(input())!;
    expect(facts.pressure[0]).toEqual({ dimension: 'pipelines', used: 9, limit: 10 });
    // The guard that matters: these figures reaching the copy as zeroes would
    // produce a sent offer reading "0 of 0 pipelines".
    expect(offerEmailText(facts)!.text).toContain('9 of 10 pipelines');
  });

  it('quotes the pack at the account\'s own interval', () => {
    expect(emailFactsFor(input({ interval: 'annual' }))!.pack!.priceCents).toBe(11_990);
    expect(emailFactsFor(input())!.pack!.priceCents).toBe(1199);
  });

  it('shows a byte grant in GB, as the quota card does', () => {
    const facts = emailFactsFor(input({
      profiles: [{
        period: '2026-11-01',
        dimensions: { storageBytes: dim(0.95, 1, 2) },
        addonsHeld: [],
        subscriptionAgeDays: 400,
        complete: true,
      }],
      bundles: [BYTE_PACK],
    }))!;
    expect(facts.pack!.grantDisplay).toBe('50 GB');
  });

  it('orders pressure strongest first', () => {
    const facts = emailFactsFor(input({
      profiles: [{
        period: '2026-11-01',
        dimensions: { pipelines: dim(0.82, 8, 10), plugins: dim(0.99, 99, 100) },
        addonsHeld: [],
        subscriptionAgeDays: 400,
        complete: true,
      }],
      bundles: [PACK, { ...PACK, id: 'plugin_pack', name: 'Plugin pack', grants: { plugins: 10 } }],
    }))!;
    expect(facts.pressure.map((p) => p.dimension)).toEqual(['plugins', 'pipelines']);
  });

  it('skips a dimension with no finite limit — a ratio against nothing is not pressure', () => {
    const facts = emailFactsFor(input({
      profiles: [{
        period: '2026-11-01',
        dimensions: { pipelines: dim(0.9, 9, 10), apiCalls: dim(0.95, 100, 0) },
        addonsHeld: [],
        subscriptionAgeDays: 400,
        complete: true,
      }],
    }))!;
    expect(facts.pressure.map((p) => p.dimension)).toEqual(['pipelines']);
  });

  it('refuses when nothing in the catalogue is sold to this tier', () => {
    // Zero is the correct answer and the offer is then not stated at all,
    // rather than stated without a price.
    expect(emailFactsFor(input({ tier: 'developer' }))).toBeNull();
  });

  it('refuses when the decision chose nothing', () => {
    expect(emailFactsFor(input({
      decision: { orgId: 'org-1', chosen: null, status: 'suppressed', reason: 'no_rule_matched', holdout: false },
    }))).toBeNull();
  });

  it('builds crossover facts from the BILL, with no pack', () => {
    const facts = emailFactsFor(input({
      decision: {
        orgId: 'org-1',
        chosen: { offerType: 'upgrade', valueCents: 36_000, probability: 0.4, rationale: ['crossover'], targetTier: 'business' },
        status: 'sent',
        holdout: false,
      },
      crossover: { candidateTier: 'business', savingCents: 2_996 },
    }))!;
    expect(facts.offerType).toBe('upgrade');
    expect(facts.savingCents).toBe(2_996);
    expect(facts.pack).toBeUndefined();
  });

  it('still produces crossover facts when NOTHING is under pressure', () => {
    // The crossover's argument is the bill, not a limit: an account paying more
    // in packs than the next tier costs is worth telling even at 20% usage.
    const facts = emailFactsFor(input({
      decision: {
        orgId: 'org-1',
        chosen: { offerType: 'upgrade', valueCents: 36_000, probability: 0.4, rationale: ['crossover'] },
        status: 'sent',
        holdout: false,
      },
      profiles: [{
        period: '2026-11-01',
        dimensions: { pipelines: dim(0.2, 2, 10) },
        addonsHeld: [],
        subscriptionAgeDays: 400,
        complete: true,
      }],
      crossover: { candidateTier: 'business', savingCents: 2_996 },
    }))!;
    expect(facts.pressure).toEqual([]);
    expect(offerEmailText(facts)).not.toBeNull();
  });
});

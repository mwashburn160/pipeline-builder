// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  QUOTA_TIERS,
  VALID_TIERS,
  DEFAULT_TIER,
  isValidTier,
  getTierLimits,
  nextQuotaResetDate,
  quotaPeriodDays,
  CPU_CREDITS_PERIOD_DAYS,
  QUOTA_RESET_DAYS,
  SEAT_PACK_TIERS,
  STANDARD_TIERS,
  seatRemedy,
  automationCallsFor,
  enforcedQuotaLimit,
} from '../src/types/quota-tiers.js';
import { DEFAULT_TIER_LIMITS, tierLabel } from '../src/types/tier-limits.js';
import { VALID_QUOTA_TYPES } from '../src/types/common.js';
import { quotaAccrual } from '../src/types/quota-catalog.js';

// storageBytes sized per tier. Tiers: developer / pro / team / enterprise.
const GB = 1024 * 1024 * 1024;

describe('QUOTA_TIERS', () => {
  it('should define developer tier', () => {
    expect(QUOTA_TIERS.developer).toEqual({
      label: 'Developer',
      // aiCalls is sized smaller than apiCalls because each AI call has
      // external dollar cost; see quota-tiers.ts for rationale.
      // Count caps on user-editable feature tables added to close per-org
      // DoS via spam (dashboards / alertRules / alertDestinations / idpConfigs).
      limits: {
        plugins: 10,
        pipelines: 2,
        apiCalls: 25_000,
        automationCalls: 30_000,
        aiCalls: 20,
        cpuCredits: 4_500,
        storageBytes: 2 * GB,
        dashboards: 20,
        alertRules: 50,
        alertDestinations: 10,
        idpConfigs: 1,
        listings: 3,
        seats: 1,
        supportContacts: 0,
        supportPremiumContacts: 0,
        eventRetentionDays: 30,
        doraRetentionDays: 180,
      },
    });
  });

  it('should define pro tier', () => {
    expect(QUOTA_TIERS.pro).toEqual({
      label: 'Pro',
      limits: {
        plugins: 25,
        pipelines: 5,
        apiCalls: 100_000,
        automationCalls: 60_000,
        aiCalls: 200,
        cpuCredits: 11_250,
        storageBytes: 25 * GB,
        dashboards: 200,
        alertRules: 500,
        alertDestinations: 50,
        idpConfigs: 5,
        listings: 10,
        seats: 1,
        supportContacts: 0,
        supportPremiumContacts: 0,
        eventRetentionDays: 30,
        doraRetentionDays: 180,
      },
    });
  });

  it('should define team tier', () => {
    expect(QUOTA_TIERS.team).toEqual({
      label: 'Team',
      limits: {
        plugins: 50,
        pipelines: 10,
        apiCalls: 300_000,
        automationCalls: 110_000,
        aiCalls: 600,
        cpuCredits: 22_500,
        storageBytes: 60 * GB,
        dashboards: -1,
        alertRules: -1,
        alertDestinations: -1,
        idpConfigs: 5,
        listings: 25,
        seats: 3,
        supportContacts: 0,
        supportPremiumContacts: 0,
        eventRetentionDays: 30,
        doraRetentionDays: 180,
      },
    });
  });

  it('should define business tier', () => {
    expect(QUOTA_TIERS.business).toEqual({
      label: 'Business',
      // 100,000 apiCalls and 200 aiCalls PER SEAT — the same per-seat rate as
      // Pro/Team/Enterprise, which is the property that makes the ladder read
      // consistently to a buyer who divides by headcount.
      limits: {
        plugins: 100,
        pipelines: 20,
        apiCalls: 800_000,
        automationCalls: 210_000,
        aiCalls: 1_600,
        cpuCredits: 45_000,
        storageBytes: 120 * GB,
        dashboards: -1,
        alertRules: -1,
        alertDestinations: -1,
        idpConfigs: 10,
        listings: 50,
        seats: 8,
        supportContacts: 0,
        supportPremiumContacts: 0,
        eventRetentionDays: 30,
        doraRetentionDays: 180,
      },
    });
  });

  it('should define enterprise tier', () => {
    expect(QUOTA_TIERS.enterprise).toEqual({
      label: 'Enterprise',
      limits: {
        plugins: 150,
        pipelines: 30,
        apiCalls: 1_500_000,
        automationCalls: 310_000,
        aiCalls: 3_000,
        cpuCredits: 67_500,
        storageBytes: 250 * GB,
        dashboards: -1,
        alertRules: -1,
        alertDestinations: -1,
        idpConfigs: -1,
        listings: 100,
        seats: 15,
        supportContacts: 0,
        supportPremiumContacts: 0,
        eventRetentionDays: 30,
        doraRetentionDays: 180,
      },
    });
  });

  it('unlimited tier has EVERY quota uncapped (-1)', () => {
    // The billing-DISABLED default tier must meter nothing. Assert every limit
    // field (derived from the shape, so a newly-added quota is covered too) is
    // exactly -1. tierLimits() hardcodes this for `unlimited` and bypasses the
    // QUOTA_TIER_UNLIMITED_* env reads, so no override can cap it.
    const limits = QUOTA_TIERS.unlimited.limits as unknown as Record<string, number>;
    const keys = Object.keys(limits);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(limits[k]).toBe(-1);
    }
  });
});

describe('VALID_TIERS', () => {
  it('should contain all tier names', () => {
    expect(VALID_TIERS).toContain('developer');
    expect(VALID_TIERS).toContain('pro');
    expect(VALID_TIERS).toContain('team');
    expect(VALID_TIERS).toContain('business');
    expect(VALID_TIERS).toContain('enterprise');
    // `unlimited` is a valid stored tier (billing-off default) but not a
    // standard/selectable one — see STANDARD_TIERS.
    expect(VALID_TIERS).toContain('unlimited');
    expect(VALID_TIERS).toHaveLength(6);
  });
});

describe('DEFAULT_TIER', () => {
  it('should be developer', () => {
    expect(DEFAULT_TIER).toBe('developer');
  });
});

describe('isValidTier', () => {
  it('should return true for valid tiers', () => {
    expect(isValidTier('developer')).toBe(true);
    expect(isValidTier('pro')).toBe(true);
    expect(isValidTier('team')).toBe(true);
    expect(isValidTier('business')).toBe(true);
    expect(isValidTier('enterprise')).toBe(true);
  });

  it('should return false for invalid tiers', () => {
    expect(isValidTier('free')).toBe(false);
    expect(isValidTier('basic')).toBe(false);
    expect(isValidTier('')).toBe(false);
    expect(isValidTier('Developer')).toBe(false);
  });
});

describe('getTierLimits', () => {
  const developerLimits = {
    plugins: 10,
    pipelines: 2,
    apiCalls: 25_000,
    automationCalls: 30_000,
    aiCalls: 20,
    cpuCredits: 4_500,
    storageBytes: 2 * GB,
    dashboards: 20,
    alertRules: 50,
    alertDestinations: 10,
    idpConfigs: 1,
    listings: 3,
    seats: 1,
    supportContacts: 0,
    supportPremiumContacts: 0,
    eventRetentionDays: 30,
    doraRetentionDays: 180,
  };
  it('should return limits for valid tiers', () => {
    expect(getTierLimits('developer')).toEqual(developerLimits);
    expect(getTierLimits('pro')).toEqual({
      plugins: 25,
      pipelines: 5,
      apiCalls: 100_000,
      automationCalls: 60_000,
      aiCalls: 200,
      cpuCredits: 11_250,
      storageBytes: 25 * GB,
      dashboards: 200,
      alertRules: 500,
      alertDestinations: 50,
      idpConfigs: 5,
      listings: 10,
      seats: 1,
      supportContacts: 0,
      supportPremiumContacts: 0,
      eventRetentionDays: 30,
      doraRetentionDays: 180,
    });
    expect(getTierLimits('team')).toEqual({
      plugins: 50,
      pipelines: 10,
      apiCalls: 300_000,
      automationCalls: 110_000,
      aiCalls: 600,
      cpuCredits: 22_500,
      storageBytes: 60 * GB,
      dashboards: -1,
      alertRules: -1,
      alertDestinations: -1,
      idpConfigs: 5,
      listings: 25,
      seats: 3,
      supportContacts: 0,
      supportPremiumContacts: 0,
      eventRetentionDays: 30,
      doraRetentionDays: 180,
    });
    expect(getTierLimits('enterprise')).toEqual({
      plugins: 150,
      pipelines: 30,
      apiCalls: 1_500_000,
      automationCalls: 310_000,
      aiCalls: 3_000,
      cpuCredits: 67_500,
      storageBytes: 250 * GB,
      dashboards: -1,
      alertRules: -1,
      alertDestinations: -1,
      idpConfigs: -1,
      listings: 100,
      seats: 15,
      supportContacts: 0,
      supportPremiumContacts: 0,
      eventRetentionDays: 30,
      doraRetentionDays: 180,
    });
  });

  it('should fall back to developer limits for invalid tiers', () => {
    expect(getTierLimits('invalid')).toEqual(developerLimits);
    expect(getTierLimits('')).toEqual(developerLimits);
  });
});

describe('nextQuotaResetDate', () => {
  it('is local midnight N days out (default QUOTA_RESET_DAYS)', () => {
    const now = new Date(2026, 0, 10, 15, 30);
    expect(nextQuotaResetDate(3, now)).toEqual(new Date(2026, 0, 13, 0, 0, 0, 0));
    expect(nextQuotaResetDate(undefined, now)).toEqual(new Date(2026, 0, 10 + QUOTA_RESET_DAYS, 0, 0, 0, 0));
  });
});

describe('seatRemedy — what an account out of seats can do', () => {
  it('offers a seat pack only where billing sells one (Team, Enterprise)', () => {
    expect(seatRemedy('team')).toBe('seat_pack');
    expect(seatRemedy('business')).toBe('seat_pack');
    expect(seatRemedy('enterprise')).toBe('seat_pack');
  });

  it('offers an UPGRADE on the single-seat tiers, which cannot buy seats', () => {
    // Pointing a Developer/Pro admin at "add a seat pack" sends them to an
    // add-on billing will not sell them (the `seat` bundle is Team+ only).
    expect(seatRemedy('developer')).toBe('upgrade');
    expect(seatRemedy('pro')).toBe('upgrade');
  });

  it('says nothing for an uncapped or unknown tier rather than guess', () => {
    expect(seatRemedy('unlimited')).toBeNull();
    expect(seatRemedy(undefined)).toBeNull();
    expect(seatRemedy(null)).toBeNull();
    expect(seatRemedy('bogus')).toBeNull();
  });

  it('every standard tier is either seat-pack capable or must upgrade', () => {
    for (const tier of STANDARD_TIERS) expect([tier, seatRemedy(tier)]).not.toEqual([tier, null]);
    expect(SEAT_PACK_TIERS.every((t) => STANDARD_TIERS.includes(t))).toBe(true);
  });
});

describe('automationCalls sizing — the table is the formula', () => {
  it('every standard tier\'s default is automationCallsFor(its pipelines)', () => {
    // The itemized per-run count (lookups, synth, runtime check, security
    // upload, register, ingest batches) + heartbeats, × headroom, rounded up.
    const off = STANDARD_TIERS
      .map((t) => ({ t, have: QUOTA_TIERS[t].limits.automationCalls, want: automationCallsFor(QUOTA_TIERS[t].limits.pipelines) }))
      .filter(({ have, want }) => have !== want);
    expect(off).toEqual([]);
  });

  it('scales with the period length', () => {
    expect(automationCallsFor(5, 6)).toBeGreaterThan(automationCallsFor(5, 3));
  });
});

describe('enforcedQuotaLimit — the automationCalls soft band', () => {
  it('adds the grace band to automationCalls only', () => {
    expect(enforcedQuotaLimit('automationCalls', 60_000, 10)).toBe(66_000);
    expect(enforcedQuotaLimit('automationCalls', 7, 10)).toBe(7); // floor(7.7)
    expect(enforcedQuotaLimit('apiCalls', 60_000, 10)).toBe(60_000);
    expect(enforcedQuotaLimit('aiCalls', 200, 10)).toBe(200);
  });

  it('leaves unlimited, zero and a disabled band alone', () => {
    expect(enforcedQuotaLimit('automationCalls', -1, 10)).toBe(-1);
    expect(enforcedQuotaLimit('automationCalls', 0, 10)).toBe(0);
    expect(enforcedQuotaLimit('automationCalls', 60_000, 0)).toBe(60_000);
  });

  it('defaults to a 10% band (QUOTA_AUTOMATION_GRACE_PCT)', () => {
    expect(enforcedQuotaLimit('automationCalls', 1000)).toBe(1100);
  });
});

describe('quotaPeriodDays — the period is PER TYPE', () => {
  /**
   * The factor-of-ten trap. Every flow quota but one rolls on the global
   * three-day window; `cpuCredits` is monthly. Anything that seeds a counter,
   * computes a reset date or extrapolates a burn rate has to ask for the type's
   * own period, and the failure is SILENT in the customer's favour: a counter
   * reset ten times too often simply never refuses anything, so nothing
   * complains and the cap does not bind.
   */
  it('gives cpuCredits its own monthly window', () => {
    expect(quotaPeriodDays('cpuCredits')).toBe(CPU_CREDITS_PERIOD_DAYS);
    expect(CPU_CREDITS_PERIOD_DAYS).toBe(30);
    // The whole point: it must NOT be the global window.
    expect(quotaPeriodDays('cpuCredits')).not.toBe(QUOTA_RESET_DAYS);
  });

  it('gives every other quota type the global window', () => {
    const odd = VALID_QUOTA_TYPES
      .filter((t) => t !== 'cpuCredits')
      .filter((t) => quotaPeriodDays(t) !== QUOTA_RESET_DAYS);
    expect(odd).toEqual([]);
  });

  it('returns a usable positive period for every type, stocks included', () => {
    // Stocks have no period; the accessor still returns the global window for
    // them because callers gate on `quotaAccrual(t) === 'stock'` first, and a
    // zero or negative would divide by nothing in a forecast that forgot to.
    const bad = VALID_QUOTA_TYPES.filter((t) => !(quotaPeriodDays(t) > 0));
    expect(bad).toEqual([]);
  });

  it('agrees with the catalog: only a FLOW may have a non-global period', () => {
    const wrong = VALID_QUOTA_TYPES
      .filter((t) => quotaPeriodDays(t) !== QUOTA_RESET_DAYS)
      .filter((t) => quotaAccrual(t) !== 'flow');
    expect(wrong).toEqual([]);
  });
});

describe('the QUOTA_TIER_<TIER>_<LIMIT> knob names', () => {
  /**
   * The names an operator sets are DERIVED from the limit field names
   * (`apiCalls` → `QUOTA_TIER_PRO_API_CALLS`), which replaced seventeen
   * hand-written lines. The derivation is the point of this test: a field rename
   * would silently move a knob somebody already has set in a `.env`, and nothing
   * else in the build would say a word — the old hand-written lines at least made
   * the rename a visible edit.
   *
   * So this freezes the full set. Changing it is allowed; changing it by accident
   * is not. `docs/environment-variables.md` documents the family as a pattern,
   * because a computed name is invisible to the env-docs scanner.
   */
  const SUFFIXES = [
    'PLUGINS', 'PIPELINES', 'API_CALLS', 'AUTOMATION_CALLS', 'AI_CALLS', 'STORAGE_BYTES',
    'CPU_CREDITS', 'DASHBOARDS', 'ALERT_RULES', 'ALERT_DESTINATIONS', 'IDP_CONFIGS',
    'LISTINGS', 'SEATS', 'SUPPORT_CONTACTS', 'SUPPORT_PREMIUM_CONTACTS',
    'EVENT_RETENTION_DAYS', 'DORA_RETENTION_DAYS',
  ];

  it('covers every limit field, with no field left unconfigurable', () => {
    // Derived here independently of the implementation — same rule, separate
    // spelling — so this compares the frozen list against the real field set
    // rather than against the production code's own output.
    const derived = Object.keys(DEFAULT_TIER_LIMITS.developer)
      .map((f) => f.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    expect(derived.sort()).toEqual([...SUFFIXES].sort());
  });

  it('spells every tier of the ladder', () => {
    // The other half of the name. `unlimited` is included deliberately: it is a
    // valid tier whose limits are NOT env-overridable, and the exclusion lives in
    // `tierLimits`, not in the name derivation.
    expect(VALID_TIERS.map((t) => t.toUpperCase())).toEqual([
      'DEVELOPER', 'PRO', 'TEAM', 'BUSINESS', 'ENTERPRISE', 'UNLIMITED',
    ]);
  });
});

describe('tierLabel', () => {
  it('title-cases a single-word key', () => {
    expect(tierLabel('developer')).toBe('Developer');
    expect(tierLabel('unlimited')).toBe('Unlimited');
  });

  it('splits a multi-word key on _ or - instead of shouting it', () => {
    // The point of the function over a bare `charAt(0).toUpperCase()`, which
    // rendered a hypothetical `pro_plus` tier as "Pro_plus".
    expect(tierLabel('pro_plus')).toBe('Pro Plus');
    expect(tierLabel('team-annual')).toBe('Team Annual');
    expect(tierLabel('business_critical_24')).toBe('Business Critical 24');
  });

  it('names every real tier', () => {
    // Not compared against `QUOTA_TIERS[t].label`: that honours
    // `QUOTA_TIER_<TIER>_LABEL`, so the comparison would depend on the ambient
    // environment. This asserts the derivation covers the ladder.
    for (const tier of VALID_TIERS) {
      expect({ tier, label: tierLabel(tier) }).toEqual({ tier, label: expect.stringMatching(/^[A-Z]/) });
    }
  });

  it('does NOT invent an acronym or a stylized name — that is the override\'s job', () => {
    // Pinned deliberately: these outputs are WRONG as product copy, and a
    // deployment selling such a tier sets `QUOTA_TIER_<TIER>_LABEL`. Asserting
    // the wrong-but-documented output stops someone "fixing" it with a list of
    // special cases that then drifts from whatever is actually being sold.
    expect(tierLabel('sso')).toBe('Sso');
    expect(tierLabel('pro_plus')).not.toBe('Pro+');
  });

  it('survives a degenerate key rather than throwing', () => {
    expect(tierLabel('')).toBe('');
    expect(tierLabel('__pro__')).toBe('Pro');
  });
});

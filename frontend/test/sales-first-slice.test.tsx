// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The "first slice" of docs/plans/sales-agent.md — the three surfaces that need
 * no agent, no campaign, no discount and (for two of them) no consent, because
 * they are INFORMATION rather than solicitation:
 *
 *  - F1 `PlanChangeModal` prices the change, discount included. A PREREQUISITE:
 *    without it an account that accepts a 50%-off offer sees the list price, and
 *    every discounted offer is a promise the checkout contradicts.
 *  - F2 the quota card says what the limit costs.
 *  - F3 the crossover: the account's real spend against the next tier.
 *
 * The failure mode each guards against is a wrong number reaching a customer, so
 * the fail-open paths are asserted as hard as the happy ones.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor, within } from '@testing-library/react';

const getPlanPreview = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({ __esModule: true, default: { getPlanPreview: (...a: unknown[]) => getPlanPreview(...a) } }));

// Static imports, because the frontend transpiles to CommonJS and `jest.mock`
// above is HOISTED by babel — top-level `await import` is a syntax error here,
// unlike in the ESM service suites.
import { packForQuota } from '../src/lib/quota-pack-offer';
import { QuotaPackHint } from '../src/components/quotas/QuotaCard';
import { CrossoverCard } from '../src/components/quotas/CrossoverCard';
import { PlanChangeModal } from '../src/components/billing/PlanChangeModal';

type Bundle = Parameters<typeof packForQuota>[1][number];

const PACK: Bundle = {
  id: 'plugin_pack', name: 'Plugin Pack', description: '', grants: { plugins: 10 },
  prices: { monthly: 1199, annual: 11990 }, stackable: true,
  availableForTiers: ['developer', 'pro', 'team', 'business', 'enterprise'],
} as Bundle;

const BIGGER: Bundle = { ...PACK, id: 'pipeline_pack', name: 'Pipeline Pack', grants: { plugins: 25 }, prices: { monthly: 2999, annual: 29990 } } as Bundle;

function quota(over: Record<string, unknown> = {}) {
  return { used: 9, limit: 10, remaining: 1, unlimited: false, resetAt: '2026-12-01T00:00:00.000Z', periodDays: 3, ...over } as never;
}

describe('F2 — packForQuota picks what to quote', () => {
  it('takes the CHEAPEST pack granting the dimension, not the largest', () => {
    // The card answers "what would it cost to not run out"; the smallest honest
    // answer is the one that makes the sentence useful.
    expect(packForQuota('plugins', [BIGGER, PACK], 'monthly')?.bundleId).toBe('plugin_pack');
  });

  it('quotes in the interval asked for', () => {
    expect(packForQuota('plugins', [PACK], 'annual')?.priceCents).toBe(11990);
  });

  it('never quotes a pack this tier cannot buy', () => {
    const proOnly = { ...PACK, availableForTiers: ['business'] } as Bundle;
    expect(packForQuota('plugins', [proOnly], 'monthly', 'developer')).toBeNull();
    expect(packForQuota('plugins', [proOnly], 'monthly', 'business')).not.toBeNull();
  });

  it('ignores a free pack and a non-stackable bundle', () => {
    // "$0" reads as a bug rather than a bargain, and a feature bundle that
    // happens to carry a grant is not "a pack of N".
    expect(packForQuota('plugins', [{ ...PACK, prices: { monthly: 0, annual: 0 } } as Bundle], 'monthly')).toBeNull();
    expect(packForQuota('plugins', [{ ...PACK, stackable: false } as Bundle], 'monthly')).toBeNull();
  });

  it('converts to the display unit, so storage reads in GB not bytes', () => {
    const GB = 1024 ** 3;
    const storage = { ...PACK, id: 'storage_pack', grants: { storageBytes: 10 * GB } } as Bundle;
    const offer = packForQuota('storageBytes', [storage], 'monthly');
    expect(offer).toMatchObject({ grantDisplay: 10, unitName: 'GB' });
  });

  it('returns null when nothing in the catalogue grants the dimension', () => {
    expect(packForQuota('apiCalls', [PACK], 'monthly')).toBeNull();
    expect(packForQuota('plugins', [], 'monthly')).toBeNull();
  });
});

describe('F2 — the card only says the price when it is information', () => {
  it('states the pack and its price once the quota is in the warning band', () => {
    render(<QuotaPackHint quotaKey="plugins" quota={quota()} bundles={[PACK]} />);
    const hint = screen.getByTestId('quota-pack-hint-plugins');
    expect(hint).toHaveTextContent('Plugin Pack adds 10 for $11.99/month');
  });

  it('says nothing at 10%, where a price is an advertisement rather than information', () => {
    const { container } = render(<QuotaPackHint quotaKey="plugins" quota={quota({ used: 1, remaining: 9 })} bundles={[PACK]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing for an unlimited quota, or when the catalogue could not be read', () => {
    // A failed bundles fetch must cost the card nothing.
    const { container: a } = render(<QuotaPackHint quotaKey="plugins" quota={quota({ unlimited: true, limit: -1 })} bundles={[PACK]} />);
    expect(a).toBeEmptyDOMElement();
    const { container: b } = render(<QuotaPackHint quotaKey="plugins" quota={quota()} bundles={[]} />);
    expect(b).toBeEmptyDOMElement();
    const { container: c } = render(<QuotaPackHint quotaKey="plugins" quota={quota()} />);
    expect(c).toBeEmptyDOMElement();
  });
});

describe('F3 — the crossover card', () => {
  const verdict = {
    crossover: true, tier: 'team' as const, interval: 'monthly' as const,
    currentCents: 27896, candidateTier: 'business' as const, candidateCents: 24900,
    savingCents: 2996, retiredAddons: ['seat'], autoPrunedAddons: [],
    dropRequiredAddons: ['seat'], savingRequiresDrops: true, keptAddons: [],
  };

  it('states both figures and the saving', () => {
    render(<CrossoverCard crossover={verdict} />);
    const card = screen.getByTestId('crossover-card');
    expect(card).toHaveTextContent('$278.96');
    expect(card).toHaveTextContent('$249.00');
    expect(card).toHaveTextContent('$29.96');
  });

  it('says the saving is CONDITIONAL on dropping the packs', () => {
    // The expensive failure: a plan change does not retire a resource pack, so
    // an account that upgrades and does nothing else pays MORE.
    render(<CrossoverCard crossover={verdict} />);
    const card = screen.getByTestId('crossover-card');
    expect(card).toHaveTextContent('does not remove it for you');
    expect(card).toHaveTextContent('would cost more than you pay today');
  });

  it('omits the condition when the move retires everything by itself', () => {
    render(<CrossoverCard crossover={{ ...verdict, savingRequiresDrops: false, dropRequiredAddons: [], autoPrunedAddons: ['seat'] }} />);
    expect(screen.getByTestId('crossover-card')).not.toHaveTextContent('does not remove');
  });

  it('renders NOTHING when there is no crossover, whatever the reason', () => {
    for (const reason of ['no_addons', 'top_tier', 'nothing_cheaper', 'would_regress'] as const) {
      const { container } = render(<CrossoverCard crossover={{ ...verdict, crossover: false, candidateTier: null, reason }} />);
      // `would_regress` especially: showing it would be an offer to downgrade.
      expect(container).toBeEmptyDOMElement();
    }
    const { container } = render(<CrossoverCard crossover={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('F1 — the modal prices the change', () => {
  const plan = { id: 'business', name: 'Business', tier: 'business', prices: { monthly: 24900, annual: 249000 } } as never;
  const props = { targetPlan: plan, currentPlanName: 'Team', interval: 'monthly' as const, isDowngrade: false, loading: false, onConfirm: () => {}, onClose: () => {} };

  beforeEach(() => { jest.clearAllMocks(); });

  it('shows the DISCOUNTED price with the list price struck through', async () => {
    // The bug F1 exists to fix: an account accepting 50% off saw $249.
    getPlanPreview.mockResolvedValue({ data: { preview: {
      tier: 'business', fromTier: 'team', interval: 'monthly',
      listCents: 24900, discountCents: 12450, netPlanCents: 12450,
      survivingAddonCents: 0, prunedAddons: [], totalCents: 12450, discountName: 'disc_1',
    } } });

    render(<PlanChangeModal {...props} />);
    await waitFor(() => expect(screen.getByTestId('plan-change-discount')).toBeInTheDocument());
    expect(screen.getByTestId('plan-change-discount')).toHaveTextContent('$124.50 off per month');
  });

  it('adds the add-ons that keep billing, because the plan line is not the invoice', async () => {
    getPlanPreview.mockResolvedValue({ data: { preview: {
      tier: 'business', fromTier: 'team', interval: 'monthly',
      listCents: 24900, discountCents: 0, netPlanCents: 24900,
      survivingAddonCents: 4999, prunedAddons: ['advanced_reporting'], totalCents: 29899, discountName: null,
    } } });

    render(<PlanChangeModal {...props} />);
    await waitFor(() => expect(screen.getByTestId('plan-change-total')).toBeInTheDocument());
    expect(screen.getByTestId('plan-change-total')).toHaveTextContent('$298.99');
    expect(screen.getByText(/includes an add-on/)).toBeInTheDocument();
  });

  it('FAILS OPEN to the list price when the preview cannot be read', async () => {
    // Blocking an upgrade on an unreachable price endpoint is worse than
    // quoting the undiscounted figure, which is the state the modal was in.
    getPlanPreview.mockRejectedValue(new Error('billing down'));
    render(<PlanChangeModal {...props} />);
    await waitFor(() => expect(getPlanPreview).toHaveBeenCalledWith('business'));
    expect(screen.queryByTestId('plan-change-discount')).not.toBeInTheDocument();
    // The list price, which is what this modal always showed.
    expect(screen.getByText(/\$249\.00/)).toBeInTheDocument();
  });

  it('quotes no discount line when there is no discount', async () => {
    getPlanPreview.mockResolvedValue({ data: { preview: {
      tier: 'business', fromTier: 'team', interval: 'monthly',
      listCents: 24900, discountCents: 0, netPlanCents: 24900,
      survivingAddonCents: 0, prunedAddons: [], totalCents: 24900, discountName: null,
    } } });
    render(<PlanChangeModal {...props} />);
    await waitFor(() => expect(getPlanPreview).toHaveBeenCalledWith('business'));
    expect(screen.queryByTestId('plan-change-discount')).not.toBeInTheDocument();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Paid-signup billing provisioning + reconcile (billing-provision.ts).
 *
 * Closes the fail-open gap: a paid-plan signup during a billing outage must NOT
 * silently stay developer-tier with no subscription. On persistent failure the
 * new org gets a durable `pendingBillingPlanId` marker; a reconcile pass retries
 * marked orgs and clears the marker on success.
 *
 * The billing HTTP client (createSafeClient), the marker persistence
 * (authService), the metrics counters, and config are all mocked — what we
 * assert is the ORCHESTRATION: retry-then-mark, mark-clears-on-success,
 * reconcile-retries-and-clears, and the billing-disabled no-op.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockPost = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCreateSafeClient = jest.fn(() => ({ post: mockPost }));

const mockSetPending = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockClearPending = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockListPending = jest.fn<(...a: unknown[]) => Promise<Array<{ orgId: string; planId: string }>>>();

const mockIncCounter = jest.fn();

// Mutable billing config so a single suite can flip `enabled` per-test.
const billingConfig = {
  enabled: true,
  serviceHost: 'billing',
  servicePort: 3000,
  serviceTimeout: 5000,
  provisionRetryAttempts: 3,
  provisionRetryBaseMs: 0, // 0 → retries don't actually sleep in tests
  reconcileIntervalMs: 300000,
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: (...a: unknown[]) => mockCreateSafeClient(...(a as [])),
  getServiceAuthHeader: () => 'Bearer service-token',
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { billing: billingConfig },
}));

jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
}));

jest.unstable_mockModule('../src/services/auth-service.js', () => ({
  authService: {
    setPendingBillingPlan: (...a: unknown[]) => mockSetPending(...a),
    clearPendingBillingPlan: (...a: unknown[]) => mockClearPending(...a),
    listPendingBillingOrgs: (...a: unknown[]) => mockListPending(...a),
  },
}));

const { provisionBillingSubscription, reconcilePendingBillingSubscriptions } =
  await import('../src/services/billing-provision.js');

beforeEach(() => {
  jest.clearAllMocks();
  billingConfig.enabled = true;
  billingConfig.provisionRetryAttempts = 3;
  billingConfig.provisionRetryBaseMs = 0;
  mockSetPending.mockResolvedValue(undefined);
  mockClearPending.mockResolvedValue(undefined);
  mockListPending.mockResolvedValue([]);
});

describe('provisionBillingSubscription (paid-signup)', () => {
  it('provisions on the first attempt — no marker set, success counter', async () => {
    mockPost.mockResolvedValueOnce({});

    await provisionBillingSubscription('org-1', 'pro');

    expect(mockPost).toHaveBeenCalledTimes(1);
    // POST carries the requested plan + a monthly interval.
    expect((mockPost.mock.calls[0] as any)[0]).toBe('/billing/subscriptions');
    expect((mockPost.mock.calls[0] as any)[1]).toMatchObject({ planId: 'pro', interval: 'monthly' });
    // No pending marker on success; success counter emitted.
    expect(mockSetPending).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('platform_billing_provision_total', { outcome: 'success' });
  });

  it('retries transient failures then succeeds without marking', async () => {
    mockPost.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({});

    await provisionBillingSubscription('org-2', 'team');

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockSetPending).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('platform_billing_provision_total', { outcome: 'success' });
  });

  it('persists the durable marker after ALL attempts fail (registration still succeeds)', async () => {
    mockPost.mockRejectedValue(new Error('billing down'));

    // Never throws — registration must not fail because billing is down.
    await expect(provisionBillingSubscription('org-3', 'enterprise')).resolves.toBeUndefined();

    // Exhausted the configured attempts, then marked the org for reconcile.
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(mockSetPending).toHaveBeenCalledWith('org-3', 'enterprise');
    expect(mockClearPending).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('platform_billing_provision_total', { outcome: 'deferred' });
  });

  it('does NOT provision or mark when billing is disabled', async () => {
    billingConfig.enabled = false;

    await provisionBillingSubscription('org-4', 'pro');

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSetPending).not.toHaveBeenCalled();
    expect(mockClearPending).not.toHaveBeenCalled();
  });
});

describe('reconcilePendingBillingSubscriptions', () => {
  it('retries a marked org and clears the marker on success', async () => {
    mockListPending.mockResolvedValue([{ orgId: 'org-5', planId: 'pro' }]);
    mockPost.mockResolvedValueOnce({});

    const summary = await reconcilePendingBillingSubscriptions();

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockClearPending).toHaveBeenCalledWith('org-5');
    expect(summary).toEqual({ scanned: 1, reconciled: 1, stillPending: 1 - 1 });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_billing_reconcile_total', { outcome: 'success' });
  });

  it('leaves the marker in place when billing is still unavailable', async () => {
    mockListPending.mockResolvedValue([{ orgId: 'org-6', planId: 'team' }]);
    mockPost.mockRejectedValue(new Error('still down'));

    const summary = await reconcilePendingBillingSubscriptions();

    expect(mockClearPending).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, reconciled: 0, stillPending: 1 });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_billing_reconcile_total', { outcome: 'still_pending' });
  });

  it('no-ops (no scan) when billing is disabled', async () => {
    billingConfig.enabled = false;

    const summary = await reconcilePendingBillingSubscriptions();

    expect(mockListPending).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 0, reconciled: 0, stillPending: 0 });
  });

  it('is a cheap no-op when no orgs carry a marker', async () => {
    mockListPending.mockResolvedValue([]);

    const summary = await reconcilePendingBillingSubscriptions();

    expect(mockPost).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 0, reconciled: 0, stillPending: 0 });
  });
});

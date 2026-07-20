// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for SubscriptionStatusCard's billing-access wiring:
 *   - A standing "Manage billing" button that opens the hosted portal
 *     (reachable at any time, not only after a purchase 402s). Gated on
 *     `canChangePlan` so a read-only viewer isn't shown a dead-end control.
 *   - A dunning banner + "Update payment method" CTA when the subscription is
 *     past_due / unpaid, reserving the alarm styling for those states.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { SubscriptionStatusCard } from '../src/components/billing/SubscriptionStatusCard';
import type { Subscription } from '../src/types';

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1',
    orgId: 'org_1',
    planId: 'pro',
    planName: 'Pro',
    status: 'active',
    interval: 'monthly',
    currentPeriodStart: '2026-07-01T00:00:00Z',
    currentPeriodEnd: '2026-08-01T00:00:00Z',
    cancelAtPeriodEnd: false,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

const baseProps = {
  canChangePlan: true,
  actionLoading: false,
  portalLoading: false,
  onReactivate: jest.fn(),
  onCancel: jest.fn(),
  onManageBilling: jest.fn(),
};

describe('SubscriptionStatusCard — standing billing access', () => {
  it('shows a "Manage billing" button that calls onManageBilling', () => {
    const onManageBilling = jest.fn();
    render(<SubscriptionStatusCard {...baseProps} subscription={makeSub()} onManageBilling={onManageBilling} />);
    const btn = screen.getByRole('button', { name: /manage billing/i });
    fireEvent.click(btn);
    expect(onManageBilling).toHaveBeenCalledTimes(1);
  });

  it('hides billing controls when the viewer cannot manage the plan', () => {
    render(<SubscriptionStatusCard {...baseProps} canChangePlan={false} subscription={makeSub()} />);
    expect(screen.queryByRole('button', { name: /manage billing/i })).not.toBeInTheDocument();
  });
});

describe('SubscriptionStatusCard — dunning / past-due CTA', () => {
  it('renders a payment-failed banner with an "Update payment method" CTA when past_due', () => {
    const onManageBilling = jest.fn();
    render(<SubscriptionStatusCard {...baseProps} subscription={makeSub({ status: 'past_due' })} onManageBilling={onManageBilling} />);
    expect(screen.getByText(/payment failed/i)).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /update payment method/i });
    fireEvent.click(cta);
    expect(onManageBilling).toHaveBeenCalledTimes(1);
  });

  it('also treats "unpaid" as a dunning state', () => {
    render(<SubscriptionStatusCard {...baseProps} subscription={makeSub({ status: 'unpaid' })} />);
    expect(screen.getByText(/payment failed/i)).toBeInTheDocument();
  });

  it('does not show the dunning banner for an active subscription', () => {
    render(<SubscriptionStatusCard {...baseProps} subscription={makeSub({ status: 'active' })} />);
    expect(screen.queryByText(/payment failed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update payment method/i })).not.toBeInTheDocument();
  });

  it('suppresses the dunning CTA when the viewer cannot manage billing (banner still warns)', () => {
    render(<SubscriptionStatusCard {...baseProps} canChangePlan={false} subscription={makeSub({ status: 'past_due' })} />);
    expect(screen.getByText(/payment failed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update payment method/i })).not.toBeInTheDocument();
  });
});

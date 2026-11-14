// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for SubscriptionStatusCard's billing-access wiring:
 *   - A standing "Manage billing" button that opens the hosted portal
 *     (reachable at any time, not only after a purchase 402s). Gated on
 *     `canChangePlan` so a read-only viewer isn't shown a dead-end control.
 *   - A dunning banner + "Update payment method" CTA when the subscription is
 *     past_due, reserving the alarm styling for those states.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubscriptionStatusCard, dunningMessage } from '../src/components/billing/SubscriptionStatusCard';
import { formatDateLong } from '../src/lib/format';
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
    dunning: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

const baseProps = {
  canChangePlan: true,
  actionLoading: false,
  portalLoading: false,
  onReactivate: jest.fn<AnyFn>(),
  onCancel: jest.fn<AnyFn>(),
  onManageBilling: jest.fn<AnyFn>(),
};

describe('SubscriptionStatusCard — standing billing access', () => {
  it('shows a "Manage billing" button that calls onManageBilling', () => {
    const onManageBilling = jest.fn<AnyFn>();
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
    const onManageBilling = jest.fn<AnyFn>();
    render(<SubscriptionStatusCard {...baseProps} subscription={makeSub({ status: 'past_due' })} onManageBilling={onManageBilling} />);
    expect(screen.getByText(/payment failed/i)).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /update payment method/i });
    fireEvent.click(cta);
    expect(onManageBilling).toHaveBeenCalledTimes(1);
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

describe('SubscriptionStatusCard — dunning dates', () => {
  it('names the date access ends while the grace period runs', () => {
    render(<SubscriptionStatusCard {...baseProps} subscription={makeSub({
      status: 'past_due',
      dunning: { firstFailedAt: '2026-07-01T12:00:00Z', downgradeAt: '2026-07-15T12:00:00Z', downgraded: false },
    })} />);
    const msg = screen.getByTestId('dunning-message').textContent ?? '';
    expect(msg).toMatch(/access ends on/i);
    expect(msg).toContain(formatDateLong('2026-07-15T12:00:00Z'));
    expect(msg).not.toMatch(/moved to developer/i);
  });

  it('says the plan already moved to Developer, and when, once downgraded', () => {
    render(<SubscriptionStatusCard {...baseProps} subscription={makeSub({
      status: 'past_due',
      dunning: {
        firstFailedAt: '2026-07-01T12:00:00Z', downgradeAt: '2026-07-15T12:00:00Z',
        downgraded: true, downgradedAt: '2026-07-15T13:00:00Z',
      },
    })} />);
    const msg = screen.getByTestId('dunning-message').textContent ?? '';
    expect(msg).toMatch(/moved to developer on/i);
    expect(msg).toContain(formatDateLong('2026-07-15T13:00:00Z'));
    expect(msg).toMatch(/pay the open invoice/i);
  });

  it('omits the date when a downgrade carries none, and invents no deadline without a dunning record', () => {
    expect(dunningMessage(makeSub({
      status: 'past_due',
      dunning: { firstFailedAt: '2026-07-01T12:00:00Z', downgradeAt: '2026-07-15T12:00:00Z', downgraded: true },
    }))).toBe('Moved to Developer — pay the open invoice to restore your plan.');
    expect(dunningMessage(makeSub({ status: 'past_due', dunning: null }))).toBe('Update your payment method to keep your plan.');
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertCircle, AlertTriangle, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { Subscription } from '@/types';
import { formatDateLong } from '@/lib/format';

/** Friendly labels for subscription status (avoids raw "Past_due" from CSS capitalize). */
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  canceled: 'Canceled',
  past_due: 'Past due',
  unpaid: 'Unpaid',
  trialing: 'Trialing',
  incomplete: 'Incomplete',
};

interface SubscriptionStatusCardProps {
  subscription: Subscription;
  canChangePlan: boolean;
  actionLoading: boolean;
  /** Spinner state for the billing-portal redirect (shared across CTAs). */
  portalLoading: boolean;
  onReactivate: () => void;
  onCancel: () => void;
  /** Redirect to the hosted billing portal (add/update payment method). */
  onManageBilling: () => void;
}

/** Current-subscription status card with reactivate/cancel controls. */
export function SubscriptionStatusCard({
  subscription,
  canChangePlan,
  actionLoading,
  portalLoading,
  onReactivate,
  onCancel,
  onManageBilling,
}: SubscriptionStatusCardProps) {
  // Dunning: a failed payment (past_due) or exhausted retries (unpaid) put the
  // subscription at risk. Reserve the alarm styling for these states.
  const needsPayment = subscription.status === 'past_due' || subscription.status === 'unpaid';
  return (    <Card>
      {/* Dunning banner — a clear path back to good standing before access lapses. */}
      {needsPayment && (
        <div className="mb-4 rounded-lg border border-danger-border bg-danger-bg p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-danger-strong">Payment failed</h3>
              <p className="text-sm text-danger mt-0.5">
                Update your payment method to avoid losing access to your subscription.
              </p>
              {canChangePlan && (
                <div className="mt-3">
                  <Button variant="danger" onClick={onManageBilling} loading={portalLoading}>
                    Update payment method
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="h2">Current Subscription</h2>
        {/* Standing access to the hosted portal to manage the payment method /
            invoices — not just reachable after a purchase throws a 402. */}
        {canChangePlan && (
          <Button variant="secondary" size="sm" onClick={onManageBilling} loading={portalLoading}>
            <CreditCard className="w-4 h-4 mr-1.5" /> Manage billing
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div>
          <p className="text-sm text-fg-muted">Plan</p>
          <p className="text-lg font-medium text-fg">{subscription.planName || subscription.planId}</p>
        </div>
        <div>
          <p className="text-sm text-fg-muted">Status</p>
          <p className="text-lg font-medium text-fg">
            {STATUS_LABELS[subscription.status] ?? subscription.status}
            {subscription.cancelAtPeriodEnd && (                    <span className="ml-2 inline-flex items-center text-xs text-warning">
                <AlertCircle className="w-3 h-3 mr-1" />
                Cancels at period end
              </span>
            )}
          </p>
        </div>
        <div>
          <p className="text-sm text-fg-muted">Billing Period</p>
          <p className="text-sm text-fg capitalize">{subscription.interval}</p>
        </div>
        <div>
          <p className="text-sm text-fg-muted">Next Billing Date</p>
          <p className="text-sm text-fg">{formatDateLong(subscription.currentPeriodEnd)}</p>
        </div>
      </div>
      {canChangePlan && (              <div className="mt-4 flex gap-3">
          {subscription.cancelAtPeriodEnd ? (                  <Button
              onClick={onReactivate}
              loading={actionLoading}
            >
              Reactivate Subscription
            </Button>
          ): subscription.planId !== 'developer' ? (                  <Button
              variant="danger-outline"
              onClick={onCancel}
              disabled={actionLoading}
            >
              Cancel Subscription
            </Button>
          ): null}
        </div>
      )}
    </Card>
  );
}

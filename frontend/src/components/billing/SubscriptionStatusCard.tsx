// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertCircle, AlertTriangle, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { Subscription } from '@/types';
import { formatDate } from './helpers';

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
  return (    <div className="card">
      {/* Dunning banner — a clear path back to good standing before access lapses. */}
      {needsPayment && (
        <div className="mb-4 rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">Payment failed</h3>
              <p className="text-sm text-red-700 dark:text-red-300 mt-0.5">
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
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Current Subscription</h2>
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
          <p className="text-sm text-gray-500 dark:text-gray-400">Plan</p>
          <p className="text-lg font-medium text-gray-900 dark:text-gray-100">{subscription.planName || subscription.planId}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Status</p>
          <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {STATUS_LABELS[subscription.status] ?? subscription.status}
            {subscription.cancelAtPeriodEnd && (                    <span className="ml-2 inline-flex items-center text-xs text-amber-600 dark:text-amber-400">
                <AlertCircle className="w-3 h-3 mr-1" />
                Cancels at period end
              </span>
            )}
          </p>
        </div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Billing Period</p>
          <p className="text-sm text-gray-900 dark:text-gray-100 capitalize">{subscription.interval}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Next Billing Date</p>
          <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(subscription.currentPeriodEnd)}</p>
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
    </div>
  );
}

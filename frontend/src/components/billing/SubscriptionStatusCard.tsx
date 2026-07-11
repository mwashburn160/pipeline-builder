// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { Subscription } from '@/types';
import { formatDate } from './helpers';

/** Friendly labels for subscription status (avoids raw "Past_due" from CSS capitalize). */
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  canceled: 'Canceled',
  past_due: 'Past due',
  trialing: 'Trialing',
  incomplete: 'Incomplete',
};

interface SubscriptionStatusCardProps {
  subscription: Subscription;
  canChangePlan: boolean;
  actionLoading: boolean;
  onReactivate: () => void;
  onCancel: () => void;
}

/** Current-subscription status card with reactivate/cancel controls. */
export function SubscriptionStatusCard({
  subscription,
  canChangePlan,
  actionLoading,
  onReactivate,
  onCancel,
}: SubscriptionStatusCardProps) {
  return (    <div className="card">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Current Subscription</h2>
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

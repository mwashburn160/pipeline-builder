// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatBytes } from '@/lib/format';
import { statusInfo, barStyles } from '@/lib/quota-helpers';
import type { UsageRollup } from '@/types';
import { formatDate } from './helpers';

/** Quota-type → human label. Keep in sync with the keys returned by
 * `GET /api/billing/usage`; falls back to the raw key for new types so the
 * UI degrades to "{key}: 12 / 100" instead of erroring. */
const QUOTA_LABELS: Record<string, { label: string; unit?: 'bytes' }> = {
  plugins: { label: 'Plugins' },
  pipelines: { label: 'Pipelines' },
  apiCalls: { label: 'API calls' },
  aiCalls: { label: 'AI calls' },
  storageBytes: { label: 'Registry storage', unit: 'bytes' },
};

/** Read-only "this period" cost + usage rollup.. */
export function UsageCard({ rollup }: { rollup: UsageRollup }) {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (    <div className="card">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Usage this period</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {rollup.period.daysElapsed} of {rollup.period.daysElapsed + rollup.period.daysRemaining} days elapsed
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Subscription</p>
          <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {rollup.subscription ? `${dollars(rollup.cost.subscriptionCents)} / ${rollup.subscription.interval === 'annual' ? 'year': 'month'}`: 'No active plan'}
          </p>
        </div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Period start</p>
          <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(rollup.period.start)}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Period end</p>
          <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(rollup.period.end)}</p>
        </div>
      </div>

      <div className="space-y-3">
        {Object.entries(rollup.usage).map(([key, entry]) => {
          const cfg = QUOTA_LABELS[key] ?? { label: key };
          const isBytes = cfg.unit === 'bytes';
          const isUnlimited = entry.percentOfLimit === null;
          const usedLabel = isBytes ? formatBytes(entry.used): entry.used.toLocaleString();
          const limitLabel = isUnlimited
            ? 'Unlimited'
: isBytes ? formatBytes(entry.limit): entry.limit.toLocaleString();
          // Bar color follows the shared quota status ladder (single source of
          // truth for thresholds + colors in quota-helpers); unlimited stays gray.
          const barColor = isUnlimited
            ? 'bg-gray-300 dark:bg-gray-600'
: barStyles[statusInfo(entry.used, entry.limit).color];
          return (            <div key={key}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-gray-900 dark:text-gray-100">{cfg.label}</span>
                <span className="text-gray-500 dark:text-gray-400">
                  {usedLabel} / {limitLabel}
                  {entry.percentOfLimit !== null && <span className="ml-2">({entry.percentOfLimit}%)</span>}
                </span>
              </div>
              <div className="mt-1 h-2 w-full bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
                <div
                  className={`h-2 rounded ${barColor}`}
                  style={{ width: `${isUnlimited ? 0: Math.min(100, entry.percentOfLimit ?? 0)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

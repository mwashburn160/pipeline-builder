// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatBytes, fmtNum, formatCents } from '@/lib/format';
import { statusInfo, barStyles } from '@/lib/quota-helpers';
import type { UsageRollup } from '@/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
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

/** ISO timestamp → `yyyy-mm-dd` for a native date input. */
const toDateInput = (iso: string) => (iso ? iso.slice(0, 10) : '');

interface UsageCardProps {
  rollup: UsageRollup;
  /** When provided, the period start/end render as editable date inputs and this
   *  fires (with `yyyy-mm-dd` values, or `undefined` when cleared) so the caller
   *  can re-fetch the rollup for the chosen window. The consumable bars below stay
   *  the live current-period snapshot regardless — see the note under the dates. */
  onPeriodChange?: (periodStart?: string, periodEnd?: string) => void;
  /** True when a caller-supplied window is currently applied (drives the Reset
   *  affordance, since the rollup's own dates can't reveal whether they're an
   *  override or the derived default). */
  overridden?: boolean;
}

/** Read-only "this period" cost + usage rollup. Period dates become editable when
 *  `onPeriodChange` is supplied (reframes the displayed window, not the bars). */
export function UsageCard({ rollup, onPeriodChange, overridden = false }: UsageCardProps) {
  const dollars = formatCents;
  const editable = !!onPeriodChange;
  const startVal = toDateInput(rollup.period.start);
  const endVal = toDateInput(rollup.period.end);

  return (    <Card>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Usage this period</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {rollup.period.daysElapsed} of {rollup.period.daysElapsed + rollup.period.daysRemaining} days elapsed
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-2">
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Subscription</p>
          <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {rollup.subscription ? `${dollars(rollup.cost.subscriptionCents)} / ${rollup.subscription.interval === 'annual' ? 'year': 'month'}`: 'No active plan'}
          </p>
        </div>
        <div>
          <label className="text-sm text-gray-500 dark:text-gray-400" htmlFor="usage-period-start">Period start</label>
          {editable ? (
            <Input
              id="usage-period-start"
              type="date"
              value={startVal}
              max={endVal || undefined}
              onChange={(e) => onPeriodChange?.(e.target.value || undefined, endVal || undefined)}
              className="mt-0.5 block w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
            />
          ) : (
            <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(rollup.period.start)}</p>
          )}
        </div>
        <div>
          <label className="text-sm text-gray-500 dark:text-gray-400" htmlFor="usage-period-end">Period end</label>
          {editable ? (
            <Input
              id="usage-period-end"
              type="date"
              value={endVal}
              min={startVal || undefined}
              onChange={(e) => onPeriodChange?.(startVal || undefined, e.target.value || undefined)}
              className="mt-0.5 block w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
            />
          ) : (
            <p className="text-sm text-gray-900 dark:text-gray-100">{formatDate(rollup.period.end)}</p>
          )}
        </div>
      </div>

      {editable && (
        <div className="mb-6 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
          <span>Adjusts the displayed window. Consumption below is the current live period, not the selected dates.</span>
          {overridden && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPeriodChange?.(undefined, undefined)}
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Reset
            </Button>
          )}
        </div>
      )}

      <div className="space-y-3">
        {/* Seats — pooled across the account (root). Not a quota type, so it's
            sourced separately and may be absent (`null`) when the platform read
            failed; the rest of the consumables still render. `limit === -1`
            means unlimited. */}
        {rollup.seats && (() => {
          const { used, limit } = rollup.seats;
          const isUnlimited = limit < 0;
          const percent = isUnlimited ? null : (limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100)));
          const barColor = isUnlimited
            ? 'bg-gray-300 dark:bg-gray-600'
            : barStyles[statusInfo(used, limit).color];
          return (
            <div>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-gray-900 dark:text-gray-100">Seats</span>
                <span className="text-gray-500 dark:text-gray-400">
                  {fmtNum(used)} / {isUnlimited ? 'Unlimited' : fmtNum(limit)}
                  {percent !== null && <span className="ml-2">({percent}%)</span>}
                </span>
              </div>
              <div className="mt-1 h-2 w-full bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
                <div
                  className={`h-2 rounded ${barColor}`}
                  style={{ width: `${isUnlimited ? 0 : percent ?? 0}%` }}
                />
              </div>
            </div>
          );
        })()}
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
    </Card>
  );
}

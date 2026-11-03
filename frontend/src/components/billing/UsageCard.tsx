// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatCents, formatDateLong } from '@/lib/format';
import { quotaLabelPlural } from '@pipeline-builder/api-core/quota-catalog';
import { statusInfo, barStyles, formatQuotaValue } from '@/lib/quota-helpers';
import type { UsageRollup } from '@/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

/** ISO timestamp → `yyyy-mm-dd` for a native date input. */
const toDateInput = (iso: string) => (iso ? iso.slice(0, 10) : '');

/**
 * One consumable's used/limit line and bar — for quota types and for seats
 * alike, since the card draws them identically.
 *
 * Seats used to carry a second copy of this markup, with its own label, its own
 * unlimited handling and its own bar-colour lookup. The copies had already
 * diverged: the quota rows formatted their values through the catalog's render
 * mode while the seats row called `fmtNum` directly, so a byte-rendered
 * consumable added beside seats would have printed raw bytes.
 *
 * `percent` stays a prop rather than being recomputed here: the quota rows get
 * it from the server, which knows about pooling, and recomputing from
 * used/limit would quietly substitute a different number.
 */
function ConsumableBar({ type, used, limit, percent }: {
  /** Catalog key — a `QuotaType`, or `seats`. */
  type: string;
  used: number;
  limit: number;
  /** `null` for unlimited. May exceed 100; the bar clamps, the text does not. */
  percent: number | null;
}) {
  const isUnlimited = percent === null;
  // Bar color follows the shared quota status ladder (single source of truth
  // for thresholds + colors in quota-helpers); unlimited stays gray.
  const barColor = isUnlimited
    ? 'bg-gray-300 dark:bg-gray-600'
    : barStyles[statusInfo(used, limit).color];
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-fg">{quotaLabelPlural(type)}</span>
        <span className="text-fg-muted">
          {formatQuotaValue(type, used)} / {isUnlimited ? 'Unlimited' : formatQuotaValue(type, limit)}
          {percent !== null && <span className="ml-2">({percent}%)</span>}
        </span>
      </div>
      <div className="mt-1 h-2 w-full bg-surface-muted rounded overflow-hidden">
        <div
          className={`h-2 rounded ${barColor}`}
          style={{ width: `${isUnlimited ? 0 : Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  );
}

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
        <h2 className="h2">Usage this period</h2>
        <span className="text-xs text-fg-muted">
          {rollup.period.daysElapsed} of {rollup.period.daysElapsed + rollup.period.daysRemaining} days elapsed
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-2">
        <div>
          <p className="text-sm text-fg-muted">Subscription</p>
          <p className="text-lg font-medium text-fg">
            {rollup.subscription ? `${dollars(rollup.cost.subscriptionCents)} / ${rollup.subscription.interval === 'annual' ? 'year': 'month'}`: 'No active plan'}
          </p>
        </div>
        <div>
          <label className="text-sm text-fg-muted" htmlFor="usage-period-start">Period start</label>
          {editable ? (
            <Input
              id="usage-period-start"
              type="date"
              value={startVal}
              max={endVal || undefined}
              onChange={(e) => onPeriodChange?.(e.target.value || undefined, endVal || undefined)}
              className="mt-0.5 block w-full rounded border border-default bg-surface px-2 py-1 text-sm text-fg"
            />
          ) : (
            <p className="text-sm text-fg">{formatDateLong(rollup.period.start)}</p>
          )}
        </div>
        <div>
          <label className="text-sm text-fg-muted" htmlFor="usage-period-end">Period end</label>
          {editable ? (
            <Input
              id="usage-period-end"
              type="date"
              value={endVal}
              min={startVal || undefined}
              onChange={(e) => onPeriodChange?.(startVal || undefined, e.target.value || undefined)}
              className="mt-0.5 block w-full rounded border border-default bg-surface px-2 py-1 text-sm text-fg"
            />
          ) : (
            <p className="text-sm text-fg">{formatDateLong(rollup.period.end)}</p>
          )}
        </div>
      </div>

      {editable && (
        <div className="mb-6 flex items-center gap-2 text-xs text-fg-muted">
          <span>Adjusts the displayed window. Consumption below is the current live period, not the selected dates.</span>
          {overridden && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPeriodChange?.(undefined, undefined)}
              className="text-brand hover:underline"
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
        {rollup.seats && (
          <ConsumableBar
            type="seats"
            used={rollup.seats.used}
            limit={rollup.seats.limit}
            percent={rollup.seats.limit < 0
              ? null
              : rollup.seats.limit === 0
                ? 100
                : Math.min(100, Math.round((rollup.seats.used / rollup.seats.limit) * 100))}
          />
        )}
        {Object.entries(rollup.usage).map(([key, entry]) => (
          <ConsumableBar
            key={key}
            type={key}
            used={entry.used}
            limit={entry.limit}
            percent={entry.percentOfLimit}
          />
        ))}
      </div>
    </Card>
  );
}

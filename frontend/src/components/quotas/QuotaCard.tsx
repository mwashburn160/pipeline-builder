// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Input } from '@/components/ui/Input';
import { pct, fmtNum, daysUntil, statusInfo, statusStyles, barStyles } from '@/lib/quota-helpers';
import type { OrgQuotaResponse, DisplayedQuotaType } from '@/types';
import { QUOTA_META } from './constants';

/**
 * Colored badge indicating quota health status (OK, Warning, Critical, Unlimited).
 * @param used - Current usage count.
 * @param limit - Quota limit (-1 for unlimited).
 */
export function StatusBadge({ used, limit }: { used: number; limit: number }) {
  const { label, color } = statusInfo(used, limit);
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${statusStyles[color]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${barStyles[color]}`} />
      {label}
    </span>
  );
}

/**
 * Card displaying a single quota's usage, progress bar, and optional admin limit editor.
 * @param quotaKey - The quota type (plugins, pipelines, or apiCalls).
 * @param quota - Current quota data including used, limit, and reset info.
 * @param isAdmin - Whether to show the limit editing controls.
 * @param editVal - The current edited limit value.
 * @param onEditChange - Callback when the admin changes the limit.
 */
export function QuotaCard({
  quotaKey,
  quota,
  isAdmin,
  editVal,
  onEditChange,
}: {
  quotaKey: DisplayedQuotaType;
  quota: OrgQuotaResponse['quotas'][DisplayedQuotaType];
  isAdmin: boolean;
  editVal: number;
  onEditChange: (key: DisplayedQuotaType, val: number) => void;
}) {
  const meta = QUOTA_META[quotaKey];
  const { color } = statusInfo(quota.used, quota.limit);
  const percentage = quota.unlimited ? 15 : pct(quota.used, quota.limit);
  const isUnlimited = editVal === -1;

  return (
    <div className="card">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{meta.label}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{meta.description}</p>
        </div>
        <StatusBadge used={quota.used} limit={quota.limit} />
      </div>

      <div className="flex items-baseline justify-between mb-2">
        <span className="text-2xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
          {fmtNum(quota.used)}
        </span>
        <span className="text-sm text-gray-500 dark:text-gray-400 tabular-nums">
          / {fmtNum(quota.limit)}
        </span>
      </div>

      <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-3">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${barStyles[color]}`}
          style={{ width: `${percentage}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>{quota.unlimited ? 'No limit' : `${fmtNum(quota.remaining)} remaining`}</span>
        <span>Resets {daysUntil(quota.resetAt)}</span>
      </div>

      {!quota.unlimited && <UsageForecast used={quota.used} limit={quota.limit} resetAt={quota.resetAt} />}

      {isAdmin && (
        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">Limit</span>
          <Input
            type="number"
            min={0}
            value={isUnlimited ? '' : editVal}
            placeholder={isUnlimited ? '∞' : ''}
            disabled={isUnlimited}
            className="w-24 !py-1.5 tabular-nums"
            onChange={(e) => {
              const v = e.target.value === '' ? 0 : parseInt(e.target.value, 10);
              if (!isNaN(v)) onEditChange(quotaKey, Math.max(0, v));
            }}
          />
          <button
            type="button"
            onClick={() => onEditChange(quotaKey, isUnlimited ? (quota.limit === -1 ? 100 : quota.limit) : -1)}
            className={`text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors ${
              isUnlimited
                ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            &infin; Unlimited
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Projects whether the org will exhaust a quota before its period reset.
 *
 * Assumptions:
 *   - The reset window is monthly (api/ai calls) or per-billing-period.
 *     We approximate the period start as 30 days before `resetAt`; for
 *     monthly windows this matches; for shorter/longer windows it's a
 *     rough estimate that errs toward conservatism (slightly
 *     under-projects the breach date for short windows, slightly over
 *     for long ones).
 *   - Burn rate is linear: a constant per-day usage based on what's
 *     consumed so far this period. Real workloads spike, but a linear
 *     baseline still catches "you're pacing 3× ahead of plan" cases.
 *
 * Renders nothing when used is 0 (no signal to project from) or when
 * the projected total is comfortably under the limit.
 */
export function UsageForecast({
  used,
  limit,
  resetAt,
}: {
  used: number;
  limit: number;
  resetAt: string;
}) {
  const reset = new Date(resetAt);
  if (Number.isNaN(reset.getTime()) || limit <= 0 || used <= 0) return null;

  const now = Date.now();
  const periodStart = reset.getTime() - 30 * 24 * 60 * 60 * 1000;
  const elapsed = now - periodStart;
  if (elapsed <= 0) return null;

  const total = reset.getTime() - periodStart;
  const projected = Math.round(used * (total / elapsed));
  const ratio = projected / limit;

  // Only surface the row when it's actually informative — projected ≥
  // 70% of limit (the user is in the warning band).
  if (ratio < 0.7) return null;

  const willBreach = projected > limit;
  const verb = willBreach ? 'will breach' : 'on track for';

  return (
    <div className={`mt-2 px-2 py-1.5 rounded-md text-xs ${willBreach
      ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
      : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'}`}
    >
      At current pace, {verb} <strong className="tabular-nums">{fmtNum(projected)}</strong> by reset
      {' '}<span className="opacity-75">(limit {fmtNum(limit)})</span>.
    </div>
  );
}

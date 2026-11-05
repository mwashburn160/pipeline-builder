// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { quotaAccrual, quotaDescription, quotaLabelPlural, quotaPackUnit } from '@pipeline-builder/api-core/quota-catalog';
import { projectUsage, projectionWorthShowing } from '@pipeline-builder/api-core/usage-projection';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { pct, daysUntil, statusInfo, statusStyles, barStyles, formatQuotaValue } from '@/lib/quota-helpers';
import { fmtNum } from '@/lib/format';
import { isAITrialTier } from '@/lib/ai-quota';
import { packForQuota } from '@/lib/quota-pack-offer';
import { formatPrice } from '@/components/billing/helpers';
import type { OrgQuotaResponse, DisplayedQuotaType, QuotaTier, Bundle, BillingInterval } from '@/types';

/**
 * Colored badge indicating quota health status (OK, Warning, Critical, Unlimited).
 * @param used - Current usage count.
 * @param limit - Quota limit (-1 for unlimited).
 */
function StatusBadge({ used, limit }: { used: number; limit: number }) {
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
 * @param canManage - Whether to show the limit editing controls.
 * @param editVal - The current edited limit value.
 * @param onEditChange - Callback when the admin changes the limit.
 * @param periodDays - The ORG-LEVEL usage period, used only as a fallback: the
 *   period is per type now and arrives on each `QuotaSummary`.
 * @param tier - The org's tier: a trial tier's AI calls are labelled as a trial.
 */
export function QuotaCard({
  quotaKey,
  quota,
  canManage,
  editVal,
  onEditChange,
  periodDays,
  tier,
  bundles,
  interval = 'monthly',
}: {
  quotaKey: DisplayedQuotaType;
  quota: OrgQuotaResponse['quotas'][DisplayedQuotaType];
  canManage: boolean;
  editVal: number;
  onEditChange: (key: DisplayedQuotaType, val: number) => void;
  periodDays?: number;
  /** The org's tier: a trial tier's AI calls are labelled as a trial, and a pack
   *  is only priced when it is actually sold to this tier. */
  tier?: QuotaTier;
  /** The add-on catalogue, for "a pack of 10 is $11.99" (F2). Omitted ⇒ the
   *  price line is simply absent; a failed catalogue fetch must cost the card
   *  nothing. */
  bundles?: readonly Bundle[];
  /** Billing interval the pack price is quoted at. */
  interval?: BillingInterval;
}) {
  // Label AND description both come from api-core's quota catalog — the page
  // keeps no copy of its own for either (see `QuotaTypeMeta.description`).
  const label = quotaLabelPlural(quotaKey);
  // A STOCK has no period: it does not reset, so a reset date, a "N-day period"
  // and a burn-rate forecast are all untrue of it. Driven by the catalog rather
  // than by naming storage, so the resource-count caps get the same treatment
  // when they are surfaced.
  const isStock = quotaAccrual(quotaKey) === 'stock';
  // THIS quota's period, not the org's. Every flow quota shares the global
  // three-day window except `cpuCredits`, which is monthly — so a forecast or a
  // "resets in N days" line computed from the org-level figure is wrong by a
  // factor of ten for the one dimension whose forecast the monthly window leans
  // on. The org-level prop is the fallback for responses predating the per-type
  // field, and `undefined` correctly renders no forecast rather than a wrong one.
  const effectivePeriodDays = quota.periodDays ?? periodDays;
  // A byte quota is edited in its PACK unit (GB), not in bytes — an operator
  // should not have to type 26843545600. `editVal`/`onEditChange` stay in RAW
  // units so the parent's `editValues` contract is unchanged; only this input
  // converts.
  const editUnit = quotaPackUnit(quotaKey);
  const toDisplay = (raw: number) => (editUnit ? raw / editUnit.per : raw);
  const toRaw = (shown: number) => (editUnit ? Math.round(shown * editUnit.per) : shown);
  const trial = quotaKey === 'aiCalls' && isAITrialTier(tier);
  const { color } = statusInfo(quota.used, quota.limit);
  const percentage = quota.unlimited ? 15 : pct(quota.used, quota.limit);
  const isUnlimited = editVal === -1;

  return (
    <Card>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-fg">
            {label}
            {trial && <span className="ml-1.5 text-xs font-medium text-fg-muted">(trial)</span>}
          </h3>
          <p className="text-xs text-fg-muted mt-0.5">{quotaDescription(quotaKey)}</p>
        </div>
        <StatusBadge used={quota.used} limit={quota.limit} />
      </div>

      <div className="flex items-baseline justify-between mb-2">
        <span className="text-2xl font-semibold text-fg tabular-nums">
          {formatQuotaValue(quotaKey, quota.used)}
        </span>
        <span className="text-sm text-fg-muted tabular-nums">
          / {formatQuotaValue(quotaKey, quota.limit)}
        </span>
      </div>

      <div className="h-1.5 bg-surface-muted rounded-full overflow-hidden mb-3">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${barStyles[color]}`}
          style={{ width: `${percentage}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-fg-muted">
        <span className="font-medium text-fg-muted">
          {quota.unlimited ? 'No limit' : `${formatQuotaValue(quotaKey, quota.remaining)} remaining`}
        </span>
        {isStock ? (
          <span title="This limit is a level, not a per-period allowance. It stays where it is until you free space.">
            Does not reset
          </span>
        ) : (
          <span>
            Resets {daysUntil(quota.resetAt)}
            {effectivePeriodDays ? <span className="text-fg-subtle"> · {periodLabel(effectivePeriodDays)}</span> : null}
          </span>
        )}
      </div>

      {/* A forecast extrapolates a burn rate to a period boundary, so it means
          nothing for a stock — there is no boundary to reach. */}
      {!quota.unlimited && !isStock && effectivePeriodDays ? (
        <UsageForecast used={quota.used} limit={quota.limit} resetAt={quota.resetAt} periodDays={effectivePeriodDays} />
      ) : null}

      {/* What the limit COSTS (F2). Under the forecast on purpose: the price is
          only useful once the card has said they are heading for the cap. */}
      <QuotaPackHint quotaKey={quotaKey} quota={quota} bundles={bundles} interval={interval} tier={tier} />

      {canManage && (
        <div className="mt-4 pt-4 border-t border-default">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Edit limit
            </span>
            <button
              type="button"
              aria-pressed={isUnlimited}
              onClick={() => onEditChange(quotaKey, isUnlimited ? (quota.limit === -1 ? toRaw(100) : quota.limit) : -1)}
              className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${
                isUnlimited
                  ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                  : 'border-default text-fg-muted hover:bg-surface-muted'
              }`}
            >
              {isUnlimited ? '✓ Unlimited' : '∞ Set unlimited'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              value={isUnlimited ? '' : toDisplay(editVal)}
              placeholder={isUnlimited ? '∞  No limit' : 'Enter a limit'}
              disabled={isUnlimited}
              aria-label={editUnit ? `${label} limit in ${editUnit.name}` : `${label} limit`}
              className="w-full !py-1.5 tabular-nums"
              onChange={(e) => {
                const v = e.target.value === '' ? 0 : Number(e.target.value);
                if (!isNaN(v)) onEditChange(quotaKey, Math.max(0, toRaw(v)));
              }}
            />
            {editUnit && <span className="text-xs text-fg-muted shrink-0">{editUnit.name}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * What it would cost to not run out (docs/plans/sales-agent.md F2).
 *
 * Deliberately NOT an offer: it quotes a catalogue price for a pack the account
 * can already buy, which is why it needs no consent, no quiet period and no
 * holdout — the same reasoning that lets `AIQuotaHint` state the cost of an AI
 * call up front instead of letting it be discovered as a refusal.
 *
 * Shown only once the card is in the warning band, because a price on a quota at
 * 10% is an advertisement rather than information. Renders nothing for an
 * unlimited quota, a dimension with no pack, or a catalogue that could not be
 * read — a failed bundles fetch must cost the card nothing.
 */
export function QuotaPackHint({
  quotaKey,
  quota,
  bundles,
  interval = 'monthly',
  tier,
}: {
  quotaKey: DisplayedQuotaType;
  quota: OrgQuotaResponse['quotas'][DisplayedQuotaType];
  bundles?: readonly Bundle[];
  interval?: BillingInterval;
  tier?: QuotaTier;
}) {
  if (!bundles?.length || quota.unlimited || quota.limit <= 0) return null;
  // The warning band, shared with the forecast row above it.
  if (pct(quota.used, quota.limit) < 70) return null;

  const pack = packForQuota(quotaKey, bundles, interval, tier);
  if (!pack) return null;

  const amount = fmtNum(pack.grantDisplay);
  const unit = pack.unitName ? ` ${pack.unitName}` : '';
  const per = interval === 'annual' ? 'year' : 'month';
  return (
    <p className="mt-2 text-xs text-fg-muted" data-testid={`quota-pack-hint-${quotaKey}`}>
      {pack.name} adds <strong className="tabular-nums">{amount}{unit}</strong> for{' '}
      <strong className="tabular-nums">{formatPrice(pack.priceCents)}</strong>/{per}.
    </p>
  );
}


/** "3-day period" / "1-day period" — the server's period, said once. */
export function periodLabel(periodDays: number): string {
  // A monthly quota reads as "monthly", not "30-day period" — the phrase is what
  // tells a reader this dimension does not share the others' window.
  if (periodDays >= 28 && periodDays <= 31) return 'monthly';
  return `${periodDays}-day period`;
}

/**
 * Projects whether the org will exhaust a quota before its period reset.
 *
 * The arithmetic moved to api-core `projectUsage` and this is now only the
 * rendering: the threshold notice and the usage profile's trajectory signal need
 * the same answer, and a projection that disagreed between the card and an offer
 * would be the worst possible split — the account reads one number here and gets
 * an offer argued from another.
 *
 * Renders nothing when there is nothing to project from (no usage yet, no
 * finite limit, a period not yet begun) or when the pace is comfortably under
 * the limit — `projectionWorthShowing` owns that band so the card and the
 * profile agree on what "approaching" means.
 */
export function UsageForecast({
  used,
  limit,
  resetAt,
  periodDays,
}: {
  used: number;
  limit: number;
  resetAt: string;
  periodDays: number;
}) {
  const projection = projectUsage({ used, limit, resetAt, periodDays });
  if (!projectionWorthShowing(projection)) return null;
  const { projected, willBreach } = projection!;
  const verb = willBreach ? 'will breach' : 'on track for';

  return (
    <div className={`mt-2 px-2 py-1.5 rounded-md text-xs ${willBreach
      ? 'bg-danger-bg text-danger'
      : 'bg-warning-bg text-warning'}`}
    >
      At current pace, {verb} <strong className="tabular-nums">{fmtNum(projected)}</strong> by reset
      {' '}<span className="opacity-75">(limit {fmtNum(limit)})</span>.
    </div>
  );
}

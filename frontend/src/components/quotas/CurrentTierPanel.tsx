// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Card } from '@/components/ui/Card';
import type { QuotaTier } from '@/types';
import { TIER_KEYS, TIER_PRESETS } from './constants';

/**
 * Prominent "Current tier" indicator. Unlike the selectable Plan Tier cards
 * (which only cover developer/pro/team/enterprise), this always renders the
 * org's ACTUAL tier — including the hidden `unlimited` tier that billing uses
 * as its off-by-default and which the selector never highlights. Unlimited
 * gets an ∞ / "no limits" treatment so it never reads as "unset".
 *
 * @param tier - The org's real, persisted tier.
 * @param pendingTier - Admin only: the tier currently chosen in the editor. When
 *   it differs from `tier`, an "unsaved change" hint is shown.
 * @param selectorBelow - Whether a Plan Tier selector follows this panel (admin).
 *   Enables the "not one of the selectable plans below" note for off-selector
 *   tiers such as `unlimited`.
 */
export function CurrentTierPanel({
  tier,
  pendingTier,
  selectorBelow = false,
}: {
  tier: QuotaTier;
  pendingTier?: QuotaTier;
  selectorBelow?: boolean;
}) {
  const preset = TIER_PRESETS[tier];
  const isUnlimited = tier === 'unlimited';
  const isSelectable = (TIER_KEYS as readonly QuotaTier[]).includes(tier);
  const changing = pendingTier != null && pendingTier !== tier;
  const pendingPreset = changing ? TIER_PRESETS[pendingTier!] : null;

  return (
    <Card className="mb-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span
            className={`flex items-center justify-center w-11 h-11 rounded-xl flex-shrink-0 ${
              isUnlimited ? 'bg-slate-100 dark:bg-slate-800' : 'bg-gray-50 dark:bg-gray-800'
            }`}
            aria-hidden="true"
          >
            {isUnlimited ? (
              <span className="text-2xl leading-none text-slate-500 dark:text-slate-300">&infin;</span>
            ) : (
              <span className={`w-3.5 h-3.5 rounded-full ${preset.color}`} />
            )}
          </span>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              Current tier
            </p>
            <p className="text-lg font-semibold leading-tight text-gray-900 dark:text-gray-100">
              {preset.label}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {isUnlimited ? 'All quotas uncapped — no limits enforced' : preset.description}
            </p>
          </div>
        </div>

        {changing ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 dark:bg-amber-900/20 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Unsaved change → {pendingPreset!.label}
          </span>
        ) : selectorBelow && !isSelectable ? (
          <span className="max-w-[15rem] text-right text-xs text-gray-400 dark:text-gray-500">
            {isUnlimited
              ? 'Billing-off default — not one of the selectable plans below.'
              : 'Not one of the selectable plans below.'}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

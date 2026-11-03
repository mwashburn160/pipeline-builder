// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { KeyRound, Sparkles } from 'lucide-react';
import { fmtNum, formatDateTime } from '@/lib/format';
import { aiQuotaBlocked, isAITrialTier, type AIKeySource } from '@/lib/ai-quota';
import type { AIQuota } from '@/hooks/useAIQuota';

/** Where a trial runs out to: the Plans tab, since AI calls come with a plan. */
const PLANS_HREF = '/dashboard/billing?tab=plans';
/** Where a paid org at its limit goes (plans and the add-on packs). */
const BILLING_HREF = '/dashboard/billing';

/**
 * The one line every AI surface shows BEFORE a generation: how many AI calls
 * are left and when they reset, said up front instead of discovered as a 429.
 *
 *  - Own key (the org's saved key, or one pasted for this request): that call
 *    is not charged, so the line says so rather than counting down.
 *  - At the limit on the platform's key: an upgrade link — the caller disables
 *    its Generate control on the same condition (`aiQuotaBlocked`). A trial
 *    tier's version is the prominent one: the trial is over, here is the plan.
 *  - Unlimited, or the quota could not be read: nothing (fails open).
 */
export function AIQuotaHint({ quota, keySource, className = '' }: {
  quota: AIQuota | null;
  keySource: AIKeySource;
  className?: string;
}) {
  if (keySource !== 'platform') {
    return (
      <p className={`flex items-center gap-1.5 text-xs text-fg-muted ${className}`} data-testid="ai-quota-hint">
        <KeyRound className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Uses your own key — doesn&apos;t count toward AI calls
      </p>
    );
  }
  if (!quota || quota.summary.unlimited) return null;

  const { summary } = quota;
  const trial = isAITrialTier(quota.tier);
  const resets = summary.resetAt ? ` · resets ${formatDateTime(summary.resetAt)}` : '';

  if (aiQuotaBlocked(summary, keySource)) {
    return trial ? (
      <div
        className={`rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-strong ${className}`}
        role="status"
        data-testid="ai-quota-hint"
      >
        <p className="font-medium">Your {fmtNum(summary.limit)} trial AI calls are used up{resets}.</p>
        <p className="mt-1">
          <Link href={PLANS_HREF} className="action-link font-semibold">
            <Sparkles className="inline w-3.5 h-3.5 mr-1" aria-hidden="true" />
            Upgrade your plan
          </Link>{' '}
          to keep generating with AI — or use your own provider key, which isn&apos;t counted.
        </p>
      </div>
    ) : (
      <p className={`text-xs text-danger ${className}`} role="status" data-testid="ai-quota-hint">
        No AI calls left{resets}.{' '}
        <Link href={BILLING_HREF} className="action-link font-medium">Upgrade for more</Link>
        {' '}or use your own provider key.
      </p>
    );
  }

  return (
    <p className={`text-xs text-fg-muted tabular-nums ${className}`} data-testid="ai-quota-hint">
      {fmtNum(summary.remaining)} {trial ? 'trial ' : ''}AI call{summary.remaining === 1 ? '' : 's'} left{resets}
    </p>
  );
}

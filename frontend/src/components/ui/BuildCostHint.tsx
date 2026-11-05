// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Cpu } from 'lucide-react';
import { fmtNum, formatDateTime } from '@/lib/format';
import { buildSizeLabel, buildSizeMultiplier, type BuildSize } from '@pipeline-builder/api-core/build-catalog';
import type { OwnQuota } from '@/hooks/useOwnQuota';

/** Where an org out of build compute goes: plans and the CPU Credits Pack. */
const BILLING_HREF = '/dashboard/billing';

/**
 * The deployment's assumed vCPU per build — mirrors `PLUGIN_BUILDKIT_MILLI_VCPU`
 * (1500m), which is also what `limits.cpu` gives the buildkitd sidecar.
 *
 * STATED in the hint rather than hidden behind it: the figure is a plugin-service
 * env var that the frontend has no way to read, so an operator who raises it
 * would otherwise make this line quietly wrong. Saying "at 1.5 vCPU" turns that
 * into a visible assumption, which is the honest version of an estimate.
 * `test/build-shape.test.ts` fails if the plugin service's default moves.
 */
export const ASSUMED_BUILD_VCPU = 1.5;

/** The wall-clock a typical plugin image build takes, for the estimate. */
const TYPICAL_BUILD_MINUTES = 10;

/**
 * Credits a build of `minutes` costs at `size`.
 *
 * Rounds UP, like the meter it describes (`creditsForBuild`): a hint that
 * rounded down would under-quote every build it quoted. Local rather than in the
 * catalog because the vCPU figure it needs is a plugin-service env var the
 * browser cannot read — see ASSUMED_BUILD_VCPU.
 */
function estimateBuildCredits(minutes: number, vcpu: number, size: BuildSize): number {
  if (!(minutes > 0) || !(vcpu > 0)) return 0;
  return Math.ceil(minutes * vcpu * buildSizeMultiplier(size));
}

/**
 * The one line a build surface shows BEFORE submitting: what the build will
 * cost in CPU credits and what is left this month — said up front instead of
 * discovered as a 429 two steps later.
 *
 * Modelled on `AIQuotaHint`, and the parallels are deliberate rather than
 * cosmetic: the caller disables its submit control on the same predicate
 * (`buildCreditsBlocked`), an unlimited or unreadable quota renders NOTHING
 * (fails open), and the exhausted state carries the remedy rather than a bare
 * refusal.
 *
 * The remedy matters here more than it does for AI, because a build has FOUR
 * distinct refusals and only one of them is a purchase (see the cpu-credits
 * plan, F4). This component speaks for exactly one of them — the monthly budget
 * — and the concurrency refusals are a wait, said on the build stream instead.
 */
export function BuildCostHint({ quota, buildSize = '1x', className = '' }: {
  quota: OwnQuota | null;
  buildSize?: BuildSize;
  className?: string;
}) {
  if (!quota || quota.summary.unlimited) return null;

  const { summary } = quota;
  const estimate = estimateBuildCredits(TYPICAL_BUILD_MINUTES, ASSUMED_BUILD_VCPU, buildSize);
  const multiplier = buildSizeMultiplier(buildSize);
  const resets = summary.resetAt ? ` · resets ${formatDateTime(summary.resetAt)}` : '';

  if (buildCreditsBlocked(summary)) {
    return (
      <p className={`text-xs text-danger ${className}`} role="status" data-testid="build-cost-hint">
        No CPU credits left this month{resets}.{' '}
        <Link href={BILLING_HREF} className="action-link font-medium">Add a credits pack</Link>
        {' '}or wait for the window to reset.
      </p>
    );
  }

  return (
    <p className={`flex items-center gap-1.5 text-xs text-fg-muted tabular-nums ${className}`} data-testid="build-cost-hint">
      <Cpu className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>
        About {fmtNum(estimate)} credits — roughly a {TYPICAL_BUILD_MINUTES}-minute build at{' '}
        {ASSUMED_BUILD_VCPU * multiplier} vCPU{multiplier === 1 ? '' : ` (${buildSizeLabel(buildSize)})`} — against{' '}
        {fmtNum(summary.remaining)} remaining this month{resets}
      </span>
    </p>
  );
}

/**
 * Whether a build is refused for want of monthly budget.
 *
 * Only the EXHAUSTED case blocks. A build whose estimate exceeds what is left
 * is still submitted, because the estimate is an estimate: refusing on it would
 * reject builds that would have fit, and the backend admits on the real counter
 * (`admitBuildOnCredits`) rather than on this guess.
 */
export function buildCreditsBlocked(summary: { unlimited?: boolean; remaining: number } | null | undefined): boolean {
  if (!summary || summary.unlimited) return false;
  return summary.remaining <= 0;
}

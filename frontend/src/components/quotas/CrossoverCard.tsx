// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { TrendingDown } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { formatPrice } from '@/components/billing/helpers';
import { getTierMeta } from '@/lib/tiers';
import type { CrossoverVerdict } from '@/types';

/**
 * "Your packs already cost more than the next plan" (docs/plans/sales-agent.md
 * D4 and F3).
 *
 * The best offer in the plan and the only one that needs nothing else built:
 * arithmetic over the account's own subscription, no discount, no campaign, no
 * model and no consent question a billing notice does not already raise. The
 * plan's example — Team plus four seat packs at $278.96 against Business at
 * $249 for more of everything — is an account paying a premium for less.
 *
 * **It states the CONDITION with the saving.** A plan change prunes only pure
 * feature bundles the new tier includes; a resource pack survives it and keeps
 * billing on top of the new tier's base. So an account that upgrades and does
 * nothing else pays MORE, not less. Quoting the saving without the drops would
 * be the offer leaving them worse off that D9's pre-flight exists to prevent.
 *
 * Renders nothing unless there is a real crossover. The verdict's `reason`
 * distinguishes "holds no packs" (an ordinary state) from "a cheaper tier exists
 * but would cost them capacity" (`would_regress`) — neither is something to
 * show, and showing the second would be an offer to downgrade.
 */
export function CrossoverCard({ crossover }: { crossover: CrossoverVerdict | null }) {
  if (!crossover?.crossover || !crossover.candidateTier) return null;

  const per = crossover.interval === 'annual' ? 'year' : 'month';
  const target = getTierMeta(crossover.candidateTier).label;
  const drops = crossover.dropRequiredAddons.length;

  return (
    <Card data-testid="crossover-card">
      <div className="flex items-start gap-3">
        <TrendingDown className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <div>
          <h3 className="text-sm font-semibold text-fg">
            {target} would cost less than what you pay now
          </h3>
          <p className="mt-1 text-sm text-fg-muted tabular-nums">
            Your plan and add-ons come to <strong>{formatPrice(crossover.currentCents)}</strong>/{per}.{' '}
            {target} is <strong>{formatPrice(crossover.candidateCents)}</strong>/{per} —{' '}
            <strong className="text-success">{formatPrice(crossover.savingCents)}</strong> less, with at
            least as much of everything you currently have.
          </p>

          {crossover.savingRequiresDrops && (
            <p className="mt-2 text-xs text-fg-muted">
              The saving assumes you also remove{' '}
              <strong>{drops === 1 ? 'the add-on' : `the ${drops} add-ons`}</strong> {target} already
              covers. Changing plan does not remove {drops === 1 ? 'it' : 'them'} for you, so keeping{' '}
              {drops === 1 ? 'it' : 'them'} would cost more than you pay today.
            </p>
          )}

          <p className="mt-3">
            <Link href="/dashboard/billing" className="action-link text-sm font-medium">
              Compare plans
            </Link>
          </p>
        </div>
      </div>
    </Card>
  );
}

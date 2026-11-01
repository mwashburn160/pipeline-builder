// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Receipt } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatCents } from '@/lib/format';
import type { AddonPriceBreakdown } from '@/types';

/**
 * What the account is paying right now, itemized.
 *
 * WHY THIS CARD EXISTS. The same breakdown was previously rendered only inside
 * two preview modals — the add-on preview and the discount modal — so every
 * adjustment the product makes was visible for the duration of one dialog and
 * then gone. A customer could see what a CHANGE would cost but never the
 * itemization of their own standing bill, which is the view that answers "why
 * is this the number".
 *
 * It matters most for the support size FLOOR, because that is the one
 * adjustment which can appear or grow without the customer touching add-ons at
 * all: it is derived from the seat count, so buying a seat pack moves it.
 * Disclosed once at purchase and never again is precisely the shape that
 * produces a billing dispute weeks later.
 *
 * Adjustments are signed in the payload — discounts negative, the floor
 * positive — so they are rendered as they come rather than re-derived here. The
 * total is the server's, not a sum computed in the browser: two places
 * computing one number is how they come to disagree.
 */
export function CurrentChargesCard() {
  const charges = useFetch(async (signal) => {
    const res = await api.getCurrentCharges({ signal });
    return res.data?.priceBreakdown ?? null;
  }, []);

  const breakdown: AddonPriceBreakdown | null = charges.data ?? null;

  return (
    <SectionCard title="Current charges" icon={Receipt}>
      {charges.loading && <LoadingSpinner />}
      {charges.error && (
        <RetryError message="Your current charges could not be loaded" onRetry={charges.refetch} />
      )}

      {/* No subscription is not an error — a deployment with billing disabled,
          or an org before its first plan, simply has nothing to itemize. */}
      {!charges.loading && !charges.error && !breakdown && (
        <p className="text-sm text-fg-muted">No plan is being billed for this organization.</p>
      )}

      {breakdown && (
        <dl className="space-y-1">
          {breakdown.items.map((item, i) => (
            <div key={`${item.label}-${i}`} className="flex items-center justify-between gap-3 text-sm">
              <dt className="text-fg-muted">
                {item.label}
                {/* Quantity only when it is a real multiple: "Standard Support
                    x3" is informative, "Pro x1" is noise. */}
                {item.quantity > 1 && <span className="text-xs"> &times;{item.quantity}</span>}
              </dt>
              <dd className="font-mono text-fg-muted text-right tabular-nums">{formatCents(item.cents)}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 text-sm border-t border-default pt-1 mt-1 font-medium">
            <dt>Total ({breakdown.interval})</dt>
            <dd className="font-mono text-fg text-right tabular-nums">{formatCents(breakdown.totalCents)}</dd>
          </div>
        </dl>
      )}
    </SectionCard>
  );
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import { OfferBasketModal } from './OfferBasketModal';
import type { AccountOffer, Bundle, BillingInterval } from '@/types';

/**
 * Where an expansion offer APPEARS (docs/plans/sales-agent.md F4).
 *
 * The redemption model was pull-only — `DiscountRedeem` takes a code the account
 * already has — so offers were being made with nowhere to land. This is the push
 * surface, and it sits on the billing page because that is where a user already
 * goes for anything commercial, served by billing rather than by the process
 * that decided it (D13).
 *
 * **Not in `QuotaBanner`, and that is a decision rather than an omission (F5).**
 * The banner is the app-wide WARNING channel. Offers there would compete with
 * genuine pressure warnings for the same strip and train people to dismiss it —
 * degrading the warning channel in order to sell is a bad trade, and the quota
 * work depends on that banner being believed.
 *
 * **Two verbs, not one.** "No" and "not now" are different answers: a decline
 * lengthens the quiet period, a dismissal only hides the card. Before this,
 * redemption was the only action, so "never saw it" and "said no" were the same
 * row — the single most valuable distinction the outcome log measures.
 *
 * Renders NOTHING when there is no live offer, which is the normal state of an
 * account. The copy shown is the copy as SENT, read back from the record rather
 * than re-derived, so the card cannot restate last month's offer at this
 * month's price.
 */
export function OfferCard({ canRespond, subscriptionId, bundles, interval = 'monthly', onApplied }: {
  /**
   * Whether this viewer may answer — `billing:manage`, the gate the routes
   * actually enforce. Without it the card still SHOWS (the offer is about the
   * account, and someone with billing:read should be able to see what was
   * suggested) but the two verbs are absent rather than rendered to 403.
   */
  canRespond: boolean;
  /** Needed only to BUY a basket; absent ⇒ the basket button is not offered. */
  subscriptionId?: string;
  /** The account's tier-filtered catalogue, for pricing the basket. */
  bundles?: readonly Bundle[];
  interval?: BillingInterval;
  /** Called after a basket is applied, so the page can refetch its figures. */
  onApplied?: () => void;
}) {
  const toast = useToast();
  const offerQ = useFetch(async (signal) => (await api.getOffer({ signal })).data?.offer ?? null, []);
  const offer = offerQ.data;
  const [busy, setBusy] = useState(false);
  // Hidden locally the moment the server confirms, so the card goes away
  // without waiting for a refetch. The RECORD is what makes the dismissal
  // stick across devices; this is only the immediate feedback.
  const [resolved, setResolved] = useState(false);
  const [basketOpen, setBasketOpen] = useState(false);

  if (!offer || resolved) return null;

  // A basket is only offerable when the offer actually named one AND we have
  // what it takes to price and apply it. Otherwise the account gets the ordinary
  // link to the add-ons tab — a "Buy together" button that cannot price itself
  // would be worse than no button.
  const basketable = offer.offerType !== 'upgrade'
    && offer.targetBundles.length > 0
    && Boolean(subscriptionId)
    && Boolean(bundles?.length)
    && canRespond;

  async function act(verb: 'decline' | 'dismiss') {
    setBusy(true);
    try {
      if (verb === 'decline') await api.declineOffer(offer!.id);
      else await api.dismissOffer(offer!.id);
      setResolved(true);
    } catch (err) {
      toast.error(formatError(err, verb === 'decline' ? 'Could not decline this' : 'Could not hide this'));
    } finally {
      setBusy(false);
    }
  }

  const expires = offer.expiresAt ? new Date(offer.expiresAt) : null;
  return (
    <Card data-testid="offer-card">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{offer.subject ?? 'A suggestion for your account'}</h3>
          {offer.body && (
            // Whitespace preserved: the body is plain text written as sentences
            // and a blank line, the same string the email carries, so the two
            // surfaces cannot say it differently.
            <p className="mt-1 whitespace-pre-line text-sm text-fg-muted">{offer.body}</p>
          )}

          {offer.rationale.length > 0 && (
            <p className="mt-2 text-xs text-fg-subtle">
              Based on {offer.rationale.map(readableSignal).filter(Boolean).join(', ')}.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              href={offer.offerType === 'upgrade' ? '/dashboard/billing?view=plans' : '/dashboard/billing?view=addons'}
              className="action-link text-sm font-medium"
            >
              {offer.offerType === 'upgrade' ? 'Compare plans' : 'See the add-on'}
            </Link>
            {basketable && (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => setBasketOpen(true)}>
                {offer.targetBundles.length > 1 ? 'Add all of them' : 'Add it'}
              </Button>
            )}
            {canRespond ? (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act('dismiss')}>
                  Not now
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act('decline')}>
                  No thanks
                </Button>
              </>
            ) : (
              <span className="text-xs text-fg-subtle">
                Contact an organization admin to act on this.
              </span>
            )}
          </div>

          {expires && (
            <p className="mt-2 text-xs text-fg-subtle">Available until {expires.toLocaleDateString()}.</p>
          )}
        </div>
      </div>

      {basketOpen && subscriptionId && bundles && (
        <OfferBasketModal
          offer={offer}
          subscriptionId={subscriptionId}
          bundles={bundles}
          interval={interval}
          onClose={() => setBasketOpen(false)}
          onApplied={() => {
            setBasketOpen(false);
            // The offer has been acted on; the server marks it redeemed through
            // the purchase path, so hide the card rather than re-reading it.
            setResolved(true);
            onApplied?.();
          }}
        />
      )}
    </Card>
  );
}

/**
 * The signals, in the account's own terms.
 *
 * Shown rather than hidden because the rationale IS the argument — "you have
 * been near this limit for three periods" is information the account can check,
 * while an unexplained suggestion reads as a guess. Unknown tokens render as
 * nothing instead of leaking an internal name.
 */
export function readableSignal(token: string): string {
  if (token === 'crossover') return 'your add-ons costing more than the next plan';
  if (token === 'co_occurrence') return 'several limits under pressure at once';
  if (token === 'sustained_pressure') return 'sustained use near a limit';
  if (token.startsWith('pressure:')) return '';
  if (token.startsWith('candidate_tier:')) return '';
  return '';
}

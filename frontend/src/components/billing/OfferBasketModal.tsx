// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { useToast } from '@/components/ui/Toast';
import { formatPrice } from './helpers';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { AccountOffer, Bundle, BillingInterval } from '@/types';

/**
 * The basket a compose offer proposed, bought in ONE step
 * (docs/plans/sales-agent.md F6).
 *
 * `AddonGrid` sells one add-on at a time and `AddonPreviewModal` previews one,
 * so before this the answer to "three dimensions are under pressure" was three
 * separate purchases — which asks the account to assemble the offer itself and
 * leaves a half-bought basket as a reachable state.
 *
 * **It shows a COMBINED total and makes one call.** The total because the offer
 * was sized as a whole and three prices in three dialogs is not the same
 * information; the single call because the server applies the whole set under
 * one concurrency guard, so either all of it lands or none of it does.
 *
 * Items whose bundle is not in the account's catalogue are dropped rather than
 * priced as unknown: the catalogue is tier-filtered, so a bundle the account
 * cannot buy must not appear in a total it is about to confirm.
 */
export function OfferBasketModal({
  offer,
  subscriptionId,
  bundles,
  interval,
  onClose,
  onApplied,
}: {
  offer: AccountOffer;
  subscriptionId: string;
  bundles: readonly Bundle[];
  interval: BillingInterval;
  onClose: () => void;
  onApplied: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const items = offer.targetBundles
    .map((t) => {
      const bundle = bundles.find((b) => b.id === t.bundleId);
      return bundle ? { bundle, quantity: t.quantity } : null;
    })
    .filter((x): x is { bundle: Bundle; quantity: number } => x !== null);

  const per = interval === 'annual' ? 'year' : 'month';
  const priceOf = (b: Bundle) => (interval === 'annual' ? b.prices.annual : b.prices.monthly);
  const totalCents = items.reduce((sum, i) => sum + priceOf(i.bundle) * i.quantity, 0);

  async function apply() {
    setBusy(true);
    try {
      await api.addAddonBasket(subscriptionId, items.map((i) => ({ bundleId: i.bundle.id, quantity: i.quantity })));
      toast.success('Add-ons applied');
      onApplied();
    } catch (err) {
      // One failure means NOTHING was applied — the server's atomicity is what
      // makes that message honest, so say it rather than leaving the account to
      // wonder which part went through.
      toast.error(formatError(err, 'Nothing was changed — the basket was not applied'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add capacity on all three limits"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => void apply()}
          confirmLabel={items.length > 0 ? `Add ${items.length === 1 ? 'add-on' : `${items.length} add-ons`}` : 'Nothing to add'}
          loading={busy}
        />
      }
    >
      <div className="space-y-4">
        {items.length === 0 ? (
          <p className="text-sm text-fg-muted">
            None of the suggested add-ons are available on your current plan. Comparing plans is the better
            route from here.
          </p>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              These are applied together, in one change. If any part of it cannot be applied, none of it is.
            </p>
            <ul className="divide-y divide-default rounded-lg border border-default">
              {items.map((i) => (
                <li key={i.bundle.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <span className="text-sm text-fg">
                    {i.bundle.name}
                    {i.quantity > 1 && <span className="text-fg-muted"> × {i.quantity}</span>}
                  </span>
                  <span className="text-sm tabular-nums text-fg-muted">
                    {formatPrice(priceOf(i.bundle) * i.quantity)}/{per}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-fg" data-testid="offer-basket-total">
              Total <strong className="tabular-nums">{formatPrice(totalCents)}</strong> per {per}, added to
              your current bill.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

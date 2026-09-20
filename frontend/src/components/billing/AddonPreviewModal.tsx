// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { LoadingSpinner } from '@/components/ui/Loading';
import { formatCents } from '@/lib/format';
import type { AddonResult } from '@/types';

interface AddonPreviewModalProps {
  pendingAddon: { bundleId: string; name: string; quantity: number };
  addonPreview: AddonResult | null;
  previewLoading: boolean;
  paymentRequired: boolean;
  actionLoading: boolean;
  portalLoading: boolean;
  onClose: () => void;
  onCancel: () => void;
  onConfirmAddonChange: () => void;
  onOpenBillingPortal: () => void;
}

/** Preview-and-confirm: show the itemized new price (and any over-cap
 *  note) before committing an add-on change. */
export function AddonPreviewModal({
  pendingAddon,
  addonPreview,
  previewLoading,
  paymentRequired,
  actionLoading,
  portalLoading,
  onClose,
  onCancel,
  onConfirmAddonChange,
  onOpenBillingPortal,
}: AddonPreviewModalProps) {
  return (    <Modal
      title={paymentRequired
        ? 'Payment method required'
        : (pendingAddon.quantity <= 0 ? `Remove ${pendingAddon.name}` : `Update ${pendingAddon.name}`)}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onCancel}
          onConfirm={paymentRequired ? onOpenBillingPortal : onConfirmAddonChange}
          confirmLabel={paymentRequired ? 'Add a payment method' : 'Confirm'}
          loading={paymentRequired ? portalLoading : actionLoading}
          confirmDisabled={paymentRequired ? false : (previewLoading || !addonPreview)}
        />
      }
    >
      {paymentRequired ? (              <div className="space-y-3 py-1">
          <p className="text-sm text-fg">
            This account has no payment method on file, so paid add-ons can&apos;t be charged yet.
            Add a card to continue — you&apos;ll return here afterward to complete the purchase.
          </p>
          <p className="text-xs text-fg-muted">
            You&apos;re taken to our payment provider&apos;s secure portal; we never store card details.
          </p>
        </div>
      ): previewLoading || !addonPreview ? (              <div className="flex items-center gap-2 text-sm text-fg-muted py-4">
          <LoadingSpinner size="sm" /> Calculating new price…
        </div>
      ): (              <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted mb-2">
              New {addonPreview.priceBreakdown.interval === 'annual' ? 'annual' : 'monthly'} total
            </p>
            <ul className="text-sm divide-y divide-default">
              {addonPreview.priceBreakdown.items.map((item, i) => (                      <li key={`${item.label}-${i}`} className="flex justify-between py-1.5">
                  <span className="text-fg-muted">
                    {item.label}{item.quantity > 1 ? ` × ${item.quantity}` : ''}
                  </span>
                  <span className="tabular-nums text-fg">{formatCents(item.cents)}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-between border-t border-default mt-1 pt-2 text-sm font-semibold">
              <span className="text-fg">Total</span>
              <span className="tabular-nums text-fg">
                {formatCents(addonPreview.priceBreakdown.totalCents)}/{addonPreview.priceBreakdown.interval === 'annual' ? 'yr' : 'mo'}
              </span>
            </div>
          </div>
          {addonPreview.lostCombos && addonPreview.lostCombos.length > 0 && (
            <div className="rounded-md bg-warning-bg px-3 py-2 text-xs text-warning-strong">
              {addonPreview.lostCombos.map((c) => (
                <p key={c.comboId}>
                  Ends your {c.name} discount — {formatCents(c.creditCents)}/{addonPreview.priceBreakdown.interval === 'annual' ? 'yr' : 'mo'} off.
                </p>
              ))}
            </div>
          )}
          <p className="text-xs text-fg-muted">
            Changes are prorated and pool across your organization&apos;s teams. You can adjust or remove add-ons anytime.
          </p>
        </div>
      )}
    </Modal>
  );
}

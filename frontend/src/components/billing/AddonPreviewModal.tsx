// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { LoadingSpinner } from '@/components/ui/Loading';
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
          <p className="text-sm text-gray-700 dark:text-gray-300">
            This account has no payment method on file, so paid add-ons can&apos;t be charged yet.
            Add a card to continue — you&apos;ll return here afterward to complete the purchase.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            You&apos;re taken to our payment provider&apos;s secure portal; we never store card details.
          </p>
        </div>
      ): previewLoading || !addonPreview ? (              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-4">
          <LoadingSpinner size="sm" /> Calculating new price…
        </div>
      ): (              <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
              New {addonPreview.priceBreakdown.interval === 'annual' ? 'annual' : 'monthly'} total
            </p>
            <ul className="text-sm divide-y divide-gray-100 dark:divide-gray-800">
              {addonPreview.priceBreakdown.items.map((item, i) => (                      <li key={`${item.label}-${i}`} className="flex justify-between py-1.5">
                  <span className="text-gray-600 dark:text-gray-400">
                    {item.label}{item.quantity > 1 ? ` × ${item.quantity}` : ''}
                  </span>
                  <span className="tabular-nums text-gray-900 dark:text-gray-100">${(item.cents / 100).toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-between border-t border-gray-200 dark:border-gray-700 mt-1 pt-2 text-sm font-semibold">
              <span className="text-gray-900 dark:text-gray-100">Total</span>
              <span className="tabular-nums text-gray-900 dark:text-gray-100">
                ${(addonPreview.priceBreakdown.totalCents / 100).toFixed(2)}/{addonPreview.priceBreakdown.interval === 'annual' ? 'yr' : 'mo'}
              </span>
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Changes are prorated and pool across your organization&apos;s teams. You can adjust or remove add-ons anytime.
          </p>
        </div>
      )}
    </Modal>
  );
}

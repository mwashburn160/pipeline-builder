// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import api, { ApiError } from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { AddonResult, Subscription } from '@/types';

export interface PendingAddon {
  bundleId: string;
  name: string;
  quantity: number;
}

/**
 * Two-step add-on change: preview the new price (dry run), then commit.
 *
 * A paid purchase blocked by 402 PAYMENT_METHOD_REQUIRED flips `paymentRequired`
 * so the confirm modal can swap in an "Add a payment method" CTA instead of a
 * dead-end error toast. `onChanged` runs after a successful commit.
 */
export function useAddonChange(subscription: Subscription | null, onChanged: () => Promise<void> | void) {
  const toast = useToast();
  const [pendingAddon, setPendingAddon] = useState<PendingAddon | null>(null);
  const [addonPreview, setAddonPreview] = useState<AddonResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [committing, setCommitting] = useState(false);

  const reset = useCallback(() => {
    setPendingAddon(null);
    setAddonPreview(null);
    setPaymentRequired(false);
  }, []);

  /** Step 1: dry-run the change so the user sees the new price + effective limits
   *  before committing. Opens the confirm modal on success. */
  const requestAddonChange = async (bundleId: string, name: string, quantity: number) => {
    if (!subscription) return;
    setPendingAddon({ bundleId, name, quantity });
    setAddonPreview(null);
    setPaymentRequired(false);
    setPreviewLoading(true);
    try {
      const res = await api.previewAddon(subscription.id, bundleId, quantity);
      if (res.success && res.data) setAddonPreview(res.data);
    } catch (err) {
      toast.error(formatError(err, 'Failed to price this change'));
      setPendingAddon(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  /** Step 2: commit the previewed change. The server re-checks the over-cap gate;
   *  its 409 message is surfaced verbatim. */
  const confirmAddonChange = async () => {
    if (!subscription || !pendingAddon) return;
    const { bundleId, quantity } = pendingAddon;
    setCommitting(true);
    try {
      const res = quantity <= 0
        ? await api.removeAddon(subscription.id, bundleId)
        : await api.addAddon(subscription.id, bundleId, quantity);
      if (res.success) {
        toast.success('Add-ons updated');
        setPendingAddon(null);
        setAddonPreview(null);
        await onChanged();
      }
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'PAYMENT_METHOD_REQUIRED' || err.statusCode === 402)) {
        setPaymentRequired(true);
      } else {
        toast.error(formatError(err, 'Failed to update add-on'));
      }
    } finally {
      setCommitting(false);
    }
  };

  /** Close the confirm modal — ignored while a commit is in flight. */
  const closeAddonChange = () => {
    if (!committing) reset();
  };

  return {
    pendingAddon,
    addonPreview,
    previewLoading,
    paymentRequired,
    committing,
    requestAddonChange,
    confirmAddonChange,
    closeAddonChange,
    cancelAddonChange: reset,
  };
}

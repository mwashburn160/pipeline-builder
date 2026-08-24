// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import { formatCents } from '@/lib/format';
import api, { ApiError } from '@/lib/api';
import type { DiscountPriceBreakdown } from '@/lib/api/domains/billing';
import type { Subscription } from '@/types';

interface DiscountRedeemProps {
  subscription: Subscription;
  /** Mirrors the page's `canChangePlan` — gates the redeem/remove actions. */
  canManage: boolean;
  /** Trigger a billing-data refresh so the applied discount / new period shows. */
  onApplied: () => void;
}

/** True when an error is a 404 — the discounts feature is disabled in this
 *  deployment, so the widget should fail soft (hide itself) rather than error. */
function isNotAvailable(err: unknown): boolean {
  return err instanceof ApiError && err.statusCode === 404;
}

/** Self-service discount-code redemption for the active subscription. Preview is
 *  a dry-run (billing:read); apply/remove mutate (billing:manage). Fails soft to
 *  nothing when the feature is disabled (endpoints 404). */
export function DiscountRedeem({ subscription, canManage, onApplied }: DiscountRedeemProps) {
  const toast = useToast();
  const [code, setCode] = useState('');
  // Per-action busy state so previewing doesn't spin the Apply/Remove buttons
  // (and vice-versa).
  const [busy, setBusy] = useState<'preview' | 'apply' | 'remove' | null>(null);
  const [preview, setPreview] = useState<{ applied: string; priceBreakdown: DiscountPriceBreakdown } | null>(null);
  // Set when an endpoint 404s (discounts disabled in this deployment) → hide.
  const [unavailable, setUnavailable] = useState(false);

  const recurring = subscription.recurringDiscount;

  if (unavailable) return null;

  const handlePreview = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy('preview');
    try {
      const res = await api.previewDiscountCode(subscription.id, trimmed);
      if (res.success && res.data) {
        setPreview({ applied: res.data.applied, priceBreakdown: res.data.priceBreakdown });
      } else {
        // 2xx with no usable payload — don't leave the user staring at a spinner
        // that ended with nothing shown.
        toast.error(res.message || 'This code could not be previewed');
      }
    } catch (err) {
      if (isNotAvailable(err)) { setUnavailable(true); return; }
      toast.error(formatError(err, 'Failed to preview discount code'));
    } finally {
      setBusy(null);
    }
  };

  const handleApply = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy('apply');
    try {
      const res = await api.redeemDiscountCode(subscription.id, trimmed);
      if (res.success) {
        toast.success('Discount applied');
        setCode('');
        setPreview(null);
        onApplied();
      } else {
        toast.error(res.message || 'This code could not be applied');
      }
    } catch (err) {
      if (isNotAvailable(err)) { setUnavailable(true); return; }
      toast.error(formatError(err, 'Failed to apply discount code'));
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    if (!recurring) return;
    setBusy('remove');
    try {
      const res = await api.removeSubscriptionDiscount(subscription.id, recurring.discountId);
      if (res.success) {
        toast.success('Recurring discount removed');
        onApplied();
      } else {
        toast.error(res.message || 'Could not remove the discount');
      }
    } catch (err) {
      if (isNotAvailable(err)) { setUnavailable(true); return; }
      toast.error(formatError(err, 'Failed to remove discount'));
    } finally {
      setBusy(null);
    }
  };

  // Readable label for the standing recurring discount: value+unit+kind when
  // available, otherwise the discount id.
  const recurringLabel = recurring
    ? [
        recurring.value != null
          ? recurring.unit === 'percent'
            ? `${recurring.value}% off`
            : formatCents(recurring.value)
          : null,
        recurring.kind,
      ].filter(Boolean).join(' · ') || recurring.discountId
    : null;

  return (
    <Card>
      <h2 className="text-lg font-semibold text-[var(--pb-text)] mb-1">Discount</h2>
      <p className="text-sm text-[var(--pb-text-muted)] mb-4">
        Have a discount code? Apply it as a usage credit against your bill.
      </p>

      {recurring && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md bg-green-50 dark:bg-green-900/30 px-3 py-2">
          <div className="text-sm text-green-700 dark:text-green-300">
            <span className="font-medium">Active recurring discount</span>
            <span className="ml-2">{recurringLabel}</span>
          </div>
          <Button
            variant="danger-outline"
            size="sm"
            loading={busy === 'remove'}
            disabled={!canManage || busy !== null}
            onClick={handleRemove}
          >
            Remove
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={code}
          onChange={(e) => { setCode(e.target.value); setPreview(null); }}
          placeholder="Enter discount code"
          disabled={!canManage || busy !== null}
          className="flex-1"
          aria-label="Discount code"
        />
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'preview'}
          disabled={!canManage || busy !== null || !code.trim()}
          onClick={handlePreview}
        >
          Preview
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy === 'apply'}
          disabled={!canManage || busy !== null || !code.trim()}
          onClick={handleApply}
        >
          Apply
        </Button>
      </div>

      {preview && (
        <div className="mt-4 rounded-md border border-[var(--pb-border)] p-3">
          <p className="text-sm text-[var(--pb-text)]">
            Applies as: <span className="font-medium">{preview.applied}</span>
          </p>
          <dl className="mt-2 space-y-1">
            {(preview.priceBreakdown.items ?? []).map((item, i) => (
              <div key={i} className="flex items-center justify-between gap-4 text-sm">
                <dt className="text-[var(--pb-text-muted)]">{item.label}</dt>
                <dd className="text-[var(--pb-text)] tabular-nums text-right">{formatCents(item.cents)}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 text-sm border-t border-[var(--pb-border)] pt-1 mt-1 font-medium">
              <dt className="text-[var(--pb-text)]">Total ({preview.priceBreakdown.interval})</dt>
              <dd className="text-[var(--pb-text)] tabular-nums text-right">{formatCents(preview.priceBreakdown.totalCents)}</dd>
            </div>
            {preview.priceBreakdown.creditRemainingCents > 0 && (
              <div className="flex items-center justify-between gap-4 text-xs text-[var(--pb-text-muted)]">
                <dt>Credit remaining</dt>
                <dd className="tabular-nums text-right">{formatCents(preview.priceBreakdown.creditRemainingCents)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {!canManage && (
        <p className="mt-3 text-sm text-[var(--pb-text-muted)]">
          Contact an organization admin to redeem a discount code.
        </p>
      )}
    </Card>
  );
}

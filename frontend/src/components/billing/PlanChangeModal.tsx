// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { formatPrice } from './helpers';
import api from '@/lib/api';
import type { Plan, BillingInterval, PlanChangePreview } from '@/types';

interface PlanChangeModalProps {
  /** The plan the user is switching to. */
  targetPlan: Plan;
  /** Name of the plan currently in effect (for the "from → to" copy). */
  currentPlanName: string;
  interval: BillingInterval;
  /** True when the target sits below the current plan — warrants a caps/features warning. */
  isDowngrade: boolean;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Confirmation dialog shown before switching an existing subscription's plan.
 *
 * It PRICES the change rather than quoting the list price, which it did not do
 * before (docs/plans/sales-agent.md F1): an account that accepted a 50%-off
 * offer opened this modal and saw the full figure, so every discounted offer in
 * the product was a promise the checkout contradicted.
 *
 * The figure comes from `GET /billing/plan-preview`, not from arithmetic here.
 * The discount stack — interval, volume curve, combos, coupon, and the
 * aggregate floor that can refuse the lot — has one implementation, and a
 * second one in this component is a second answer the invoice disagrees with.
 *
 * FAILS OPEN to the list price: a preview that cannot be read still lets the
 * change be confirmed, because blocking an upgrade on an unreachable price
 * endpoint is worse than quoting the undiscounted figure. The discount line is
 * simply absent, which is the state this modal was always in.
 */
export function PlanChangeModal({
  targetPlan,
  currentPlanName,
  interval,
  isDowngrade,
  loading,
  onConfirm,
  onClose,
}: PlanChangeModalProps) {
  const price = interval === 'annual' ? targetPlan.prices.annual : targetPlan.prices.monthly;
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getPlanPreview(targetPlan.tier);
        if (!cancelled) setPreview(res.data?.preview ?? null);
      } catch { /* fail open to the list price — see above */ }
    })();
    return () => { cancelled = true; };
  }, [targetPlan.tier]);

  const per = interval === 'annual' ? 'year' : 'month';
  const discounted = preview !== null && preview.discountCents > 0;
  return (
    <Modal
      title={`Switch to ${targetPlan.name}?`}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onConfirm}
          confirmLabel={isDowngrade ? 'Downgrade plan' : 'Switch plan'}
          confirmVariant={isDowngrade ? 'danger' : 'primary'}
          loading={loading}
        />
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-fg">
          You&apos;re changing your plan from <strong>{currentPlanName}</strong> to{' '}
          <strong>{targetPlan.name}</strong>
          {discounted ? (
            <>
              {' '}at{' '}
              <strong className="tabular-nums">{formatPrice(preview.netPlanCents)}</strong> per {per}{' '}
              <span className="text-fg-muted line-through tabular-nums">{formatPrice(preview.listCents)}</span>.
            </>
          ) : (
            <>
              {' '}at <strong className="tabular-nums">{formatPrice(price)}</strong>
              {price > 0 ? ` per ${per}` : ''}.
            </>
          )}
        </p>

        {discounted && (
          <p className="text-xs text-success" data-testid="plan-change-discount">
            Your discount applies: <strong className="tabular-nums">{formatPrice(preview.discountCents)}</strong>{' '}
            off per {per}.
          </p>
        )}

        {/* Add-ons that keep billing after the move. Said here because the plan
            price alone is not what the next invoice carries, and an account that
            reads only the plan figure is surprised by the total. */}
        {preview !== null && preview.survivingAddonCents > 0 && (
          <p className="text-xs text-fg-muted tabular-nums" data-testid="plan-change-total">
            With your current add-ons, the total becomes{' '}
            <strong>{formatPrice(preview.totalCents)}</strong> per {per}.
          </p>
        )}

        {preview !== null && preview.prunedAddons.length > 0 && (
          <p className="text-xs text-fg-muted">
            {targetPlan.name} includes {preview.prunedAddons.length === 1 ? 'an add-on' : `${preview.prunedAddons.length} add-ons`}{' '}
            you currently pay for separately — {preview.prunedAddons.length === 1 ? 'it' : 'they'} will be
            removed from your bill.
          </p>
        )}
        {isDowngrade && (
          <div className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning-bg p-3">
            <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <p className="text-sm text-warning-strong">
              Downgrading may reduce your quota caps and disable features tied to your current plan.
              If your usage is above the lower plan&apos;s limits, some actions may be blocked until you
              reduce usage.
            </p>
          </div>
        )}
        <p className="text-xs text-fg-muted">
          Changes are prorated and take effect immediately.
        </p>
      </div>
    </Modal>
  );
}

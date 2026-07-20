// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import type { Plan, BillingInterval } from '@/types';

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

/** Formats a price in cents as a dollar string (0 → "Free"). */
function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Confirmation dialog shown before switching an existing subscription's plan.
 * Plan changes lack a proration/price preview endpoint (only add-ons have one),
 * so this is a plain confirm — with an explicit warning that a downgrade can
 * reduce quota caps and disable plan-gated features.
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
        <p className="text-sm text-gray-700 dark:text-gray-300">
          You&apos;re changing your plan from <strong>{currentPlanName}</strong> to{' '}
          <strong>{targetPlan.name}</strong> at{' '}
          <strong>{formatPrice(price)}</strong>
          {price > 0 ? ` per ${interval === 'annual' ? 'year' : 'month'}` : ''}.
        </p>
        {isDowngrade && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-800 dark:text-amber-200">
              Downgrading may reduce your quota caps and disable features tied to your current plan.
              If your usage is above the lower plan&apos;s limits, some actions may be blocked until you
              reduce usage.
            </p>
          </div>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Changes are prorated and take effect immediately.
        </p>
      </div>
    </Modal>
  );
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useId } from 'react';
import { formatError } from '@/lib/constants';
import { useFormState } from '@/hooks/useFormState';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { OrgPicker } from '@/components/ui/OrgPicker';
import api from '@/lib/api';
import { formatCents } from '@/lib/format';
import type { DiscountPriceBreakdown } from '@/lib/api/domains/billing';
import type { Discount } from '@/types';
import { formatDiscount } from './formatDiscount';

/** Render the itemized discount price breakdown: one row per line item plus the
 *  period total, all money in cents formatted with `formatCents`. */
function PriceBreakdown({ breakdown }: { breakdown: DiscountPriceBreakdown }) {
  if (!breakdown?.items?.length) return null;
  return (
    <dl className="mt-2 space-y-1">
      {breakdown.items.map((item, i) => (
        <div key={i} className="flex items-center justify-between gap-3 text-xs">
          <dt className="text-fg-muted">{item.label}</dt>
          <dd className="font-mono text-fg-muted text-right tabular-nums">{formatCents(item.cents)}</dd>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 text-xs border-t border-default pt-1 mt-1 font-medium">
        <dt className="text-fg-muted">Total ({breakdown.interval})</dt>
        <dd className="font-mono text-fg text-right tabular-nums">{formatCents(breakdown.totalCents)}</dd>
      </div>
      {breakdown.creditRemainingCents > 0 && (
        <div className="flex items-center justify-between gap-3 text-xs text-fg-muted">
          <dt>Credit remaining</dt>
          <dd className="font-mono text-right tabular-nums">{formatCents(breakdown.creditRemainingCents)}</dd>
        </div>
      )}
    </dl>
  );
}

interface ApplyDiscountModalProps {
  discount: Discount;
  /** Org picker options (loaded by the caller when the modal opens). */
  onClose: () => void;
  /** Called with the target org id after the grant succeeded. */
  onApplied: (orgId: string) => void;
}

/** Grant a discount directly to an organization, with an optional dry-run preview. */
export function ApplyDiscountModal({ discount, onClose, onApplied }: ApplyDiscountModalProps) {
  const uid = useId();
  const [applyOrgId, setApplyOrgId] = useState(discount.targetOrgId ?? '');
  const applyForm = useFormState();

  // Dry-run the direct grant so the operator sees the effect before it counts as
  // a redemption. Cleared when the org id changes.
  const [applyPreview, setApplyPreview] = useState<{ applied: string; priceBreakdown: DiscountPriceBreakdown } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handlePreviewApply = async () => {
    const org = applyOrgId.trim();
    if (!org) {
      applyForm.setError('Enter a target organization id.');
      return;
    }
    setPreviewLoading(true);
    applyForm.setError(null);
    try {
      const res = await api.previewDiscountForOrg(discount.id, org);
      if (res.success && res.data) setApplyPreview(res.data);
    } catch (err) {
      applyForm.setError(formatError(err, 'Failed to preview discount'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    const org = applyOrgId.trim();
    if (!org) {
      applyForm.setError('Enter a target organization id.');
      return;
    }
    const result = await applyForm.run(() => api.applyDiscountToOrg(discount.id, org));
    if (result !== null) onApplied(org);
  };

  return (
    <Modal
      title="Apply discount to organization"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={applyForm.loading}>Cancel</Button>
          <Button
            variant="secondary"
            onClick={handlePreviewApply}
            loading={previewLoading}
            disabled={!applyOrgId.trim() || applyForm.loading}
          >
            Preview
          </Button>
          <Button
            onClick={handleApply}
            loading={applyForm.loading}
            disabled={!applyOrgId.trim() || previewLoading}
          >
            Apply
          </Button>
        </div>
      }
    >
      <p className="text-sm text-fg-muted mb-4">
        Grant <strong className="text-fg-muted">{formatDiscount(discount)}</strong> directly to an
        organization. Preview the effect first — applying counts as a redemption.
      </p>
      <div className="space-y-1">
        <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-target-org`}>Target organization</label>
        {/* Server-searched, so any org is reachable; a prefilled target org is
            always the selected option even before its name resolves. */}
        <OrgPicker
          id={`${uid}-target-org`}
          value={applyOrgId}
          onChange={(id) => { setApplyOrgId(id); setApplyPreview(null); }}
          none={{ value: '', label: 'Select an organization…' }}
          aria-label="Target organization"
          disabled={applyForm.loading}
        />
      </div>
      {applyPreview && (
        <div className="mt-4 rounded-md border border-blue-200/70 dark:border-blue-800/60 bg-blue-50/70 dark:bg-blue-900/20 p-3">
          <div className="text-xs font-semibold text-info-strong">Preview (not applied)</div>
          <div className="mt-1 text-sm text-fg-muted">{applyPreview.applied}</div>
          <PriceBreakdown breakdown={applyPreview.priceBreakdown} />
        </div>
      )}
      {applyForm.error && <p className="text-sm text-danger mt-3">{applyForm.error}</p>}
    </Modal>
  );
}

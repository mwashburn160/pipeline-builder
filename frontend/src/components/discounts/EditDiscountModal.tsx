// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useId } from 'react';
import { useFormState } from '@/hooks/useFormState';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import api from '@/lib/api';
import type { Discount } from '@/types';
import { TIER_KEYS } from '@/lib/tiers';
import { formatDiscount } from './formatDiscount';

// Selectable tiers a discount can target — sourced from the shared TIER_KEYS so
// the picker never drifts from the tier catalog. (`unlimited` is intentionally absent.)
const TIER_OPTIONS = TIER_KEYS;

interface EditDiscountModalProps {
  discount: Discount;
  onClose: () => void;
  /** Called after the update succeeded. */
  onSaved: () => void;
}

/** Edit isActive / maxRedemptions / redeemBy / appliesToTiers of a minted discount. */
export function EditDiscountModal({ discount, onClose, onSaved }: EditDiscountModalProps) {
  const uid = useId();
  const [editMaxRedemptions, setEditMaxRedemptions] = useState(
    discount.maxRedemptions != null ? String(discount.maxRedemptions) : '',
  );
  // <input type="date"> wants YYYY-MM-DD; the record carries a full ISO instant.
  const [editRedeemBy, setEditRedeemBy] = useState(discount.redeemBy ? discount.redeemBy.slice(0, 10) : '');
  const [editTiers, setEditTiers] = useState<string[]>(discount.appliesToTiers ?? []);
  const [editActive, setEditActive] = useState(discount.isActive);
  const editForm = useFormState();

  const toggleEditTier = (tier: string) => {
    setEditTiers((prev) => prev.includes(tier) ? prev.filter((t) => t !== tier) : [...prev, tier]);
  };

  const handleEdit = async () => {
    const maxR = editMaxRedemptions.trim() ? Number(editMaxRedemptions.trim()) : undefined;
    // The API only accepts a positive cap (schema min 1); a blank field leaves the
    // existing value untouched rather than clearing it.
    if (maxR !== undefined && (!Number.isFinite(maxR) || maxR < 1)) {
      editForm.setError('Max redemptions must be a positive number (leave blank to keep unchanged).');
      return;
    }
    const body: { isActive?: boolean; maxRedemptions?: number; redeemBy?: string; appliesToTiers?: string[] } = {
      isActive: editActive,
      appliesToTiers: editTiers,
    };
    if (maxR !== undefined) body.maxRedemptions = maxR;
    if (editRedeemBy.trim()) body.redeemBy = new Date(editRedeemBy.trim()).toISOString();
    const result = await editForm.run(() => api.updateDiscount(discount.id, body));
    if (result !== null) onSaved();
  };

  return (
    <Modal
      title="Edit discount"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleEdit}
          confirmLabel="Save Changes"
          loading={editForm.loading}
        />
      }
    >
      <p className="text-sm text-fg-muted mb-4">
        Editing <strong className="text-fg-muted">{discount.alias || formatDiscount(discount)}</strong>.
        The discount amount and kind are fixed at mint time and can’t be changed here.
      </p>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <Checkbox
            checked={editActive}
            onChange={(e) => setEditActive(e.target.checked)}
            disabled={editForm.loading}
          />
          <span><strong>Active</strong> — uncheck to deactivate (existing grants persist).</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-max-redemptions`}>Max redemptions</label>
            <Input id={`${uid}-max-redemptions`}
              type="number"
              min={1}
              placeholder="Keep unchanged"
              value={editMaxRedemptions}
              onChange={(e) => setEditMaxRedemptions(e.target.value)}
              className="text-sm"
              disabled={editForm.loading}
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-redeem-by`}>Redeem by</label>
            <Input id={`${uid}-redeem-by`}
              type="date"
              value={editRedeemBy}
              onChange={(e) => setEditRedeemBy(e.target.value)}
              className="text-sm"
              disabled={editForm.loading}
            />
          </div>
        </div>
        <div className="space-y-1">
          <span className="block text-xs font-medium text-fg-muted" id={`${uid}-tiers`}>Applies to tiers <span className="text-fg-subtle">(none = all tiers)</span></span>
          <div role="group" aria-labelledby={`${uid}-tiers`} className="flex flex-wrap gap-2">
            {TIER_OPTIONS.map((tier) => (
              <button
                key={tier}
                type="button"
                onClick={() => toggleEditTier(tier)}
                aria-pressed={editTiers.includes(tier)}
                disabled={editForm.loading}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border capitalize transition-colors ${editTiers.includes(tier)
                  ? 'bg-brand text-white border-brand'
                  : 'bg-surface text-fg-muted border-default hover:bg-surface-muted'}`}
              >
                {tier}
              </button>
            ))}
          </div>
        </div>
      </div>
      {editForm.error && <p className="text-sm text-danger mt-3">{editForm.error}</p>}
    </Modal>
  );
}

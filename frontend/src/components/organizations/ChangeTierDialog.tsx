// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Select } from '@/components/ui/Select';
import { TIER_KEYS, getTierMeta } from '@/lib/tiers';
import type { Organization, QuotaTier } from '@/types';

interface ChangeTierDialogProps {
  org: Organization;
  onClose: () => void;
  /** Called with the picked tier when it differs from the org's current tier (then closes). */
  onSelect: (tier: QuotaTier) => void;
}

/**
 * First phase of the inline per-row tier change: pick the new tier. The caller
 * then re-verifies via StepUpModal (the backend PATCH is step-up gated because a
 * tier change reseeds quota limits / affects billing).
 */
export function ChangeTierDialog({ org, onClose, onSelect }: ChangeTierDialogProps) {
  const current = org.tier ?? 'developer';
  const [newTier, setNewTier] = useState<QuotaTier>(current);
  // `unlimited` is the tier every org is on when billing is disabled, and it is
  // deliberately not purchasable — so it is never OFFERED, but it has to be
  // listed while the org is on it or the <select> would silently show (and
  // submit) "Developer" for an org that is on no such plan.
  const options: readonly QuotaTier[] = TIER_KEYS.includes(current) ? TIER_KEYS : [current, ...TIER_KEYS];

  // Advance from tier-picker to the step-up prompt (no-op if unchanged).
  const confirmTierSelection = () => {
    if (newTier !== org.tier) onSelect(newTier);
    onClose();
  };

  return (
    <Modal
      title={`Change tier — ${org.name}`}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={confirmTierSelection}
          confirmLabel="Continue"
          confirmDisabled={newTier === org.tier}
        />
      }
    >
      <p className="text-sm text-fg-muted mb-4">
        Changing the tier reseeds this organization’s quota limits and affects billing.
        You’ll be asked to re-verify before the change is applied.
      </p>
      <div className="space-y-1">
        <label className="block text-xs font-medium text-fg-muted">Tier</label>
        <Select
          value={newTier}
          onChange={(e) => setNewTier(e.target.value as QuotaTier)}
          className="text-sm"
        >
          {options.map((tier) => (
            <option key={tier} value={tier}>{getTierMeta(tier).label}</option>
          ))}
        </Select>
      </div>
    </Modal>
  );
}

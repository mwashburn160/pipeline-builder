// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Select } from '@/components/ui/Select';
import type { Organization } from '@/types';

/** Tiers an operator can assign to an organization. */
export type OrgTier = 'developer' | 'pro' | 'team' | 'enterprise';

interface ChangeTierDialogProps {
  org: Organization;
  onClose: () => void;
  /** Called with the picked tier when it differs from the org's current tier (then closes). */
  onSelect: (tier: OrgTier) => void;
}

/**
 * First phase of the inline per-row tier change: pick the new tier. The caller
 * then re-verifies via StepUpModal (the backend PATCH is step-up gated because a
 * tier change reseeds quota limits / affects billing).
 */
export function ChangeTierDialog({ org, onClose, onSelect }: ChangeTierDialogProps) {
  const [newTier, setNewTier] = useState<OrgTier>((org.tier as OrgTier) ?? 'developer');

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
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Tier</label>
        <Select
          value={newTier}
          onChange={(e) => setNewTier(e.target.value as OrgTier)}
          className="text-sm"
        >
          <option value="developer">Developer</option>
          <option value="pro">Pro</option>
          <option value="team">Team</option>
          <option value="enterprise">Enterprise</option>
        </Select>
      </div>
    </Modal>
  );
}

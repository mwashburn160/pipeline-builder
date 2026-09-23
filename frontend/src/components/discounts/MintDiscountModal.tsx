// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useId } from 'react';
import { useFormState } from '@/hooks/useFormState';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import api from '@/lib/api';

interface MintDiscountModalProps {
  onClose: () => void;
  /** Called after the discount was created successfully. */
  onCreated: () => void;
}

/** Create (mint) a discount. Mounted only while open, so every open starts blank. */
export function MintDiscountModal({ onClose, onCreated }: MintDiscountModalProps) {
  const uid = useId();
  const [code, setCode] = useState('');
  const [alias, setAlias] = useState('');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [campaign, setCampaign] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [redeemBy, setRedeemBy] = useState('');
  const createForm = useFormState();

  const handleCreate = async () => {
    const trimmedCode = code.trim();
    if (!trimmedCode) return;
    const maxR = maxRedemptions.trim() ? Number(maxRedemptions.trim()) : undefined;
    // Schema floor is 1 (blank = unlimited) — match the edit path so a `0` fails
    // up front instead of as a generic server 400.
    if (maxR !== undefined && (!Number.isFinite(maxR) || maxR < 1)) {
      createForm.setError('Max redemptions must be 1 or more (leave blank for unlimited).');
      return;
    }
    await createForm.run(() => api.createDiscount({
      code: trimmedCode,
      ...(alias.trim() && { alias: alias.trim() }),
      ...(targetOrgId.trim() && { targetOrgId: targetOrgId.trim() }),
      ...(campaign.trim() && { campaign: campaign.trim() }),
      ...(maxR !== undefined && { maxRedemptions: maxR }),
      // <input type="date"> yields YYYY-MM-DD; send as an ISO instant.
      ...(redeemBy.trim() && { redeemBy: new Date(redeemBy.trim()).toISOString() }),
    }), { onSuccess: () => onCreated() });
  };

  return (
    <Modal
      title="Mint discount"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleCreate}
          confirmLabel="Create Discount"
          loading={createForm.loading}
          confirmDisabled={!code.trim()}
        />
      }
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-code`}>Code</label>
          <Input id={`${uid}-code`}
            type="text"
            placeholder="50:percent:onetime"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="text-sm font-mono"
            autoFocus
            disabled={createForm.loading}
          />
          <p className="text-xs text-fg-muted">
            Format <code className="font-mono">value:unit:kind[:campaign]</code> — unit is
            {' '}<code className="font-mono">percent</code> or <code className="font-mono">dollar</code>; kind is
            {' '}<code className="font-mono">onetime</code>, <code className="font-mono">recurring</code>, or <code className="font-mono">credit</code>.
            {' '}e.g. <code className="font-mono">50:percent:onetime</code>, <code className="font-mono">25:dollar:recurring</code>, <code className="font-mono">100:dollar:credit</code>.
          </p>
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-alias-optional`}>Alias <span className="text-fg-subtle">(optional)</span></label>
          <Input id={`${uid}-alias-optional`}
            type="text"
            placeholder="e.g. LAUNCH50"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            className="text-sm"
            disabled={createForm.loading}
          />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-target-org-id-optional`}>Target org id <span className="text-fg-subtle">(optional)</span></label>
          <Input id={`${uid}-target-org-id-optional`}
            type="text"
            placeholder="Leave blank for any org"
            value={targetOrgId}
            onChange={(e) => setTargetOrgId(e.target.value)}
            className="text-sm font-mono"
            disabled={createForm.loading}
          />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-campaign-optional`}>Campaign <span className="text-fg-subtle">(optional)</span></label>
          <Input id={`${uid}-campaign-optional`}
            type="text"
            placeholder="e.g. summer-2026"
            value={campaign}
            onChange={(e) => setCampaign(e.target.value)}
            className="text-sm"
            disabled={createForm.loading}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-max-redemptions-optional`}>Max redemptions <span className="text-fg-subtle">(optional)</span></label>
            <Input id={`${uid}-max-redemptions-optional`}
              type="number"
              min={1}
              placeholder="Unlimited"
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              className="text-sm"
              disabled={createForm.loading}
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-redeem-by-optional`}>Redeem by <span className="text-fg-subtle">(optional)</span></label>
            <Input id={`${uid}-redeem-by-optional`}
              type="date"
              value={redeemBy}
              onChange={(e) => setRedeemBy(e.target.value)}
              className="text-sm"
              disabled={createForm.loading}
            />
          </div>
        </div>
      </div>
      {createForm.error && <p className="text-sm text-danger mt-3">{createForm.error}</p>}
    </Modal>
  );
}

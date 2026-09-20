// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { useFormState } from '@/hooks/useFormState';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { useToast } from '@/components/ui/Toast';
import { OrgSetupStep } from '@/components/onboarding/OrgSetupStep';
import { EligibleParentPicker, type ParentOrgOption } from '@/components/teams/EligibleParentPicker';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { TIER_KEYS, getTierMeta } from '@/lib/tiers';
import type { QuotaTier } from '@/types';

interface CreateOrganizationFlowProps {
  /** Whether the create modal is shown. */
  open: boolean;
  onClose: () => void;
  /** Called after an org/team was created (e.g. refresh the list). */
  onCreated: () => void;
}

/**
 * Create a new organization (sysadmin): the create modal, then — for a
 * TOP-LEVEL org only — the CLI/setup step. The creator becomes the initial
 * owner; ownership can be transferred from the org's detail page. Stays mounted
 * so the setup step can outlive the create modal.
 */
export function CreateOrganizationFlow({ open, onClose, onCreated }: CreateOrganizationFlowProps) {
  const toast = useToast();
  // After creating a TOP-LEVEL org, offer the CLI/setup step (teams/sub-orgs share
  // the parent's deployment + token, so they skip it).
  const [setupTier, setSetupTier] = useState<string | undefined>(undefined);
  const [setupOpen, setSetupOpen] = useState(false);

  const handleCreated = ({ name, tier, asTeam }: { name: string; tier: QuotaTier; asTeam: boolean }) => {
    onClose();
    onCreated();
    toast.success(`${asTeam ? 'Team' : 'Organization'} "${name}" created`);
    // Top-level org → show the final install/setup step (CLI + optional per-org
    // event metrics). Teams/sub-orgs share the parent's setup, so they skip it.
    if (!asTeam) {
      setSetupTier(tier);
      setSetupOpen(true);
    }
  };

  return (
    <>
      {open && <CreateOrganizationModal onClose={onClose} onCreated={handleCreated} />}

      {setupOpen && (
        <Modal title="Finish setting up your organization" onClose={() => setSetupOpen(false)} maxWidth="lg">
          <OrgSetupStep planTier={setupTier} variant="modal" doneLabel="Done" onDone={() => setSetupOpen(false)} />
        </Modal>
      )}
    </>
  );
}

/** The create form. Mounted only while open, so each open starts from a clean state. */
function CreateOrganizationModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (result: { name: string; tier: QuotaTier; asTeam: boolean }) => void;
}) {
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgTier, setNewOrgTier] = useState<QuotaTier>('developer');
  // Defaults to a top-level org (matching the "New Organization" label); check
  // the Team box to instead nest under a parent. Parent candidates come from a
  // server-side search over the ELIGIBLE roots only (team/enterprise tier), so
  // the picker can't offer a parent the backend would refuse.
  const [createAsSubOrg, setCreateAsSubOrg] = useState(false);
  const [parent, setParent] = useState<ParentOrgOption | null>(null);
  const parentOrgId = parent?.id ?? '';
  const createForm = useFormState();

  const handleCreateOrg = async () => {
    const name = newOrgName.trim();
    if (!name) return;
    if (createAsSubOrg && !parentOrgId) {
      createForm.setError('Choose a parent organization for the team (or uncheck to create a top-level org).');
      return;
    }
    // A team inherits its parent's tier, so none is sent for one.
    const result = await createForm.run(() => api.createOrganization({
      name,
      ...(createAsSubOrg && parentOrgId ? { parentOrgId } : { tier: newOrgTier }),
    }));
    if (result !== null) {
      // Every cached org list (audit page, quota picker, IdP roster, this very
      // parent picker) is now missing the new org.
      invalidate.organizations();
      onCreated({ name, tier: newOrgTier, asTeam: createAsSubOrg });
    }
  };

  return (
    <Modal
      title={createAsSubOrg ? 'Create team' : 'Create Organization'}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleCreateOrg}
          confirmLabel={createAsSubOrg ? 'Create team' : 'Create Organization'}
          loading={createForm.loading}
          confirmDisabled={!newOrgName.trim() || (createAsSubOrg && !parentOrgId)}
        />
      }
    >
      <p className="text-sm text-fg-muted mb-4">
        {createAsSubOrg
          ? 'Create a team nested under a parent organization. You become its initial owner; transfer ownership from the org’s detail page afterward.'
          : 'Create a top-level organization. You become its initial owner; transfer ownership from the org’s detail page afterward.'}
      </p>
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted">
            {createAsSubOrg ? 'Team name' : 'Organization name'}
          </label>
          <Input
            type="text"
            placeholder="e.g. acme-platform"
            value={newOrgName}
            onChange={(e) => setNewOrgName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateOrg()}
            className="text-sm"
            autoFocus
            disabled={createForm.loading}
          />
        </div>
        {!createAsSubOrg && (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted">Tier</label>
            <Select
              value={newOrgTier}
              onChange={(e) => setNewOrgTier(e.target.value as QuotaTier)}
              className="text-sm"
              disabled={createForm.loading}
            >
              {/* TIER_KEYS, not a hand-written list: `unlimited` is a real
                  tier but never a purchasable one, so it must not appear here. */}
              {TIER_KEYS.map((tier) => (
                <option key={tier} value={tier}>{getTierMeta(tier).label}</option>
              ))}
            </Select>
          </div>
        )}

        {/* Team toggle — defaults OFF (top-level org). When on, pick the parent. */}
        <label className="flex items-start gap-2 text-xs text-fg-muted pt-1">
          <Checkbox
            checked={createAsSubOrg}
            onChange={(e) => setCreateAsSubOrg(e.target.checked)}
            disabled={createForm.loading}
            className="mt-0.5"
          />
          <span>
            <strong>Team</strong> — nest this organization under a parent org.
            Uncheck to create a standalone top-level organization. A team inherits
            its parent&apos;s tier, seats and quotas.
          </span>
        </label>

        {createAsSubOrg && (
          <EligibleParentPicker value={parent} onChange={setParent} disabled={createForm.loading} />
        )}
      </div>
      {createForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{createForm.error}</p>}
    </Modal>
  );
}

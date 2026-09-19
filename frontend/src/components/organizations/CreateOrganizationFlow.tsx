// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { useFormState } from '@/hooks/useFormState';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { useToast } from '@/components/ui/Toast';
import { OrgSetupStep } from '@/components/onboarding/OrgSetupStep';
import api from '@/lib/api';
import { invalidate, queries } from '@/lib/api-cache';
import { runQuery } from '@/lib/query-cache';
import type { Organization } from '@/types';
import type { OrgTier } from './ChangeTierDialog';

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

  const handleCreated = ({ name, tier, asTeam }: { name: string; tier: OrgTier; asTeam: boolean }) => {
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
  onCreated: (result: { name: string; tier: OrgTier; asTeam: boolean }) => void;
}) {
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgTier, setNewOrgTier] = useState<OrgTier>('developer');
  // Defaults to a top-level org (matching the "New Organization" label); check
  // the Team box to instead nest under a parent. Parent candidates are the
  // existing root orgs.
  const [createAsSubOrg, setCreateAsSubOrg] = useState(false);
  const [parentOrgId, setParentOrgId] = useState('');
  const [parentOptions, setParentOptions] = useState<Organization[]>([]);
  const createForm = useFormState();

  // Load the root orgs that can act as a parent for a team.
  useEffect(() => {
    void (async () => {
      try {
        const res = await runQuery(queries.listOrganizations({ limit: 200 }));
        setParentOptions((res.data?.organizations ?? []).filter((o) => !o.parentOrgId));
      } catch { /* best-effort — the team option simply won't have parents to pick */ }
    })();
  }, []);

  const handleCreateOrg = async () => {
    const name = newOrgName.trim();
    if (!name) return;
    if (createAsSubOrg && !parentOrgId) {
      createForm.setError('Choose a parent organization for the team (or uncheck to create a top-level org).');
      return;
    }
    const result = await createForm.run(() => api.createOrganization({
      name,
      tier: newOrgTier,
      ...(createAsSubOrg && parentOrgId ? { parentOrgId } : {}),
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
      title={createAsSubOrg ? 'Create Team' : 'Create Organization'}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleCreateOrg}
          confirmLabel={createAsSubOrg ? 'Create Team' : 'Create Organization'}
          loading={createForm.loading}
          confirmDisabled={!newOrgName.trim() || (createAsSubOrg && !parentOrgId)}
        />
      }
    >
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {createAsSubOrg
          ? 'Create a team nested under a parent organization. You become its initial owner; transfer ownership from the org’s detail page afterward.'
          : 'Create a top-level organization. You become its initial owner; transfer ownership from the org’s detail page afterward.'}
      </p>
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
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
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Tier</label>
          <Select
            value={newOrgTier}
            onChange={(e) => setNewOrgTier(e.target.value as OrgTier)}
            className="text-sm"
            disabled={createForm.loading}
          >
            <option value="developer">Developer</option>
            <option value="pro">Pro</option>
            <option value="team">Team</option>
            <option value="enterprise">Enterprise</option>
          </Select>
        </div>

        {/* Team toggle — defaults OFF (top-level org). When on, pick the parent. */}
        <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 pt-1">
          <Checkbox
            checked={createAsSubOrg}
            onChange={(e) => setCreateAsSubOrg(e.target.checked)}
            disabled={createForm.loading}
            className="mt-0.5"
          />
          <span>
            <strong>Team</strong> — nest this organization under a parent org.
            Uncheck to create a standalone top-level organization.
          </span>
        </label>

        {createAsSubOrg && (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Parent organization</label>
            <Select
              value={parentOrgId}
              onChange={(e) => setParentOrgId(e.target.value)}
              className="text-sm"
              disabled={createForm.loading}
            >
              <option value="">Select a parent organization…</option>
              {parentOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </Select>
            {parentOptions.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                No top-level organizations available to nest under — uncheck above to create one.
              </p>
            )}
          </div>
        )}
      </div>
      {createForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{createForm.error}</p>}
    </Modal>
  );
}

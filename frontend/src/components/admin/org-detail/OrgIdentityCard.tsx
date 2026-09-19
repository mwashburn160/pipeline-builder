// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Building2, Users } from 'lucide-react';
import api from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useFormState } from '@/hooks/useFormState';
import { formatError } from '@/lib/constants';
import { TIER_KEYS, getTierMeta } from '@/lib/tiers';
import type { OrganizationDetail } from '@/lib/api/domains/organizations';

type Tier = 'developer' | 'pro' | 'team' | 'enterprise';
type IdentityChanges = { name?: string; slug?: string; description?: string };

/** Max description length — mirrors the platform's `updateOrganizationSchema`. */
const DESCRIPTION_MAX = 500;

/**
 * The org's identity (name, slug, description) and pricing tier, for the
 * sysadmin drill-down.
 *
 * Identity edits go through `PUT /organization/:id` — the sysadmin route, and
 * the only one that edits the description — sending only the fields that
 * changed. Both it and the tier change are step-up gated, so each write is
 * confirmed in ONE `StepUpModal` that states what is about to happen.
 */
export function OrgIdentityCard({
  org,
  onChanged,
  onShowMembers,
}: {
  org: OrganizationDetail;
  /** Re-read the org after a successful write. */
  onChanged: () => void;
  /** Jump to the member roster tab. */
  onShowMembers: () => void;
}) {
  const toast = useToast();
  const editForm = useFormState();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  // Validated identity changes, held while the step-up dialog is open.
  const [pendingEdit, setPendingEdit] = useState<IdentityChanges | null>(null);
  const [pendingTier, setPendingTier] = useState<Tier | null>(null);
  const [tierError, setTierError] = useState<string | null>(null);

  const currentTier = (org.tier ?? 'developer') as Tier;

  const openEdit = () => {
    setName(org.name ?? '');
    setSlug(org.slug ?? '');
    setDescription(org.description ?? '');
    editForm.reset();
    setEditing(true);
  };

  /** Validate and collect the changed fields; the write waits for step-up. */
  const reviewEdit = () => {
    const changes: IdentityChanges = {};
    const nextName = name.trim();
    const nextSlug = slug.trim().toLowerCase();
    const nextDescription = description.trim();
    if (nextName.length < 2) { editForm.setError('Name must be at least 2 characters'); return; }
    if (nextName !== org.name) changes.name = nextName;
    if (nextSlug && nextSlug !== (org.slug ?? '')) changes.slug = nextSlug;
    if (nextDescription !== (org.description ?? '')) changes.description = nextDescription;
    if (Object.keys(changes).length === 0) { editForm.setError('No changes to save'); return; }
    editForm.setError(null);
    setPendingEdit(changes);
  };

  const executeEdit = async (stepUpToken: string) => {
    const changes = pendingEdit;
    setPendingEdit(null);
    if (!changes) return;
    const result = await editForm.run(() => api.updateOrganization(org.id, changes, stepUpToken));
    if (result !== null) {
      setEditing(false);
      toast.success('Organization updated');
      onChanged();
    }
  };

  const executeTierChange = async (stepUpToken: string) => {
    const tier = pendingTier;
    setPendingTier(null);
    if (!tier) return;
    setTierError(null);
    try {
      await api.updateOrganizationTier(org.id, tier, stepUpToken);
      toast.success(`Tier changed to ${getTierMeta(tier).label}`);
      onChanged();
    } catch (e) {
      setTierError(formatError(e, 'Failed to update tier'));
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Building2 className="w-5 h-5 text-gray-500" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Identity</h3>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={openEdit} className="action-link text-sm">Edit</button>
          {/* Selecting a different tier opens the step-up confirmation; the
              current tier is a no-op so a stray click never prompts. */}
          <FilterSelect
            value={currentTier}
            onChange={(e) => {
              const next = e.target.value as Tier;
              if (next !== currentTier) setPendingTier(next);
            }}
            className="text-xs"
            aria-label="Change pricing tier"
          >
            {TIER_KEYS.map((tier) => (
              <option key={tier} value={tier}>{getTierMeta(tier).label}</option>
            ))}
          </FilterSelect>
        </div>
      </div>
      <ErrorAlert message={tierError} onDismiss={() => setTierError(null)} />
      <dl className="text-sm space-y-2">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Org id</dt>
          <dd><CopyableId value={org.id} size="sm" /></dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Slug</dt>
          <dd>{org.slug ? <CopyableId value={org.slug} size="sm" /> : <code className="text-xs">—</code>}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Description</dt>
          <dd className="whitespace-pre-wrap break-words">
            {org.description || <span className="text-gray-400 dark:text-gray-500 italic">None</span>}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Created</dt>
          <dd><RelativeTime value={org.createdAt} /></dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Members</dt>
          <dd>
            <button type="button" onClick={onShowMembers} className="action-link inline-flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> {org.memberCount} — view roster
            </button>
          </dd>
        </div>
      </dl>

      {editing && (
        <Modal
          title="Edit organization"
          onClose={() => { if (!editForm.loading) setEditing(false); }}
          maxWidth="max-w-md"
          footer={(
            <ModalFooter
              onCancel={() => setEditing(false)}
              onConfirm={reviewEdit}
              confirmLabel="Save"
              loading={editForm.loading}
            />
          )}
        >
          <div className="space-y-4">
            <ErrorAlert message={editForm.error} />
            <FormField label="Name" id="org-name">
              <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} disabled={editForm.loading} maxLength={100} />
            </FormField>
            <FormField label="Slug" id="org-slug" hint="Lowercase letters, numbers and single hyphens (e.g. my-org).">
              <Input id="org-slug" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={editForm.loading} placeholder="my-org" />
            </FormField>
            <FormField
              label="Description"
              id="org-description"
              hint={`${description.trim().length}/${DESCRIPTION_MAX} characters. Leave empty to clear it.`}
            >
              <Textarea
                id="org-description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={editForm.loading}
                maxLength={DESCRIPTION_MAX}
              />
            </FormField>
          </div>
        </Modal>
      )}

      {pendingEdit && (
        <StepUpModal
          title="Save organization changes?"
          action={`Update ${org.name}: ${Object.keys(pendingEdit).join(', ')}`}
          details={pendingEdit.slug ? <p>Changing the slug changes this organization&apos;s URLs and identifiers used by integrations.</p> : undefined}
          onConfirmed={executeEdit}
          onClose={() => setPendingEdit(null)}
        />
      )}

      {pendingTier && (
        <StepUpModal
          action={`Change ${org.name} tier to ${getTierMeta(pendingTier).label} (reseeds quota limits)`}
          onConfirmed={executeTierChange}
          onClose={() => setPendingTier(null)}
        />
      )}
    </Card>
  );
}

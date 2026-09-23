// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { useToast } from '@/components/ui/Toast';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import type { UserOrgMembership } from '@/types';

interface CreateOrgModalProps {
  /** The root org the new team nests under (its plan and quotas are inherited). */
  parentOrg: UserOrgMembership | undefined;
  parentOrgId: string | undefined;
  onClose: () => void;
  /** The team that was created, so the caller can offer what comes next. */
  onCreated: (team: { orgId: string; orgName: string } | null) => void;
}

/**
 * Create a team nested under the active root org.
 *
 * Owns the name, the write and the cache invalidation. The page renders it only
 * while it is open, so each opening starts from a clean form — and keeps only
 * what it actually uses afterwards (the new team, for the "what now?" banner).
 */
export function CreateOrgModal({ parentOrg, parentOrgId, onClose, onCreated }: CreateOrgModalProps) {
  const uid = useId();
  const toast = useToast();
  const form = useFormState();
  const [orgName, setOrgName] = useState('');

  const submit = async () => {
    const name = orgName.trim();
    if (!name) return;
    // Teams always inherit the parent's tier server-side, so no tier is sent.
    await form.run(
      () => api.createOrganization({ name, parentOrgId }),
      {
        onSuccess: (result) => {
          // The new team belongs in the switcher and in every cached org list.
          invalidate.organizations();
          const created = result.data?.organization;
          toast.success(parentOrgId ? `Team "${name}" created` : `Organization "${name}" created`);
          onCreated(parentOrgId && created ? { orgId: created.id, orgName: created.name } : null);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      title="Create team"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => void submit()}
          confirmLabel="Create team"
          loading={form.loading}
          confirmDisabled={!orgName.trim()}
        />
      }
    >
      <p className="text-sm text-fg-muted mb-4">
        Create a <strong>team</strong> nested under <strong>{parentOrg?.name}</strong>. It gets
        its own members, quotas, and secrets, and you&apos;ll be its owner.
        <br />
        <span className="text-xs">Need a separate top-level organization instead? A system admin creates those from the Organizations page.</span>
      </p>
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-team-name`}>
            Team name
          </label>
          <Input id={`${uid}-team-name`}
            type="text"
            placeholder="e.g. mobile-team, qa-shared, project-foo"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            className="text-sm"
            autoFocus
            disabled={form.loading}
          />
        </div>
        <p className="text-xs text-fg-muted">
          The team inherits <strong>{parentOrg?.name}</strong>&apos;s plan
          {parentOrg?.tier ? ` (${parentOrg.tier})` : ''} and its quotas are pooled under the parent organization.
        </p>
      </div>
      <ErrorAlert message={form.error} className="mt-3" />
      <SuccessAlert message={form.success} className="mt-3" />
    </Modal>
  );
}

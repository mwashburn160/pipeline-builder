// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ModalFooter } from '@/components/ui/ModalFooter';
import type { FormState } from '@/hooks/useFormState';
import type { UserOrgMembership } from '@/types';

interface CreateOrgModalProps {
  open: boolean;
  orgName: string;
  onOrgNameChange: (value: string) => void;
  form: FormState;
  activeOrg: UserOrgMembership | undefined;
  onSubmit: () => void;
  onClose: () => void;
}

export function CreateOrgModal({
  open,
  orgName,
  onOrgNameChange,
  form,
  activeOrg,
  onSubmit,
  onClose,
}: CreateOrgModalProps) {
  if (!open) return null;
  return (
    <Modal
      title="Create Team"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Create Team"
          loading={form.loading}
          confirmDisabled={!orgName.trim()}
        />
      }
    >
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Create a <strong>team</strong> nested under <strong>{activeOrg?.name}</strong>. It gets
        its own members, quotas, and secrets, and you&apos;ll be its owner.
        <br />
        <span className="text-xs">Need a separate top-level organization instead? A system admin creates those from the Organizations page.</span>
      </p>
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Team name
          </label>
          <Input
            type="text"
            placeholder="e.g. mobile-team, qa-shared, project-foo"
            value={orgName}
            onChange={(e) => onOrgNameChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
            className="text-sm"
            autoFocus
            disabled={form.loading}
          />
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The team inherits <strong>{activeOrg?.name}</strong>&apos;s plan
          {activeOrg?.tier ? ` (${activeOrg.tier})` : ''} and its quotas are pooled under the parent organization.
        </p>
      </div>
      {form.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{form.error}</p>}
      {form.success && <p className="text-sm text-green-600 dark:text-green-400 mt-3">{form.success}</p>}
    </Modal>
  );
}

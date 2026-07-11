// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ModalFooter } from '@/components/ui/ModalFooter';
import type { FormState } from '@/hooks/useFormState';

interface AddMemberModalProps {
  open: boolean;
  email: string;
  onEmailChange: (value: string) => void;
  form: FormState;
  teamRoster: { orgId: string; orgName: string }[];
  selectedTeams: Set<string>;
  onToggleTeam: (teamId: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function AddMemberModal({
  open,
  email,
  onEmailChange,
  form,
  teamRoster,
  selectedTeams,
  onToggleTeam,
  onSubmit,
  onClose,
}: AddMemberModalProps) {
  if (!open) return null;
  return (
    <Modal
      title="Add Member"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Add Member"
          loading={form.loading}
          confirmDisabled={!email.trim()}
        />
      }
    >
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Enter the email address of an existing user to add to your organization.</p>
      <Input
        type="email"
        placeholder="user@example.com"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        className="text-sm"
        autoFocus
      />
      {teamRoster.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">Also add to teams (optional)</p>
          <div className="space-y-0.5 max-h-40 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-1">
            {teamRoster.map((t) => (
              <label key={t.orgId} className="flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedTeams.has(t.orgId)}
                  onChange={() => onToggleTeam(t.orgId)}
                  disabled={form.loading}
                  className="rounded border-gray-300"
                />
                <span className="truncate text-gray-900 dark:text-gray-100">{t.orgName}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {form.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{form.error}</p>}
    </Modal>
  );
}

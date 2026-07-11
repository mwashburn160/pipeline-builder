// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ModalFooter } from '@/components/ui/ModalFooter';
import type { FormState } from '@/hooks/useFormState';

interface AddToTeamModalProps {
  target: { orgId: string; orgName: string } | null;
  email: string;
  onEmailChange: (value: string) => void;
  form: FormState;
  onSubmit: () => void;
  onClose: () => void;
}

export function AddToTeamModal({
  target,
  email,
  onEmailChange,
  form,
  onSubmit,
  onClose,
}: AddToTeamModalProps) {
  if (!target) return null;
  return (
    <Modal
      title={`Add member to ${target.orgName}`}
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
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Enter the email of an existing user to add to the <strong>{target.orgName}</strong> team.
      </p>
      <Input
        type="email"
        placeholder="user@example.com"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        className="text-sm"
        autoFocus
      />
      {form.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{form.error}</p>}
    </Modal>
  );
}

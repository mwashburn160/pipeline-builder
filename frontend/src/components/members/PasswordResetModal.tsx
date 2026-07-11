// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ModalFooter } from '@/components/ui/ModalFooter';
import type { FormState } from '@/hooks/useFormState';
import type { OrganizationMember } from '@/types';

interface PasswordResetModalProps {
  target: OrganizationMember | null;
  password: string;
  onPasswordChange: (value: string) => void;
  form: FormState;
  onSubmit: () => void;
  onClose: () => void;
}

export function PasswordResetModal({
  target,
  password,
  onPasswordChange,
  form,
  onSubmit,
  onClose,
}: PasswordResetModalProps) {
  if (!target) return null;
  return (
    <Modal
      title={`Reset Password: ${target.username}`}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Reset Password"
          loading={form.loading}
          confirmDisabled={!password}
        />
      }
    >
      {form.error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{form.error}</p>}
      {form.success && <p className="text-sm text-green-600 dark:text-green-400 mb-3">{form.success}</p>}
      {/* <form> + username field + autocomplete hints so this reads as a
          credential change to browsers/password managers (silences
          Chrome's "Password field is not contained in a form" warning).
          onSubmit also gives us native Enter-to-submit. */}
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <label className="label">New Password</label>
        <input type="text" name="username" autoComplete="username" value={target.username} readOnly hidden />
        <Input
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="Minimum 8 characters"
          autoComplete="new-password"
          className="text-sm"
          autoFocus
          disabled={form.loading}
        />
      </form>
    </Modal>
  );
}

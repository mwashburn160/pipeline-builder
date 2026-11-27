// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
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
  /** Viewer holds `invitations:manage`, so the invitation route is theirs to take. */
  canInvite?: boolean;
  /** The address the last add was refused for because the person is outside the
   *  account (platform's 409 `MEMBER_INVITATION_REQUIRED`): offer an invitation. */
  inviteEmail?: string | null;
}

export function AddToTeamModal({
  target,
  email,
  onEmailChange,
  form,
  onSubmit,
  onClose,
  canInvite = false,
  inviteEmail = null,
}: AddToTeamModalProps) {
  if (!target) return null;
  // Only while the field still holds the refused address — an edit is a new attempt.
  const offerInvite = !!inviteEmail && inviteEmail === email.trim().toLowerCase();
  return (
    <Modal
      title={`Add member to ${target.orgName}`}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Add member"
          loading={form.loading}
          confirmDisabled={!email.trim()}
        />
      }
    >
      <p className="text-sm text-fg-muted mb-4">
        Enter the email of an existing user to add to the <strong>{target.orgName}</strong> team.
      </p>
      <Input
        type="email"
        aria-label="Email address"
        placeholder="user@example.com"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        // Enter is a second submit path beside the footer button (which
        // `loading` disables) — without the guard a repeated Enter posts twice.
        onKeyDown={(e) => e.key === 'Enter' && !form.loading && onSubmit()}
        disabled={form.loading}
        className="text-sm"
        autoFocus
      />
      {form.error && <p className="text-sm text-danger mt-3">{form.error}</p>}
      {offerInvite && (
        <p className="mt-2 text-sm text-fg-muted">
          {canInvite ? (
            <>
              <Link href={`/dashboard/members?tab=invitations&email=${encodeURIComponent(inviteEmail)}`} className="action-link font-medium underline">
                Invite {inviteEmail} to the organization
              </Link>{' '}first — once they accept, add them to {target.orgName}.
            </>
          ) : 'They must join the organization first: ask an admin with invitation access to invite them.'}
        </p>
      )}
    </Modal>
  );
}

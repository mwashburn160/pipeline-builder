// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { OrgPicker } from '@/components/ui/OrgPicker';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { CopyableId } from '@/components/ui/CopyableId';
import { FeatureOverridesEditor } from '@/components/admin/FeatureOverridesEditor';
import { SysadminGrantHistory } from './SysadminGrantHistory';
import type { FormState } from '@/hooks/useFormState';
import type { UserListItem } from './types';

interface EditUserModalProps {
  editingUser: UserListItem | null;
  form: FormState;
  currentUserId: string | undefined;
  editUsername: string;
  onEditUsernameChange: (value: string) => void;
  editEmail: string;
  onEditEmailChange: (value: string) => void;
  editOrgId: string;
  onEditOrgIdChange: (value: string) => void;
  editRole: 'owner' | 'admin' | 'member';
  onEditRoleChange: (value: 'owner' | 'admin' | 'member') => void;
  newPassword: string;
  onNewPasswordChange: (value: string) => void;
  onImpersonate: () => void;
  /** Emergency access over the org's impersonation policy. */
  onBreakglass: () => void;
  onSubmit: () => void;
  onClose: () => void;
  onFeatureSaved: () => void;
  /** The fresh `GET /users/:id` read is in flight — fields hold the list row until it lands. */
  detailLoading?: boolean;
  /** The fresh read failed; the editor still works from the list row. */
  detailError?: string | null;
}

/**
 * Sysadmin edit-user modal. Only the changed fields are sent on save.
 *
 * The page opens it on the list row and then re-reads the user
 * (`GET /users/:id`); while that read is in flight the fields are disabled so
 * nobody edits a value that is about to be replaced by the current one.
 */
export function EditUserModal({
  editingUser,
  form,
  currentUserId,
  editUsername,
  onEditUsernameChange,
  editEmail,
  onEditEmailChange,
  editOrgId,
  onEditOrgIdChange,
  editRole,
  onEditRoleChange,
  newPassword,
  onNewPasswordChange,
  onImpersonate,
  onBreakglass,
  onSubmit,
  onClose,
  onFeatureSaved,
  detailLoading = false,
  detailError = null,
}: EditUserModalProps) {
  const uid = useId();
  if (!editingUser) return null;
  const locked = form.loading || detailLoading;
  return (
    <Modal
      title={`Edit User: ${editingUser.username}`}
      onClose={() => !form.loading && onClose()}
      maxWidth="max-w-md"
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Save Changes"
          loading={form.loading}
          confirmDisabled={detailLoading}
        >
          {/* "View as user" — sysadmin impersonation (read-only). Disabled
              for sysadmin targets (you can't impersonate another sysadmin)
              and for the actor themselves. */}
          {editingUser.id !== currentUserId && !editingUser.isSuperAdmin && (
            <>
              <Button
                variant="secondary"
                onClick={onImpersonate}
                disabled={form.loading}
                title="Ask to view the app as this user (read-only). The organization may need to approve."
              >
                View as user
              </Button>
              {/* Deliberately secondary and separate: emergency access is for
                  incidents, not a faster route around approval. */}
              <Button
                variant="ghost"
                onClick={onBreakglass}
                disabled={form.loading}
                title="Emergency access without waiting for approval. The organization is notified."
              >
                Emergency access…
              </Button>
            </>
          )}
        </ModalFooter>
      }
    >
      <ErrorAlert message={form.error} />
      <SuccessAlert message={form.success} />
      {detailError && <ErrorAlert message={detailError} />}
      {detailLoading && (
        <p className="mb-3 text-xs text-fg-muted" role="status">Loading the latest details…</p>
      )}

      <div className="space-y-4">
        <div>
          <label className="label" htmlFor={`${uid}-username`}>Username</label>
          <Input
            id={`${uid}-username`}
            type="text"
            value={editUsername}
            onChange={(e) => onEditUsernameChange(e.target.value)}
            placeholder="jane-doe"
            autoComplete="off"
            disabled={locked}
          />
          <p className="mt-1 text-xs text-fg-muted inline-flex items-center gap-1">
            User ID: <CopyableId value={editingUser.id} size="sm" />
          </p>
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-email`}>Email</label>
          <Input
            id={`${uid}-email`}
            type="email"
            value={editEmail}
            onChange={(e) => onEditEmailChange(e.target.value)}
            placeholder="jane@example.com"
            autoComplete="off"
            disabled={locked}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-organization`}>Organization</label>
          {/* The user's CURRENT org is always the selected option, even when it
              is past any page cap — a blank select used to save them out of it. */}
          <OrgPicker
            id={`${uid}-organization`}
            value={editOrgId}
            onChange={onEditOrgIdChange}
            none={{ value: '', label: '— No organization —' }}
            valueName={editOrgId && editOrgId === editingUser.organizationId ? editingUser.organizationName : undefined}
            disabled={locked}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-role`}>Role</label>
          <Select id={`${uid}-role`} value={editRole} onChange={(e) => onEditRoleChange(e.target.value as 'owner' | 'admin' | 'member')} disabled={locked || editingUser.id === currentUserId}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </Select>
          {editingUser.id === currentUserId && (
            <p className="mt-1 text-xs text-fg-muted">Cannot change your own role</p>
          )}
        </div>
        {/* Wrapped in a <form> with a username field + autocomplete hints
            so browsers/password managers treat this as a credential change
            (silences Chrome's "Password field is not contained in a form"
            warning). onSubmit is a no-op — saving goes through the explicit
            "Save Changes" button below; this just prevents an Enter keypress
            from reloading the page. */}
        <form onSubmit={(e) => e.preventDefault()}>
          <label className="label" htmlFor={`${uid}-new-password-leave-blank`}>New password (leave blank to keep current)</label>
          <input id={`${uid}-new-password-leave-blank`} type="text" name="username" autoComplete="username" value={editingUser.email} readOnly hidden />
          <Input type="password" value={newPassword} onChange={(e) => onNewPasswordChange(e.target.value)} placeholder="Minimum 8 characters" autoComplete="new-password" disabled={locked} />
        </form>

        <SysadminGrantHistory userId={editingUser.id} isSuperAdmin={editingUser.isSuperAdmin === true} />

        <FeatureOverridesEditor
          userId={editingUser.id}
          initial={editingUser.featureOverrides ?? {}}
          onSaved={onFeatureSaved}
        />
      </div>
    </Modal>
  );
}

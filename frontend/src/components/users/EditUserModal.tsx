// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
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
  orgOptions: Array<{ id: string; name: string }>;
  onImpersonate: () => void;
  onSubmit: () => void;
  onClose: () => void;
  onFeatureSaved: () => void;
}

/** Sysadmin edit-user modal. Only the changed fields are sent on save. */
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
  orgOptions,
  onImpersonate,
  onSubmit,
  onClose,
  onFeatureSaved,
}: EditUserModalProps) {
  if (!editingUser) return null;
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
        >
          {/* "View as user" — sysadmin impersonation (read-only). Disabled
              for sysadmin targets (you can't impersonate another sysadmin)
              and for the actor themselves. */}
          {editingUser.id !== currentUserId && !editingUser.isSuperAdmin && (
            <Button
              variant="secondary"
              onClick={onImpersonate}
              disabled={form.loading}
              title="View the app as this user (read-only)"
            >
              View as user
            </Button>
          )}
        </ModalFooter>
      }
    >
      <ErrorAlert message={form.error} />
      {form.success && <div className="alert-success"><p>{form.success}</p></div>}

      <div className="space-y-4">
        <div>
          <label className="label">Username</label>
          <Input
            type="text"
            value={editUsername}
            onChange={(e) => onEditUsernameChange(e.target.value)}
            placeholder="jane-doe"
            autoComplete="off"
            disabled={form.loading}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
            User ID: <CopyableId value={editingUser.id} size="sm" />
          </p>
        </div>
        <div>
          <label className="label">Email</label>
          <Input
            type="email"
            value={editEmail}
            onChange={(e) => onEditEmailChange(e.target.value)}
            placeholder="jane@example.com"
            autoComplete="off"
            disabled={form.loading}
          />
        </div>
        <div>
          <label className="label">Organization</label>
          <Select
            value={editOrgId}
            onChange={(e) => onEditOrgIdChange(e.target.value)}
            disabled={form.loading}
          >
            <option value="">— No organization —</option>
            {orgOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="label">Role</label>
          <Select value={editRole} onChange={(e) => onEditRoleChange(e.target.value as 'owner' | 'admin' | 'member')} disabled={form.loading || editingUser.id === currentUserId}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </Select>
          {editingUser.id === currentUserId && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Cannot change your own role</p>
          )}
        </div>
        {/* Wrapped in a <form> with a username field + autocomplete hints
            so browsers/password managers treat this as a credential change
            (silences Chrome's "Password field is not contained in a form"
            warning). onSubmit is a no-op — saving goes through the explicit
            "Save Changes" button below; this just prevents an Enter keypress
            from reloading the page. */}
        <form onSubmit={(e) => e.preventDefault()}>
          <label className="label">New Password (leave blank to keep current)</label>
          <input type="text" name="username" autoComplete="username" value={editingUser.email} readOnly hidden />
          <Input type="password" value={newPassword} onChange={(e) => onNewPasswordChange(e.target.value)} placeholder="Minimum 8 characters" autoComplete="new-password" disabled={form.loading} />
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

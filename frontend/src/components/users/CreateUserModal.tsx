// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, SetStateAction } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Badge } from '@/components/ui/Badge';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { roleDisplayName } from '@/lib/permissions';
import type { FormState } from '@/hooks/useFormState';
import type { NewUserState, OrgRoleOption } from './types';

interface CreateUserModalProps {
  open: boolean;
  form: FormState;
  newUser: NewUserState;
  setNewUser: Dispatch<SetStateAction<NewUserState>>;
  orgOptions: Array<{ id: string; name: string }>;
  orgRoles: OrgRoleOption[];
  selectedRoleIds: Set<string>;
  onOrgChange: (orgId: string) => void;
  onToggleRole: (id: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

/**
 * Create-user modal. Sysadmin-only server-side; the whole page is already gated
 * to sysadmins so no extra guard here. Org list is fetched lazily on open to
 * populate the optional org assignment.
 */
export function CreateUserModal({
  open,
  form,
  newUser,
  setNewUser,
  orgOptions,
  orgRoles,
  selectedRoleIds,
  onOrgChange,
  onToggleRole,
  onSubmit,
  onClose,
}: CreateUserModalProps) {
  if (!open) return null;
  return (
    <Modal
      title="Add User"
      onClose={() => !form.loading && onClose()}
      maxWidth="max-w-md"
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Create User"
          loading={form.loading}
        />
      }
    >
      <ErrorAlert message={form.error} />
      {form.success && <div className="alert-success"><p>{form.success}</p></div>}

      <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
        <div>
          <label className="label">Username</label>
          <Input
            type="text"
            value={newUser.username}
            onChange={(e) => setNewUser((s) => ({ ...s, username: e.target.value }))}
            placeholder="jane-doe"
            autoComplete="off"
            disabled={form.loading}
          />
        </div>
        <div>
          <label className="label">Email</label>
          <Input
            type="email"
            value={newUser.email}
            onChange={(e) => setNewUser((s) => ({ ...s, email: e.target.value }))}
            placeholder="jane@example.com"
            autoComplete="off"
            disabled={form.loading}
          />
        </div>
        <div>
          <label className="label">Password</label>
          <Input
            type="password"
            value={newUser.password}
            onChange={(e) => setNewUser((s) => ({ ...s, password: e.target.value }))}
            placeholder="Minimum 8 characters"
            autoComplete="new-password"
            disabled={form.loading}
          />
        </div>
        <div>
          <label className="label">Organization</label>
          <Select
            value={newUser.organizationId}
            onChange={(e) => onOrgChange(e.target.value)}
            disabled={form.loading}
          >
            <option value="">— No organization —</option>
            {orgOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
        </div>
        {newUser.organizationId && (
          <div>
            <label className="label">Role</label>
            <Select
              value={newUser.role}
              onChange={(e) => setNewUser((s) => ({ ...s, role: e.target.value as 'owner' | 'admin' | 'member' }))}
              disabled={form.loading}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </Select>
          </div>
        )}
        {/* Roles are org-scoped — only shown once an org is selected. */}
        {newUser.organizationId && orgRoles.length > 0 && (
          <div>
            <label className="label">
              Roles <span className="text-gray-400 font-normal">({selectedRoleIds.size} selected)</span>
            </label>
            <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-800">
              {orgRoles.map((g) => (
                <label key={g.id} className="flex items-center gap-2 p-2.5 text-sm cursor-pointer">
                  <Checkbox
                    checked={selectedRoleIds.has(g.id)}
                    onChange={() => onToggleRole(g.id)}
                    disabled={form.loading}
                  />
                  <span className="font-medium text-gray-800 dark:text-gray-200">{roleDisplayName(g.name)}</span>
                  {g.grantsRole !== 'member' && (
                    <Badge color={g.grantsRole === 'superadmin' ? 'red' : 'purple'}>{g.grantsRole}</Badge>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Checkbox
            checked={newUser.isSuperAdmin}
            onChange={(e) => setNewUser((s) => ({ ...s, isSuperAdmin: e.target.checked }))}
            disabled={form.loading}
          />
          Platform super admin
        </label>
      </form>
    </Modal>
  );
}

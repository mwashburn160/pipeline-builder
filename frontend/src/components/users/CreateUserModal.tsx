// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { OrgPicker } from '@/components/ui/OrgPicker';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Badge } from '@/components/ui/Badge';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import type { FormState } from '@/hooks/useFormState';
import type { NewUserState, OrgRoleOption } from './types';

interface CreateUserModalProps {
  open: boolean;
  form: FormState;
  newUser: NewUserState;
  setNewUser: Dispatch<SetStateAction<NewUserState>>;
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
  orgRoles,
  selectedRoleIds,
  onOrgChange,
  onToggleRole,
  onSubmit,
  onClose,
}: CreateUserModalProps) {
  const uid = useId();
  if (!open) return null;
  return (
    <Modal
      title="Add user"
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
      <SuccessAlert message={form.success} />

      <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
        <div>
          <label className="label" htmlFor={`${uid}-username`}>Username</label>
          <Input
            id={`${uid}-username`}
            type="text"
            value={newUser.username}
            onChange={(e) => setNewUser((s) => ({ ...s, username: e.target.value }))}
            placeholder="jane-doe"
            autoComplete="off"
            disabled={form.loading}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-email`}>Email</label>
          <Input
            id={`${uid}-email`}
            type="email"
            value={newUser.email}
            onChange={(e) => setNewUser((s) => ({ ...s, email: e.target.value }))}
            placeholder="jane@example.com"
            autoComplete="off"
            disabled={form.loading}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-password`}>Password</label>
          <Input
            id={`${uid}-password`}
            type="password"
            value={newUser.password}
            onChange={(e) => setNewUser((s) => ({ ...s, password: e.target.value }))}
            placeholder="Minimum 8 characters"
            autoComplete="new-password"
            disabled={form.loading}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-organization`}>Organization</label>
          <OrgPicker
            id={`${uid}-organization`}
            value={newUser.organizationId}
            onChange={onOrgChange}
            none={{ value: '', label: '— No organization —' }}
            disabled={form.loading}
          />
        </div>
        {newUser.organizationId && (
          <div>
            <label className="label" htmlFor={`${uid}-role`}>Role</label>
            <Select
              id={`${uid}-role`}
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
            <span className="label" id={`${uid}-roles`}>
              Roles <span className="text-fg-subtle font-normal">({selectedRoleIds.size} selected)</span>
            </span>
            <div role="group" aria-labelledby={`${uid}-roles`} className="max-h-48 overflow-y-auto border border-default rounded-lg divide-y divide-default">
              {orgRoles.map((g) => (
                <label key={g.id} className="flex items-center gap-2 p-2.5 text-sm cursor-pointer">
                  <Checkbox
                    checked={selectedRoleIds.has(g.id)}
                    onChange={() => onToggleRole(g.id)}
                    disabled={form.loading}
                  />
                  <span className="font-medium text-fg">{g.name}</span>
                  {g.grantsRole !== 'member' && (
                    <Badge color={g.grantsRole === 'superadmin' ? 'red' : 'purple'}>{g.grantsRole}</Badge>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-fg-muted">
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

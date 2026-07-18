// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Checkbox } from '@/components/ui/Checkbox';
import { roleDisplayName } from '@/lib/permissions';
import type { OrganizationMember, OrganizationRole } from '@/types';

interface ManageRolesModalProps {
  target: OrganizationMember | null;
  roles: OrganizationRole[];
  rolesListError: string | null;
  selectedRoleIds: Set<string>;
  saving: boolean;
  error: string | null;
  onToggleRole: (roleId: string) => void;
  onRetry: () => void;
  onSubmit: () => void;
  onClose: () => void;
}

/**
 * Manage Roles — assign/remove the org's Roles for one member. Editing access
 * happens here; the coarse Role badge is derived from the result.
 */
export function ManageRolesModal({
  target,
  roles,
  rolesListError,
  selectedRoleIds,
  saving,
  error,
  onToggleRole,
  onRetry,
  onSubmit,
  onClose,
}: ManageRolesModalProps) {
  if (!target) return null;
  return (
    <Modal
      title={`Manage roles for ${target.username}`}
      onClose={() => !saving && onClose()}
      maxWidth="max-w-md"
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Save roles"
          loading={saving}
        />
      }
    >
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
        A member&apos;s access is the union of their Roles. The Owner/Admin/Member badge is derived from these.
      </p>
      {rolesListError ? (
        // Distinguish a FAILED catalog load from a genuinely empty one, so the
        // list isn't silently blank (which would read like "no roles exist").
        <div className="text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
          <span>Couldn&apos;t load roles — {rolesListError}.</span>
          <button type="button" onClick={() => void onRetry()} className="action-link">Retry</button>
        </div>
      ) : roles.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">No roles exist in this organization yet.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-800">
          {roles.map((r) => (
            <label key={r.id} className="flex items-start gap-2 p-2.5 text-sm cursor-pointer">
              <Checkbox
                checked={selectedRoleIds.has(r.id)}
                onChange={() => onToggleRole(r.id)}
                disabled={saving}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="font-medium text-gray-800 dark:text-gray-200">{roleDisplayName(r.name)}</span>
                {r.description && <span className="block text-xs text-gray-400 dark:text-gray-500">{r.description}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400 mt-3 whitespace-pre-line">{error}</p>}
    </Modal>
  );
}

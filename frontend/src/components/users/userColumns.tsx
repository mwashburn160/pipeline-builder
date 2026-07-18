// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/Badge';
import { type Column } from '@/components/ui/DataTable';
import type { UserListItem } from './types';

interface BuildUserColumnsOptions {
  currentUserId: string | undefined;
  allVisibleSelected: boolean;
  onToggleSelectAllVisible: () => void;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onEdit: (u: UserListItem) => void;
  onToggleSuperAdmin: (u: UserListItem) => void;
  onDelete: (u: UserListItem) => void;
}

/**
 * Builds the all-users DataTable columns. Kept as a pure helper so the page
 * reads as orchestration; the page wraps this in a `useMemo`.
 */
export function buildUserColumns({
  currentUserId,
  allVisibleSelected,
  onToggleSelectAllVisible,
  selectedIds,
  onToggleSelected,
  onEdit,
  onToggleSuperAdmin,
  onDelete,
}: BuildUserColumnsOptions): Column<UserListItem>[] {
  return [
    {
      id: 'select',
      // Header checkbox toggles all visible (non-self) rows. Indeterminate
      // state isn't surfaced — partial selection just shows unchecked.
      header: (
        <input
          type="checkbox"
          aria-label="Select all visible users"
          checked={allVisibleSelected}
          onChange={onToggleSelectAllVisible}
          className="h-4 w-4 cursor-pointer"
        />
      ),
      headerClassName: 'w-10',
      cellClassName: 'w-10',
      render: (u) => (
        u.id === currentUserId ? null : (
          <input
            type="checkbox"
            aria-label={`Select ${u.email}`}
            checked={selectedIds.has(u.id)}
            onChange={() => onToggleSelected(u.id)}
            className="h-4 w-4 cursor-pointer"
          />
        )
      ),
    },
    {
      id: 'user',
      header: 'User',
      sortValue: (u) => u.username,
      render: (u) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{u.username}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{u.email}</div>
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortValue: (u) => u.role,
      render: (u) => (
        <span className="inline-flex items-center gap-1">
          <Badge color={u.role === 'admin' ? 'purple' : 'gray'}>{u.role}</Badge>
          {u.isSuperAdmin && <Badge color="red">platform-admin</Badge>}
        </span>
      ),
    },
    {
      id: 'organization',
      header: 'Organization',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (u) => u.organizationName || '',
      render: (u) => <>{u.organizationName || 'None'}</>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (u) => u.isEmailVerified,
      render: (u) => (
        <Badge color={u.isEmailVerified ? 'green' : 'yellow'}>{u.isEmailVerified ? 'Verified' : 'Unverified'}</Badge>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (userItem) => (
        <div className="flex justify-end gap-3">
          <button onClick={() => onEdit(userItem)} className="action-link">Edit</button>
          {userItem.id !== currentUserId && (
            <>
              <button
                onClick={() => onToggleSuperAdmin(userItem)}
                className="action-link"
                title={userItem.isSuperAdmin ? 'Revoke platform-admin grant' : 'Grant platform-admin'}
              >
                {userItem.isSuperAdmin ? 'Revoke admin' : 'Grant admin'}
              </button>
              <button onClick={() => onDelete(userItem)} className="action-link-danger">Delete</button>
            </>
          )}
        </div>
      ),
    },
  ];
}

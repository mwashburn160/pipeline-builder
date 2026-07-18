// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ShieldCheck, UserMinus, UserCheck, UserX, Crown, KeyRound, Network } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/IconButton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { type Column } from '@/components/ui/DataTable';
import { roleDisplayName } from '@/lib/permissions';
import type { OrganizationMember } from '@/types';

interface BuildMemberColumnsOptions {
  currentUserId: string | undefined;
  currentUserRole: string | undefined;
  isSuperAdmin: boolean;
  canManageTeams: boolean;
  canManageRoles: boolean;
  rolesForMember: (m: OrganizationMember) => Array<{ id: string; name: string }>;
  onManageTeams: (m: OrganizationMember) => void;
  onTransfer: (m: OrganizationMember) => void;
  onManageRoles: (m: OrganizationMember) => void;
  onResetPassword: (m: OrganizationMember) => void;
  onToggleActive: (m: OrganizationMember) => void;
  onRemove: (m: OrganizationMember) => void;
}

/**
 * Builds the Members roster DataTable columns. Kept as a pure helper so the page
 * reads as orchestration; the page wraps this in a `useMemo`.
 */
export function buildMemberColumns({
  currentUserId,
  currentUserRole,
  isSuperAdmin,
  canManageTeams,
  canManageRoles,
  rolesForMember,
  onManageTeams,
  onTransfer,
  onManageRoles,
  onResetPassword,
  onToggleActive,
  onRemove,
}: BuildMemberColumnsOptions): Column<OrganizationMember>[] {
  return [
    {
      id: 'username',
      header: 'User',
      sortValue: (m) => m.username,
      render: (m) => (
        <div>
          <span className="font-medium text-gray-900 dark:text-gray-100">{m.username}</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">{m.email}</p>
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortValue: (m) => m.role,
      // Derived, read-only badge — the backend computes this coarse role from the
      // member's assigned Roles. Access is edited via the Roles column, not here.
      render: (m) => (
        <div className="flex items-center gap-2">
          <Badge color={m.role === 'admin' ? 'purple' : 'gray'}>{m.role}</Badge>
          {m.isOwner && <span title="Owner"><Crown className="w-3.5 h-3.5 text-yellow-500" /></span>}
        </div>
      ),
    },
    ...(canManageRoles ? [{
      id: 'roles',
      header: 'Roles',
      // Assigned Roles as chips, read straight off the member payload. Editing
      // (add/remove) is the ShieldCheck action. Roles ship WITH the roster, so a
      // load failure fails the whole roster (page ErrorAlert + no rows) rather
      // than silently rendering "No roles" — "No roles" here always means empty.
      render: (m: OrganizationMember) => {
        const assigned = rolesForMember(m);
        if (assigned.length === 0) return <span className="text-xs text-gray-400 dark:text-gray-500 italic">No roles</span>;
        return (
          <div className="flex flex-wrap items-center gap-1">
            {assigned.map((r) => (
              <span key={r.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                <ShieldCheck className="w-2.5 h-2.5 text-gray-400" />{roleDisplayName(r.name)}
              </span>
            ))}
          </div>
        );
      },
    } as Column<OrganizationMember>] : []),
    {
      id: 'status',
      header: 'Status',
      sortValue: (m) => m.isActive,
      render: (m) => (
        <div className="flex items-center gap-1.5">
          <Badge color={m.isActive ? 'green' : 'red'}>{m.isActive ? 'Active' : 'Inactive'}</Badge>
          {!m.isEmailVerified && <Badge color="yellow">Unverified</Badge>}
        </div>
      ),
    },
    {
      id: 'joined',
      header: 'Joined',
      sortValue: (m) => m.createdAt,
      render: (m) => (
        <span className="text-sm text-gray-500 dark:text-gray-400">
          <RelativeTime value={m.createdAt} />
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      render: (m) => {
        const isSelf = m.id === currentUserId;
        if (isSelf || m.isOwner) return null;
        return (
          <div className="flex items-center gap-1 justify-end">
            {canManageTeams && (
              <IconButton
                tone="indigo"
                onClick={() => onManageTeams(m)}
                title="Manage team memberships"
                aria-label={`Manage team memberships for ${m.username}`}
              >
                <Network className="w-4 h-4" />
              </IconButton>
            )}
            {/* Ownership transfer is backend-gated to the current owner or a
                sysadmin — only surface it to them so others don't hit a 403. */}
            {(currentUserRole === 'owner' || isSuperAdmin) && (
              <IconButton
                tone="success"
                onClick={() => onTransfer(m)}
                title="Make owner (transfers organization ownership)"
                aria-label={`Transfer organization ownership to ${m.username}`}
              >
                <Crown className="w-4 h-4" />
              </IconButton>
            )}
            {canManageRoles && (
              <IconButton
                tone="primary"
                onClick={() => onManageRoles(m)}
                title="Manage roles"
                aria-label={`Manage roles for ${m.username}`}
              >
                <ShieldCheck className="w-4 h-4" />
              </IconButton>
            )}
            <IconButton
              tone="warn"
              onClick={() => onResetPassword(m)}
              title="Reset password"
              aria-label={`Reset password for ${m.username}`}
            >
              <KeyRound className="w-4 h-4" />
            </IconButton>
            <IconButton
              tone={m.isActive ? 'orange' : 'success'}
              onClick={() => onToggleActive(m)}
              title={m.isActive ? 'Deactivate member' : 'Reactivate member'}
              aria-label={`${m.isActive ? 'Deactivate' : 'Reactivate'} ${m.username}`}
            >
              {m.isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
            </IconButton>
            <IconButton
              tone="danger"
              onClick={() => onRemove(m)}
              title="Remove from organization"
              aria-label={`Remove ${m.username} from the organization`}
            >
              <UserMinus className="w-4 h-4" />
            </IconButton>
          </div>
        );
      },
    },
  ];
}

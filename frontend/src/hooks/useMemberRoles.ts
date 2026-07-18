// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { roleDisplayName } from '@/lib/permissions';
import api from '@/lib/api';
import type { OrganizationMember, OrganizationRole } from '@/types';

interface UseMemberRolesOptions {
  orgId: string | undefined;
  canManageRoles: boolean;
  isAuthenticated: boolean;
  /** Called after roles change so the derived coarse badge + chips refresh. */
  onRolesChanged: () => void;
}

/**
 * Encapsulates the Members page's Role catalog + manage-Roles modal logic.
 *
 * A member's access is the union of their assigned Roles; the coarse
 * owner/admin/member badge is derived server-side. Editing access = adding or
 * removing Roles. Each member's own Roles ship embedded in the roster payload,
 * so only the modal's checkbox list needs the full org Role catalog.
 */
export function useMemberRoles({ orgId, canManageRoles, isAuthenticated, onRolesChanged }: UseMemberRolesOptions) {
  const toast = useToast();

  // The org's full Role catalog — ONLY the manage-Roles modal's checkbox list
  // needs it. `rolesListError` distinguishes a failed load from a genuinely
  // empty catalog so the modal can offer a retry instead of silently showing
  // no options.
  const [roles, setRoles] = useState<OrganizationRole[]>([]);
  const [rolesListError, setRolesListError] = useState<string | null>(null);

  // Manage-Roles modal (multi-select of the org's Roles for one member).
  const [rolesTarget, setRolesTarget] = useState<OrganizationMember | null>(null);
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(new Set());
  const [rolesSaving, setRolesSaving] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);

  // The org's full Role catalog — needed only for the manage-Roles modal's
  // checkbox list (a member's own Roles ship with the roster payload). A failed
  // load sets `rolesListError` so the modal shows a retry instead of an empty
  // list that reads like "this org has no roles".
  const fetchRoles = useCallback(async () => {
    if (!orgId || !canManageRoles) return;
    setRolesListError(null);
    try {
      const res = await api.getOrganizationRoles(orgId);
      setRoles(res.data?.roles ?? []);
    } catch (err) {
      setRolesListError(err instanceof Error ? err.message : 'Failed to load roles');
    }
  }, [orgId, canManageRoles]);

  useEffect(() => {
    if (isAuthenticated && canManageRoles && orgId) fetchRoles();
  }, [isAuthenticated, canManageRoles, orgId, fetchRoles]);

  // The Roles a member currently holds — read straight off the roster payload
  // (embedded per member), so no all-roles O(members×roles) scan is needed.
  const rolesForMember = useCallback(
    (m: OrganizationMember) => m.roles ?? [],
    [],
  );
  const roleDisplayById = useCallback(
    (id: string) => roleDisplayName(roles.find(r => r.id === id)?.name ?? id),
    [roles],
  );

  const openManageRoles = useCallback((m: OrganizationMember) => {
    setRolesTarget(m);
    setSelectedRoleIds(new Set(rolesForMember(m).map((r) => r.id)));
    setRolesError(null);
  }, [rolesForMember]);

  const closeRoles = useCallback(() => setRolesTarget(null), []);

  const toggleRoleSelection = (roleId: string) => setSelectedRoleIds((prev) => {
    const next = new Set(prev);
    if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
    return next;
  });

  // Diff the desired Role set against the member's current one and apply the
  // adds/removes independently (allSettled) so a mid-flight failure doesn't
  // abort the rest or leave a half-applied set behind a generic error. On
  // partial failure we report exactly which ops failed and fold the applied
  // ones into the target, so re-saving retries ONLY the failures. The coarse
  // role badge is derived server-side, so we refresh the roster to reflect it.
  const handleSaveRoles = async () => {
    if (!orgId || !rolesTarget) return;
    const member = rolesTarget;
    const currentIds = new Set(rolesForMember(member).map((r) => r.id));
    const toAdd = [...selectedRoleIds].filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !selectedRoleIds.has(id));
    if (toAdd.length === 0 && toRemove.length === 0) { setRolesTarget(null); return; }
    setRolesSaving(true);
    setRolesError(null);

    const ops = [
      ...toAdd.map((roleId) => ({ roleId, kind: 'add' as const })),
      ...toRemove.map((roleId) => ({ roleId, kind: 'remove' as const })),
    ];
    const results = await Promise.allSettled(ops.map((op) =>
      op.kind === 'add'
        ? api.addRoleMember(orgId, op.roleId, { userId: member.id })
        : api.removeRoleMember(orgId, op.roleId, member.id),
    ));

    const failures: string[] = [];
    const nextRoleIds = new Set(currentIds);
    results.forEach((r, i) => {
      const { roleId, kind } = ops[i];
      const ok = r.status === 'fulfilled' && r.value.success;
      if (ok) {
        if (kind === 'add') nextRoleIds.add(roleId); else nextRoleIds.delete(roleId);
        return;
      }
      const msg = r.status === 'rejected'
        ? (r.reason instanceof Error ? r.reason.message : String(r.reason))
        : (r.value.message || 'failed');
      failures.push(`${kind} ${roleDisplayById(roleId)}: ${msg}`);
    });

    setRolesSaving(false);
    // Reflect whatever actually applied (updates chips + coarse badge).
    onRolesChanged();

    if (failures.length === 0) {
      toast.success(`Updated ${member.username}'s roles`);
      setRolesTarget(null);
      return;
    }
    // Rebase the target on the applied state so a re-save diffs correctly and
    // re-attempts only the failures (never a role that was already added/removed).
    const nextRoles = [...nextRoleIds].map((id) => ({ id, name: roles.find(r => r.id === id)?.name ?? id }));
    setRolesTarget({ ...member, roles: nextRoles });
    const applied = ops.length - failures.length;
    setRolesError(
      `${applied} change${applied === 1 ? '' : 's'} applied, ${failures.length} failed:\n`
      + failures.join('\n')
      + `\nRe-save to retry just the failed change${failures.length === 1 ? '' : 's'}.`,
    );
  };

  return {
    roles,
    rolesListError,
    fetchRoles,
    rolesTarget,
    selectedRoleIds,
    rolesSaving,
    rolesError,
    rolesForMember,
    openManageRoles,
    closeRoles,
    toggleRoleSelection,
    handleSaveRoles,
  };
}

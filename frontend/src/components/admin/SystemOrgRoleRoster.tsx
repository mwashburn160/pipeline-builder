// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { UserPlus, UserMinus, Users, type LucideIcon } from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import { useQuery } from '@/hooks/useQuery';
import { useToast } from '@/components/ui/Toast';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { RetryError } from '@/components/ui/RetryError';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';
import { SYSTEM_ORG_ID, formatError } from '@/lib/constants';
import type { OrganizationRole } from '@/types';

export interface SystemOrgRoleRosterProps {
  /** The built-in Role's EXACT seeded name — how it is found among the system org's roles. */
  roleName: string;
  title: string;
  description: string;
  icon?: LucideIcon;
  /** Shown when nobody holds the Role, to say what that costs. */
  emptyDescription: string;
  /** Only superadmins may assign a system-org Role; everyone else sees it read-only. */
  isSuperAdmin: boolean;
  /** False during a read-only impersonation — writes would 403. */
  canWrite: boolean;
}

/**
 * The roster of one built-in SYSTEM-ORG Role: who holds it, and add/remove.
 *
 * ONE implementation for every job Role rather than a panel each. It began as
 * `EcosystemManagersPanel`, and when the system org grew from two Roles to six
 * the choice was six near-identical copies or this: the only thing that differed
 * between them was the Role's name and its prose, and a copy per Role is a copy
 * per Role to keep in step with the assignment rules below.
 *
 * WHY IT READS THE ROLE BY NAME. The Role ids are per-install (seeded when the
 * system org is created), so there is nothing stable to reference. The seeded
 * NAME is the stable handle, and `GET /organization/:id/roles` is readable by
 * any member, so a holder can see the roster even when they cannot change it.
 *
 * WHY ONLY A SUPERADMIN MAY ASSIGN. Every Role here carries at least one
 * `SYSTEM_ORG_ONLY_PERMISSION`, and platform refuses assignment of such a Role
 * to anyone but a platform superadmin (`RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN`)
 * — an admin or owner of the system org included. This component mirrors that
 * rather than enforcing it: the buttons are hidden for everyone else, and the
 * backend is what actually refuses.
 */
export function SystemOrgRoleRoster({
  roleName,
  title,
  description,
  icon = Users,
  emptyDescription,
  isSuperAdmin,
  canWrite,
}: SystemOrgRoleRosterProps) {
  const toast = useToast();
  const canAssign = isSuperAdmin && canWrite;
  /**
   * WHY the controls are locked, when they are. The Callout below explains the
   * `!isSuperAdmin` case; a SUPERADMIN under read-only impersonation just lost
   * Add and Remove with nothing said, because `canWrite` is false for every
   * mutation in that session. Same information, stated rather than implied.
   */
  const lockedReason = !isSuperAdmin
    ? 'Only a platform superadmin can change this roster'
    : !canWrite
      ? 'Read-only session: staffing changes are disabled while viewing as another user'
      : undefined;

  const rolesQ = useFetch(async (signal): Promise<OrganizationRole | null> => {
    const res = await api.getOrganizationRoles(SYSTEM_ORG_ID, undefined, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load roles');
    return res.data.roles.find((r) => r.name === roleName) ?? null;
  }, [roleName]);
  const role = rolesQ.data;

  // Candidates: active system-org members not already holding the Role. Only
  // fetched when the viewer could act on it — a read-only holder has no picker.
  const membersQ = useQuery(canAssign ? queries.orgMembers(SYSTEM_ORG_ID, { limit: 200, status: 'active' }) : null);
  const candidates = useMemo(() => {
    const holding = new Set(role?.members.map((m) => m.id) ?? []);
    return (membersQ.data?.data?.members ?? []).filter((m) => !holding.has(m.id));
  }, [membersQ.data, role]);

  const [selectedUserId, setSelectedUserId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const add = async () => {
    if (!role || !selectedUserId) return;
    const who = candidates.find((m) => m.id === selectedUserId);
    setBusy('add');
    try {
      const res = await api.addRoleMember(SYSTEM_ORG_ID, role.id, { userId: selectedUserId });
      if (!res.success) throw new Error(res.message || 'Failed to add to role');
      toast.success(`Added ${who?.username ?? who?.email ?? 'member'} to ${roleName}`);
      setSelectedUserId('');
      void rolesQ.refetch();
    } catch (err) {
      toast.error(formatError(err, 'Failed to add to role'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (member: OrganizationRole['members'][number]) => {
    if (!role) return;
    setBusy(member.id);
    try {
      const res = await api.removeRoleMember(SYSTEM_ORG_ID, role.id, member.id);
      if (!res.success) throw new Error(res.message || 'Failed to remove from role');
      toast.success(`Removed ${member.username} from ${roleName}`);
      void rolesQ.refetch();
    } catch (err) {
      toast.error(formatError(err, 'Failed to remove from role'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard icon={icon} title={title} description={description}>
      {rolesQ.loading && !rolesQ.data ? (
        <Skeleton className="h-16 w-full" />
      ) : rolesQ.error ? (
        <RetryError message={formatError(rolesQ.error, `Failed to load the ${roleName} role`)} onRetry={rolesQ.refetch} />
      ) : !role ? (
        <Callout variant="warning" title="Role not found">
          The system organization has no built-in &ldquo;{roleName}&rdquo; role. It is seeded when the system
          organization is created, and the startup backfill creates it on a deployment installed before it
          existed — restart the platform if this persists.
        </Callout>
      ) : (
        <div className="space-y-4">
          {!isSuperAdmin && (
            <Callout variant="neutral">Only superadmins can assign or remove this role.</Callout>
          )}

          {role.members.length === 0 ? (
            <EmptyState compact icon={icon} title={`No ${roleName}s`} description={emptyDescription} />
          ) : (
            <ul className="divide-y divide-default" aria-label={`${roleName} holders`}>
              {role.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-fg truncate">{m.username}</div>
                    <div className="text-xs text-fg-muted truncate">{m.email}</div>
                  </div>
                  {isSuperAdmin && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === m.id}
                      disabled={busy !== null || !canAssign}
                      title={lockedReason}
                      onClick={() => remove(m)}
                      aria-label={`Remove ${m.username} from ${roleName}`}
                    >
                      <UserMinus className="w-4 h-4" /> Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canAssign && (
            <div className="flex flex-wrap items-end gap-2 border-t border-default pt-4">
              <label className="flex-1 min-w-[14rem] text-sm">
                <span className="block mb-1 text-fg-muted">Add a system-organization member</span>
                <Select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  aria-label={`System-organization member to add to ${roleName}`}
                  disabled={busy !== null}
                >
                  <option value="">{candidates.length ? 'Choose a member…' : 'No eligible members'}</option>
                  {candidates.map((m) => (
                    <option key={m.id} value={m.id}>{m.username} ({m.email})</option>
                  ))}
                </Select>
              </label>
              <Button onClick={add} loading={busy === 'add'} disabled={!selectedUserId || busy !== null}>
                <UserPlus className="w-4 h-4" /> Add
              </Button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

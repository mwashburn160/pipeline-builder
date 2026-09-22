// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Users, UserPlus, UserMinus } from 'lucide-react';
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
import { ECOSYSTEM_MANAGER_ROLE_NAME } from '@/lib/ecosystem-access';
import type { OrganizationRole } from '@/types';

interface Props {
  /** Only superadmins may assign or unassign the role (plan §5a.1); the
   *  backend refuses everyone else with RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN. */
  isSuperAdmin: boolean;
  /** False during a read-only impersonation — writes would 403. */
  canWrite: boolean;
}

/**
 * The system org's built-in **Ecosystem Manager** role roster.
 *
 * Reads the system org's roles (`GET /organization/:id/roles`, readable by any
 * member) and finds the role by its exact built-in name. A superadmin can add
 * an existing system-org member / remove a holder through the ordinary role
 * membership routes (audited as `org.role.member.add|remove`); every other
 * holder sees the list read-only.
 */
export function EcosystemManagersPanel({ isSuperAdmin, canWrite }: Props) {
  const toast = useToast();
  const canAssign = isSuperAdmin && canWrite;

  const rolesQ = useFetch(async (signal): Promise<OrganizationRole | null> => {
    const res = await api.getOrganizationRoles(SYSTEM_ORG_ID, undefined, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load roles');
    return res.data.roles.find((r) => r.name === ECOSYSTEM_MANAGER_ROLE_NAME) ?? null;
  }, []);
  const role = rolesQ.data;

  // Candidates: active system-org members not already holding the role.
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
      toast.success(`Added ${who?.username ?? who?.email ?? 'member'} to ${ECOSYSTEM_MANAGER_ROLE_NAME}`);
      setSelectedUserId('');
      rolesQ.refetch();
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
      toast.success(`Removed ${member.username} from ${ECOSYSTEM_MANAGER_ROLE_NAME}`);
      rolesQ.refetch();
    } catch (err) {
      toast.error(formatError(err, 'Failed to remove from role'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard
      icon={Users}
      title="Ecosystem Managers"
      description="System-org members who approve listings and versions, verify publishers and moderate reviews and submissions."
    >
      {rolesQ.loading && !rolesQ.data ? (
        <Skeleton className="h-16 w-full" />
      ) : rolesQ.error ? (
        <RetryError message={formatError(rolesQ.error, 'Failed to load the Ecosystem Manager role')} onRetry={rolesQ.refetch} />
      ) : !role ? (
        <Callout variant="warning" title="Role not found">
          The system organization has no built-in &ldquo;{ECOSYSTEM_MANAGER_ROLE_NAME}&rdquo; role. It is seeded when the
          system organization is created.
        </Callout>
      ) : (
        <div className="space-y-4">
          {!isSuperAdmin && (
            <Callout variant="neutral">Only superadmins can assign or remove Ecosystem Managers.</Callout>
          )}

          {role.members.length === 0 ? (
            <EmptyState
              compact
              icon={Users}
              title="No Ecosystem Managers"
              description="Until someone holds the role, superadmins receive every moderation notice."
            />
          ) : (
            <ul className="divide-y divide-default" aria-label="Ecosystem Managers">
              {role.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-fg truncate">{m.username}</div>
                    <div className="text-xs text-fg-muted truncate">{m.email}</div>
                  </div>
                  {canAssign && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === m.id}
                      disabled={busy !== null}
                      onClick={() => remove(m)}
                      aria-label={`Remove ${m.username} from ${ECOSYSTEM_MANAGER_ROLE_NAME}`}
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
                  aria-label="System-organization member to add"
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

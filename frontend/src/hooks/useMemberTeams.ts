// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import type { OrganizationMember, MemberTeam } from '@/types';

interface UseMemberTeamsOptions {
  orgId: string | undefined;
}

/**
 * Encapsulates the Members page's per-member "Manage teams" modal (org → team
 * hierarchy: a member can belong to multiple teams). The desired membership set
 * is initialized from the roster's current membership, then diffed against it on
 * save to compute adds (bulk) and removes (per team).
 */
export function useMemberTeams({ orgId }: UseMemberTeamsOptions) {
  const toast = useToast();

  const [manageTeamsTarget, setManageTeamsTarget] = useState<OrganizationMember | null>(null);
  const [teamRoster, setTeamRoster] = useState<MemberTeam[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsSaving, setTeamsSaving] = useState(false);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  // Desired membership set — initialized from the roster's current membership,
  // diffed against it on save to compute adds (bulk) and removes (per team).
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());

  const openManageTeams = useCallback(async (m: OrganizationMember) => {
    if (!orgId) return;
    setManageTeamsTarget(m);
    setTeamRoster([]);
    setSelectedTeamIds(new Set());
    setTeamsError(null);
    setTeamsLoading(true);
    try {
      const res = await api.getMemberTeams(orgId, m.id);
      const teams = res.data?.teams ?? [];
      setTeamRoster(teams);
      setSelectedTeamIds(new Set(teams.filter(t => t.isMember).map(t => t.orgId)));
    } catch {
      setTeamsError('Failed to load teams');
    } finally {
      setTeamsLoading(false);
    }
    // orgId is captured; openManageTeams is only called for the active org's members.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const closeManageTeams = useCallback(() => setManageTeamsTarget(null), []);

  const toggleTeam = (teamId: string) => setSelectedTeamIds(prev => {
    const next = new Set(prev);
    if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
    return next;
  });

  const teamName = useCallback(
    (id: string) => teamRoster.find(t => t.orgId === id)?.orgName ?? id,
    [teamRoster],
  );

  const handleSaveTeams = async () => {
    if (!orgId || !manageTeamsTarget) return;
    const member = manageTeamsTarget;
    const toAdd = teamRoster.filter(t => !t.isMember && selectedTeamIds.has(t.orgId)).map(t => t.orgId);
    // Owners can't be removed via this flow (transfer ownership first), so they're
    // excluded from removals even if unchecked.
    const toRemove = teamRoster.filter(t => t.isMember && t.role !== 'owner' && !selectedTeamIds.has(t.orgId)).map(t => t.orgId);
    if (toAdd.length === 0 && toRemove.length === 0) { setManageTeamsTarget(null); return; }
    setTeamsSaving(true);
    setTeamsError(null);

    // Each diff op runs independently (allSettled), so one failure doesn't abort
    // the rest and leave a half-applied set with only a generic error. The adds
    // go in one bulk call (idempotent server-side); each remove is its own call.
    type TeamOp = { kind: 'add'; orgIds: string[] } | { kind: 'remove'; orgId: string };
    const ops: TeamOp[] = [];
    if (toAdd.length > 0) ops.push({ kind: 'add', orgIds: toAdd });
    for (const id of toRemove) ops.push({ kind: 'remove', orgId: id });

    const results = await Promise.allSettled(ops.map(op =>
      op.kind === 'add'
        ? api.bulkAddMemberToTeams(orgId, { userId: member.id, orgIds: op.orgIds, role: 'member' })
        : api.removeMemberFromOrganization(op.orgId, member.id),
    ));

    const failures: string[] = [];
    const appliedAdds = new Set<string>();
    const appliedRemoves = new Set<string>();
    results.forEach((r, i) => {
      const op = ops[i];
      const ok = r.status === 'fulfilled' && r.value.success;
      const msg = r.status === 'rejected'
        ? (r.reason instanceof Error ? r.reason.message : String(r.reason))
        : (r.status === 'fulfilled' ? (r.value.message || 'failed') : 'failed');
      if (op.kind === 'add') {
        if (ok) op.orgIds.forEach(id => appliedAdds.add(id));
        else failures.push(`add to ${op.orgIds.map(teamName).join(', ')}: ${msg}`);
      } else {
        if (ok) appliedRemoves.add(op.orgId);
        else failures.push(`remove from ${teamName(op.orgId)}: ${msg}`);
      }
    });

    // Fold what actually applied back into the roster so a re-save diffs against
    // the new truth and re-attempts ONLY the failures (never a done add/remove).
    if (appliedAdds.size > 0 || appliedRemoves.size > 0) {
      setTeamRoster(prev => prev.map(t =>
        appliedAdds.has(t.orgId) ? { ...t, isMember: true, role: t.role ?? 'member' }
          : appliedRemoves.has(t.orgId) ? { ...t, isMember: false }
            : t,
      ));
    }

    setTeamsSaving(false);
    if (failures.length === 0) {
      toast.success(`Updated ${member.username}'s teams`);
      setManageTeamsTarget(null);
    } else {
      const applied = appliedAdds.size + appliedRemoves.size;
      setTeamsError(
        `${applied} change${applied === 1 ? '' : 's'} applied, ${failures.length} failed:\n`
        + failures.join('\n')
        + `\nRe-save to retry just the failed change${failures.length === 1 ? '' : 's'}.`,
      );
    }
  };

  return {
    manageTeamsTarget,
    teamRoster,
    teamsLoading,
    teamsSaving,
    teamsError,
    selectedTeamIds,
    openManageTeams,
    closeManageTeams,
    toggleTeam,
    handleSaveTeams,
  };
}

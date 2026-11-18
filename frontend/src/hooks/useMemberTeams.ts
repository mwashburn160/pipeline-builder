// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatError, settledFailureMessage } from '@/lib/constants';
import { useCallback, useRef, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
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
  const [teamsError, setTeamsError] = useState<string | null>(null);
  // Desired membership set — initialized from the roster's current membership,
  // diffed against it on save to compute adds (bulk) and removes (per team).
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());

  // Only the latest open may publish its roster. Closing one member's modal and
  // opening another's while the first read is in flight would otherwise show —
  // and save a diff against — the FIRST member's team memberships.
  const openGenRef = useRef(0);

  const openManageTeams = useCallback(async (m: OrganizationMember) => {
    if (!orgId) return;
    const gen = ++openGenRef.current;
    setManageTeamsTarget(m);
    setTeamRoster([]);
    setSelectedTeamIds(new Set());
    setTeamsError(null);
    setTeamsLoading(true);
    try {
      const res = await api.getMemberTeams(orgId, m.id);
      if (gen !== openGenRef.current) return;
      const teams = res.data?.teams ?? [];
      setTeamRoster(teams);
      setSelectedTeamIds(new Set(teams.filter(t => t.isMember).map(t => t.orgId)));
    } catch (err) {
      if (gen === openGenRef.current) setTeamsError(formatError(err, 'Failed to load teams'));
    } finally {
      if (gen === openGenRef.current) setTeamsLoading(false);
    }
  }, [orgId]);

  const closeManageTeams = useCallback(() => {
    openGenRef.current += 1;
    setManageTeamsTarget(null);
  }, []);

  const toggleTeam = (teamId: string) => setSelectedTeamIds(prev => {
    const next = new Set(prev);
    if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
    return next;
  });

  const teamName = useCallback(
    (id: string) => teamRoster.find(t => t.orgId === id)?.orgName ?? id,
    [teamRoster],
  );

  // Each diff op runs independently (allSettled), so one failure doesn't abort
  // the rest and leave a half-applied set with only a generic error. The adds
  // go in one bulk call (idempotent server-side); each remove is its own call.
  type TeamOp = { kind: 'add'; orgIds: string[] } | { kind: 'remove'; orgId: string };
  const saveTeams = useMutation({
    fn: (member: OrganizationMember, ops: TeamOp[]) => {
      if (!orgId) throw new Error('No organization');
      return Promise.allSettled(ops.map(op =>
        op.kind === 'add'
          ? api.bulkAddMemberToTeams(orgId, { userId: member.id, orgIds: op.orgIds, role: 'member' })
          : api.removeMemberFromOrganization(op.orgId, member.id),
      ));
    },
    scopeKey: orgId,
    errorFallback: 'Failed to update teams',
    onError: (_err, message) => setTeamsError(message),
    onSuccess: (results, member, ops) => {
      const failures: string[] = [];
      const appliedAdds = new Set<string>();
      const appliedRemoves = new Set<string>();
      results.forEach((r, i) => {
        const op = ops[i];
        const ok = r.status === 'fulfilled' && r.value.success;
        const msg = settledFailureMessage(r);
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
        // Each touched team's member list is cached and now wrong.
        for (const id of [...appliedAdds, ...appliedRemoves]) invalidate.orgMembers(id);
        setTeamRoster(prev => prev.map(t =>
          appliedAdds.has(t.orgId) ? { ...t, isMember: true, role: t.role ?? 'member' }
            : appliedRemoves.has(t.orgId) ? { ...t, isMember: false }
              : t,
        ));
      }

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
    },
  });
  const teamsSaving = saveTeams.pending;

  const handleSaveTeams = async () => {
    if (!orgId || !manageTeamsTarget) return;
    const member = manageTeamsTarget;
    const toAdd = teamRoster.filter(t => !t.isMember && selectedTeamIds.has(t.orgId)).map(t => t.orgId);
    // Owners can't be removed via this flow (transfer ownership first), so they're
    // excluded from removals even if unchecked.
    const toRemove = teamRoster.filter(t => t.isMember && t.role !== 'owner' && !selectedTeamIds.has(t.orgId)).map(t => t.orgId);
    if (toAdd.length === 0 && toRemove.length === 0) { setManageTeamsTarget(null); return; }
    setTeamsError(null);

    const ops: TeamOp[] = [];
    if (toAdd.length > 0) ops.push({ kind: 'add', orgIds: toAdd });
    for (const id of toRemove) ops.push({ kind: 'remove', orgId: id });
    await saveTeams.run(member, ops);
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

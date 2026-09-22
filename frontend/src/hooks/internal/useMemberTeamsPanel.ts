// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/hooks/useAuth';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

interface UseMemberTeamsPanelOptions {
  /** The active org (the potential parent). */
  orgId: string;
  canManageMembers: boolean;
  canOrgSettings: boolean;
  /** Only a root org can parent a team. */
  activeOrgIsRoot: boolean;
  /** Whether the org currently parents any team. */
  hasChildOrgs: boolean;
}

/**
 * The members page's Teams panel: the live and soft-deleted team lists, the
 * reload that keeps them and the session's org list in step, switching into a
 * team, and adding someone straight to one.
 *
 * Pulled out of the page because none of it concerns the member roster — it is
 * the org→team hierarchy, which the roster page merely hosts.
 */
export function useMemberTeamsPanel({
  orgId, canManageMembers, canOrgSettings, activeOrgIsRoot, hasChildOrgs,
}: UseMemberTeamsPanelOptions) {
  const { refreshUser, switchOrganization } = useAuth();
  const toast = useToast();
  const router = useRouter();

  // Descendant teams this org parents (org → team hierarchy) — drives the Teams
  // list + the "Manage teams" gate. Fetched only when the org actually parents
  // teams (`hasChildOrgs`), for admins who can act on them. Best-effort: a
  // failure surfaces a brief note, never blanks the page. Creating a team calls
  // `refreshUser()`, which flips `hasChildOrgs` and so re-runs this read.
  const teamsQ = useFetch(async (signal) => {
    if (!orgId || !canManageMembers || !hasChildOrgs) return [];
    return (await api.getOrganizationTeams(orgId, { signal })).data?.teams ?? [];
  }, [orgId, canManageMembers, hasChildOrgs]);

  // Soft-deleted teams still inside their retention window. Read for any root
  // whose admin may restore them — NOT only while `hasChildOrgs`: deleting the
  // last team drops `childOrgCount` to 0, and its restore must stay reachable.
  const deletedTeamsQ = useFetch(async (signal) => {
    if (!orgId || !canOrgSettings || !activeOrgIsRoot) return [];
    return (await api.listDeletedTeams(orgId, { signal })).data?.teams ?? [];
  }, [orgId, canOrgSettings, activeOrgIsRoot]);

  /** After a team is created, renamed, deleted or restored: re-read both lists
   *  and the session's org list (`childOrgCount` + the switcher). */
  const { refetch: refetchTeams } = teamsQ;
  const { refetch: refetchDeletedTeams } = deletedTeamsQ;
  const refreshTeams = useCallback(async () => {
    await refreshUser();
    refetchTeams();
    refetchDeletedTeams();
  }, [refreshUser, refetchTeams, refetchDeletedTeams]);

  // Switch the active org context to a team so its members can be managed
  // directly (mirrors the org switcher). A parent admin may open any of its
  // teams without a membership row there. A refusal is a toast naming the team,
  // never a silent no-op.
  const switchTeam = async (team: { orgId: string; orgName: string }) => {
    try {
      await switchOrganization(team.orgId);
      toast.success(`Switched to ${team.orgName}`);
      void router.replace(router.asPath);
    } catch (err) {
      toast.error(`Couldn't open ${team.orgName}: ${formatError(err, 'the switch was refused')}`);
    }
  };

  // Add a user (by email) straight to one team, without switching context.
  const [addToTeam, setAddToTeam] = useState<{ orgId: string; orgName: string } | null>(null);
  const [teamMemberEmail, setTeamMemberEmail] = useState('');
  const teamAddForm = useFormState();

  const handleAddToTeam = async () => {
    if (!orgId || !addToTeam) return;
    const email = teamMemberEmail.trim().toLowerCase();
    if (!email) return;
    const result = await teamAddForm.run(
      () => api.bulkAddMemberToTeams(orgId, { email, orgIds: [addToTeam.orgId], role: 'member' }),
    );
    if (result !== null) {
      const status = result.data?.results?.[0]?.status;
      toast.success(status === 'already_member'
        ? `${email} is already a member of ${addToTeam.orgName}`
        : `Added ${email} to ${addToTeam.orgName}`);
      setAddToTeam(null);
      setTeamMemberEmail('');
    }
  };

  const teams = teamsQ.data ?? [];
  return {
    teams,
    /** A failed teams read shows a brief note rather than blanking the panel. */
    teamsLoadWarning: !!teamsQ.error,
    childTeamCount: teams.length,
    deletedTeams: deletedTeamsQ.data ?? [],
    refreshTeams,
    switchTeam,
    addToTeam,
    setAddToTeam,
    teamMemberEmail,
    setTeamMemberEmail,
    teamAddForm,
    handleAddToTeam,
  };
}

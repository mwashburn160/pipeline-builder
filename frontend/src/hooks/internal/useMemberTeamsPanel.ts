// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/hooks/useAuth';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { ApiError, MEMBER_INVITATION_REQUIRED } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { isSessionPolicyReauth } from '@/lib/sign-in-reason';

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
    void refetchTeams();
    void refetchDeletedTeams();
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
      // The team's session policy needs a fresh sign-in: offer one (the panel
      // renders `reauthFor`) instead of an error — nothing moved meanwhile.
      if (isSessionPolicyReauth(err)) setReauthFor(team.orgName);
      else toast.error(`Couldn't open ${team.orgName}: ${formatError(err, 'the switch was refused')}`);
    }
  };
  /** The team whose session policy refused the switch, for {@link OrgReauthDialog}. */
  const [reauthFor, setReauthFor] = useState<string | null>(null);

  // Add a user (by email) straight to one team, without switching context.
  const [addToTeam, setAddToTeam] = useState<{ orgId: string; orgName: string } | null>(null);
  const [teamMemberEmail, setTeamMemberEmail] = useState('');
  const teamAddForm = useFormState();
  /** The address the last add was refused for because the person is outside the
   *  account ({@link MEMBER_INVITATION_REQUIRED}) — they need an invitation to
   *  the organization first, which `form.error` (a string) cannot offer. */
  const [teamAddInviteEmail, setTeamAddInviteEmail] = useState<string | null>(null);

  const handleAddToTeam = async () => {
    if (!orgId || !addToTeam) return;
    const email = teamMemberEmail.trim().toLowerCase();
    if (!email) return;
    setTeamAddInviteEmail(null);
    await teamAddForm.run(
      async () => {
        try {
          return await api.bulkAddMemberToTeams(orgId, { email, orgIds: [addToTeam.orgId], role: 'member' });
        } catch (err) {
          if (err instanceof ApiError && err.code === MEMBER_INVITATION_REQUIRED) setTeamAddInviteEmail(email);
          throw err;
        }
      },
      {
        onSuccess: (result) => {
          const status = result.data?.results?.[0]?.status;
          toast.success(status === 'already_member'
            ? `${email} is already a member of ${addToTeam.orgName}`
            : `Added ${email} to ${addToTeam.orgName}`);
          setAddToTeam(null);
          setTeamMemberEmail('');
        },
      },
    );
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
    reauthFor,
    clearReauth: () => setReauthFor(null),
    addToTeam,
    setAddToTeam,
    teamMemberEmail,
    setTeamMemberEmail,
    teamAddForm,
    teamAddInviteEmail,
    handleAddToTeam,
  };
}

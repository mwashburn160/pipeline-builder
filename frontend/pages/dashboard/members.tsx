import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/router';
import { UserPlus, Users, Search, Building2, Network } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAuth } from '@/hooks/useAuth';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { useMemberRoles } from '@/hooks/useMemberRoles';
import { useMemberTeams } from '@/hooks/useMemberTeams';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ActionBar } from '@/components/ui/ActionBar';
import { AddMemberModal } from '@/components/members/AddMemberModal';
import { PasswordResetModal } from '@/components/members/PasswordResetModal';
import { CreateOrgModal } from '@/components/members/CreateOrgModal';
import { ManageTeamsModal } from '@/components/members/ManageTeamsModal';
import { AddToTeamModal } from '@/components/members/AddToTeamModal';
import { ManageRolesModal } from '@/components/members/ManageRolesModal';
import { TransferOwnershipModal } from '@/components/members/TransferOwnershipModal';
import { buildMemberColumns } from '@/components/members/memberColumns';
import { StepUpModal } from '@/components/admin/StepUpModal';
import api from '@/lib/api';
import type { OrganizationMember } from '@/types';

export default function MembersPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard({ requirePermission: 'members:manage' });
  // Capability to manage members — role admins/owners hold it via their bundle,
  // and so do custom-role members granted `members:manage`. Gates the page's
  // data fetches + controls (the page itself is guarded on this permission).
  const canManageMembers = can('members:manage');
  const { refreshUser, organizations, switchOrganization } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const orgId = user?.organizationId;

  // Server-paginated, server-filtered roster. Search + role filter are pushed
  // to the backend (never an in-memory scan of a whole roster), and each member
  // arrives with its assigned Role names embedded — so role chips render without
  // fetching all roles and running an O(members×roles) membership scan.
  const list = useListPage<OrganizationMember>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
      { key: 'role', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      if (!orgId) return { items: [] };
      const res = await api.getOrganizationMembers(orgId, {
        ...(params.search ? { search: params.search } : {}),
        ...(params.role && params.role !== 'all' ? { role: params.role as 'admin' | 'member' } : {}),
        offset: Number(params.offset || 0),
        limit: Number(params.limit || 25),
      });
      return { items: res.data?.members || [], pagination: res.data?.pagination };
    },
    enabled: isAuthenticated && canManageMembers && !!orgId,
  });
  const members = list.data;

  // Add member
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const addForm = useFormState();
  // Optional "also add to teams" picker shown in the Add Member modal when the
  // active org parents teams (org → team hierarchy).
  const [addTeamRoster, setAddTeamRoster] = useState<{ orgId: string; orgName: string }[]>([]);
  const [addSelectedTeams, setAddSelectedTeams] = useState<Set<string>>(new Set());

  // Roles (org permission-set assignments). A member's access is the union of
  // their assigned Roles; the coarse owner/admin/member `role` is derived from
  // them by the backend and shown as a read-only badge. Editing access = adding
  // or removing Roles, which maps to the role-assignment API under the hood.
  // Gated on `roles:manage` so members-only admins see chips but can't 403 on
  // an assignment they aren't allowed to make.
  const canManageRoles = can('roles:manage');
  const memberRoles = useMemberRoles({
    orgId,
    canManageRoles,
    isAuthenticated,
    onRolesChanged: () => list.refresh(),
  });

  // Create organization
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  // Teams nest one level: only a root org can parent a team, so the "Create
  // Team" action only appears when the active org is itself a root.
  const activeOrg = organizations.find(o => o.id === user?.organizationId);
  const activeOrgIsRoot = !!activeOrg && !activeOrg.parentOrgId;
  // Teams are a paid feature: the backend only lets a root on the team/enterprise
  // tier parent a team (organizationService.checkParentEligible). Mirror that here
  // so we don't offer a "Create Team" action that would 403 — the create modal's
  // tier picker never mattered (a team always inherits the parent's tier).
  const activeOrgCanHaveTeams = activeOrgIsRoot && (activeOrg?.tier === 'team' || activeOrg?.tier === 'enterprise');
  // Descendant teams this org parents (org → team hierarchy) — drives the Teams
  // list + the "Manage teams" gate. Best-effort; admins of a root org only.
  const [teams, setTeams] = useState<{ orgId: string; orgName: string }[]>([]);
  const [teamsLoadWarning, setTeamsLoadWarning] = useState(false);
  const childTeamCount = teams.length;
  // Bumped after creating a team so the list (and the "Manage teams" button it
  // gates) refresh without a full page reload.
  const [teamCountTick, setTeamCountTick] = useState(0);
  useEffect(() => {
    // Only root orgs can parent teams — skip the lookup when the active org is
    // itself a team (the banner shows the "is a team" branch regardless).
    if (!user?.organizationId || !canManageMembers || !activeOrgIsRoot) return;
    let cancelled = false;
    setTeamsLoadWarning(false);
    void api.getOrganizationTeams(user.organizationId)
      .then((res) => { if (!cancelled) setTeams(res.data?.teams ?? []); })
      .catch(() => { if (!cancelled) setTeamsLoadWarning(true); }); // best-effort — surface a brief note
    return () => { cancelled = true; };
  }, [user?.organizationId, canManageMembers, activeOrgIsRoot, teamCountTick]);

  // Pooled seat usage for the whole account (distinct members + pending invites
  // across the subtree vs the root's seat limit). Endpoint resolves to root, so
  // this is account-wide even when viewing a team. Best-effort; admins only.
  const [seatUsage, setSeatUsage] = useState<{ limit: number; used: number } | null>(null);
  const [seatLoadWarning, setSeatLoadWarning] = useState(false);
  useEffect(() => {
    if (!user?.organizationId || !canManageMembers) return;
    let cancelled = false;
    setSeatLoadWarning(false);
    void api.getOrganizationSeatUsage(user.organizationId)
      .then((res) => { if (!cancelled && res.data) setSeatUsage(res.data); })
      .catch(() => { if (!cancelled) setSeatLoadWarning(true); }); // best-effort — surface a brief note
    return () => { cancelled = true; };
    // Re-check on any membership change (total shifts on add/remove/reactivate).
  }, [user?.organizationId, canManageMembers, list.pagination.total]);

  // Switch the active org context to a team so its members can be managed
  // directly (mirrors the org switcher). The page re-renders in the new scope.
  const switchTeam = async (team: { orgId: string; orgName: string }) => {
    try {
      await switchOrganization(team.orgId);
      toast.success(`Switched to ${team.orgName}`);
      router.replace(router.asPath);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to switch team');
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

  const createOrgForm = useFormState();

  // Password reset
  const [passwordTarget, setPasswordTarget] = useState<OrganizationMember | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const passwordForm = useFormState();

  // Manage teams (org → team hierarchy: a member can belong to multiple teams).
  // Only meaningful when the active org is a root that parents teams.
  const canManageTeams = activeOrgIsRoot && childTeamCount > 0;
  const memberTeams = useMemberTeams({ orgId });

  // Transfer ownership. Click-through path mirrors the delete-org flow:
  // confirm modal → step-up (backend `requireStepUp`) → executeTransfer with
  // the returned token. Only offered on non-owner, non-self rows.
  const [transferConfirm, setTransferConfirm] = useState<OrganizationMember | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<OrganizationMember | null>(null);

  const confirmTransfer = () => {
    setPendingTransfer(transferConfirm);
    setTransferConfirm(null);
  };

  const executeTransfer = async (stepUpToken: string) => {
    if (!orgId || !pendingTransfer) return;
    const target = pendingTransfer;
    try {
      const res = await api.transferOrgOwnership(orgId, target.id, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Transfer failed');
      toast.success(`Ownership transferred to ${target.username}`);
      // The current user is no longer owner — refresh their role + the roster.
      await refreshUser();
      list.refresh();
    } catch (err) {
      list.setError(err instanceof Error ? err.message : 'Failed to transfer ownership');
    } finally {
      setPendingTransfer(null);
    }
  };

  // Remove member
  const removeMember = useDelete<OrganizationMember>(
    async (m) => {
      if (!orgId) return; // same guard the other handlers use — avoid sending `undefined` as the org id
      await api.removeMemberFromOrganization(orgId, m.id);
      list.refresh();
    },
    undefined,
    () => list.setError('Failed to remove member'),
  );

  // Open the Add Member modal, resetting form state and (for orgs that parent
  // teams) loading the team roster so the admin can also place the new member
  // on teams in one step.
  const openAddModal = async () => {
    setAddEmail('');
    setAddSelectedTeams(new Set());
    setAddTeamRoster([]);
    addForm.reset();
    setAddModalOpen(true);
    if (canManageTeams && orgId) {
      try {
        const res = await api.getOrganizationTeams(orgId);
        setAddTeamRoster(res.data?.teams ?? []);
      } catch { /* best-effort — no team picker if it fails */ }
    }
  };

  const handleAddMember = async () => {
    if (!orgId || !addEmail.trim()) return;
    const email = addEmail.trim().toLowerCase();
    const result = await addForm.run(
      () => api.addMemberToOrganization(orgId, { email }),
    );
    if (result !== null) {
      // The user now exists in the org; optionally place them on the selected
      // teams too (best-effort — a team failure doesn't undo the org add).
      if (addSelectedTeams.size > 0) {
        const res = await api.bulkAddMemberToTeams(orgId, { email, orgIds: [...addSelectedTeams], role: 'member' });
        if (res.success) toast.success(`Added to ${addSelectedTeams.size} team${addSelectedTeams.size === 1 ? '' : 's'}`);
        else toast.error(res.message || 'Member added, but adding to teams failed');
      }
      setAddEmail('');
      setAddSelectedTeams(new Set());
      setAddModalOpen(false);
      list.refresh();
    }
  };

  const handlePasswordReset = async () => {
    if (!passwordTarget) return;
    if (!newPassword || newPassword.length < 8) {
      passwordForm.setError('Password must be at least 8 characters');
      return;
    }
    const result = await passwordForm.run(
      () => api.updateUserById(passwordTarget.id, { password: newPassword }),
      { successMessage: 'Password updated successfully' },
    );
    if (result !== null) {
      setNewPassword('');
      setTimeout(() => { setPasswordTarget(null); passwordForm.reset(); }, 1500);
    }
  };

  const handleToggleActive = async (member: OrganizationMember) => {
    if (!orgId) return;
    try {
      if (member.isActive) {
        await api.deactivateMember(orgId, member.id);
      } else {
        await api.activateMember(orgId, member.id);
      }
      list.refresh();
    } catch {
      list.setError(`Failed to ${member.isActive ? 'deactivate' : 'activate'} member`);
    }
  };

  const handleCreateOrg = async () => {
    const name = newOrgName.trim();
    if (!name) return;
    // Create Team only renders on a root org, so the new org always nests under
    // the active (root) org as a team.
    const parentOrgId = user?.organizationId;
    // Teams always inherit the parent's tier server-side, so no tier is sent.
    const result = await createOrgForm.run(
      () => api.createOrganization({ name, parentOrgId }),
    );
    if (result !== null) {
      setNewOrgName('');
      setCreateOrgOpen(false);
      await refreshUser();          // pulls the new org into the org-switcher list
      setTeamCountTick((t) => t + 1); // refresh the team-count banner + Manage-teams button
      toast.success(parentOrgId
        ? `Team "${name}" created — switch to it from the organization switcher (bottom-left)`
        : `Organization "${name}" created`);
    }
  };

  const columns = useMemo(() => buildMemberColumns({
    currentUserId: user?.id,
    currentUserRole: user?.role,
    isSuperAdmin,
    canManageTeams,
    canManageRoles,
    rolesForMember: memberRoles.rolesForMember,
    onManageTeams: memberTeams.openManageTeams,
    onTransfer: (m) => setTransferConfirm(m),
    onManageRoles: memberRoles.openManageRoles,
    onResetPassword: (m) => { setPasswordTarget(m); setNewPassword(''); passwordForm.reset(); },
    onToggleActive: handleToggleActive,
    onRemove: (m) => removeMember.open(m),
  }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, isSuperAdmin, canManageTeams, memberTeams.openManageTeams, canManageRoles, memberRoles.rolesForMember, memberRoles.openManageRoles]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Members"
      subtitle="Manage organization members and roles"
      maxWidth="4xl"
      actions={
        <div className="flex gap-2">
          {/* Teams nest one level under a root org, so only show this on a root
              org (a team can't parent sub-teams). Top-level orgs are created by
              a system admin from the Organizations page. Disabled (not hidden) on
              ineligible tiers so the feature is discoverable as an upsell. */}
          {activeOrgIsRoot && (
            <Button
              variant="secondary"
              onClick={() => { setNewOrgName(''); createOrgForm.reset(); setCreateOrgOpen(true); }}
              disabled={!activeOrgCanHaveTeams}
              title={activeOrgCanHaveTeams ? undefined : 'Teams require a Team or Enterprise plan — upgrade this organization to create teams'}
              className="disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Building2 className="w-4 h-4 mr-1.5" /> Create Team
            </Button>
          )}
          <Button onClick={openAddModal}>
            <UserPlus className="w-4 h-4 mr-1.5" /> Add Member
          </Button>
        </div>
      }
    >
      <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="team members" />

      {seatUsage && (() => {
        const unlimited = seatUsage.limit === -1;
        const atCap = !unlimited && seatUsage.used >= seatUsage.limit;
        return (
          <div className={`mb-4 flex items-center gap-2 px-3 py-2 rounded border text-xs ${
            atCap
              ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200'
              : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-gray-600 dark:text-gray-400'
          }`}>
            <UserPlus className="w-3.5 h-3.5 shrink-0" />
            <span>
              <strong>{seatUsage.used}</strong>{unlimited ? '' : ` of ${seatUsage.limit}`} account {seatUsage.limit === 1 ? 'seat' : 'seats'} used
              {unlimited ? ' (unlimited)' : atCap ? ' — at capacity; remove a member or add a seat pack to invite more' : ''}
              {activeOrgIsRoot ? '' : ' (pooled across your organization)'}
            </span>
          </div>
        );
      })()}

      {activeOrg?.parentOrgId && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-600 dark:text-gray-400">
          <Building2 className="w-3.5 h-3.5 text-gray-400 shrink-0" />
          <span>This organization is a <strong>team</strong> nested under a parent organization. Its members, quotas, and billing are scoped here.</span>
        </div>
      )}

      {/* Teams list — the org's teams. Open one to manage its
          members directly; or add an existing member to teams via the
          per-member "Manage teams" action below. */}
      {activeOrgIsRoot && teams.length > 0 && (
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
              <Building2 className="w-4 h-4 text-gray-400" /> Teams <span className="text-gray-400 font-normal">({teams.length})</span>
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">Teams of {activeOrg?.name}</span>
          </div>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {teams.map((t) => (
              <li key={t.orgId} className="py-2 flex items-center justify-between gap-2 text-sm">
                <span className="font-medium text-gray-900 dark:text-gray-100 truncate">{t.orgName}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => { setTeamMemberEmail(''); teamAddForm.reset(); setAddToTeam(t); }}
                    className="action-link text-xs inline-flex items-center gap-1"
                  >
                    <UserPlus className="w-3.5 h-3.5" /> Add member
                  </button>
                  <button onClick={() => void switchTeam(t)} className="action-link text-xs">Open →</button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            <strong>Open</strong> a team to manage its members directly, or add an existing member to teams with the
            <Network className="w-3 h-3 inline mx-0.5 -mt-0.5" /> action on each member row.
          </p>
        </div>
      )}

      {(teamsLoadWarning || seatLoadWarning) && (
        <div className="mb-3 px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400">
          Couldn&apos;t load {teamsLoadWarning && seatLoadWarning ? 'the teams list and seat usage' : teamsLoadWarning ? 'the teams list' : 'seat usage'} — that section is hidden. Everything else works normally.
        </div>
      )}

      <ErrorAlert message={list.error} onDismiss={() => list.setError(null)} />

      <div className="filter-bar">
        <ActionBar
          left={
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
              <input type="text" placeholder="Search by name or email..." value={list.filters.search} onChange={(e) => list.updateFilter('search', e.target.value)} className="filter-input" />
            </div>
          }
          right={
            <select value={list.filters.role} onChange={(e) => list.updateFilter('role', e.target.value)} className="filter-select">
              <option value="all">All Roles</option>
              <option value="member">Members</option>
              <option value="admin">Admins</option>
            </select>
          }
        />
      </div>

      <DataTable<OrganizationMember>
        data={members}
        columns={columns}
        getRowKey={(m) => m.id}
        isLoading={list.isLoading}
        emptyState={{
          icon: Users,
          title: 'No team members found',
          description: list.hasActiveFilters ? 'Try adjusting your search or filter.' : 'Add members to your organization to get started.',
          action: list.hasActiveFilters ? undefined : (
            <Button onClick={openAddModal}>
              <UserPlus className="w-4 h-4 mr-1.5" /> Add Member
            </Button>
          ),
        }}
        defaultSortColumn="username"
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}

      {/* Add member modal */}
      <AddMemberModal
        open={addModalOpen}
        email={addEmail}
        onEmailChange={setAddEmail}
        form={addForm}
        teamRoster={addTeamRoster}
        selectedTeams={addSelectedTeams}
        onToggleTeam={(teamId) => setAddSelectedTeams(prev => {
          const next = new Set(prev);
          if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
          return next;
        })}
        onSubmit={handleAddMember}
        onClose={() => setAddModalOpen(false)}
      />

      {/* Manage Roles — assign/remove the org's Roles for one member. Editing
          access happens here; the coarse Role badge is derived from the result. */}
      <ManageRolesModal
        target={memberRoles.rolesTarget}
        roles={memberRoles.roles}
        rolesListError={memberRoles.rolesListError}
        selectedRoleIds={memberRoles.selectedRoleIds}
        saving={memberRoles.rolesSaving}
        error={memberRoles.rolesError}
        onToggleRole={memberRoles.toggleRoleSelection}
        onRetry={memberRoles.fetchRoles}
        onSubmit={memberRoles.handleSaveRoles}
        onClose={memberRoles.closeRoles}
      />

      {/* Password reset modal */}
      <PasswordResetModal
        target={passwordTarget}
        password={newPassword}
        onPasswordChange={setNewPassword}
        form={passwordForm}
        onSubmit={handlePasswordReset}
        onClose={() => setPasswordTarget(null)}
      />

      {/* Create organization modal */}
      <CreateOrgModal
        open={createOrgOpen}
        orgName={newOrgName}
        onOrgNameChange={setNewOrgName}
        form={createOrgForm}
        activeOrg={activeOrg}
        onSubmit={handleCreateOrg}
        onClose={() => setCreateOrgOpen(false)}
      />

      {/* Manage teams modal — a member can belong to multiple teams */}
      <ManageTeamsModal
        target={memberTeams.manageTeamsTarget}
        roster={memberTeams.teamRoster}
        loading={memberTeams.teamsLoading}
        saving={memberTeams.teamsSaving}
        error={memberTeams.teamsError}
        selectedTeamIds={memberTeams.selectedTeamIds}
        onToggleTeam={memberTeams.toggleTeam}
        onSubmit={memberTeams.handleSaveTeams}
        onClose={memberTeams.closeManageTeams}
      />

      {/* Add a member straight to one team (no context switch) */}
      <AddToTeamModal
        target={addToTeam}
        email={teamMemberEmail}
        onEmailChange={setTeamMemberEmail}
        form={teamAddForm}
        onSubmit={handleAddToTeam}
        onClose={() => setAddToTeam(null)}
      />

      {/* Transfer ownership — confirm, then step-up before the PATCH runs */}
      <TransferOwnershipModal
        target={transferConfirm}
        onConfirm={confirmTransfer}
        onClose={() => setTransferConfirm(null)}
      />
      {pendingTransfer && (
        <StepUpModal
          action={`Transfer ownership of this organization to ${pendingTransfer.username}`}
          onConfirmed={executeTransfer}
          onClose={() => setPendingTransfer(null)}
        />
      )}

      {/* Remove confirmation */}
      {removeMember.target && (
        <DeleteConfirmModal
          title="Remove Member"
          itemName={removeMember.target.username}
          loading={removeMember.loading}
          onConfirm={removeMember.confirm}
          onCancel={removeMember.close}
        />
      )}
    </DashboardLayout>
  );
}

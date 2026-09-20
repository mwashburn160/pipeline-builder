import { useCallback, useState, useMemo } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { UserPlus, Users, Building2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasPermission } from '@/lib/auth-helpers';
import { useAuth } from '@/hooks/useAuth';
import { useFetch } from '@/hooks/useFetch';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { useMemberRoles } from '@/hooks/useMemberRoles';
import { useMemberTeams } from '@/hooks/useMemberTeams';
import { useMemberTeamsPanel } from '@/hooks/internal/useMemberTeamsPanel';
import { TeamMemberAccess } from '@/components/members/TeamMemberAccess';
import { TeamsCard } from '@/components/teams/TeamsCard';
import { useToast } from '@/components/ui/Toast';
import { SearchInput } from '@/components/ui/SearchInput';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Callout } from '@/components/ui/Callout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataTable } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ActionBar } from '@/components/ui/ActionBar';
import { AddMemberModal } from '@/components/members/AddMemberModal';
import { CreateOrgModal } from '@/components/members/CreateOrgModal';
import { ManageTeamsModal } from '@/components/members/ManageTeamsModal';
import { AddToTeamModal } from '@/components/members/AddToTeamModal';
import { ManageRolesModal } from '@/components/members/ManageRolesModal';
import { buildMemberColumns } from '@/components/members/memberColumns';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { MfaResetPanel } from '@/components/members/MfaResetPanel';
import { POOLING_TITLE, poolingExplanation } from '@/components/quotas/constants';
import { RequestMfaResetModal } from '@/components/members/RequestMfaResetModal';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { tierAllowsTeams } from '@/lib/tiers';
import type { OrganizationMember } from '@/types';
import { formatError } from '@/lib/constants';

/** Ties the disabled Create Team button to the sentence that says why. */
const CREATE_TEAM_REASON_ID = 'create-team-blocked-reason';

export default function MembersPage() {
  // The read gate (`members:manage`) comes from the nav entry via page-access.
  const { accessDenied, user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, isReadOnly, can } = useAuthGuard();
  // Capability to manage members — role admins/owners hold it via their bundle,
  // and so do custom-role members granted `members:manage`. `can()` is
  // read-only-aware (false under read-only impersonation) — use it for the WRITE
  // controls. For READ visibility (the roster fetch) use the raw permission so a
  // read-only "view-as" session can still SEE the roster (the backend permits
  // GETs under impersonation); gating the fetch on the mutation-aware `can()`
  // left the page permanently empty during an investigation.
  const canManageMembers = can('members:manage');
  const canViewMembers = hasPermission(user, 'members:manage');
  // Team lifecycle + settings. Creating, exporting, deleting and restoring a team
  // all ride `org:settings` at the API (POST /organization, /export,
  // DELETE /teams/:teamId, /restore); the Manage drawer shows whichever of a
  // team's settings this viewer may edit.
  const canOrgSettings = can('org:settings');
  const canManageTeamSettings = canOrgSettings || can('org:impersonation') || can('org:idp');
  const { refreshUser, switchOrganization } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const orgId = user?.organizationId;

  // Server-paginated, server-filtered roster. Search + role + status filters and
  // the sort are pushed to the backend (never an in-memory scan of a whole
  // roster), and each member arrives with its assigned Role names embedded — so
  // role chips render without fetching all roles and running an O(members×roles)
  // membership scan.
  const list = useListPage<OrganizationMember>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
      { key: 'role', type: 'select', defaultValue: 'all' },
      { key: 'status', type: 'select', defaultValue: 'all' },
    ],
    // Server-side sort — the roster spans pages, so ordering must happen on the
    // backend (a client sort would only order the visible page). Defaults to the
    // username column shown selected in the table.
    initialSort: { sortBy: 'username', sortOrder: 'asc' },
    fetcher: async (params, signal) => {
      if (!orgId) return { items: [] };
      const res = await api.getOrganizationMembers(orgId, {
        ...(params.search ? { search: params.search } : {}),
        ...(params.role && params.role !== 'all' ? { role: params.role as 'admin' | 'member' } : {}),
        ...(params.status && params.status !== 'all' ? { status: params.status as 'active' | 'inactive' } : {}),
        ...(params.sortBy ? { sortBy: params.sortBy } : {}),
        ...(params.sortOrder ? { sortOrder: params.sortOrder as 'asc' | 'desc' } : {}),
        offset: Number(params.offset || 0),
        limit: Number(params.limit || 25),
      }, { signal });
      return { items: res.data?.members || [], pagination: res.data?.pagination };
    },
    enabled: isAuthenticated && canViewMembers && !!orgId,
  });
  // Maps a sortable DataTable column id to the backend `sortBy` whitelist key.
  // `username`/`role`/`status` map through; the "Joined" column orders by the
  // membership `joinedAt`.
  const MEMBER_SORT_MAP: Record<string, string> = { username: 'username', role: 'role', status: 'status', joined: 'joinedAt' };
  const members = list.data;

  /**
   * Reload the roster after a write.
   *
   * This page's own list is uncached (a filtered, paged view must never serve a
   * stale window), but the SHARED member reads — the dashboard home's count
   * probe, the org-admin card, the compliance recipient picker, the pipeline
   * detail's owner-name map — are, so a write here has to drop them too.
   */
  const { refresh: refreshList } = list;
  const refreshRoster = useCallback(() => {
    invalidate.orgMembers(orgId);
    refreshList();
  }, [orgId, refreshList]);

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
    onRolesChanged: () => refreshRoster(),
  });

  // Create organization
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  // The team just created here, if any — drives the "what now?" banner.
  const [newTeam, setNewTeam] = useState<{ orgId: string; orgName: string } | null>(null);
  // Teams nest one level: only a root org can parent a team, so the "Create
  // Team" action only appears when the active org is itself a root.
  const { activeOrg, isChildOrg, hasChildOrgs } = useOrgHierarchy();
  const activeOrgIsRoot = !!activeOrg && !isChildOrg;
  // Can this viewer buy capacity? Seat packs are purchased at the root (pooled
  // billing), so only offer the "add a seat pack" link to a root-org admin (or a
  // custom group granted `billing:manage`). A plain member sees the text, not a link.
  const canManageBilling = (isAdmin || can('billing:manage')) && activeOrgIsRoot;
  // Teams are a paid feature: the backend only lets a root on a team-capable
  // tier parent a team (organizationService.checkParentEligible). `tierAllowsTeams`
  // mirrors its tier list — including `unlimited`, the billing-off default, which
  // the hardcoded team/enterprise test here used to exclude, hiding "Create team"
  // on every billing-disabled deployment. (A team always inherits the parent's
  // tier, so the create modal never needed a tier picker.)
  const activeOrgCanHaveTeams = activeOrgIsRoot && tierAllowsTeams(activeOrg?.tier);
  // The Teams panel — both team lists, their reload, switching into a team and
  // adding someone straight to one.
  const {
    teams, teamsLoadWarning, childTeamCount, deletedTeams, refreshTeams, switchTeam,
    addToTeam, setAddToTeam, teamMemberEmail, setTeamMemberEmail, teamAddForm, handleAddToTeam,
  } = useMemberTeamsPanel({ orgId: orgId ?? '', canManageMembers, canOrgSettings, activeOrgIsRoot, hasChildOrgs });

  // Pooled seat usage for the whole account (distinct members + pending invites
  // across the subtree vs the root's seat limit). Endpoint resolves to root, so
  // this is account-wide even when viewing a team. Best-effort; admins only.
  // Re-checked on any membership change (total shifts on add/remove/reactivate).
  const seatQ = useFetch(async (signal) => {
    if (!user?.organizationId || !canManageMembers) return null;
    return (await api.getOrganizationSeatUsage(user.organizationId, { signal })).data ?? null;
  }, [user?.organizationId, canManageMembers, list.pagination.total]);
  const seatUsage = seatQ.data;
  const seatLoadWarning = !!seatQ.error;

  const createOrgForm = useFormState();

  // Manage teams (org → team hierarchy: a member can belong to multiple teams).
  // Only meaningful when the active org is a root that parents teams.
  const canManageTeams = hasChildOrgs && childTeamCount > 0;
  const memberTeams = useMemberTeams({ orgId });

  // Transfer ownership. Destructive (the current owner is demoted and loses
  // owner-only controls) AND step-up gated, so it is ONE dialog that states
  // what is lost and takes the factor — the rule settings.tsx documents for
  // "Delete your account". It used to open a confirm modal and THEN the
  // step-up modal, which asked the same person the same question twice.
  // Only offered on non-owner, non-self rows.
  const [pendingTransfer, setPendingTransfer] = useState<OrganizationMember | null>(null);

  const executeTransfer = async (stepUpToken: string) => {
    if (!orgId || !pendingTransfer) return;
    const target = pendingTransfer;
    try {
      const res = await api.transferOrgOwnership(orgId, target.id, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Transfer failed');
      toast.success(`Ownership transferred to ${target.username}`);
      // The current user is no longer owner — refresh their role + the roster.
      await refreshUser();
      refreshRoster();
    } catch (err) {
      list.setError(formatError(err, 'Failed to transfer ownership'));
    } finally {
      setPendingTransfer(null);
    }
  };

  // Remove member
  const removeMember = useDelete<OrganizationMember>(
    async (m) => {
      if (!orgId) return; // same guard the other handlers use — avoid sending `undefined` as the org id
      await api.removeMemberFromOrganization(orgId, m.id);
      refreshRoster();
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
      refreshRoster();
    }
  };

  // Deactivating a member revokes their access, so it's confirmed first;
  // reactivation is harmless and applies immediately. Both paths toast.
  // Two-person MFA reset: only an owner/admin (or a sysadmin) may file or decide
  // one — the server checks `canAdministerOrg` on top of `members:manage`.
  const canResetMfa = can('members:manage') && (isAdmin || isSuperAdmin);
  const [resetMfaTarget, setResetMfaTarget] = useState<OrganizationMember | null>(null);
  const [mfaResetsVersion, setMfaResetsVersion] = useState(0);

  const [deactivateTarget, setDeactivateTarget] = useState<OrganizationMember | null>(null);
  const [deactivateLoading, setDeactivateLoading] = useState(false);

  const performToggleActive = async (member: OrganizationMember) => {
    if (!orgId) return;
    try {
      if (member.isActive) {
        await api.deactivateMember(orgId, member.id);
      } else {
        await api.activateMember(orgId, member.id);
      }
      toast.success(`${member.username} ${member.isActive ? 'deactivated' : 'activated'}`);
      refreshRoster();
    } catch {
      list.setError(`Failed to ${member.isActive ? 'deactivate' : 'activate'} member`);
    }
  };

  const handleToggleActive = async (member: OrganizationMember) => {
    if (member.isActive) { setDeactivateTarget(member); return; }
    await performToggleActive(member);
  };

  const confirmDeactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivateLoading(true);
    await performToggleActive(deactivateTarget);
    setDeactivateLoading(false);
    setDeactivateTarget(null);
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
      // The new team belongs in the switcher and in every cached org list.
      invalidate.organizations();
      // Pulls the new org into the switcher and bumps `childOrgCount`, which
      // reveals the Teams list + Manage-teams action (re-running the teams read).
      await refreshTeams();
      const created = result.data?.organization;
      toast.success(parentOrgId ? `Team "${name}" created` : `Organization "${name}" created`);
      // A team with no members and nothing in it is a dead end, and telling the
      // user to "switch from the organization switcher (bottom-left)" is an
      // instruction where a button belongs. Stage the new team so the banner
      // below offers the two things that actually move it forward.
      if (parentOrgId && created) setNewTeam({ orgId: created.id, orgName: created.name });
    }
  };

  // The create-team entry point: shown to a root-org admin whether or not the
  // org has any teams yet (an org with none is precisely the one that needs to
  // find it), and disabled — with the reason in view, not only in a tooltip —
  // when the root's tier can't parent teams.
  const canCreateTeamHere = activeOrgIsRoot && canOrgSettings;
  const openCreateTeam = () => { setNewOrgName(''); createOrgForm.reset(); setCreateOrgOpen(true); };
  const createTeamBlockedReason = activeOrgCanHaveTeams ? undefined : 'Teams need a Team or Enterprise plan.';

  const columns = useMemo(() => buildMemberColumns({
    currentUserId: user?.id,
    currentUserRole: user?.role,
    isSuperAdmin,
    canManageMembers,
    canManageTeams,
    canManageRoles,
    rolesForMember: memberRoles.rolesForMember,
    onManageTeams: memberTeams.openManageTeams,
    onTransfer: (m) => setPendingTransfer(m),
    onManageRoles: memberRoles.openManageRoles,
    onToggleActive: handleToggleActive,
    onRemove: (m) => removeMember.open(m),
    ...(canResetMfa ? { onResetMfa: (m: OrganizationMember) => setResetMfaTarget(m) } : {}),
  }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the column builder closes over per-render handlers; the listed values are what change it
    [user, isSuperAdmin, canManageMembers, canManageTeams, memberTeams.openManageTeams, canManageRoles, memberRoles.rolesForMember, memberRoles.openManageRoles, canResetMfa]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Members"
      subtitle="Manage organization members and roles"
      maxWidth="4xl"
      actions={
        <div className="flex gap-2 items-start">
          {/* Teams nest one level under a root org, so only show this on a root
              org (a team can't parent sub-teams). Top-level orgs are created by
              a system admin from the Organizations page. Disabled (not hidden) on
              ineligible tiers so the feature is discoverable as an upsell — and
              this is the entry point an org with NO teams has, so it stays put
              while the team LIST stays hidden until there is something to list. */}
          {canCreateTeamHere && (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant="secondary"
                onClick={openCreateTeam}
                disabled={!activeOrgCanHaveTeams}
                aria-describedby={createTeamBlockedReason ? CREATE_TEAM_REASON_ID : undefined}
                className="disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Building2 className="w-4 h-4 mr-1.5" /> Create Team
              </Button>
              {/* The reason used to live ONLY in a `title`: invisible on touch,
                  unread by most screen readers, and with nowhere to go about it.
                  Rendered as text next to the control (the pattern
                  TokenPermissionPicker uses for a permission you don't hold),
                  with the upgrade link only for someone who can open Billing. */}
              {createTeamBlockedReason && (
                <p id={CREATE_TEAM_REASON_ID} className="text-2xs text-fg-muted text-right max-w-[16rem]">
                  {createTeamBlockedReason}{' '}
                  {canManageBilling ? (
                    <Link href="/dashboard/billing" className="action-link underline">Upgrade this organization</Link>
                  ) : 'Ask an owner to upgrade this organization'}{' '}to create teams.
                </p>
              )}
            </div>
          )}
          {canManageMembers && (
            <Button onClick={openAddModal}>
              <UserPlus className="w-4 h-4 mr-1.5" /> Add Member
            </Button>
          )}
        </div>
      }
    >
      <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="team members" size="sm" />

      {seatUsage && (() => {
        const unlimited = seatUsage.limit === -1;
        const atCap = !unlimited && seatUsage.used >= seatUsage.limit;
        return (
          <Callout variant={atCap ? 'warning' : 'neutral'} icon={UserPlus} className="mb-4">
            <strong>{seatUsage.used}</strong>{unlimited ? '' : ` of ${seatUsage.limit}`} account {seatUsage.limit === 1 ? 'seat' : 'seats'} used
            {unlimited ? ' (unlimited)' : atCap ? (
              <> — at capacity; remove a member or{' '}
                {canManageBilling ? (
                  <Link href="/dashboard/billing" className="action-link font-medium underline">add a seat pack</Link>
                ) : 'add a seat pack'}{' '}to invite more</>
            ) : ''}
            {/* Buying seats is decided HERE, so what pooling means for that
                purchase is stated here rather than hidden in a tooltip — one
                wording shared with the quota surfaces (`poolingExplanation`). */}
            {(isChildOrg || hasChildOrgs) && (
              <span className="block mt-1 text-xs">
                <strong>{POOLING_TITLE}.</strong>{' '}
                {poolingExplanation(activeOrgIsRoot ? 'root' : 'team')}
              </span>
            )}
          </Callout>
        );
      })()}

      {isChildOrg && (
        <Callout variant="neutral" icon={Building2} className="mb-4">
          This organization is a <strong>team</strong> nested under a parent organization. Its members are managed here;
          quotas, seats and billing are set on the root organization.
        </Callout>
      )}

      {/* "You made a team — now what?" Both next steps are real buttons on the
          handlers the Teams list already uses, so the admin never has to go
          hunting for the org switcher. Dismissible; the Teams list below keeps
          both actions permanently. */}
      {newTeam && (
        <Callout variant="success" title={`Team "${newTeam.orgName}" is ready`} onDismiss={() => setNewTeam(null)} className="mb-4">
          <p className="text-sm">
            It starts empty. Add the people who belong to it, or switch into it to create pipelines and plugins there.
            Existing pipelines stay with the organization that created them — set their owning team from a pipeline&apos;s
            Edit → Access &amp; Status instead.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {canManageMembers && (
              <Button
                variant="secondary"
                onClick={() => { setTeamMemberEmail(''); teamAddForm.reset(); setAddToTeam(newTeam); }}
              >
                Add members
              </Button>
            )}
            <Button onClick={() => { const t = newTeam; setNewTeam(null); void switchTeam(t); }}>
              Switch to {newTeam.orgName}
            </Button>
          </div>
        </Callout>
      )}

      {/* Teams list — the org's teams, each openable, manageable in place and
          deletable; plus the recently-deleted teams still restorable. Shown
          while there are deleted teams even when no live team remains. */}
      {orgId && ((hasChildOrgs && teams.length > 0) || (canOrgSettings && deletedTeams.length > 0)) && (
        <TeamsCard
          parentOrgId={orgId}
          parentOrgName={activeOrg?.name}
          teams={teams}
          deletedTeams={deletedTeams}
          canManageMembers={canManageMembers}
          canOrgSettings={canOrgSettings}
          canManageSettings={canManageTeamSettings}
          onOpen={(t) => void switchTeam(t)}
          onAddMember={(t) => { setTeamMemberEmail(''); teamAddForm.reset(); setAddToTeam(t); }}
          onChanged={refreshTeams}
          {...(canCreateTeamHere ? { onCreateTeam: openCreateTeam } : {})}
          {...(createTeamBlockedReason ? { createTeamDisabledReason: createTeamBlockedReason } : {})}
        />
      )}

      {(teamsLoadWarning || seatLoadWarning) && (
        <Callout variant="neutral" className="mb-3">
          Couldn&apos;t load {teamsLoadWarning && seatLoadWarning ? 'the teams list and seat usage' : teamsLoadWarning ? 'the teams list' : 'seat usage'} — that section is hidden. Everything else works normally.
        </Callout>
      )}

      {/* Two-person MFA resets waiting on a second owner/admin (hidden when there
          are none). Covers this org and its teams. */}
      {orgId && canResetMfa && (
        <div className="mb-4">
          <MfaResetPanel orgId={orgId} currentUserId={user.id} readOnly={isReadOnly} refreshKey={mfaResetsVersion} />
        </div>
      )}

      <ErrorAlert message={list.error} onRetry={list.refresh} onDismiss={() => list.setError(null)} />

      <div className="filter-bar">
        <ActionBar
          left={
            <SearchInput placeholder="Search by name or email..." value={list.filters.search} onChange={(v) => list.updateFilter('search', v)} aria-label="Search members by name or email" />
          }
          right={
            <div className="flex gap-2">
              <FilterSelect value={list.filters.status} onChange={(e) => list.updateFilter('status', e.target.value)} aria-label="Filter by status">
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </FilterSelect>
              <FilterSelect value={list.filters.role} onChange={(e) => list.updateFilter('role', e.target.value)} aria-label="Filter by role">
                <option value="all">All roles</option>
                <option value="member">Members</option>
                <option value="admin">Admins</option>
              </FilterSelect>
            </div>
          }
        />
      </div>

      <DataTable<OrganizationMember>
        data={members}
        columns={columns}
        getRowKey={(m) => m.id}
        isLoading={list.isLoading}
        loadFailed={!!list.error}
        onRetry={list.refresh}
        emptyState={{
          icon: Users,
          title: 'No team members found',
          description: list.hasActiveFilters ? 'Try adjusting your search or filter.' : 'Add members to your organization to get started.',
          // Same gate as the header button: without `members:manage` the modal's
          // submit 403s, so the empty state must not offer the action either.
          action: list.hasActiveFilters || !canManageMembers ? undefined : (
            <Button onClick={openAddModal}>
              <UserPlus className="w-4 h-4 mr-1.5" /> Add Member
            </Button>
          ),
        }}
        defaultSortColumn="username"
        serverSort
        onSortChange={(columnId, direction) => {
          const field = MEMBER_SORT_MAP[columnId];
          if (field) list.setSort(field, direction);
        }}
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}

      {/* View a TEAM member's account from the parent org. A separate panel, not a
          button on the roster above: that roster is this org's own members, whom a
          parent admin can't view (same org). Admins of a root org with teams only —
          the server re-checks authority on every request. */}
      {isAdmin && hasChildOrgs && teams.length > 0 && user && (
        <div className="mt-6">
          <TeamMemberAccess teams={teams} currentUserId={user.id} readOnly={isReadOnly} />
        </div>
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

      {/* Transfer ownership — ONE dialog: what it costs, and the factor. */}
      {pendingTransfer && (
        <StepUpModal
          title="Transfer ownership?"
          action={`Transfer ownership of this organization to ${pendingTransfer.username}`}
          details={(
            <>
              <p>
                <strong className="text-fg">{pendingTransfer.username}</strong> becomes the owner of this organization.
              </p>
              <p className="mt-2">
                You are demoted to admin and lose owner-only controls, including the ability to transfer ownership back.
              </p>
            </>
          )}
          onConfirmed={executeTransfer}
          onClose={() => setPendingTransfer(null)}
        />
      )}

      {/* Remove confirmation */}
      {removeMember.target && (
        <DeleteConfirmModal
          title="Remove member"
          itemName={removeMember.target.username}
          loading={removeMember.loading}
          onConfirm={removeMember.confirm}
          onCancel={removeMember.close}
        />
      )}

      {resetMfaTarget && orgId && (
        <RequestMfaResetModal
          orgId={orgId}
          member={resetMfaTarget}
          onClose={() => setResetMfaTarget(null)}
          onRequested={() => setMfaResetsVersion((v) => v + 1)}
        />
      )}

      {/* Deactivate confirmation — deactivation revokes access, so confirm it. */}
      {deactivateTarget && (
        <ConfirmDialog
          title="Deactivate member?"
          confirmLabel="Deactivate"
          tone="danger"
          loading={deactivateLoading}
          onConfirm={confirmDeactivate}
          onCancel={() => setDeactivateTarget(null)}
        >
          <p>
            <span className="font-medium">{deactivateTarget.username}</span> will lose access to this organization until
            reactivated.
          </p>
        </ConfirmDialog>
      )}
    </DashboardLayout>
  );
}

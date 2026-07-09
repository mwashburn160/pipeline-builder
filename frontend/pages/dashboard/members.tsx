import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/router';
import { UserPlus, Users, Shield, ShieldOff, UserMinus, UserCheck, UserX, Crown, Search, KeyRound, Building2, Network } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAuth } from '@/hooks/useAuth';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Modal } from '@/components/ui/Modal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ActionBar } from '@/components/ui/ActionBar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import api from '@/lib/api';
import type { OrganizationMember, MemberTeam } from '@/types';

export default function MembersPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin } = useAuthGuard({ requireAdmin: true });
  const { refreshUser, organizations, switchOrganization } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const orgId = user?.organizationId;

  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'member' | 'admin'>('all');

  // Add member
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const addForm = useFormState();
  // Optional "also add to teams" picker shown in the Add Member modal when the
  // active org parents teams (org → team hierarchy).
  const [addTeamRoster, setAddTeamRoster] = useState<{ orgId: string; orgName: string }[]>([]);
  const [addSelectedTeams, setAddSelectedTeams] = useState<Set<string>>(new Set());

  // Role change
  const [roleChangeTarget, setRoleChangeTarget] = useState<OrganizationMember | null>(null);
  const [roleChangeLoading, setRoleChangeLoading] = useState(false);

  // Create organization
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgTier, setNewOrgTier] = useState<'developer' | 'pro' | 'team' | 'enterprise'>('developer');
  // Teams nest one level: only a root org can parent a team, so the "Create
  // Team" action only appears when the active org is itself a root.
  const activeOrg = organizations.find(o => o.id === user?.organizationId);
  const activeOrgIsRoot = !!activeOrg && !activeOrg.parentOrgId;
  // Descendant teams this org parents (org → team hierarchy) — drives the Teams
  // list + the "Manage teams" gate. Best-effort; admins of a root org only.
  const [teams, setTeams] = useState<{ orgId: string; orgName: string }[]>([]);
  const childTeamCount = teams.length;
  // Bumped after creating a team so the list (and the "Manage teams" button it
  // gates) refresh without a full page reload.
  const [teamCountTick, setTeamCountTick] = useState(0);
  useEffect(() => {
    // Only root orgs can parent teams — skip the lookup when the active org is
    // itself a team (the banner shows the "is a team" branch regardless).
    if (!user?.organizationId || !isAdmin || !activeOrgIsRoot) return;
    let cancelled = false;
    void api.getOrganizationTeams(user.organizationId)
      .then((res) => { if (!cancelled) setTeams(res.data?.teams ?? []); })
      .catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [user?.organizationId, isAdmin, activeOrgIsRoot, teamCountTick]);

  // Pooled seat usage for the whole account (distinct members + pending invites
  // across the subtree vs the root's seat limit). Endpoint resolves to root, so
  // this is account-wide even when viewing a team. Best-effort; admins only.
  const [seatUsage, setSeatUsage] = useState<{ limit: number; used: number } | null>(null);
  useEffect(() => {
    if (!user?.organizationId || !isAdmin) return;
    let cancelled = false;
    void api.getOrganizationSeatUsage(user.organizationId)
      .then((res) => { if (!cancelled && res.data) setSeatUsage(res.data); })
      .catch(() => { /* best-effort — seat pill just hides */ });
    return () => { cancelled = true; };
  }, [user?.organizationId, isAdmin, members.length]);

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

  const toggleTeam = (teamId: string) => setSelectedTeamIds(prev => {
    const next = new Set(prev);
    if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
    return next;
  });

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
    try {
      if (toAdd.length > 0) {
        const res = await api.bulkAddMemberToTeams(orgId, { userId: member.id, orgIds: toAdd, role: 'member' });
        if (!res.success) throw new Error(res.message || 'Failed to add to teams');
      }
      for (const teamId of toRemove) {
        const res = await api.removeMemberFromOrganization(teamId, member.id);
        if (!res.success) throw new Error(res.message || 'Failed to remove from a team');
      }
      toast.success(`Updated ${member.username}'s teams`);
      setManageTeamsTarget(null);
    } catch (err) {
      setTeamsError(err instanceof Error ? err.message : 'Failed to update teams');
    } finally {
      setTeamsSaving(false);
    }
  };

  // Remove member
  const removeMember = useDelete<OrganizationMember>(
    async (m) => {
      if (!orgId) return; // same guard the other handlers use — avoid sending `undefined` as the org id
      await api.removeMemberFromOrganization(orgId, m.id);
      setMembers(prev => prev.filter(x => x.id !== m.id));
    },
    undefined,
    () => setError('Failed to remove member'),
  );

  const fetchMembers = useCallback(async () => {
    if (!orgId) return;
    try {
      setIsLoading(true);
      const res = await api.getOrganizationMembers(orgId);
      setMembers(res.data?.members || []);
      setError(null);
    } catch {
      setError('Failed to load team members');
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (isAuthenticated && isAdmin && orgId) fetchMembers();
  }, [isAuthenticated, isAdmin, orgId, fetchMembers]);

  const filteredMembers = useMemo(() => {
    let result = members;
    if (roleFilter !== 'all') result = result.filter(m => m.role === roleFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(m => m.username.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
    }
    return result;
  }, [members, roleFilter, searchQuery]);

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
      fetchMembers();
    }
  };

  const handleRoleChange = async () => {
    if (!orgId || !roleChangeTarget) return;
    const newRole = roleChangeTarget.role === 'admin' ? 'member' : 'admin';
    setRoleChangeLoading(true);
    try {
      await api.updateMemberRole(orgId, roleChangeTarget.id, newRole);
      setMembers(prev => prev.map(m => m.id === roleChangeTarget.id ? { ...m, role: newRole } : m));
      setRoleChangeTarget(null);
    } catch {
      setError('Failed to update role');
    } finally {
      setRoleChangeLoading(false);
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
      setMembers(prev => prev.map(m => m.id === member.id ? { ...m, isActive: !m.isActive } : m));
    } catch {
      setError(`Failed to ${member.isActive ? 'deactivate' : 'activate'} member`);
    }
  };

  const handleCreateOrg = async () => {
    const name = newOrgName.trim();
    if (!name) return;
    // Create Team only renders on a root org, so the new org always nests under
    // the active (root) org as a team.
    const parentOrgId = user?.organizationId;
    const result = await createOrgForm.run(
      () => api.createOrganization({ name, tier: newOrgTier, parentOrgId }),
    );
    if (result !== null) {
      setNewOrgName('');
      setNewOrgTier('developer');
      setCreateOrgOpen(false);
      await refreshUser();          // pulls the new org into the org-switcher list
      setTeamCountTick((t) => t + 1); // refresh the team-count banner + Manage-teams button
      toast.success(parentOrgId
        ? `Team "${name}" created — switch to it from the organization switcher (bottom-left)`
        : `Organization "${name}" created`);
    }
  };

  const columns: Column<OrganizationMember>[] = useMemo(() => [
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
      render: (m) => (
        <div className="flex items-center gap-2">
          <Badge color={m.role === 'admin' ? 'purple' : 'gray'}>{m.role}</Badge>
          {m.isOwner && <span title="Owner"><Crown className="w-3.5 h-3.5 text-yellow-500" /></span>}
        </div>
      ),
    },
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
        const isSelf = m.id === user?.id;
        if (isSelf || m.isOwner) return null;
        return (
          <div className="flex items-center gap-1 justify-end">
            {canManageTeams && (
              <button
                onClick={() => openManageTeams(m)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:text-indigo-400 dark:hover:bg-indigo-900/20 transition-colors"
                title="Manage team memberships"
                aria-label={`Manage team memberships for ${m.username}`}
              >
                <Network className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => setRoleChangeTarget(m)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:text-blue-400 dark:hover:bg-blue-900/20 transition-colors"
              title={m.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
              aria-label={`${m.role === 'admin' ? 'Demote' : 'Promote'} ${m.username}`}
            >
              {m.role === 'admin' ? <ShieldOff className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
            </button>
            <button
              onClick={() => { setPasswordTarget(m); setNewPassword(''); passwordForm.reset(); }}
              className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:text-amber-400 dark:hover:bg-amber-900/20 transition-colors"
              title="Reset password"
              aria-label={`Reset password for ${m.username}`}
            >
              <KeyRound className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleToggleActive(m)}
              className={`p-1.5 rounded-lg transition-colors ${
                m.isActive
                  ? 'text-gray-400 hover:text-orange-600 hover:bg-orange-50 dark:hover:text-orange-400 dark:hover:bg-orange-900/20'
                  : 'text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:text-green-400 dark:hover:bg-green-900/20'
              }`}
              title={m.isActive ? 'Deactivate member' : 'Reactivate member'}
              aria-label={`${m.isActive ? 'Deactivate' : 'Reactivate'} ${m.username}`}
            >
              {m.isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
            </button>
            <button
              onClick={() => removeMember.open(m)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-900/20 transition-colors"
              title="Remove from organization"
              aria-label={`Remove ${m.username} from the organization`}
            >
              <UserMinus className="w-4 h-4" />
            </button>
          </div>
        );
      },
    },
  ], [user, canManageTeams, openManageTeams]);

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
              a system admin from the Organizations page. */}
          {activeOrgIsRoot && (
            <button onClick={() => { setNewOrgName(''); setNewOrgTier('developer'); createOrgForm.reset(); setCreateOrgOpen(true); }} className="btn btn-secondary">
              <Building2 className="w-4 h-4 mr-1.5" /> Create Team
            </button>
          )}
          <button onClick={openAddModal} className="btn btn-primary">
            <UserPlus className="w-4 h-4 mr-1.5" /> Add Member
          </button>
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

      {error && (
        <div className="alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      <div className="filter-bar">
        <ActionBar
          left={
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
              <input type="text" placeholder="Search by name or email..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="filter-input" />
            </div>
          }
          right={
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as 'all' | 'member' | 'admin')} className="filter-select">
              <option value="all">All Roles</option>
              <option value="member">Members</option>
              <option value="admin">Admins</option>
            </select>
          }
        />
      </div>

      <DataTable<OrganizationMember>
        data={filteredMembers}
        columns={columns}
        getRowKey={(m) => m.id}
        isLoading={isLoading}
        emptyState={{
          icon: Users,
          title: 'No team members found',
          description: searchQuery ? 'Try adjusting your search.' : 'Add members to your organization to get started.',
          action: searchQuery ? undefined : (
            <button onClick={openAddModal} className="btn btn-primary">
              <UserPlus className="w-4 h-4 mr-1.5" /> Add Member
            </button>
          ),
        }}
        defaultSortColumn="username"
      />

      {/* Add member modal */}
      {addModalOpen && (
        <Modal
          title="Add Member"
          onClose={() => setAddModalOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setAddModalOpen(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={handleAddMember} disabled={addForm.loading || !addEmail.trim()} className="btn btn-primary">
                {addForm.loading ? 'Adding...' : 'Add Member'}
              </button>
            </div>
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Enter the email address of an existing user to add to your organization.</p>
          <input
            type="email"
            placeholder="user@example.com"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
            className="input text-sm"
            autoFocus
          />
          {addTeamRoster.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">Also add to teams (optional)</p>
              <div className="space-y-0.5 max-h-40 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-1">
                {addTeamRoster.map((t) => (
                  <label key={t.orgId} className="flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addSelectedTeams.has(t.orgId)}
                      onChange={() => setAddSelectedTeams(prev => {
                        const next = new Set(prev);
                        if (next.has(t.orgId)) next.delete(t.orgId); else next.add(t.orgId);
                        return next;
                      })}
                      disabled={addForm.loading}
                      className="rounded border-gray-300"
                    />
                    <span className="truncate text-gray-900 dark:text-gray-100">{t.orgName}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {addForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{addForm.error}</p>}
        </Modal>
      )}

      {/* Role change confirmation */}
      {roleChangeTarget && (
        <DeleteConfirmModal
          title={roleChangeTarget.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
          itemName={roleChangeTarget.username}
          loading={roleChangeLoading}
          onConfirm={handleRoleChange}
          onCancel={() => setRoleChangeTarget(null)}
        />
      )}

      {/* Password reset modal */}
      {passwordTarget && (
        <Modal
          title={`Reset Password: ${passwordTarget.username}`}
          onClose={() => setPasswordTarget(null)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setPasswordTarget(null)} className="btn btn-secondary" disabled={passwordForm.loading}>Cancel</button>
              <button onClick={handlePasswordReset} disabled={passwordForm.loading || !newPassword} className="btn btn-primary">
                {passwordForm.loading ? 'Updating...' : 'Reset Password'}
              </button>
            </div>
          }
        >
          {passwordForm.error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{passwordForm.error}</p>}
          {passwordForm.success && <p className="text-sm text-green-600 dark:text-green-400 mb-3">{passwordForm.success}</p>}
          {/* <form> + username field + autocomplete hints so this reads as a
              credential change to browsers/password managers (silences
              Chrome's "Password field is not contained in a form" warning).
              onSubmit also gives us native Enter-to-submit. */}
          <form onSubmit={(e) => { e.preventDefault(); handlePasswordReset(); }}>
            <label className="label">New Password</label>
            <input type="text" name="username" autoComplete="username" value={passwordTarget.username} readOnly hidden />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Minimum 8 characters"
              autoComplete="new-password"
              className="input text-sm"
              autoFocus
              disabled={passwordForm.loading}
            />
          </form>
        </Modal>
      )}

      {/* Create organization modal */}
      {createOrgOpen && (
        <Modal
          title="Create Team"
          onClose={() => setCreateOrgOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setCreateOrgOpen(false)} className="btn btn-secondary" disabled={createOrgForm.loading}>Cancel</button>
              <button onClick={handleCreateOrg} disabled={createOrgForm.loading || !newOrgName.trim()} className="btn btn-primary">
                {createOrgForm.loading ? 'Creating...' : 'Create Team'}
              </button>
            </div>
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Create a <strong>team</strong> nested under <strong>{activeOrg?.name}</strong>. It gets
            its own members, quotas, and secrets, and you&apos;ll be its owner.
            <br />
            <span className="text-xs">Need a separate top-level organization instead? A system admin creates those from the Organizations page.</span>
          </p>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Team name
              </label>
              <input
                type="text"
                placeholder="e.g. mobile-team, qa-shared, project-foo"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateOrg()}
                className="input text-sm"
                autoFocus
                disabled={createOrgForm.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Tier
              </label>
              <select
                value={newOrgTier}
                onChange={(e) => setNewOrgTier(e.target.value as 'developer' | 'pro' | 'team' | 'enterprise')}
                className="input text-sm"
                disabled={createOrgForm.loading}
              >
                <option value="developer">Developer — small budget, cheapest builds</option>
                <option value="pro">Pro — medium budget, faster builds</option>
                <option value="team">Team — shared quotas, collaboration features</option>
                <option value="enterprise">Enterprise — highest limits, unlimited API calls</option>
              </select>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Tier determines build resources and quota. Can be changed later.
              </p>
            </div>
          </div>
          {createOrgForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{createOrgForm.error}</p>}
          {createOrgForm.success && <p className="text-sm text-green-600 dark:text-green-400 mt-3">{createOrgForm.success}</p>}
        </Modal>
      )}

      {/* Manage teams modal — a member can belong to multiple teams */}
      {manageTeamsTarget && (
        <Modal
          title={`Manage Teams: ${manageTeamsTarget.username}`}
          onClose={() => setManageTeamsTarget(null)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setManageTeamsTarget(null)} className="btn btn-secondary" disabled={teamsSaving}>Cancel</button>
              <button onClick={handleSaveTeams} disabled={teamsSaving || teamsLoading} className="btn btn-primary">
                {teamsSaving ? 'Saving...' : 'Save Teams'}
              </button>
            </div>
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Select which teams <strong>{manageTeamsTarget.username}</strong> belongs to.
            A member can be on multiple teams; each membership keeps its own role.
          </p>
          {teamsError && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{teamsError}</p>}
          {teamsLoading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading teams…</p>
          ) : teamRoster.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">This organization has no teams yet.</p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {teamRoster.map((t) => {
                const isOwner = t.role === 'owner';
                return (
                  <label
                    key={t.orgId}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm ${isOwner ? 'opacity-60' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer'}`}
                    title={isOwner ? 'Owner of this team — transfer ownership to remove' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTeamIds.has(t.orgId)}
                      onChange={() => toggleTeam(t.orgId)}
                      disabled={teamsSaving || isOwner}
                      className="rounded border-gray-300"
                    />
                    <span className="flex-1 truncate text-gray-900 dark:text-gray-100">{t.orgName}</span>
                    {t.isMember && <Badge color={isOwner ? 'purple' : 'gray'}>{t.role}</Badge>}
                    {t.isMember && t.isActive === false && <Badge color="red">inactive</Badge>}
                  </label>
                );
              })}
            </div>
          )}
        </Modal>
      )}

      {/* Add a member straight to one team (no context switch) */}
      {addToTeam && (
        <Modal
          title={`Add member to ${addToTeam.orgName}`}
          onClose={() => setAddToTeam(null)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setAddToTeam(null)} className="btn btn-secondary" disabled={teamAddForm.loading}>Cancel</button>
              <button onClick={handleAddToTeam} disabled={teamAddForm.loading || !teamMemberEmail.trim()} className="btn btn-primary">
                {teamAddForm.loading ? 'Adding...' : 'Add Member'}
              </button>
            </div>
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Enter the email of an existing user to add to the <strong>{addToTeam.orgName}</strong> team.
          </p>
          <input
            type="email"
            placeholder="user@example.com"
            value={teamMemberEmail}
            onChange={(e) => setTeamMemberEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddToTeam()}
            className="input text-sm"
            autoFocus
          />
          {teamAddForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{teamAddForm.error}</p>}
        </Modal>
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

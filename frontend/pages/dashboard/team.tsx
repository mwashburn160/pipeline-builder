import { useEffect, useState, useMemo, useCallback } from 'react';
import { UserPlus, Users, Shield, ShieldOff, UserMinus, UserCheck, UserX, Crown, Search, KeyRound } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ActionBar } from '@/components/ui/ActionBar';
import api from '@/lib/api';
import type { OrganizationMember } from '@/types';

export default function TeamPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard({ requireAdmin: true });

  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'user' | 'admin'>('all');

  // Add member
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const addForm = useFormState();

  // Role change
  const [roleChangeTarget, setRoleChangeTarget] = useState<OrganizationMember | null>(null);
  const [roleChangeLoading, setRoleChangeLoading] = useState(false);

  // Password reset
  const [passwordTarget, setPasswordTarget] = useState<OrganizationMember | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const passwordForm = useFormState();

  // Remove member
  const removeMember = useDelete<OrganizationMember>(
    async (m) => {
      await api.removeMemberFromOrganization(user!.organizationId!, m.id);
      setMembers(prev => prev.filter(x => x.id !== m.id));
    },
    undefined,
    () => setError('Failed to remove member'),
  );

  const orgId = user?.organizationId;

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

  const handleAddMember = async () => {
    if (!orgId || !addEmail.trim()) return;
    const result = await addForm.run(
      () => api.addMemberToOrganization(orgId, { email: addEmail.trim().toLowerCase() }),
    );
    if (result !== null) {
      setAddEmail('');
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
          {new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
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
            <button
              onClick={() => setRoleChangeTarget(m)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:text-blue-400 dark:hover:bg-blue-900/20 transition-colors"
              title={m.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
            >
              {m.role === 'admin' ? <ShieldOff className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
            </button>
            <button
              onClick={() => { setPasswordTarget(m); setNewPassword(''); passwordForm.reset(); }}
              className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:text-amber-400 dark:hover:bg-amber-900/20 transition-colors"
              title="Reset password"
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
            >
              {m.isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
            </button>
            <button
              onClick={() => removeMember.open(m)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-900/20 transition-colors"
              title="Remove from organization"
            >
              <UserMinus className="w-4 h-4" />
            </button>
          </div>
        );
      },
    },
  ], [user]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Team"
      subtitle="Manage team members and roles"
      maxWidth="4xl"
      actions={
        <button onClick={() => { setAddEmail(''); addForm.reset(); setAddModalOpen(true); }} className="btn btn-primary text-sm">
          <UserPlus className="w-4 h-4 mr-1.5" /> Add Member
        </button>
      }
    >
      <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="team members" />

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
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as 'all' | 'user' | 'admin')} className="filter-select">
              <option value="all">All Roles</option>
              <option value="user">Users</option>
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
        emptyState={{ icon: Users, title: 'No team members found', description: searchQuery ? 'Try adjusting your search.' : 'Add members to your organization to get started.' }}
        defaultSortColumn="username"
      />

      {/* Add member modal */}
      {addModalOpen && (
        <div className="modal-backdrop" onClick={() => setAddModalOpen(false)}>
          <div className="modal-panel max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Add Member</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Enter the email address of an existing user to add to your organization.</p>
            <input
              type="email"
              placeholder="user@example.com"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
              className="input text-sm mb-3"
              autoFocus
            />
            {addForm.error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{addForm.error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setAddModalOpen(false)} className="btn btn-secondary text-sm">Cancel</button>
              <button onClick={handleAddMember} disabled={addForm.loading || !addEmail.trim()} className="btn btn-primary text-sm">
                {addForm.loading ? 'Adding...' : 'Add Member'}
              </button>
            </div>
          </div>
        </div>
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
        <div className="modal-backdrop" onClick={() => setPasswordTarget(null)}>
          <div className="modal-panel max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Reset Password: {passwordTarget.username}</h3>
            {passwordForm.error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{passwordForm.error}</p>}
            {passwordForm.success && <p className="text-sm text-green-600 dark:text-green-400 mb-3">{passwordForm.success}</p>}
            <div>
              <label className="label">New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handlePasswordReset()}
                placeholder="Minimum 8 characters"
                className="input text-sm"
                autoFocus
                disabled={passwordForm.loading}
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setPasswordTarget(null)} className="btn btn-secondary text-sm" disabled={passwordForm.loading}>Cancel</button>
              <button onClick={handlePasswordReset} disabled={passwordForm.loading || !newPassword} className="btn btn-primary text-sm">
                {passwordForm.loading ? 'Updating...' : 'Reset Password'}
              </button>
            </div>
          </div>
        </div>
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

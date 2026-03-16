import { useEffect, useState, useMemo } from 'react';
import { Search, Users } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useDebounce } from '@/hooks/useDebounce';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ActionBar } from '@/components/ui/ActionBar';
import api from '@/lib/api';

interface UserListItem {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  isEmailVerified: boolean;
  organizationId?: string;
  organizationName?: string;
  createdAt?: string;
}

/** System-admin-only page for managing users across all organizations. */
export default function UsersPage() {
  const { user, isReady, isAuthenticated, isSysAdmin } = useAuthGuard({ requireAdmin: true });
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'user' | 'admin'>('all');

  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [editRole, setEditRole] = useState<'user' | 'admin'>('user');
  const [newPassword, setNewPassword] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<UserListItem | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const debouncedSearch = useDebounce(searchQuery, 300);

  useEffect(() => {
    async function fetchUsers() {
      if (!isAuthenticated || !isSysAdmin) return;
      try {
        setIsLoading(true);
        const params: Record<string, string> = {};
        if (debouncedSearch) params.search = debouncedSearch;
        if (roleFilter !== 'all') params.role = roleFilter;
        const response = await api.listUsers(params);
        setUsers((response.data?.users || []) as UserListItem[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load users');
      } finally {
        setIsLoading(false);
      }
    }

    if (isAuthenticated && isSysAdmin) fetchUsers();
  }, [isAuthenticated, isSysAdmin, debouncedSearch, roleFilter]);

  const handleEditUser = (userItem: UserListItem) => {
    setEditingUser(userItem);
    setEditRole(userItem.role);
    setNewPassword('');
    setEditError(null);
    setEditSuccess(null);
  };

  const handleSaveUser = async () => {
    if (!editingUser) return;
    setEditLoading(true);
    setEditError(null);
    setEditSuccess(null);

    try {
      const updates: { role?: string; password?: string } = {};
      if (editRole !== editingUser.role) updates.role = editRole;
      if (newPassword && newPassword.length >= 8) {
        updates.password = newPassword;
      } else if (newPassword && newPassword.length < 8) {
        setEditError('Password must be at least 8 characters');
        setEditLoading(false);
        return;
      }

      if (Object.keys(updates).length === 0) {
        setEditError('No changes to save');
        setEditLoading(false);
        return;
      }

      await api.updateUserById(editingUser.id, updates);
      setUsers(users.map(u => u.id === editingUser.id ? { ...u, role: editRole } : u));
      setEditSuccess('User updated successfully');
      setNewPassword('');
      setTimeout(() => setEditingUser(null), 1500);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await api.deleteUserById(deleteTarget.id);
      setUsers(users.filter(u => u.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const userColumns: Column<UserListItem>[] = useMemo(() => [
    {
      id: 'user',
      header: 'User',
      sortValue: (u) => u.username,
      render: (u) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{u.username}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{u.email}</div>
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortValue: (u) => u.role,
      render: (u) => <Badge color={u.role === 'admin' ? 'purple' : 'gray'}>{u.role}</Badge>,
    },
    {
      id: 'organization',
      header: 'Organization',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (u) => u.organizationName || '',
      render: (u) => <>{u.organizationName || 'None'}</>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (u) => u.isEmailVerified,
      render: (u) => (
        <Badge color={u.isEmailVerified ? 'green' : 'yellow'}>{u.isEmailVerified ? 'Verified' : 'Unverified'}</Badge>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (userItem) => (
        <>
          <button onClick={() => handleEditUser(userItem)} className="action-link mr-4">Edit</button>
          {userItem.id !== user?.id && (
            <button onClick={() => setDeleteTarget(userItem)} className="action-link-danger">Delete</button>
          )}
        </>
      ),
    },
  ], [user]);

  if (!isReady || !user) return <LoadingPage />;

  // Non-system admins should not see this page — redirect handled by useAuthGuard,
  // but show nothing if they somehow reach here
  if (!isSysAdmin) return null;

  return (
    <DashboardLayout title="All Users" subtitle="System-wide user administration">
      {error && (
        <div className="alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      <div className="filter-bar">
        <ActionBar
          left={(
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
              <input type="text" placeholder="Search by username or email..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="filter-input" />
            </div>
          )}
          right={(
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as 'all' | 'user' | 'admin')} className="filter-select">
              <option value="all">All Roles</option>
              <option value="user">Users</option>
              <option value="admin">Admins</option>
            </select>
          )}
        />
      </div>

      <DataTable
        data={users}
        columns={userColumns}
        isLoading={isLoading}
        emptyState={{
          icon: Users,
          title: 'No users found',
          description: searchQuery ? 'Try adjusting your search criteria.' : 'No users to display.',
        }}
        getRowKey={(u) => u.id}
        defaultSortColumn="user"
      />

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete User"
          itemName={deleteTarget.username}
          loading={deleteLoading}
          onConfirm={handleDeleteUser}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {editingUser && (
        <div className="modal-backdrop">
          <div className="modal-panel max-w-md">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Edit User: {editingUser.username}</h2>

            {editError && <div className="alert-error"><p>{editError}</p></div>}
            {editSuccess && <div className="alert-success"><p>{editSuccess}</p></div>}

            <div className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input type="text" value={editingUser.email} disabled className="input bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400" />
              </div>
              <div>
                <label className="label">Organization</label>
                <input type="text" value={editingUser.organizationName || 'None'} disabled className="input bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400" />
              </div>
              <div>
                <label className="label">Role</label>
                <select value={editRole} onChange={(e) => setEditRole(e.target.value as 'user' | 'admin')} className="input" disabled={editLoading || editingUser.id === user?.id}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                {editingUser.id === user?.id && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Cannot change your own role</p>
                )}
              </div>
              <div>
                <label className="label">New Password (leave blank to keep current)</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Minimum 8 characters" className="input" disabled={editLoading} />
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button onClick={() => setEditingUser(null)} disabled={editLoading} className="btn btn-secondary">Cancel</button>
              <button onClick={handleSaveUser} disabled={editLoading} className="btn btn-primary">
                {editLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

import { useState, useMemo } from 'react';
import { formatError } from '@/lib/constants';
import { Search, Users } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
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

  const list = useListPage<UserListItem>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
      { key: 'role', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const page = Math.floor(Number(params.offset || 0) / Number(params.limit || 25)) + 1;
      const p: Record<string, string | number> = { page, limit: Number(params.limit || 25) };
      if (params.search) p.search = params.search;
      if (params.role && params.role !== 'all') p.role = params.role;
      const response = await api.listUsers(p as Record<string, string>);
      const data = response.data;
      const users = (data?.users || []) as UserListItem[];
      return {
        items: users,
        pagination: data ? { total: data.total, offset: (data.page - 1) * data.limit } : undefined,
      };
    },
    enabled: isAuthenticated && isSysAdmin,
  });

  const del = useDelete<UserListItem>(
    async (u) => {
      await api.deleteUserById(u.id);
    },
    list.refresh,
    (err) => list.setError(formatError(err, 'Failed to delete user')),
  );

  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [editRole, setEditRole] = useState<'user' | 'admin'>('user');
  const [newPassword, setNewPassword] = useState('');
  const editForm = useFormState();

  const handleEditUser = (userItem: UserListItem) => {
    setEditingUser(userItem);
    setEditRole(userItem.role);
    setNewPassword('');
    editForm.reset();
  };

  const handleSaveUser = async () => {
    if (!editingUser) return;

    const updates: { role?: string; password?: string } = {};
    if (editRole !== editingUser.role) updates.role = editRole;
    if (newPassword && newPassword.length >= 8) {
      updates.password = newPassword;
    } else if (newPassword && newPassword.length < 8) {
      editForm.setError('Password must be at least 8 characters');
      return;
    }

    if (Object.keys(updates).length === 0) {
      editForm.setError('No changes to save');
      return;
    }

    const result = await editForm.run(
      () => api.updateUserById(editingUser.id, updates),
      { successMessage: 'User updated successfully' },
    );

    if (result !== null) {
      list.refresh();
      setNewPassword('');
      setTimeout(() => setEditingUser(null), 1500);
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
            <button onClick={() => del.open(userItem)} className="action-link-danger">Delete</button>
          )}
        </>
      ),
    },
  ], [user]);

  if (!isReady || !user) return <LoadingPage />;
  if (!isSysAdmin) return null;

  return (
    <DashboardLayout title="All Users" subtitle="System-wide user administration">
      {list.error && (
        <div className="alert-error">
          <p>{list.error}</p>
          <button onClick={() => list.setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      <div className="filter-bar">
        <ActionBar
          left={
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
              <input type="text" placeholder="Search by username or email..." value={list.filters.search} onChange={(e) => list.updateFilter('search', e.target.value)} className="filter-input" />
            </div>
          }
          right={
            <select value={list.filters.role} onChange={(e) => list.updateFilter('role', e.target.value)} className="filter-select">
              <option value="all">All Roles</option>
              <option value="user">Users</option>
              <option value="admin">Admins</option>
            </select>
          }
        />
      </div>

      <DataTable
        data={list.data}
        columns={userColumns}
        isLoading={list.isLoading}
        emptyState={{
          icon: Users,
          title: 'No users found',
          description: list.hasActiveFilters ? 'Try adjusting your search criteria.' : 'No users to display.',
        }}
        getRowKey={(u) => u.id}
        defaultSortColumn="user"
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}

      {del.target && (
        <DeleteConfirmModal
          title="Delete User"
          itemName={del.target.username}
          loading={del.loading}
          onConfirm={del.confirm}
          onCancel={del.close}
        />
      )}

      {editingUser && (
        <div className="modal-backdrop">
          <div className="modal-panel max-w-md">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Edit User: {editingUser.username}</h2>

            {editForm.error && <div className="alert-error"><p>{editForm.error}</p></div>}
            {editForm.success && <div className="alert-success"><p>{editForm.success}</p></div>}

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
                <select value={editRole} onChange={(e) => setEditRole(e.target.value as 'user' | 'admin')} className="input" disabled={editForm.loading || editingUser.id === user?.id}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                {editingUser.id === user?.id && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Cannot change your own role</p>
                )}
              </div>
              <div>
                <label className="label">New Password (leave blank to keep current)</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Minimum 8 characters" className="input" disabled={editForm.loading} />
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button onClick={() => setEditingUser(null)} disabled={editForm.loading} className="btn btn-secondary">Cancel</button>
              <button onClick={handleSaveUser} disabled={editForm.loading} className="btn btn-primary">
                {editForm.loading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Search, Users } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
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

export default function UsersPage() {
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard({ requireAdmin: true });
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

  useEffect(() => {
    async function fetchUsers() {
      if (!isAuthenticated || !isAdmin) return;
      try {
        setIsLoading(true);
        const params: Record<string, string> = {};
        if (searchQuery) params.search = searchQuery;
        if (roleFilter !== 'all') params.role = roleFilter;
        const response = await api.listUsers(params);
        const userList = (response as any).users || response.data || [];
        setUsers(userList);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load users');
      } finally {
        setIsLoading(false);
      }
    }

    if (isAuthenticated && isAdmin) fetchUsers();
  }, [isAuthenticated, isAdmin, searchQuery, roleFilter]);

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
      const updates: Record<string, unknown> = {};
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

      await api.updateUserById(editingUser.id, updates as any);
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

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="User Management">
      <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="users" orgName={user.organizationName} />

      {error && (
        <div className="alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)} className="mt-2 text-sm text-red-600 dark:text-red-400 underline">Dismiss</button>
        </div>
      )}

      {/* Filters */}
      <div className="filter-bar">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <input type="text" placeholder="Search by username or email..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="filter-input" />
          </div>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as 'all' | 'user' | 'admin')} className="filter-select">
            <option value="all">All Roles</option>
            <option value="user">Users</option>
            <option value="admin">Admins</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : users.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No users found"
          description={searchQuery ? 'Try adjusting your search criteria.' : 'No users to display.'}
        />
      ) : (
        <div className="data-table">
          <table className="min-w-full">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                {isSysAdmin && <th>Organization</th>}
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((userItem, i) => (
                <motion.tr
                  key={userItem.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: i * 0.03 }}
                >
                  <td>
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{userItem.username}</div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">{userItem.email}</div>
                  </td>
                  <td>
                    <Badge color={userItem.role === 'admin' ? 'purple' : 'gray'}>{userItem.role}</Badge>
                  </td>
                  {isSysAdmin && (
                    <td className="text-sm text-gray-500 dark:text-gray-400">{userItem.organizationName || 'None'}</td>
                  )}
                  <td>
                    <Badge color={userItem.isEmailVerified ? 'green' : 'yellow'}>{userItem.isEmailVerified ? 'Verified' : 'Unverified'}</Badge>
                  </td>
                  <td className="text-right text-sm font-medium">
                    <button onClick={() => handleEditUser(userItem)} className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 mr-4 transition-colors" disabled={userItem.id === user.id}>Edit</button>
                    {userItem.id !== user.id && (
                      <button onClick={() => setDeleteTarget(userItem)} className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300 transition-colors">Delete</button>
                    )}
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete User"
          itemName={deleteTarget.username}
          loading={deleteLoading}
          onConfirm={handleDeleteUser}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div className="modal-backdrop">
          <div className="modal-panel max-w-md">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Edit User: {editingUser.username}</h2>

            {editError && (
              <div className="alert-error"><p>{editError}</p></div>
            )}
            {editSuccess && (
              <div className="alert-success"><p>{editSuccess}</p></div>
            )}

            <div className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input type="text" value={editingUser.email} disabled className="input bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400" />
              </div>
              <div>
                <label className="label">Role</label>
                <select value={editRole} onChange={(e) => setEditRole(e.target.value as 'user' | 'admin')} className="input" disabled={editLoading}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label className="label">New Password (leave blank to keep current)</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" className="input" disabled={editLoading} />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Minimum 8 characters</p>
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

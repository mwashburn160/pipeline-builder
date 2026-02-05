import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { User, isSystemAdmin, isOrgAdmin } from '@/types';

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
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading: authLoading } = useAuth();
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'user' | 'admin'>('all');
  
  // Edit modal state
  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [editRole, setEditRole] = useState<'user' | 'admin'>('user');
  const [newPassword, setNewPassword] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  // Determine user permissions
  const isSysAdmin = isSystemAdmin(user);
  const isOrgAdminUser = isOrgAdmin(user);
  const canManageUsers = isSysAdmin || isOrgAdminUser;

  useEffect(() => {
    if (isInitialized && !authLoading && !isAuthenticated) {
      router.push('/auth/login');
    }
    // Redirect non-admins
    if (isInitialized && !authLoading && isAuthenticated && !canManageUsers) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, isInitialized, authLoading, canManageUsers, router]);

  useEffect(() => {
    async function fetchUsers() {
      if (!isAuthenticated || !canManageUsers) return;
      
      try {
        setIsLoading(true);
        const params: Record<string, string> = {};
        
        if (searchQuery) {
          params.search = searchQuery;
        }
        if (roleFilter !== 'all') {
          params.role = roleFilter;
        }
        
        const response = await api.listUsers(params);
        // Handle response format - could be { users: [] } or { data: [] }
        const userList = (response as any).users || response.data || [];
        setUsers(userList);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load users');
      } finally {
        setIsLoading(false);
      }
    }

    if (isAuthenticated && canManageUsers) {
      fetchUsers();
    }
  }, [isAuthenticated, canManageUsers, searchQuery, roleFilter]);

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
      
      // Update role if changed
      if (editRole !== editingUser.role) {
        updates.role = editRole;
      }

      // Update password if provided
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
      
      // Update local state
      setUsers(users.map(u => 
        u.id === editingUser.id 
          ? { ...u, role: editRole }
          : u
      ));
      
      setEditSuccess('User updated successfully');
      setNewPassword('');
      
      // Close modal after delay
      setTimeout(() => {
        setEditingUser(null);
      }, 1500);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
      return;
    }

    try {
      await api.deleteUserById(userId);
      setUsers(users.filter(u => u.id !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  if (!isInitialized || authLoading) {
    return <LoadingPage message="Loading..." />;
  }

  if (!isAuthenticated || !user || !canManageUsers) {
    return <LoadingPage message="Redirecting..." />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <Link href="/dashboard" className="text-gray-500 hover:text-gray-700">
              ← Back
            </Link>
            <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Info banner */}
        {isSysAdmin ? (
          <div className="mb-6 rounded-md bg-purple-50 p-4">
            <p className="text-sm text-purple-700">
              System Admin: You can view and manage all users across all organizations.
            </p>
          </div>
        ) : (
          <div className="mb-6 rounded-md bg-blue-50 p-4">
            <p className="text-sm text-blue-700">
              Organization Admin: You can view and manage users within <strong>{user.organizationName || 'your organization'}</strong> only.
            </p>
          </div>
        )}

        {error && (
          <div className="mb-6 rounded-md bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">{error}</p>
            <button 
              onClick={() => setError(null)}
              className="mt-2 text-sm text-red-600 underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search by username or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            />
          </div>
          <div>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as 'all' | 'user' | 'admin')}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            >
              <option value="all">All Roles</option>
              <option value="user">Users</option>
              <option value="admin">Admins</option>
            </select>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner size="lg" />
          </div>
        ) : users.length === 0 ? (
          <div className="bg-white shadow rounded-lg p-6 text-center">
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
              />
            </svg>
            <h3 className="mt-4 text-lg font-medium text-gray-900">No users found</h3>
            <p className="mt-2 text-sm text-gray-500">
              {searchQuery ? 'Try adjusting your search criteria.' : 'No users to display.'}
            </p>
          </div>
        ) : (
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  {isSysAdmin && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Organization
                    </th>
                  )}
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {users.map((userItem) => (
                  <tr key={userItem.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{userItem.username}</div>
                      <div className="text-sm text-gray-500">{userItem.email}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          userItem.role === 'admin'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {userItem.role}
                      </span>
                    </td>
                    {isSysAdmin && (
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {userItem.organizationName || 'None'}
                      </td>
                    )}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          userItem.isEmailVerified
                            ? 'bg-green-100 text-green-800'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {userItem.isEmailVerified ? 'Verified' : 'Unverified'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => handleEditUser(userItem)}
                        className="text-blue-600 hover:text-blue-900 mr-4"
                        disabled={userItem.id === user.id}
                      >
                        Edit
                      </button>
                      {userItem.id !== user.id && (
                        <button
                          onClick={() => handleDeleteUser(userItem.id)}
                          className="text-red-600 hover:text-red-900"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">
              Edit User: {editingUser.username}
            </h2>

            {editError && (
              <div className="mb-4 rounded-md bg-red-50 p-3">
                <p className="text-sm text-red-800">{editError}</p>
              </div>
            )}
            {editSuccess && (
              <div className="mb-4 rounded-md bg-green-50 p-3">
                <p className="text-sm text-green-800">{editSuccess}</p>
              </div>
            )}

            <div className="space-y-4">
              {/* Email (read-only) */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="text"
                  value={editingUser.email}
                  disabled
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-500 sm:text-sm"
                />
              </div>

              {/* Role */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Role</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as 'user' | 'admin')}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  disabled={editLoading}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              {/* New Password */}
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  New Password (leave blank to keep current)
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  disabled={editLoading}
                />
                <p className="mt-1 text-xs text-gray-500">Minimum 8 characters</p>
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={() => setEditingUser(null)}
                disabled={editLoading}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveUser}
                disabled={editLoading}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {editLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

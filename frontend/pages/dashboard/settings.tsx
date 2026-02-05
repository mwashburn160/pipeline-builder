import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';

export default function SettingsPage() {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading: authLoading, refreshUser } = useAuth();
  
  // Profile form state
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Password form state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Delete account state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    if (isInitialized && !authLoading && !isAuthenticated) {
      router.push('/auth/login');
    }
  }, [isAuthenticated, isInitialized, authLoading, router]);

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setEmail(user.email);
    }
  }, [user]);

  const handleProfileSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setProfileError(null);
    setProfileSuccess(null);
    setProfileLoading(true);

    try {
      const updates: { username?: string; email?: string } = {};
      if (username !== user?.username) updates.username = username;
      if (email !== user?.email) updates.email = email;

      if (Object.keys(updates).length === 0) {
        setProfileError('No changes to save');
        return;
      }

      await api.updateProfile(updates);
      await refreshUser();
      setProfileSuccess('Profile updated successfully');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setProfileLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }

    setPasswordLoading(true);

    try {
      await api.changePassword(currentPassword, newPassword);
      setPasswordSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleteLoading(true);
    try {
      await api.deleteAccount();
      router.push('/auth/login');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to delete account');
      setShowDeleteConfirm(false);
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!isInitialized || authLoading) {
    return <LoadingPage message="Loading..." />;
  }

  if (!isAuthenticated || !user) {
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
            <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-3xl mx-auto py-6 px-4 sm:px-6 lg:px-8 space-y-6">
        {/* Profile Settings */}
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Profile Settings</h2>
          
          <form onSubmit={handleProfileSubmit} className="space-y-4">
            {profileError && (
              <div className="rounded-md bg-red-50 p-3">
                <p className="text-sm text-red-800">{profileError}</p>
              </div>
            )}
            {profileSuccess && (
              <div className="rounded-md bg-green-50 p-3">
                <p className="text-sm text-green-800">{profileSuccess}</p>
              </div>
            )}

            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                disabled={profileLoading}
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                disabled={profileLoading}
              />
            </div>

            <button
              type="submit"
              disabled={profileLoading}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {profileLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
              Save Changes
            </button>
          </form>
        </div>

        {/* Change Password */}
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Change Password</h2>
          
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            {passwordError && (
              <div className="rounded-md bg-red-50 p-3">
                <p className="text-sm text-red-800">{passwordError}</p>
              </div>
            )}
            {passwordSuccess && (
              <div className="rounded-md bg-green-50 p-3">
                <p className="text-sm text-green-800">{passwordSuccess}</p>
              </div>
            )}

            <div>
              <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700">
                Current Password
              </label>
              <input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                disabled={passwordLoading}
              />
            </div>

            <div>
              <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700">
                New Password
              </label>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                disabled={passwordLoading}
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                Confirm New Password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                disabled={passwordLoading}
              />
            </div>

            <button
              type="submit"
              disabled={passwordLoading}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {passwordLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
              Change Password
            </button>
          </form>
        </div>

        {/* Danger Zone */}
        <div className="bg-white shadow rounded-lg p-6 border border-red-200">
          <h2 className="text-lg font-medium text-red-600 mb-4">Danger Zone</h2>
          
          {!showDeleteConfirm ? (
            <div>
              <p className="text-sm text-gray-600 mb-4">
                Once you delete your account, there is no going back. Please be certain.
              </p>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-4 py-2 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
              >
                Delete Account
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-red-600 font-medium">
                Are you absolutely sure you want to delete your account? This action cannot be undone.
              </p>
              <div className="flex space-x-3">
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleteLoading}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                >
                  {deleteLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                  Yes, Delete My Account
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={deleteLoading}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

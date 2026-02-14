import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import api from '@/lib/api';

export default function SettingsPage() {
  const { user, isReady, refreshUser } = useAuthGuard();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setEmail(user.email);
    }
  }, [user]);

  const handleProfileSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
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
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Failed to update profile');
    } finally {
      setProfileLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
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
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : 'Failed to change password');
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleteLoading(true);
    try {
      await api.deleteAccount();
      window.location.href = '/auth/login';
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Failed to delete account');
      setShowDeleteConfirm(false);
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="Settings" maxWidth="3xl">
      {/* Profile Settings */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="card mb-6"
      >
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Profile Settings</h2>

        <form onSubmit={handleProfileSubmit} className="space-y-4">
          {profileError && (
            <div className="alert-error"><p>{profileError}</p></div>
          )}
          {profileSuccess && (
            <div className="alert-success"><p>{profileSuccess}</p></div>
          )}

          <div>
            <label htmlFor="username" className="label">Username</label>
            <input id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="input" disabled={profileLoading} />
          </div>

          <div>
            <label htmlFor="email" className="label">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" disabled={profileLoading} />
          </div>

          <button type="submit" disabled={profileLoading} className="btn btn-primary">
            {profileLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
            Save Changes
          </button>
        </form>
      </motion.div>

      {/* Change Password */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="card mb-6"
      >
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Change Password</h2>

        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          {passwordError && (
            <div className="alert-error"><p>{passwordError}</p></div>
          )}
          {passwordSuccess && (
            <div className="alert-success"><p>{passwordSuccess}</p></div>
          )}

          <div>
            <label htmlFor="currentPassword" className="label">Current Password</label>
            <input id="currentPassword" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="input" disabled={passwordLoading} />
          </div>

          <div>
            <label htmlFor="newPassword" className="label">New Password</label>
            <input id="newPassword" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="input" disabled={passwordLoading} />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="label">Confirm New Password</label>
            <input id="confirmPassword" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="input" disabled={passwordLoading} />
          </div>

          <button type="submit" disabled={passwordLoading} className="btn btn-primary">
            {passwordLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
            Change Password
          </button>
        </form>
      </motion.div>

      {/* Danger Zone */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2 }}
        className="card border-red-200/60 dark:border-red-800/60"
      >
        <h2 className="text-lg font-medium text-red-600 dark:text-red-400 mb-4">Danger Zone</h2>

        {!showDeleteConfirm ? (
          <div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Once you delete your account, there is no going back. Please be certain.
            </p>
            <button onClick={() => setShowDeleteConfirm(true)} className="btn btn-danger">
              Delete Account
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-red-600 dark:text-red-400 font-medium">
              Are you absolutely sure you want to delete your account? This action cannot be undone.
            </p>
            <div className="flex space-x-3">
              <button onClick={handleDeleteAccount} disabled={deleteLoading} className="btn btn-danger">
                {deleteLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                Yes, Delete My Account
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} disabled={deleteLoading} className="btn btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </DashboardLayout>
  );
}

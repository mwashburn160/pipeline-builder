import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { isOrgAdmin, isSystemAdmin, type AIProviderStatus } from '@/types';
import { AI_PROVIDER_NAMES } from '@/lib/ai-constants';
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

  // AI provider state
  const [aiProviders, setAiProviders] = useState<Record<string, AIProviderStatus>>({});
  const [aiLoading, setAiLoading] = useState<Record<string, boolean>>({});
  const [aiSuccess, setAiSuccess] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  // Add/update provider form
  const [selectedProvider, setSelectedProvider] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  // Inline update for existing providers
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editApiKey, setEditApiKey] = useState('');

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setEmail(user.email);
    }
  }, [user]);

  // Fetch AI config on mount
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const response = await api.getOrgAIConfig();
        if (response.data?.providers) {
          setAiProviders(response.data.providers);
        }
      } catch {
        // Non-critical — user may not have an org
      }
    })();
  }, [user]);

  // Configured provider IDs
  const configuredIds = Object.entries(aiProviders)
    .filter(([, s]) => s.configured)
    .map(([id]) => id);

  // Unconfigured providers for the dropdown
  const availableProviders = Object.entries(AI_PROVIDER_NAMES)
    .filter(([id]) => !configuredIds.includes(id));

  const providerDisplayName = (id: string) => AI_PROVIDER_NAMES[id] || id;

  const handleAddProvider = async () => {
    const key = newApiKey.trim();
    if (!selectedProvider || !key) return;

    setAiError(null);
    setAiSuccess(null);
    setAddLoading(true);

    try {
      const response = await api.updateOrgAIConfig({ [selectedProvider]: key });
      if (response.data?.providers) {
        setAiProviders(response.data.providers);
      }
      setAiSuccess(`${providerDisplayName(selectedProvider)} added`);
      setSelectedProvider('');
      setNewApiKey('');
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'Failed to add provider');
    } finally {
      setAddLoading(false);
    }
  };

  const handleUpdateProvider = async (providerId: string) => {
    const key = editApiKey.trim();
    if (!key) return;

    setAiError(null);
    setAiSuccess(null);
    setAiLoading((prev) => ({ ...prev, [providerId]: true }));

    try {
      const response = await api.updateOrgAIConfig({ [providerId]: key });
      if (response.data?.providers) {
        setAiProviders(response.data.providers);
      }
      setAiSuccess(`${providerDisplayName(providerId)} API key updated`);
      setEditingProvider(null);
      setEditApiKey('');
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'Failed to update API key');
    } finally {
      setAiLoading((prev) => ({ ...prev, [providerId]: false }));
    }
  };

  const handleRemoveProvider = async (providerId: string) => {
    setAiError(null);
    setAiSuccess(null);
    setAiLoading((prev) => ({ ...prev, [providerId]: true }));

    try {
      const response = await api.updateOrgAIConfig({ [providerId]: null });
      if (response.data?.providers) {
        setAiProviders(response.data.providers);
      }
      setAiSuccess(`${providerDisplayName(providerId)} removed`);
      if (editingProvider === providerId) {
        setEditingProvider(null);
        setEditApiKey('');
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'Failed to remove provider');
    } finally {
      setAiLoading((prev) => ({ ...prev, [providerId]: false }));
    }
  };

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

      {/* AI Providers */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="card mb-6"
      >
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">AI Providers</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Configure API keys for AI-powered pipeline generation. Keys are stored at the organization level.
        </p>

        {aiError && <div className="alert-error mb-4"><p>{aiError}</p></div>}
        {aiSuccess && <div className="alert-success mb-4"><p>{aiSuccess}</p></div>}

        {/* Configured providers list */}
        {configuredIds.length > 0 && (
          <div className="space-y-3 mb-4">
            {configuredIds.map((id) => {
              const status = aiProviders[id];
              const loading = aiLoading[id] ?? false;
              const admin = isOrgAdmin(user) || isSystemAdmin(user);
              const isEditing = editingProvider === id;

              return (
                <div key={id} className="flex items-center gap-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {providerDisplayName(id)}
                      </span>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                        Configured
                      </span>
                      {status?.hint && (
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          Key: {status.hint}
                        </span>
                      )}
                    </div>
                    {admin && isEditing ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={editApiKey}
                          onChange={(e) => setEditApiKey(e.target.value)}
                          placeholder="Enter new API key"
                          className="input text-sm flex-1"
                          disabled={loading}
                        />
                        <button
                          onClick={() => handleUpdateProvider(id)}
                          disabled={loading || !editApiKey.trim()}
                          className="btn btn-primary text-sm"
                        >
                          {loading ? <LoadingSpinner size="sm" /> : 'Save'}
                        </button>
                        <button
                          onClick={() => { setEditingProvider(null); setEditApiKey(''); }}
                          disabled={loading}
                          className="btn btn-secondary text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : admin ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => { setEditingProvider(id); setEditApiKey(''); }}
                          className="btn btn-secondary text-sm"
                        >
                          Update
                        </button>
                        <button
                          onClick={() => handleRemoveProvider(id)}
                          disabled={loading}
                          className="btn btn-danger text-sm"
                        >
                          {loading ? <LoadingSpinner size="sm" /> : 'Remove'}
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Key ending in {status?.hint}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {configuredIds.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 mb-4">No AI providers configured yet.</p>
        )}

        {/* Add new provider — admin only */}
        {(isOrgAdmin(user) || isSystemAdmin(user)) && availableProviders.length > 0 && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Add Provider</h3>
            <div className="flex items-end gap-3">
              <div className="flex-shrink-0">
                <label htmlFor="ai-provider-select" className="label text-xs">Provider</label>
                <select
                  id="ai-provider-select"
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                  className="input text-sm"
                  disabled={addLoading}
                >
                  <option value="">Select provider...</option>
                  {availableProviders.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label htmlFor="ai-api-key" className="label text-xs">API Key</label>
                <input
                  id="ai-api-key"
                  type="password"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="Enter API key"
                  className="input text-sm"
                  disabled={addLoading || !selectedProvider}
                />
              </div>
              <button
                onClick={handleAddProvider}
                disabled={addLoading || !selectedProvider || !newApiKey.trim()}
                className="btn btn-primary text-sm"
              >
                {addLoading ? <LoadingSpinner size="sm" /> : 'Add'}
              </button>
            </div>
          </div>
        )}
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

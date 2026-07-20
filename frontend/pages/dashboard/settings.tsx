import { useEffect, useState } from 'react';
import { formatError } from '@/lib/constants';
import { motion } from 'framer-motion';
import { CheckCircle, MailWarning } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { AIProviderConfig } from '@/components/settings/AIProviderConfig';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import Link from 'next/link';
import api from '@/lib/api';
import { decodeJwt } from '@/lib/jwt';

/** User and organization settings page. Manages profile info, AI provider API keys, password changes, and account deletion. */
export default function SettingsPage() {
  const { user, isReady, refreshUser, can } = useAuthGuard();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const profile = useFormState();

  // Email-verification resend (surfaced next to the Unverified state below).
  const verify = useFormState();
  const handleResendVerification = async () => {
    await verify.run(
      () => api.sendVerificationEmail(),
      { successMessage: 'Verification email sent — check your inbox for the link.' },
    );
  };

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const password = useFormState();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  // Step-up gate state: when set, StepUpModal renders and on success
  // performs the gated action with the returned token.
  const [pendingDelete, setPendingDelete] = useState(false);

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setEmail(user.email);
    }
  }, [user]);

  const handleProfileSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const updates: { username?: string; email?: string } = {};
    if (username !== user?.username) updates.username = username;
    if (email !== user?.email) updates.email = email;

    if (Object.keys(updates).length === 0) {
      profile.setError('No changes to save');
      return;
    }

    const result = await profile.run(
      () => api.updateProfile(updates),
      { successMessage: 'Profile updated successfully' },
    );
    if (result !== null) await refreshUser();
  };

  const handlePasswordSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      password.setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      password.setError('New password must be at least 8 characters');
      return;
    }

    const result = await password.run(
      () => api.changePassword(currentPassword, newPassword),
      { successMessage: 'Password changed successfully' },
    );
    if (result !== null) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    }
  };

  // Click-through path: DeleteConfirm → StepUp → executeDelete.
  const handleDeleteAccount = () => {
    setShowDeleteConfirm(false);
    setPendingDelete(true);
  };

  const executeDelete = async (stepUpToken: string) => {
    setDeleteLoading(true);
    try {
      await api.deleteAccount(stepUpToken);
      window.location.href = '/';
    } catch (err) {
      profile.setError(formatError(err, 'Failed to delete account'));
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="Settings" subtitle="Account preferences and defaults">
      <div className="page-section">
        {/* Profile Settings */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="card mb-6"
        >
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Profile Settings</h2>

          <form onSubmit={handleProfileSubmit} className="space-y-4">
            <ErrorAlert message={profile.error} />
            <SuccessAlert message={profile.success} />

            <div>
              <label htmlFor="username" className="label">Username</label>
              <Input id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} disabled={profile.loading} />
            </div>

            <div>
              <label htmlFor="email" className="label">Email</label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={profile.loading} />
              {user.isEmailVerified ? (
                <p className="mt-1.5 text-xs text-green-600 dark:text-green-400 inline-flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" /> Email verified
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
                  <span className="inline-flex items-center gap-1.5">
                    <MailWarning className="w-4 h-4 shrink-0" /> Your email address is unverified.
                  </span>
                  <Button type="button" variant="secondary" size="sm" loading={verify.loading} onClick={handleResendVerification}>
                    Resend verification email
                  </Button>
                </div>
              )}
              {verify.error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{verify.error}</p>}
              {verify.success && <p className="mt-1.5 text-xs text-green-600 dark:text-green-400">{verify.success}</p>}
            </div>

            <SessionStartedRow />

            <Button type="submit" loading={profile.loading}>
              Save Changes
            </Button>
          </form>
        </motion.div>

        {/* Organization Identity (owner/admin self-serve) */}
        {can('org:settings') && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.04 }}
            className="card mb-6"
          >
            <OrgIdentitySettings onSaved={refreshUser} />
          </motion.div>
        )}

        {/* AI Providers */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
          className="card mb-6"
        >
          <AIProviderConfig canEdit={can('org:settings')} />
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
            <ErrorAlert message={password.error} />
            <SuccessAlert message={password.success} />

            <div>
              <label htmlFor="currentPassword" className="label">Current Password</label>
              <Input id="currentPassword" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} disabled={password.loading} />
            </div>

            <div>
              <label htmlFor="newPassword" className="label">New Password</label>
              <Input id="newPassword" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={password.loading} />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="label">Confirm New Password</label>
              <Input id="confirmPassword" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={password.loading} />
            </div>

            <Button type="submit" loading={password.loading}>
              Change Password
            </Button>
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
              <Button variant="danger" onClick={() => setShowDeleteConfirm(true)}>
                Delete Account
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-red-600 dark:text-red-400 font-medium">
                Are you absolutely sure you want to delete your account? This action cannot be undone.
              </p>
              <div className="flex space-x-3">
                <Button variant="danger" onClick={handleDeleteAccount} loading={deleteLoading}>
                  Yes, Delete My Account
                </Button>
                <Button variant="secondary" onClick={() => setShowDeleteConfirm(false)} disabled={deleteLoading}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {pendingDelete && (
        <StepUpModal
          action="Delete your account (this cannot be undone)"
          onConfirmed={executeDelete}
          onClose={() => setPendingDelete(false)}
        />
      )}
    </DashboardLayout>
  );
}

/**
 * Organization identity (name + URL slug) editor for owners/admins.
 *
 * Gated by the caller on `can('org:settings')` (the same capability the backend
 * requires); the backend additionally enforces that the caller administers the
 * target org. Loads the current org via GET /organization, saves via
 * PATCH /organization/:id/identity, and refreshes the auth profile on success so
 * a renamed org is reflected across the shell.
 */
function OrgIdentitySettings({ onSaved }: { onSaved: () => Promise<void> }) {
  const form = useFormState();
  const [loaded, setLoaded] = useState(false);
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [initial, setInitial] = useState<{ name: string; slug: string }>({ name: '', slug: '' });

  useEffect(() => {
    let active = true;
    api.getMyOrganization()
      .then((res) => {
        if (!active) return;
        const org = res.data?.organization;
        if (org) {
          setOrgId(org.id);
          setName(org.name ?? '');
          setSlug(org.slug ?? '');
          setInitial({ name: org.name ?? '', slug: org.slug ?? '' });
        }
      })
      .catch(() => { /* surfaced on save attempt */ })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const updates: { name?: string; slug?: string } = {};
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim().toLowerCase();
    if (trimmedName !== initial.name) updates.name = trimmedName;
    if (trimmedSlug !== initial.slug) updates.slug = trimmedSlug;

    if (Object.keys(updates).length === 0) {
      form.setError('No changes to save');
      return;
    }
    if (updates.name !== undefined && updates.name.length < 2) {
      form.setError('Organization name must be at least 2 characters');
      return;
    }
    if (updates.slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(updates.slug)) {
      form.setError('Slug may contain only lowercase letters, numbers, and single hyphens');
      return;
    }

    const result = await form.run(
      () => api.updateOrganizationIdentity(orgId, updates),
      { successMessage: 'Organization updated successfully' },
    );
    if (result !== null) {
      const org = result.data?.organization;
      if (org) {
        setName(org.name);
        setSlug(org.slug);
        setInitial({ name: org.name, slug: org.slug });
      }
      await onSaved();
    }
  };

  return (
    <>
      <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Organization</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <ErrorAlert message={form.error} />
        <SuccessAlert message={form.success} />

        <div>
          <label htmlFor="org-name" className="label">Organization name</label>
          <Input id="org-name" type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={!loaded || form.loading} />
        </div>

        <div>
          <label htmlFor="org-slug" className="label">URL slug</label>
          <Input id="org-slug" type="text" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!loaded || form.loading} placeholder="my-organization" />
          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">Lowercase letters, numbers, and hyphens. Must be unique.</p>
        </div>

        <Button type="submit" loading={form.loading} disabled={!loaded}>
          Save Organization
        </Button>
      </form>
    </>
  );
}

/**
 * Surfaces "this session started X ago" + a link to the sessions panel.
 * Sourced from the current access token's `iat` claim — no backend
 * round trip needed, and the value matches what /tokens shows for the
 * active token.
 */
function SessionStartedRow() {
  const accessToken = api.getAccessToken();
  if (!accessToken) return null;
  const decoded = decodeJwt(accessToken);
  const iat = decoded?.payload && typeof (decoded.payload as { iat?: number }).iat === 'number'
    ? (decoded.payload as { iat: number }).iat
    : null;
  if (iat === null) return null;
  const issuedAt = iat * 1000;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-3 py-2 text-xs text-gray-600 dark:text-gray-400 flex items-center justify-between gap-2">
      <span>
        Current session started{' '}
        <strong className="text-gray-800 dark:text-gray-200">
          <RelativeTime value={issuedAt} live />
        </strong>
        . If this looks wrong, sign out everywhere from{' '}
        <Link href="/dashboard/tokens" className="action-link">Sessions &amp; tokens</Link>.
      </span>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { formatError } from '@/lib/constants';
import { CheckCircle, MailWarning, User, Building2, Lock, Trash2, Clock } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFormState } from '@/hooks/useFormState';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { TabBar } from '@/components/ui/TabBar';
import { SectionCard } from '@/components/ui/SectionCard';
import { FormSection } from '@/components/ui/FormSection';
import { FormField } from '@/components/ui/FormField';
import { Callout } from '@/components/ui/Callout';
import { RetryError } from '@/components/ui/RetryError';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { AIProviderConfig } from '@/components/settings/AIProviderConfig';
import { DomainJoinSettings } from '@/components/settings/DomainJoinSettings';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import Link from 'next/link';
import { useRouter } from 'next/router';
import api from '@/lib/api';
import { decodeJwt } from '@/lib/jwt';

// Settings is split into major tabs so account, org, and security controls don't
// stack into one long scroll. Each is deep-linkable via `?tab=`.
const SETTINGS_TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'organization', label: 'Organization' },
  { id: 'security', label: 'Security' },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];
const SETTINGS_TAB_IDS = SETTINGS_TABS.map((t) => t.id) as readonly string[];

/** User and organization settings page. Manages profile info, AI provider API keys, password changes, and account deletion. */
export default function SettingsPage() {
  const { user, isReady, refreshUser, can, isSuperAdmin, isReadOnly } = useAuthGuard();
  const router = useRouter();

  // Active tab, hydrated from `?tab=` and kept in sync (shallow) so it's
  // shareable / back-forward-friendly — same pattern as the Billing page.
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
  useEffect(() => {
    const raw = Array.isArray(router.query.tab) ? router.query.tab[0] : router.query.tab;
    if (raw && SETTINGS_TAB_IDS.includes(raw) && raw !== activeTab) setActiveTab(raw as SettingsTab);
  }, [router.query.tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeTab = (id: string) => {
    setActiveTab(id as SettingsTab);
    void router.replace({ query: { ...router.query, tab: id } }, undefined, { shallow: true });
  };

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

  // Superadmins can mark their email verified directly (no emailed link) — a
  // no-outbound-email operator convenience. The backend gates this to superadmin
  // ONLY (an admin/owner gate was insecure: every user owns their personal org,
  // so it reduced to "anyone can self-verify" — the domain-join trust hole).
  // `!isReadOnly` hides it under read-only impersonation (the POST would 403).
  const canMarkVerified = isSuperAdmin && !isReadOnly;
  const markVerify = useFormState();
  const handleMarkVerified = async () => {
    await markVerify.run(
      async () => {
        const res = await api.markEmailVerified();
        await refreshUser(); // flips the banner to the verified state
        return res;
      },
      { successMessage: 'Email marked verified.' },
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

  const handleProfileSubmit = async (e: React.FormEvent) => {
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

  const handlePasswordSubmit = async (e: React.FormEvent) => {
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
      <div className="space-y-6">
        <TabBar items={[...SETTINGS_TABS]} activeId={activeTab} onSelect={changeTab} />

        {activeTab === 'profile' && (
        /* Profile */
        <FormSection
          icon={User}
          title="Profile"
          description="Your display name and sign-in email."
          error={profile.error}
          success={profile.success}
          onSubmit={handleProfileSubmit}
          submitLabel="Save changes"
          submitLoading={profile.loading}
        >
          <FormField label="Username">
            <Input type="text" value={username} onChange={(e) => setUsername(e.target.value)} disabled={profile.loading} />
          </FormField>

          <FormField label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={profile.loading} />
          </FormField>

          {user.isEmailVerified ? (
            <Callout variant="success" icon={CheckCircle}>Your email address is verified.</Callout>
          ) : (
            <Callout variant="warning" icon={MailWarning} title="Your email address is unverified">
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {canMarkVerified && (
                  <Button type="button" variant="secondary" size="sm" loading={markVerify.loading} onClick={handleMarkVerified}>
                    Mark as verified
                  </Button>
                )}
                <Button type="button" variant="secondary" size="sm" loading={verify.loading} onClick={handleResendVerification}>
                  Resend verification email
                </Button>
              </div>
            </Callout>
          )}
          {verify.error && <p className="text-xs text-[var(--pb-danger)]">{verify.error}</p>}
          {verify.success && <p className="text-xs text-[var(--pb-success)]">{verify.success}</p>}
          {markVerify.error && <p className="text-xs text-[var(--pb-danger)]">{markVerify.error}</p>}
          {markVerify.success && <p className="text-xs text-[var(--pb-success)]">{markVerify.success}</p>}

          <SessionStartedRow />
        </FormSection>
        )}

        {activeTab === 'organization' && (
          <div className="space-y-6">
            {/* Organization Identity (owner/admin self-serve) */}
            {can('org:settings') && <OrgIdentitySettings onSaved={refreshUser} />}

            {/* Domain-based join (owner/admin self-serve) */}
            {can('org:settings') && user.organizationId && (
              <DomainJoinSettings orgId={user.organizationId} />
            )}

            {/* AI Providers */}
            <AIProviderConfig canEdit={can('org:settings')} />
          </div>
        )}

        {activeTab === 'security' && (
          <div className="space-y-6">
        {/* Change Password */}
        <FormSection
          icon={Lock}
          title="Password"
          description="Change the password you use to sign in."
          error={password.error}
          success={password.success}
          onSubmit={handlePasswordSubmit}
          submitLabel="Change password"
          submitLoading={password.loading}
        >
          <FormField label="Current password">
            <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} disabled={password.loading} />
          </FormField>
          <FormField label="New password" hint="At least 8 characters.">
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={password.loading} />
          </FormField>
          <FormField label="Confirm new password">
            <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={password.loading} />
          </FormField>
        </FormSection>

        {/* Danger Zone */}
        <SectionCard
          icon={Trash2}
          title="Delete account"
          description="Permanently delete your account and all associated data. This cannot be undone."
          className="border-[var(--pb-danger)]/40"
        >
          <Button variant="danger" onClick={() => setShowDeleteConfirm(true)}>
            Delete account
          </Button>
        </SectionCard>
          </div>
        )}
      </div>

      {showDeleteConfirm && (
        <DeleteConfirmModal
          title="Delete account"
          itemName="your account"
          loading={deleteLoading}
          onConfirm={handleDeleteAccount}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

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
  // Set when the initial org fetch fails, so the user gets an explicit error +
  // retry instead of a silently-blank form they'd edit blindly (and only find out
  // it failed on save).
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadOrg = useCallback(async () => {
    setLoadError(null);
    setLoaded(false);
    try {
      const res = await api.getMyOrganization();
      const org = res.data?.organization;
      if (org) {
        setOrgId(org.id);
        setName(org.name ?? '');
        setSlug(org.slug ?? '');
        setInitial({ name: org.name ?? '', slug: org.slug ?? '' });
      } else {
        setLoadError('Could not load your organization settings.');
      }
    } catch (e) {
      setLoadError(formatError(e, 'Could not load your organization settings.'));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void loadOrg(); }, [loadOrg]);

  const handleSubmit = async (e: React.FormEvent) => {
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

  if (loadError) {
    return (
      <SectionCard icon={Building2} title="Organization">
        <RetryError message={loadError} onRetry={() => void loadOrg()} />
      </SectionCard>
    );
  }

  return (
    <FormSection
      icon={Building2}
      title="Organization"
      description="Your organization's display name and URL slug."
      error={form.error}
      success={form.success}
      onSubmit={handleSubmit}
      submitLabel="Save organization"
      submitLoading={form.loading}
      submitDisabled={!loaded}
    >
      <FormField label="Organization name">
        <Input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={!loaded || form.loading} />
      </FormField>
      <FormField label="URL slug" hint="Lowercase letters, numbers, and hyphens. Must be unique.">
        <Input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!loaded || form.loading} placeholder="my-organization" />
      </FormField>
    </FormSection>
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
    <Callout variant="neutral" icon={Clock}>
      Current session started{' '}
      <strong className="text-[var(--pb-text)]">
        <RelativeTime value={issuedAt} live />
      </strong>
      . If this looks wrong, sign out everywhere from{' '}
      <Link href="/dashboard/tokens" className="action-link">Sessions &amp; tokens</Link>.
    </Callout>
  );
}

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { formatError } from '@/lib/constants';
import { CheckCircle, MailWarning, User, Building2, Trash2, Clock } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
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
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { Input } from '@/components/ui/Input';
import { AIProviderConfig } from '@/components/settings/AIProviderConfig';
import { DomainJoinSettings } from '@/components/settings/DomainJoinSettings';
import { DOMAIN_SETTINGS_ANCHOR } from '@/components/sso/VerifiedDomainPicker';
import { ImpersonationPolicySettings } from '@/components/settings/ImpersonationPolicySettings';
import { MfaPolicySettings } from '@/components/settings/MfaPolicySettings';
import { PasswordPolicySettings } from '@/components/settings/PasswordPolicySettings';
import { AuthenticatorPolicySettings } from '@/components/settings/AuthenticatorPolicySettings';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import Link from 'next/link';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { decodeJwt } from '@/lib/jwt';
import { useUrlTab } from '@/hooks/useUrlTab';
import { SECURITY_HREF, SESSIONS_HREF } from '@/lib/security-links';

// Account settings: who you are, and what your organization is configured to do.
// Each tab is deep-linkable via `?tab=`.
//
// SIGN-IN CREDENTIALS ARE NOT HERE. Password, passkeys, authenticator app,
// sessions and keys moved to /dashboard/security, which is one page for all of
// them instead of three that pointed at each other; `?tab=security` forwards
// there (fragment included), so old links and prompts still land.
const SETTINGS_TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'organization', label: 'Organization' },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];
const SETTINGS_TAB_IDS = SETTINGS_TABS.map((t) => t.id) as readonly string[];

/** User and organization settings page. Manages profile info, org identity and
 *  policy, AI provider API keys, and account deletion. */
export default function SettingsPage() {
  const { user, isReady, refreshUser, can, isSuperAdmin, isReadOnly } = useAuthGuard();
  const router = useRouter();

  // `?tab=security` was where factors and sessions used to live. Forward it —
  // with whatever section the link named — so every bookmark, banner and
  // enrolment prompt written against the old address still arrives.
  const movedToSecurity = router.isReady && router.query.tab === 'security';
  useEffect(() => {
    if (!movedToSecurity) return;
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    void router.replace(`${SECURITY_HREF}?tab=factors${hash}`);
  }, [movedToSecurity, router]);

  // Active tab, hydrated from `?tab=` and kept in sync (shallow) so it's
  // shareable / back-forward-friendly — same pattern as the Billing page.
  // Tab state lives in `?tab=` so the view is shareable, refresh-safe and
  // back/forward-friendly. `useUrlTab` owns the hydrate + shallow write-back.
  // `#email-domains` names the card SSO setup sends admins to (verify a domain).
  // Registering it here makes the fragment carry its own tab, so the link works
  // with or without `?tab=organization`, and `useUrlTab` does the scroll once the
  // card has actually rendered.
  const [activeTab, changeTab] = useUrlTab<SettingsTab>(
    'tab',
    SETTINGS_TAB_IDS as readonly SettingsTab[],
    'profile',
    { hashTabs: { [DOMAIN_SETTINGS_ANCHOR]: 'organization' } },
  );

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

  // Step-up gate state: when set, StepUpModal renders — it is BOTH the
  // confirmation and the gate — and on success deletes the account.
  const [pendingDelete, setPendingDelete] = useState(false);

  // Seed the form once per signed-in user — NOT on every profile refresh, which
  // would overwrite whatever the user is typing.
  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setEmail(user.email);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed the form once per signed-in user, not on every profile refresh
  }, [user?.id]);

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

  const executeDelete = async (stepUpToken: string) => {
    try {
      await api.deleteAccount(stepUpToken);
      window.location.href = '/';
    } catch (err) {
      profile.setError(formatError(err, 'Failed to delete account'));
    }
  };

  if (!isReady || !user || movedToSecurity) return <LoadingPage />;

  return (
    <DashboardLayout title="Settings" subtitle="Account preferences and defaults">
      <div className="space-y-6">
        <TabBar items={[...SETTINGS_TABS]} activeId={activeTab} onSelect={(id) => changeTab(id as SettingsTab)} />
        {/* Profile writes are the viewer's OWN account, which isn't
            capability-gated (so `can()` doesn't catch them) — gate on `isReadOnly`. */}
        <ReadOnlyNotice show={isReadOnly && activeTab === 'profile'} />

        {activeTab === 'profile' && (
        <div className="space-y-6">
        {/* Profile */}
        <FormSection
          icon={User}
          title="Profile"
          description="Your display name and sign-in email."
          error={profile.error}
          success={profile.success}
          onSubmit={handleProfileSubmit}
          submitLabel="Save changes"
          submitLoading={profile.loading}
          submitDisabled={isReadOnly}
        >
          <FormField label="Username">
            <Input type="text" value={username} onChange={(e) => setUsername(e.target.value)} disabled={profile.loading || isReadOnly} />
          </FormField>

          <FormField label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={profile.loading || isReadOnly} />
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
                <Button type="button" variant="secondary" size="sm" loading={verify.loading} onClick={handleResendVerification} readOnly={isReadOnly}>
                  Resend verification email
                </Button>
              </div>
            </Callout>
          )}
          {verify.error && <p className="text-xs text-danger">{verify.error}</p>}
          {verify.success && <p className="text-xs text-success">{verify.success}</p>}
          {markVerify.error && <p className="text-xs text-danger">{markVerify.error}</p>}
          {markVerify.success && <p className="text-xs text-success">{markVerify.success}</p>}

          <SessionStartedRow />
        </FormSection>

        {/* Danger Zone. It sits with the account it deletes, not with the
            sign-in factors — those are on the Security page now. */}
        <SectionCard
          icon={Trash2}
          title="Delete account"
          description="Permanently delete your account and all associated data. This cannot be undone."
          className="border-danger/40"
        >
          <Button variant="danger" onClick={() => setPendingDelete(true)} readOnly={isReadOnly}>
            Delete account
          </Button>
        </SectionCard>
        </div>
        )}

        {activeTab === 'organization' && (
          <div className="space-y-6">
            {/* Organization Identity (owner/admin self-serve) */}
            {can('org:settings') && <OrgIdentitySettings onSaved={refreshUser} />}

            {/* Email domains: DNS verification (what single sign-on serves) +
                domain-based join (owner/admin self-serve). The SSO wizard deep
                links here — see DOMAIN_SETTINGS_ANCHOR. */}
            {can('org:settings') && user.organizationId && (
              <DomainJoinSettings orgId={user.organizationId} />
            )}

            {/* Administrator access (impersonation policy). Mounted in the same
                change that ENFORCES it — never shown while it controlled nothing.
                Its own capability, `org:impersonation`, not org:settings, so a role
                that manages general settings can't also open the org to impersonation. */}
            {can('org:impersonation') && user.organizationId && (
              <ImpersonationPolicySettings orgId={user.organizationId} readOnly={isReadOnly} />
            )}

            {/* Two-factor requirement (#8). Same capability as the other org
                security settings; the WRITE is step-up gated server-side because
                turning it OFF removes a control for every member. */}
            {can('org:settings') && user.organizationId && (
              <MfaPolicySettings orgId={user.organizationId} readOnly={isReadOnly} />
            )}

            {/* Security policy: password minimum + approved authenticator models.
                Same capability as the two-factor requirement; both writes are
                step-up gated server-side, and LOOSENING either also needs a
                session opened with a second factor. */}
            {can('org:settings') && user.organizationId && (
              <PasswordPolicySettings orgId={user.organizationId} readOnly={isReadOnly} />
            )}
            {can('org:settings') && user.organizationId && (
              <AuthenticatorPolicySettings orgId={user.organizationId} readOnly={isReadOnly} />
            )}

            {/* AI Providers */}
            <AIProviderConfig canEdit={can('org:settings')} />
          </div>
        )}

      </div>

      {/* Deleting the account is destructive AND step-up gated, so it is ONE
          dialog that states what goes and takes the factor — the rule the whole
          app now follows, rather than a confirm modal in front of a step-up. */}
      {pendingDelete && (
        <StepUpModal
          title="Delete your account?"
          action="Delete this account and everything in it"
          details={(
            <>
              <p>
                Your account, its organizations where you are the only owner, and everything they
                contain are removed. Anything authenticating as you stops working.
              </p>
              <p className="text-danger">This cannot be undone.</p>
            </>
          )}
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
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [initial, setInitial] = useState<{ name: string; slug: string }>({ name: '', slug: '' });

  // A failed read shows an explicit error + retry instead of a silently-blank
  // form the user would edit blindly (and only find out it failed on save).
  const org = useFetch(async (signal) => {
    const res = await api.getMyOrganization({ signal });
    if (!res.data?.organization) throw new Error('Could not load your organization settings.');
    return res.data.organization;
  }, []);
  const loaded = !!org.data;

  useEffect(() => {
    if (!org.data) return;
    setOrgId(org.data.id);
    setName(org.data.name ?? '');
    setSlug(org.data.slug ?? '');
    setInitial({ name: org.data.name ?? '', slug: org.data.slug ?? '' });
  }, [org.data]);

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
      // The org switcher and every org list read the name through the shared
      // cache, so they keep the old one until it is dropped.
      invalidate.organizations();
      await onSaved();
    }
  };

  if (org.error) {
    return (
      <SectionCard icon={Building2} title="Organization">
        <RetryError message={formatError(org.error, 'Could not load your organization settings.')} onRetry={org.refetch} />
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
 * round trip needed, and the value matches what Security → Sessions shows
 * for the active token.
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
      <strong className="text-fg">
        <RelativeTime value={issuedAt} live />
      </strong>
      . If this looks wrong, sign out everywhere from{' '}
      <Link href={SESSIONS_HREF} className="action-link">Security → Sessions</Link>.
    </Callout>
  );
}

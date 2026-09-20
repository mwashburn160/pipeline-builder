// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SECURITY — one home for everything that can sign in as you or as this org.
 *
 * It replaces four surfaces that each held part of the answer and pointed at
 * each other for the rest: Settings → Security (password, passkeys,
 * authenticator, sessions), "API Tokens" (access keys, a SECOND sessions list,
 * the decoded current token), Settings → Service Accounts, and the enrolment
 * links that sent people to a tab called "Profile". Two of those pages literally
 * told the reader the other one was the real place.
 *
 * Four sub-tabs, each a complete answer to one question:
 *   - Factors — how I prove it's me (password, passkeys, authenticator app);
 *   - Sessions — where I'm signed in, and what to kill;
 *   - Access keys — the long-lived credentials my machines use: minting a
 *     machine token (lifetime + optional capability scope), the history of the
 *     tokens I've been issued, and my access keys;
 *   - Service accounts — the org's machine identities (permission-gated).
 *
 * Old URLs still work: /dashboard/tokens and /dashboard/settings/service-accounts
 * redirect here, and /dashboard/settings?tab=security does too. That is a page
 * moving, not a compatibility layer — nothing keeps the old behaviour alive.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, History, KeyRound, Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import { useUrlTab } from '@/hooks/useUrlTab';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { TabBar } from '@/components/ui/TabBar';
import { SectionCard } from '@/components/ui/SectionCard';
import { FormSection } from '@/components/ui/FormSection';
import { FormField } from '@/components/ui/FormField';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { CopyButton } from '@/components/ui/CopyButton';
import { DescriptionList, type DescriptionItem } from '@/components/ui/DescriptionList';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { Select } from '@/components/ui/Select';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { SecretReveal } from '@/components/ui/SecretReveal';
import { SecurityPostureStrip } from '@/components/security/SecurityPostureStrip';
import { AccessKeysSection } from '@/components/settings/AccessKeysSection';
import { MfaPromptPreference } from '@/components/settings/MfaPromptPreference';
import { PasskeySection } from '@/components/settings/PasskeySection';
import { ServiceAccountsSection } from '@/components/settings/ServiceAccountsSection';
import { SessionsSection } from '@/components/settings/SessionsSection';
import { TotpSection } from '@/components/settings/TotpSection';
import { MAX_CREDENTIAL_DAYS, TOKEN_SCOPE_OPTIONS, readOnlyPreset, type PermissionMode } from '@/components/settings/token-scopes';
import { TokenPermissionPicker, permissionsForRequest } from '@/components/settings/TokenPermissionPicker';
import { StepUpModal } from '@/components/admin/StepUpModal';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import type { TokenHistoryEntry } from '@/lib/api/domains/auth';
import { decodeJwt, formatTimestamp, isExpired, expiresIn } from '@/lib/jwt';
import { redactString, redactDetails } from '@/lib/redact';
import { SECURITY_HASH_TABS, SECURITY_TABS, SECURITY_TAB_IDS, type SecurityTab } from '@/lib/security-links';

/** An anchored section: `#passkeys` and friends land (and focus) here. */
function Anchor({ id, children }: { id: string; children: React.ReactNode }) {
  // `tabIndex={-1}` makes it a focus target, so a deep link moves the keyboard
  // caret to the section rather than only the viewport. `scroll-mt-20` keeps the
  // heading clear of the sticky top bar.
  return (
    <div id={id} tabIndex={-1} className="scroll-mt-20 focus:outline-none">
      {children}
    </div>
  );
}

export default function SecurityPage() {
  const { user, isReady, isReadOnly, can, refreshUser } = useAuthGuard();
  const [activeTab, changeTab] = useUrlTab<SecurityTab>(
    'tab', SECURITY_TAB_IDS, 'factors', { hashTabs: SECURITY_HASH_TABS },
  );

  const canManageServiceAccounts = can('service_accounts:manage');
  // The org's machine identities are a different authority from your own
  // credentials, so the tab only exists for someone who holds it (the API
  // enforces the same permission).
  const tabs = useMemo(
    () => SECURITY_TABS.filter((t) => t.id !== 'service-accounts' || canManageServiceAccounts),
    [canManageServiceAccounts],
  );

  if (!isReady || !user) return <LoadingPage />;

  const orgId = user.organizationId;

  return (
    <DashboardLayout
      title="Security"
      subtitle="Sign-in factors, sessions, and the keys your machines use"
      titleExtra={<ShieldCheck className="w-5 h-5 text-brand" />}
    >
      <div className="space-y-6">
        {/* Posture at a glance — each item links to the tab that changes it. */}
        <SecurityPostureStrip user={user} />
        <TabBar items={[...tabs]} activeId={activeTab} onSelect={(id) => changeTab(id as SecurityTab)} />
        {/* Everything here is a write the backend's read-only guard rejects
            during impersonation, on every tab — including the org's service
            accounts, which had no notice at all before. */}
        <ReadOnlyNotice show={isReadOnly} />

        {activeTab === 'factors' && (
          <div className="space-y-6">
            <Anchor id="password"><PasswordSection readOnly={isReadOnly} /></Anchor>
            <Anchor id="passkeys"><PasskeySection readOnly={isReadOnly} /></Anchor>
            <Anchor id="totp"><TotpSection readOnly={isReadOnly} /></Anchor>
            {/* Only rendered while a "not now" / "don't ask again" is actually
                in force, and it is what makes that choice reversible by the
                person who made it. Last, because it is about the REMINDER, not
                about a factor — the sections above are the account's real
                two-factor state, and nothing here changes it. */}
            <MfaPromptPreference nudge={user.mfaNudge} readOnly={isReadOnly} onChanged={() => refreshUser({ force: true })} />
          </div>
        )}

        {activeTab === 'sessions' && (
          <div className="space-y-6">
            <Anchor id="devices"><SessionsSection readOnly={isReadOnly} /></Anchor>
            <Anchor id="current-token"><CurrentTokenSection /></Anchor>
          </div>
        )}

        {activeTab === 'keys' && (
          <div className="space-y-6">
            <MachineTokenSection readOnly={isReadOnly} held={user?.permissions ?? []} />
            <Anchor id="token-history"><TokenHistorySection /></Anchor>
            <Anchor id="access-keys"><AccessKeysSection readOnly={isReadOnly} /></Anchor>
          </div>
        )}

        {activeTab === 'service-accounts' && (
          canManageServiceAccounts && orgId ? (
            <Anchor id="service-accounts">
              <ServiceAccountsSection orgId={orgId} readOnly={isReadOnly} />
            </Anchor>
          ) : (
            <Callout variant="warning" title="Service accounts are managed by an administrator">
              They belong to the organization rather than to you, so changing them needs the
              service-account permission. Your own credentials are on the other tabs.
            </Callout>
          )
        )}
      </div>
    </DashboardLayout>
  );
}

/**
 * Change the sign-in password.
 *
 * The backend step-up gates it — changing the password on a session someone left
 * open is precisely the takeover step-up exists to stop — so this confirms in
 * ONE dialog that both states the consequence and takes the factor, rather than
 * posting blind and letting the 401 produce a dialog after the fact.
 */
function PasswordSection({ readOnly }: { readOnly: boolean }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const form = useFormState();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      form.setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      form.setError('New password must be at least 8 characters');
      return;
    }
    setConfirming(true);
  };

  const execute = async (stepUpToken: string) => {
    setConfirming(false);
    const result = await form.run(
      () => api.changePassword(currentPassword, newPassword, stepUpToken),
      { successMessage: 'Password changed successfully' },
    );
    if (result !== null) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    }
  };

  return (
    <>
      <FormSection
        icon={Lock}
        title="Password"
        description="Change the password you use to sign in."
        error={form.error}
        success={form.success}
        onSubmit={handleSubmit}
        submitLabel="Change password"
        submitLoading={form.loading}
        submitDisabled={readOnly}
      >
        <FormField label="Current password">
          <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} disabled={form.loading || readOnly} />
        </FormField>
        <FormField label="New password" hint="At least 8 characters.">
          <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={form.loading || readOnly} />
        </FormField>
        <FormField label="Confirm new password">
          <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={form.loading || readOnly} />
        </FormField>
      </FormSection>

      {confirming && (
        <StepUpModal
          title="Change your password?"
          action="Change the password on this account"
          details={<p>Other sessions keep working; anything that stores the old password stops.</p>}
          onConfirmed={execute}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** Lifetime presets for a machine token, in days (the API caps it at 365). */
const TOKEN_LIFETIME_DAYS = [1, 7, 30, 90, 180, MAX_CREDENTIAL_DAYS] as const;
const DEFAULT_TOKEN_DAYS = 30;

/**
 * Mint a stored MACHINE credential (CLI / CI / the renewal Lambda).
 *
 * It opens its own machine session rather than replacing this tab's, and shows
 * up under Sessions → Machine credentials, where renewal can be stopped. The
 * person picks its lifetime (1–365 days, the API's bounds) and either ONE
 * capability scope — a scoped token carries none of their permissions, only
 * that capability — or, without a scope, "Selected permissions" (the default,
 * seeded read-only) versus "Full access". The subset is fixed for the session's
 * life and re-intersected with the person's roles at every renewal.
 */
function MachineTokenSection({ readOnly, held }: { readOnly: boolean; held: readonly string[] }) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<{ value: string; expiresIn: number; scope: string; permissions?: string[] } | null>(null);
  const [days, setDays] = useState<number>(DEFAULT_TOKEN_DAYS);
  const [scope, setScope] = useState('');
  const [permMode, setPermMode] = useState<PermissionMode>('selected');
  const [selectedPerms, setSelectedPerms] = useState<Set<string> | null>(null);
  const selected = selectedPerms ?? new Set(readOnlyPreset(held));
  const permissions = scope ? undefined : permissionsForRequest(permMode, selected);

  const generate = async () => {
    if (permissions && permissions.length === 0) {
      setError('Choose at least one permission, or full access');
      return;
    }
    setGenerating(true);
    setError(null);
    setToken(null);
    try {
      const res = await api.generateNewToken({
        expiresIn: days * 86400,
        ...(scope ? { scope } : {}),
        ...(permissions ? { permissions } : {}),
      });
      if (!res.success || !res.data?.accessToken) throw new Error('Failed to generate token');
      setToken({ value: res.data.accessToken, expiresIn: res.data.expiresIn, scope, ...(permissions ? { permissions } : {}) });
      // A new issuance belongs in the history list below.
      window.dispatchEvent(new Event(TOKEN_ISSUED_EVENT));
    } catch (err) {
      setError(formatError(err, 'Failed to generate token'));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <SectionCard
      icon={KeyRound}
      title="Generate machine token"
      description="Mint a long-lived token for CLI or API access. It gets its own machine session — your browser session is untouched — and is listed under Sessions, where you can stop it renewing."
    >
      <ErrorAlert message={error} />

      <div className={`flex flex-wrap items-end gap-3 ${error ? 'mt-4' : ''}`}>
        <FormField label="Expires after" className="w-40">
          <Select
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={generating || readOnly}
          >
            {TOKEN_LIFETIME_DAYS.map((d) => (
              <option key={d} value={d}>{d === 1 ? '1 day' : `${d} days`}</option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Capability"
          className="min-w-[260px] flex-1"
          hint={scope
            ? 'Least privilege: the token can do only this, and carries none of your permissions.'
            : 'The token acts with your permissions in the active organization — all of them, or the ones selected below.'}
        >
          <Select value={scope} onChange={(e) => setScope(e.target.value)} disabled={generating || readOnly}>
            <option value="">Your permissions (no scope)</option>
            {TOKEN_SCOPE_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </FormField>
        <Button onClick={() => void generate()} loading={generating} readOnly={readOnly}>
          {generating ? 'Generating...' : <><RefreshCw className="w-4 h-4 mr-2" />Generate Token</>}
        </Button>
      </div>

      {/* Without a capability scope the token carries permissions — pick which. */}
      {!scope && (
        <div className="mt-4">
          <TokenPermissionPicker
            mode={permMode}
            onModeChange={setPermMode}
            selected={selected}
            onSelectedChange={setSelectedPerms}
            held={held}
            disabled={generating || readOnly}
          />
        </div>
      )}

      {token && (
        <>
          <p className="mt-4 text-sm text-fg-muted">
            Valid for {Math.round(token.expiresIn / 86400)} day{Math.round(token.expiresIn / 86400) === 1 ? '' : 's'}
            {token.scope
              ? <> · scoped to <code className="text-xs">{token.scope}</code></>
              : token.permissions
                ? ` · ${token.permissions.length} selected permission${token.permissions.length === 1 ? '' : 's'}`
                : ' · full permissions'}.
          </p>
          <SecretReveal
            value={token.value}
            label="Machine token"
            filename="pipeline-builder-machine-token.txt"
            onDone={() => setToken(null)}
            className="mt-2"
          />
        </>
      )}
    </SectionCard>
  );
}

/** Fired by the mint form so the history list re-reads without a shared store. */
const TOKEN_ISSUED_EVENT = 'pb:machine-token-issued';

const TOKEN_STATUS_COLOR: Record<TokenHistoryEntry['status'], 'green' | 'gray' | 'red'> = {
  active: 'green',
  expired: 'gray',
  revoked: 'red',
};

/**
 * The tokens this account has been issued (`GET /user/tokens`), newest first,
 * each with where it stands now: `revoked` means a sign-out-everywhere came
 * after it, `expired` that its lifetime ran out. The question it answers is
 * "is anything I minted still live?" — which the sessions list only answers for
 * credentials that are still renewing.
 */
function TokenHistorySection() {
  const { data, loading, error, refetch } = useFetch(
    async (signal) => (await api.listTokenHistory({ signal })).data?.tokens ?? [],
    [],
  );

  useEffect(() => {
    window.addEventListener(TOKEN_ISSUED_EVENT, refetch);
    return () => window.removeEventListener(TOKEN_ISSUED_EVENT, refetch);
  }, [refetch]);

  return (
    <SectionCard
      icon={History}
      title="Token history"
      description="Tokens issued to this account, newest first. Revoked ones were cut off by a sign-out everywhere."
    >
      {error ? (
        <RetryError message={error.message || 'Failed to load token history'} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingSpinner />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={History} title="No tokens issued yet" description="Machine tokens you generate above are listed here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <th className="py-2 pr-4 font-medium">Issued</th>
                <th className="py-2 pr-4 font-medium">Expires</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {data.map((t) => (
                <tr key={t.id}>
                  <td className="py-2 pr-4">{formatDateTime(t.createdAt)}</td>
                  <td className="py-2 pr-4">{formatDateTime(t.expiresAt)}</td>
                  <td className="py-2"><Badge color={TOKEN_STATUS_COLOR[t.status]}>{t.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Current access token (the decoded view that used to be its own page tab)
// ---------------------------------------------------------------------------

const KNOWN_TIME_FIELDS = new Set(['exp', 'iat', 'nbf']);
const FIELD_LABELS: Record<string, string> = {
  sub: 'Subject (User ID)',
  iss: 'Issuer',
  aud: 'Audience',
  exp: 'Expires At',
  iat: 'Issued At',
  nbf: 'Not Before',
  jti: 'Token ID',
  role: 'Role',
  email: 'Email',
  username: 'Username',
  organizationId: 'Organization ID',
  organizationName: 'Organization',
  tokenVersion: 'Token Version',
  type: 'Token Type',
};

/** This browser session's access token, decoded — and why the refresh token
 *  isn't here. Kept because it is the fastest way to answer "what does the API
 *  think I am right now", which is a support question, not a security control. */
function CurrentTokenSection() {
  const [token, setToken] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  // The token lives in the api client, which is browser-only state.
  useEffect(() => { setToken(api.getAccessToken()); }, []);

  const decoded = useMemo(() => (token ? decodeJwt(token) : null), [token]);

  if (!token) {
    return (
      <SectionCard title="This session's access token">
        <p className="text-sm text-fg-muted">No token available</p>
      </SectionCard>
    );
  }

  const expired = decoded ? isExpired(decoded.payload) : false;
  const ttl = decoded ? expiresIn(decoded.payload) : null;

  const payloadItems: DescriptionItem[] = decoded
    ? Object.entries(decoded.payload).map(([key, value]) => {
      const label = FIELD_LABELS[key] || key;
      const isTime = KNOWN_TIME_FIELDS.has(key);
      const formattedTime = isTime ? formatTimestamp(value) : null;
      return {
        label: <span title={key}>{label}</span>,
        // Claim keys are kept as-is; claim VALUES can carry an account-id-shaped
        // token (e.g. an ARN in a custom claim), so redact id-shaped runs first.
        value: (
          <span className="font-mono text-xs leading-5">
            {formattedTime ? (
              <span>{formattedTime}<span className="ml-2 text-fg-muted">({String(value)})</span></span>
            ) : typeof value === 'object' ? (
              JSON.stringify(redactDetails(value))
            ) : (
              redactString(String(value))
            )}
          </span>
        ),
      };
    })
    : [];

  return (
    <div className="space-y-6">
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2">
            This session&apos;s access token
            {decoded && (expired ? <Badge color="red">Expired</Badge> : <Badge color="green">Valid</Badge>)}
            {ttl && !expired && <Badge color="blue">{ttl}</Badge>}
          </span>
        }
        actions={
          <>
            <button onClick={() => setShowRaw(!showRaw)} className="action-link text-xs">
              {showRaw ? 'Decoded' : 'Raw'}
            </button>
            <CopyButton text={token} />
          </>
        }
      >
        {showRaw ? (
          <CodeBlock code={token} language="jwt" copyable={false} className="max-h-48 overflow-y-auto" />
        ) : decoded ? (
          <div className="space-y-4">
            <div>
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center text-xs font-semibold text-fg-muted uppercase tracking-wider hover:text-fg transition-colors"
              >
                <ChevronRight className={`w-3.5 h-3.5 mr-1 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                Header
              </button>
              {expanded && <CodeBlock className="mt-2" language="json" copyable={false} code={JSON.stringify(decoded.header, null, 2)} />}
            </div>

            <div>
              <p className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1">Payload</p>
              <DescriptionList items={payloadItems} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-danger">Failed to decode token</p>
        )}
      </SectionCard>

      <SectionCard title="Refresh token">
        <p className="text-sm text-fg-muted">
          Your refresh token is stored in an HttpOnly cookie scoped to the refresh endpoint,
          so no script — including this page — can read it. That is what keeps a stolen script
          from walking off with a 30-day credential. The browser presents it automatically when
          this access token needs renewing; to end it, sign out (or use Sign out everywhere).
        </p>
      </SectionCard>
    </div>
  );
}

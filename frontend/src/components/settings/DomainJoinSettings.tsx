// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Globe, Check, Trash2, RefreshCw } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { useToast } from '@/components/ui/Toast';
import { DOMAIN_SETTINGS_ANCHOR } from '@/components/sso/VerifiedDomainPicker';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import { useFetch } from '@/hooks/useFetch';
import { useDelete } from '@/hooks/useDelete';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgDomainDto } from '@/lib/api/domains/organizations';
import { EmptyState } from '@/components/ui/EmptyState';
import { JoinRequestsPanel } from './JoinRequestsPanel';

/**
 * Admin panel for the org's EMAIL DOMAINS: register + DNS-verify them, choose
 * how matching signups may join (off / request / auto), and decide join
 * requests (approve / deny pending ones, clear a denial — {@link JoinRequestsPanel}). Rendered on the org settings page for owners/admins;
 * the backend enforces `org_settings:write` + tenancy independently.
 *
 * TWO consumers, not one: domain-based join, and SSO setup, which sends admins
 * here as well — a non-Google IdP's identities are refused
 * unless the email's domain is DNS-verified by the org (`assertSsoIdentityTrusted`)
 * and "require single sign-on" is a hard 409 without one. So the card is named
 * (and anchored, {@link DOMAIN_SETTINGS_ANCHOR}) for verification AND join,
 * and the unentitled upsell names both.
 *
 * The "holds `sso` but can't register a domain" branch below is NARROW now that
 * SSO is a Team-and-above TIER feature with no add-on to buy: a plan can no
 * longer put `sso` on a sub-Team org. It is still reachable two ways — a
 * superadmin (issued every entitlement, and `useFeatureGate` honours that
 * bypass) looking at a Developer/Pro org, and a per-user `sso` force-on
 * override (`resolveUserFeatures`) on a member of one. Both see an SSO surface
 * they cannot finish wiring up, which is exactly the loop this text breaks.
 */
/**
 * "Share with teams" (ROOT orgs only, verified rows only): delegates the
 * domain's identity trust to the account's teams, so a team's own IdP / SCIM may
 * vouch for addresses at it. A security-relevant delegation, so the switch opens
 * a `StepUpModal` stating the consequence and the PATCH carries its token. Hidden
 * on a team (only the root owns the account's domains — the server refuses with
 * `DOMAIN_SHARE_NOT_ROOT`) and on unverified rows (`DOMAIN_SHARE_UNVERIFIED`).
 * Root-ness comes from {@link useOrgHierarchy}: the switch shows only once the
 * active org's membership row has loaded, is THIS org, and has no parent — an
 * unknown hierarchy never offers it.
 *
 * `readOnly` shows the card with every control disabled — for a read-only
 * impersonation session, where the settings must be VISIBLE (that is the point
 * of investigating) but no write may be offered.
 */
export function DomainJoinSettings({ orgId, readOnly = false }: { orgId: string; readOnly?: boolean }) {
  const toast = useToast();
  // Only to EXPLAIN the dead end below — the domain gate is the account tier,
  // not this entitlement, so it never unlocks the form. (SSO is itself a Team+
  // tier feature, so the two agree for ordinary members; see the note above for
  // the superadmin / per-user-override cases where they don't.)
  const sso = useFeatureGate('sso');
  const [newDomain, setNewDomain] = useState('');
  const form = useFormState();
  const { activeOrg } = useOrgHierarchy();
  const isRootOrg = !!activeOrg && activeOrg.id === orgId && !activeOrg.parentOrgId;
  // The share change awaiting its step-up (the domain and the value to set).
  const [pendingShare, setPendingShare] = useState<{ domain: OrgDomainDto; shared: boolean } | null>(null);

  // The domains. Join requests are their own paged read (JoinRequestsPanel).
  const read = useFetch(
    async (signal): Promise<{ domains: OrgDomainDto[]; entitled: boolean }> => {
      const d = await api.listOrgDomains(orgId, { signal });
      return {
        domains: d.data?.domains ?? [],
        // Default false: the add-domain form must not show for an org whose
        // entitlement is unknown (the real gate is server-side regardless).
        entitled: d.data?.entitled ?? false,
      };
    },
    [orgId],
  );
  const domains = read.data?.domains ?? [];
  const entitled = read.data?.entitled ?? false;
  const loading = read.loading && !read.data;

  // Wrap a mutating action: clear errors, run, toast, then re-read. A failed
  // re-read surfaces as the section's retry state, not as a failed action.
  // `useFormState.run` also owns the step-up replay, so a write refused pending
  // re-auth completes (and re-reads) once the person confirms in the dialog.
  const run = (fn: () => Promise<unknown>, successMsg?: string) => form.run(fn, {
    onSuccess: () => {
      if (successMsg) toast.success(successMsg);
      void read.refetch();
    },
  });

  // The step-up token is single-use and forwarded here, so the request is never
  // replayed by the global dialog (`replayOnStepUp: false` on the client); a
  // refusal (e.g. DOMAIN_SHARE_NOT_ROOT) lands in the card's error alert.
  const confirmShare = async (stepUpToken: string) => {
    const pending = pendingShare;
    setPendingShare(null);
    if (!pending) return;
    await run(
      () => api.setOrgDomainSharing(orgId, pending.domain.id, pending.shared, stepUpToken),
      pending.shared ? `${pending.domain.domain} is now shared with teams` : `${pending.domain.domain} is no longer shared with teams`,
    );
  };

  // Same for the delete: `useDelete` follows the replay and re-reads after it.
  const del = useDelete<OrgDomainDto>(
    (d) => api.deleteOrgDomain(orgId, d.id),
    () => { toast.success('Domain removed'); void read.refetch(); },
    (e) => form.setError(formatError(e)),
  );
  const locked = form.loading || del.loading || readOnly;

  // The anchor wrapper carries `tabIndex={-1}` because `useUrlTab` FOCUSES the
  // fragment's target: a keyboard user following "Verify a domain" then arrives
  // at the card instead of at the top of the settings page.
  return (
    <div id={DOMAIN_SETTINGS_ANCHOR} tabIndex={-1} className="scroll-mt-6 outline-none">
    <SectionCard
      icon={Globe}
      title="Email domains"
      description={`Prove your organization owns an email domain with a DNS TXT record. A verified domain is what single sign-on serves, and what lets matching signups discover and join this organization.${!entitled ? ' Registering one needs the Team or Enterprise tier.' : ''}`}
    >
      {form.error && <div className="mb-3"><ErrorAlert message={form.error} /></div>}

      {read.error ? (
        <RetryError message={formatError(read.error, 'Could not load domains')} onRetry={read.refetch} />
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted py-4">
          <LoadingSpinner size="sm" /> Loading domains…
        </div>
      ) : (
        <>
          {/* Add a domain — gated on entitlement (matches the server-side gate). */}
          {entitled ? (
            <form
              className="flex items-end gap-2 mb-4"
              onSubmit={(e) => { e.preventDefault(); if (newDomain.trim()) void run(async () => { await api.addOrgDomain(orgId, newDomain.trim()); setNewDomain(''); }, 'Domain added'); }}
            >
              <div className="flex-1">
                <FormField label="Add a domain" id="new-domain" hint="e.g. acme.com — you'll verify ownership via DNS.">
                  <Input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="acme.com" disabled={readOnly} />
                </FormField>
              </div>
              <Button type="submit" disabled={locked || !newDomain.trim()}>Add</Button>
            </form>
          ) : (
            <Callout variant="neutral" className="mb-4" title="Registering a domain needs the Team or Enterprise tier">
              A verified domain unlocks two things: <strong>single sign-on</strong> — an identity provider&apos;s
              sign-ins are refused for any domain you haven&apos;t verified (Google Workspace is the one exception:
              Google verifies the domain itself), and &ldquo;require single sign-on&rdquo; cannot be switched on at
              all — and <strong>domain-based join</strong>, which lets people with a matching
              company email discover and join this organization.
              {sso.isLoaded && sso.entitled && (
                <>
                  {' '}You hold {sso.label}, but domain registration is gated on the account tier, so an SSO
                  connection here cannot be completed until the account is on Team or Enterprise.{' '}
                  <Link href={sso.upsellHref} className="underline">{sso.upsellCta}</Link>.
                </>
              )}
            </Callout>
          )}

          {/* Domain list */}
          <div className="space-y-3">
            {domains.length === 0 && (
              <EmptyState compact title="No domains registered yet" description="Add a domain above, then publish its DNS TXT record to verify it." />
            )}
            {domains.map((d) => (
              <div key={d.id} className="rounded-lg border border-default p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-sm">{d.domain}</span>
                  <div className="flex items-center gap-2">
                    {d.verified
                      ? <span className="inline-flex items-center gap-1 text-xs text-success"><Check className="w-3.5 h-3.5" /> Verified</span>
                      : <span className="text-xs text-fg-muted">Unverified</span>}
                    <button
                      type="button"
                      aria-label={`Delete ${d.domain}`}
                      className="text-fg-muted hover:text-danger"
                      disabled={locked}
                      onClick={() => del.open(d)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {!d.verified && d.verification && (
                  <div className="mt-2 rounded-md bg-surface-muted p-2.5 text-xs">
                    <p className="text-fg-muted mb-1">Publish this DNS TXT record, then verify:</p>
                    <code className="block break-all">{d.verification.host} TXT &quot;{d.verification.value}&quot;</code>
                    <Button type="button" variant="secondary" className="mt-2" disabled={locked}
                      onClick={() => void run(() => api.verifyOrgDomain(orgId, d.id), 'Domain verified')}>
                      <RefreshCw className="w-3.5 h-3.5 mr-1" /> Verify
                    </Button>
                  </div>
                )}

                {d.verified && (
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-xs text-fg-muted" htmlFor={`mode-${d.id}`}>Who can join</label>
                    <Select
                      id={`mode-${d.id}`}
                      className="text-sm"
                      value={d.autoJoin}
                      disabled={locked || !entitled}
                      onChange={(e) => void run(() => api.setOrgDomainMode(orgId, d.id, e.target.value as 'off' | 'request' | 'auto'), 'Join mode updated')}
                    >
                      <option value="off">Off — no discovery</option>
                      <option value="request">Request — admin approves</option>
                      <option value="auto">Auto — join immediately</option>
                    </Select>
                  </div>
                )}

                {d.verified && isRootOrg && (
                  <div className="mt-2 flex items-center gap-2">
                    <Switch
                      id={`share-${d.id}`}
                      aria-label={`Share ${d.domain} with teams`}
                      checked={d.sharedWithTeams}
                      disabled={locked}
                      onChange={(next) => setPendingShare({ domain: d, shared: next })}
                    />
                    <label className="text-xs text-fg-muted" htmlFor={`share-${d.id}`}>Share with teams</label>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Join requests: pending (approve / deny) and denied (clear). */}
          <JoinRequestsPanel orgId={orgId} readOnly={readOnly} />
        </>
      )}

      {pendingShare && (
        <StepUpModal
          title={pendingShare.shared ? `Share ${pendingShare.domain.domain} with teams?` : `Stop sharing ${pendingShare.domain.domain}?`}
          action={pendingShare.shared ? `Share ${pendingShare.domain.domain} with teams` : `Stop sharing ${pendingShare.domain.domain} with teams`}
          details={pendingShare.shared
            ? <>Teams in this account will be able to sign in and provision users at <strong>{pendingShare.domain.domain}</strong> through their own identity providers.</>
            : <>Teams in this account will no longer be able to sign in or provision users at <strong>{pendingShare.domain.domain}</strong> through their own identity providers.</>}
          onConfirmed={confirmShare}
          onClose={() => setPendingShare(null)}
        />
      )}

      {del.target && (
        <DeleteConfirmModal
          title="Delete domain"
          itemName={del.target.domain}
          loading={del.loading}
          onCancel={del.close}
          onConfirm={() => void del.confirm()}
        />
      )}
    </SectionCard>
    </div>
  );
}

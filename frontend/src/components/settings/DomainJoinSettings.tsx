// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Globe, Check, Trash2, RefreshCw } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { useToast } from '@/components/ui/Toast';
import { DOMAIN_SETTINGS_ANCHOR } from '@/components/sso/VerifiedDomainPicker';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgDomainDto, OrgJoinRequestDto } from '@/lib/api/domains/organizations';

/**
 * Admin panel for the org's EMAIL DOMAINS: register + DNS-verify them, choose
 * how matching signups may join (off / request / auto), and approve or deny
 * pending join requests. Rendered on the org settings page for owners/admins;
 * the backend enforces `org:settings` + tenancy independently.
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
  const [busy, setBusy] = useState(false);
  const locked = busy || readOnly;
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<OrgDomainDto | null>(null);

  // Domains and pending join requests, read together.
  const read = useFetch(
    async (signal): Promise<{ domains: OrgDomainDto[]; entitled: boolean; requests: OrgJoinRequestDto[] }> => {
      const [d, r] = await Promise.all([api.listOrgDomains(orgId, { signal }), api.listOrgJoinRequests(orgId, { signal })]);
      return {
        domains: d.data?.domains ?? [],
        // Default false: the add-domain form must not show for an org whose
        // entitlement is unknown (the real gate is server-side regardless).
        entitled: d.data?.entitled ?? false,
        requests: r.data?.requests ?? [],
      };
    },
    [orgId],
  );
  const domains = read.data?.domains ?? [];
  const requests = read.data?.requests ?? [];
  const entitled = read.data?.entitled ?? false;
  const loading = read.loading && !read.data;

  // Wrap a mutating action: clear errors, run, toast, then re-read. A failed
  // re-read surfaces as the section's retry state, not as a failed action.
  const run = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
      void read.refetch();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

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
      {error && <div className="mb-3"><ErrorAlert message={error} /></div>}

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
            {domains.length === 0 && <p className="text-sm text-fg-muted">No domains registered yet.</p>}
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
                      onClick={() => setPendingDelete(d)}
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
              </div>
            ))}
          </div>

          {/* Pending join requests */}
          {requests.length > 0 && (
            <div className="mt-5">
              <h4 className="text-sm font-semibold mb-2">Pending join requests ({requests.length})</h4>
              <div className="space-y-2">
                {requests.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 rounded-md border border-default p-2.5">
                    <span className="text-sm truncate">{r.email}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button type="button" disabled={locked} onClick={() => void run(() => api.decideOrgJoinRequest(orgId, r.id, 'approve'), 'Request approved')}>Approve</Button>
                      <Button type="button" variant="secondary" disabled={locked} onClick={() => void run(() => api.decideOrgJoinRequest(orgId, r.id, 'deny'), 'Request denied')}>Deny</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {pendingDelete && (
        <DeleteConfirmModal
          title="Delete domain"
          itemName={pendingDelete.domain}
          loading={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const d = pendingDelete;
            setPendingDelete(null);
            void run(() => api.deleteOrgDomain(orgId, d.id), 'Domain removed');
          }}
        />
      )}
    </SectionCard>
    </div>
  );
}

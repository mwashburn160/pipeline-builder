// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
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
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgDomainDto, OrgJoinRequestDto } from '@/lib/api/domains/organizations';

/**
 * Admin panel for domain-based org join (P2b): register + DNS-verify email
 * domains, choose how matching signups may join (off / request / auto), and
 * approve or deny pending join requests. Rendered on the org settings page for
 * owners/admins; the backend enforces `org:settings` + tenancy independently.
 */
export function DomainJoinSettings({ orgId }: { orgId: string }) {
  const toast = useToast();
  const [newDomain, setNewDomain] = useState('');
  const [busy, setBusy] = useState(false);
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
      read.refetch();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      icon={Globe}
      title="Domain-based join"
      description={`Let people with a verified company email domain discover and join this organization.${!entitled ? ' Requires the Team or Enterprise tier to enable.' : ''}`}
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
                  <Input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="acme.com" />
                </FormField>
              </div>
              <Button type="submit" disabled={busy || !newDomain.trim()}>Add</Button>
            </form>
          ) : (
            <Callout variant="neutral" className="mb-4">
              Upgrade to the Team or Enterprise tier to register domains for join.
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
                      disabled={busy}
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
                    <Button type="button" variant="secondary" className="mt-2" disabled={busy}
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
                      disabled={busy || !entitled}
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
                      <Button type="button" disabled={busy} onClick={() => void run(() => api.decideOrgJoinRequest(orgId, r.id, 'approve'), 'Request approved')}>Approve</Button>
                      <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => api.decideOrgJoinRequest(orgId, r.id, 'deny'), 'Request denied')}>Deny</Button>
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
  );
}

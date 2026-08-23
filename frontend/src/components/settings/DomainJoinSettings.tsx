// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { Globe, Check, Trash2, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { LoadingSpinner } from '@/components/ui/Loading';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { useToast } from '@/components/ui/Toast';
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
  const [domains, setDomains] = useState<OrgDomainDto[]>([]);
  const [requests, setRequests] = useState<OrgJoinRequestDto[]>([]);
  // Default false: the add-domain form must not flash for an unentitled org before
  // the first load resolves (the real gate is server-side regardless).
  const [entitled, setEntitled] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<OrgDomainDto | null>(null);

  /** Reload domains + requests. Returns false (and sets `error`) on failure so
   *  `run` can suppress a misleading success toast when the post-mutation reload
   *  actually failed. */
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const [d, r] = await Promise.all([api.listOrgDomains(orgId), api.listOrgJoinRequests(orgId)]);
      if (d.success && d.data) { setDomains(d.data.domains); setEntitled(d.data.entitled); }
      if (r.success && r.data) setRequests(r.data.requests);
      return true;
    } catch (e) {
      setError(formatError(e));
      return false;
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  // Wrap a mutating action: clear errors, run, reload, toast ONLY if the reload
  // also succeeded (else the reload already set `error` — don't show both).
  const run = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      const reloaded = await load();
      if (successMsg && reloaded) toast.success(successMsg);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-1">
        <Globe className="w-4 h-4 text-[var(--pb-brand)]" />
        <h3 className="font-semibold">Domain-based join</h3>
      </div>
      <p className="text-sm text-[var(--pb-text-muted)] mb-4">
        Let people with a verified company email domain discover and join this organization.
        {!entitled && ' Requires the Team or Enterprise tier to enable.'}
      </p>

      {error && <div className="mb-3"><ErrorAlert message={error} /></div>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--pb-text-muted)] py-4">
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
            <p className="mb-4 text-sm text-[var(--pb-text-muted)] rounded-md bg-[var(--pb-surface-muted)] p-3">
              Upgrade to the Team or Enterprise tier to register domains for join.
            </p>
          )}

          {/* Domain list */}
          <div className="space-y-3">
            {domains.length === 0 && <p className="text-sm text-[var(--pb-text-muted)]">No domains registered yet.</p>}
            {domains.map((d) => (
              <div key={d.id} className="rounded-lg border border-[var(--pb-border)] p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-sm">{d.domain}</span>
                  <div className="flex items-center gap-2">
                    {d.verified
                      ? <span className="inline-flex items-center gap-1 text-xs text-[var(--pb-success)]"><Check className="w-3.5 h-3.5" /> Verified</span>
                      : <span className="text-xs text-[var(--pb-text-muted)]">Unverified</span>}
                    <button
                      type="button"
                      aria-label={`Delete ${d.domain}`}
                      className="text-[var(--pb-text-muted)] hover:text-[var(--pb-danger)]"
                      disabled={busy}
                      onClick={() => setPendingDelete(d)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {!d.verified && d.verification && (
                  <div className="mt-2 rounded-md bg-[var(--pb-surface-muted)] p-2.5 text-xs">
                    <p className="text-[var(--pb-text-muted)] mb-1">Publish this DNS TXT record, then verify:</p>
                    <code className="block break-all">{d.verification.host} TXT &quot;{d.verification.value}&quot;</code>
                    <Button type="button" variant="secondary" className="mt-2" disabled={busy}
                      onClick={() => void run(() => api.verifyOrgDomain(orgId, d.id), 'Domain verified')}>
                      <RefreshCw className="w-3.5 h-3.5 mr-1" /> Verify
                    </Button>
                  </div>
                )}

                {d.verified && (
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-xs text-[var(--pb-text-muted)]" htmlFor={`mode-${d.id}`}>Who can join</label>
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
                  <div key={r.id} className="flex items-center justify-between gap-3 rounded-md border border-[var(--pb-border)] p-2.5">
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
    </Card>
  );
}

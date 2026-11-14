// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { TabBar } from '@/components/ui/TabBar';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

/** Rows per page — the server allows up to 500; a settings card wants far fewer. */
export const JOIN_REQUEST_PAGE_SIZE = 25;

type JoinRequestStatus = 'pending' | 'denied';
const TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'denied', label: 'Denied' },
] as const;

/**
 * Domain-join requests for an org, in two lists:
 *
 * - **Pending** — approve or deny. A pending request lapses on its own after
 *   30 days (the person may ask again).
 * - **Denied** — a denial is sticky (the person cannot re-ask), so an admin who
 *   denied by mistake, or whose policy changed, clears it here
 *   (`DELETE /organization/:id/join-requests/:reqId`).
 *
 * Paged with offset + `hasMore`. Mounted inside DomainJoinSettings, whose mount
 * site is the `org_settings:write` gate every route here requires; `readOnly`
 * (read-only impersonation) shows the lists with every action disabled.
 */
export function JoinRequestsPanel({ orgId, readOnly = false }: { orgId: string; readOnly?: boolean }) {
  const toast = useToast();
  const form = useFormState();
  const [status, setStatus] = useState<JoinRequestStatus>('pending');
  const [offset, setOffset] = useState(0);

  const read = useFetch(
    async (signal) => {
      const res = await api.listOrgJoinRequests(orgId, { status, limit: JOIN_REQUEST_PAGE_SIZE, offset, signal });
      return { requests: res.data?.requests ?? [], hasMore: res.data?.hasMore ?? false };
    },
    [orgId, status, offset],
    { keepPreviousData: true },
  );
  const requests = read.data?.requests ?? [];
  const hasMore = read.data?.hasMore ?? false;
  const locked = form.loading || readOnly;

  const run = (fn: () => Promise<unknown>, successMsg: string) => form.run(fn, {
    onSuccess: () => {
      toast.success(successMsg);
      // A decided / cleared row leaves this list; stepping back keeps a page
      // that just emptied from showing nothing while earlier rows exist.
      if (requests.length === 1 && offset > 0) setOffset(Math.max(0, offset - JOIN_REQUEST_PAGE_SIZE));
      else void read.refetch();
    },
  });

  const selectTab = (id: string) => {
    setStatus(id as JoinRequestStatus);
    setOffset(0);
    form.setError(null);
  };

  return (
    <div className="mt-5" data-testid="join-requests">
      <h4 className="text-sm font-semibold mb-2">Join requests</h4>
      <TabBar items={[...TABS]} activeId={status} onSelect={selectTab} idPrefix="join-requests" ariaLabel="Join request status" />
      <div className="mt-3 space-y-2">
        {form.error && <ErrorAlert message={form.error} />}
        {read.error ? (
          <RetryError message={formatError(read.error, 'Could not load join requests')} onRetry={read.refetch} />
        ) : read.loading && !read.data ? (
          <div className="flex items-center gap-2 text-sm text-fg-muted py-2">
            <LoadingSpinner size="sm" /> Loading join requests…
          </div>
        ) : requests.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {status === 'pending'
              ? 'No pending join requests.'
              : 'No denied requests. Clearing a denial lets that person ask to join again.'}
          </p>
        ) : (
          <>
            {status === 'pending' && (
              <p className="text-xs text-fg-muted">A request nobody decides lapses after 30 days; the person may then ask again.</p>
            )}
            {status === 'denied' && (
              <p className="text-xs text-fg-muted">A denied person cannot ask again until you clear their denial.</p>
            )}
            {requests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 rounded-md border border-default p-2.5">
                <div className="min-w-0">
                  <span className="text-sm truncate block">{r.email}</span>
                  <span className="text-xs text-fg-muted">
                    {status === 'denied' && r.decidedAt
                      ? <>Denied <RelativeTime value={r.decidedAt} /></>
                      : <>Requested <RelativeTime value={r.requestedAt} /></>}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {status === 'pending' ? (
                    <>
                      <Button type="button" disabled={locked} onClick={() => void run(() => api.decideOrgJoinRequest(orgId, r.id, 'approve'), 'Request approved')}>Approve</Button>
                      <Button type="button" variant="secondary" disabled={locked} onClick={() => void run(() => api.decideOrgJoinRequest(orgId, r.id, 'deny'), 'Request denied')}>Deny</Button>
                    </>
                  ) : (
                    <Button type="button" variant="secondary" disabled={locked} onClick={() => void run(() => api.clearOrgJoinRequest(orgId, r.id), 'Denial cleared — they may ask again')}>
                      Clear denial
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
        {(offset > 0 || hasMore) && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" disabled={offset === 0 || read.loading} onClick={() => setOffset(Math.max(0, offset - JOIN_REQUEST_PAGE_SIZE))}>
              Previous
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={!hasMore || read.loading} onClick={() => setOffset(offset + JOIN_REQUEST_PAGE_SIZE)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

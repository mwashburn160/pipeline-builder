// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { ArrowRightLeft, Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { EcosystemActionDialog } from '@/components/ecosystem/EcosystemActionDialog';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { REQUEST_KIND_LABELS, REQUEST_STATUS_COLORS, REQUEST_STATUS_LABELS, isOpenRequest } from '@/lib/ecosystem';
import type { PublishRequestKind, PublishRequestStatus, PublishRequestView } from '@/types/ecosystem';

/** Kinds submitted (and withdrawn) under `publishers:manage`; the rest need `plugins:publish`. */
const MANAGE_KINDS: ReadonlySet<PublishRequestKind> = new Set(['profile_change', 'transfer', 'claim', 'verify']);

type StatusFilter = 'all' | PublishRequestStatus;
const FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'pending_second_approval', label: 'Second approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

/** What a request is about, in one line. */
export function requestSubject(r: PublishRequestView): string {
  const name = r.listingName ?? r.payload.name ?? null;
  if (r.kind === 'profile_change') {
    const t = r.payload.target ?? {};
    return [t.handle && `handle to ${t.handle}`, t.displayName && `display name to ${t.displayName}`].filter(Boolean).join(', ') || 'Profile';
  }
  if (r.kind === 'claim') return r.payload.target?.handle ? `Handle ${r.payload.target.handle}` : name ?? 'Handle';
  if (r.kind === 'verify') return r.payload.application?.domain ? `Domain ${r.payload.application.domain}` : 'Verified publisher';
  if (r.kind === 'transfer') {
    const to = r.payload.target?.targetPublisherHandle;
    return `${name ?? 'Listing'}${to ? ` to ${to}` : ''}`;
  }
  return `${name ?? ''}${r.version ? ` v${r.version}` : ''}`.trim() || REQUEST_KIND_LABELS[r.kind];
}

interface Props {
  canPublish: boolean;
  canManage: boolean;
}

/**
 * The org's own publish requests (status, the decision's reason, withdraw) and
 * transfers other publishers have offered it (accept / decline, step-up).
 */
export function PublishRequestsPanel({ canPublish, canManage }: Props) {
  const toast = useToast();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const statusParam = filter === 'all' ? {} : { status: filter };
  const requestsQ = useFetch(async (signal) => {
    const res = await api.listPublishRequests(statusParam, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load requests');
    return { requests: res.data.requests, nextCursor: res.data.nextCursor ?? null };
  }, [filter]);
  // Older pages, appended by "Load more" (the list is paged server-side).
  const [more, setMore] = useState<{ requests: PublishRequestView[]; nextCursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setMore(null); }, [requestsQ.data]);
  const nextCursor = more ? more.nextCursor : requestsQ.data?.nextCursor ?? null;
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api.listPublishRequests({ ...statusParam, cursor: nextCursor });
      const page = { requests: res.data?.requests ?? [], nextCursor: res.data?.nextCursor ?? null };
      setMore((m) => ({ requests: [...(m?.requests ?? []), ...page.requests], nextCursor: page.nextCursor }));
    } catch (err) {
      toast.error(formatError(err, 'Could not load more requests'));
    } finally {
      setLoadingMore(false);
    }
  };
  // Incoming transfers are few; every page is read so none is missed.
  const incomingQ = useFetch(async (signal) => {
    if (!canManage) return [];
    const all: PublishRequestView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const res = await api.listIncomingTransfers(cursor ? { cursor } : undefined, { signal });
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to load incoming transfers');
      all.push(...res.data.requests);
      if (!res.data.nextCursor) break;
      cursor = res.data.nextCursor;
    }
    return all;
  }, [canManage]);

  const [withdrawing, setWithdrawing] = useState<PublishRequestView | null>(null);
  const [busy, setBusy] = useState(false);
  const [responding, setResponding] = useState<{ request: PublishRequestView; accept: boolean } | null>(null);

  const canWithdraw = (r: PublishRequestView) => isOpenRequest(r.status) && (MANAGE_KINDS.has(r.kind) ? canManage : canPublish);

  const withdraw = async () => {
    if (!withdrawing) return;
    setBusy(true);
    try {
      await api.withdrawPublishRequest(withdrawing.id);
      toast.success('Request withdrawn');
      setWithdrawing(null);
      void requestsQ.refetch();
    } catch (err) {
      toast.error(formatError(err, 'Could not withdraw the request'));
    } finally {
      setBusy(false);
    }
  };

  const requests = [...(requestsQ.data?.requests ?? []), ...(more?.requests ?? [])];
  const incoming = (incomingQ.data ?? []).filter((r) => r.payload.transfer?.response === 'pending' && isOpenRequest(r.status));

  return (
    <div className="space-y-6">
      {canManage && incoming.length > 0 && (
        <SectionCard icon={ArrowRightLeft} title="Incoming transfers" description="Listings other publishers want to transfer to you. The ecosystem team approves after you accept.">
          <ul className="divide-y divide-default" aria-label="Incoming transfers">
            {incoming.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="text-sm">
                  <span className="font-mono font-medium text-fg">{r.listingName ?? 'Listing'}</span>
                  <span className="text-fg-muted"> from {r.publisherHandle}</span>
                  {r.reason && <span className="block text-xs text-fg-muted">{r.reason}</span>}
                </div>
                <div className="flex gap-1">
                  <Button size="xs" onClick={() => setResponding({ request: r, accept: true })}>Accept</Button>
                  <Button size="xs" variant="secondary" onClick={() => setResponding({ request: r, accept: false })}>Decline</Button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        icon={Inbox}
        title="Requests"
        description="Everything your publisher has asked the ecosystem team to decide."
        actions={<SegmentedFilter options={FILTERS} value={filter} onChange={setFilter} ariaLabel="Filter requests by status" />}
      >
        {requestsQ.loading && !requestsQ.data ? (
          <Skeleton className="h-20 w-full" />
        ) : requestsQ.error ? (
          <RetryError message={formatError(requestsQ.error, 'Failed to load requests')} onRetry={requestsQ.refetch} />
        ) : requests.length === 0 ? (
          <EmptyState compact icon={Inbox} title="No requests" description="Requests you submit appear here with their status." />
        ) : (
          <ul className="divide-y divide-default" aria-label="Publish requests">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-2" data-testid={`request-${r.id}`}>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-fg">{REQUEST_KIND_LABELS[r.kind]}</span>
                    <span className="font-mono text-fg-muted">{requestSubject(r)}</span>
                    <Badge color={REQUEST_STATUS_COLORS[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</Badge>
                    {r.lane === 'security' && <Badge color="red">Security lane</Badge>}
                    {r.autoRuleId && <Badge color="blue">Auto-approved</Badge>}
                  </div>
                  <p className="text-xs text-fg-muted">
                    Submitted <RelativeTime value={r.submittedAt} />
                    {r.decidedAt && <> · decided <RelativeTime value={r.decidedAt} /></>}
                  </p>
                  {r.reason && <p className="text-xs text-fg">Reason: {r.reason}</p>}
                </div>
                {canWithdraw(r) && (
                  <Button variant="secondary" size="xs" onClick={() => setWithdrawing(r)} aria-label={`Withdraw ${REQUEST_KIND_LABELS[r.kind]} request ${requestSubject(r)}`}>
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {nextCursor && requests.length > 0 && (
          <div className="pt-2">
            <Button variant="secondary" size="xs" onClick={() => void loadMore()} loading={loadingMore}>Load more</Button>
          </div>
        )}
      </SectionCard>

      {withdrawing && (
        <ConfirmDialog
          title="Withdraw this request?"
          confirmLabel="Withdraw"
          tone="danger"
          loading={busy}
          onConfirm={() => void withdraw()}
          onCancel={() => setWithdrawing(null)}
        >
          <p>{REQUEST_KIND_LABELS[withdrawing.kind]}: {requestSubject(withdrawing)}. You can submit it again later.</p>
        </ConfirmDialog>
      )}

      {responding && (
        <EcosystemActionDialog
          title={responding.accept ? 'Accept this transfer?' : 'Decline this transfer?'}
          action={`${responding.accept ? 'Accept' : 'Decline'} ${responding.request.listingName ?? 'the listing'} from ${responding.request.publisherHandle}`}
          details={responding.accept
            ? <p>Once the ecosystem team approves, the listing moves to your publisher and you maintain it.</p>
            : <p>The transfer request is closed; the listing stays with its current publisher.</p>}
          stepUp
          onSubmit={async (_reason, token) => {
            await api.respondToTransfer(responding.request.id, responding.accept, token);
            toast.success(responding.accept ? 'Transfer accepted' : 'Transfer declined');
            void incomingQ.refetch();
          }}
          onClose={() => setResponding(null)}
        />
      )}
    </div>
  );
}

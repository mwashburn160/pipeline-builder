// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform → Cascade outbox (system org).
 *
 * Every downstream leg of an org purge or a GDPR user erasure: one row per
 * owning service, delivered by a leader-locked dispatcher with backoff until
 * it is `done` or exhausts its attempts and goes `dead` (alerted as
 * PlatformCascadeLegDead). The page reads with `platform:read`.
 *
 * Redrive is the runbook step once the owning service is fixed: it puts a dead
 * leg, or a pending one stuck on a long backoff or a lapsed lease, back in the
 * queue. `orgs:manage` plus a step-up, audited `admin.cascade.redrive`. Every
 * leg's handler is idempotent, so a redrive is always safe to repeat.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Workflow } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { CopyableId } from '@/components/ui/CopyableId';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingPage } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { useToast } from '@/components/ui/Toast';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import type { CascadeKind, CascadeLeg, CascadeLegQuery, CascadeLegStatus } from '@/lib/api/domains/admin';
import { MfaRequiredError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';

const PAGE_SIZE = 50;

const STATUS_META: Record<CascadeLegStatus, { label: string; color: 'yellow' | 'red' | 'green' }> = {
  pending: { label: 'Pending', color: 'yellow' },
  dead: { label: 'Dead', color: 'red' },
  done: { label: 'Done', color: 'green' },
};
const KIND_LABEL: Record<CascadeKind, string> = { 'org.deleted': 'Org purge', 'user.erased': 'User erasure' };

interface PendingRedrive {
  leg: CascadeLeg;
  resetAttempts: boolean;
  reason: string;
}

export default function CascadeOutboxPage() {
  const { accessDenied, isReady, user, can, isReadOnly } = useAuthGuard();
  const toast = useToast();
  const [status, setStatus] = useState<CascadeLegStatus | 'all'>('all');
  const [kind, setKind] = useState<CascadeKind | 'all'>('all');
  const [subjectInput, setSubjectInput] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<PendingRedrive | null>(null);
  const canManage = can('orgs:manage');

  const legs = useFetch(async (signal) => {
    if (!isReady || !user || accessDenied) return null;
    const query: CascadeLegQuery = {
      ...(status !== 'all' ? { status } : {}),
      ...(kind !== 'all' ? { kind } : {}),
      ...(subjectId ? { subjectId } : {}),
      limit: PAGE_SIZE,
      offset,
    };
    const r = await api.listCascadeLegs(query, { signal });
    if (!r.success || !r.data) throw new Error(r.message || 'Failed to load the cascade outbox');
    return r.data;
  }, [isReady, user?.id, !!accessDenied, status, kind, subjectId, offset]);

  const redrive = useMutation({
    fn: async (p: PendingRedrive, stepUpToken: string) => {
      const reason = p.reason.trim();
      const r = await api.redriveCascadeLeg(p.leg.id, { resetAttempts: p.resetAttempts, ...(reason ? { reason } : {}) }, stepUpToken);
      if (!r.success) throw new Error(r.message || 'The redrive was refused');
      return r;
    },
    formatError: (e) => (e instanceof MfaRequiredError ? '' : formatError(e, 'Could not redrive the leg')),
    onSuccess: (r, p) => {
      toast.success(r.message || `Cascade leg to ${p.leg.service} queued for redelivery`);
      void legs.refetch();
    },
    // A 409 (delivered meanwhile) or 404 means the row on screen is stale.
    onError: () => { void legs.refetch(); },
  });

  // A page left empty past the first (a redrive or a delivery moved its legs
  // out of the filter) steps back to the last page that has rows.
  const pageData = legs.data;
  useEffect(() => {
    if (pageData && pageData.legs.length === 0 && pageData.pagination.offset > 0) {
      const lastOffset = Math.max(0, Math.floor((pageData.pagination.total - 1) / PAGE_SIZE) * PAGE_SIZE);
      setOffset(Math.min(lastOffset, pageData.pagination.offset - PAGE_SIZE));
    }
  }, [pageData]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const rows = pageData?.legs ?? [];
  const page = pageData?.pagination;

  const applySubject = (e: FormEvent) => {
    e.preventDefault();
    setSubjectId(subjectInput.trim());
    setOffset(0);
  };

  const columns: Column<CascadeLeg>[] = [
    { id: 'kind', header: 'Kind', render: (l) => KIND_LABEL[l.kind] ?? l.kind },
    { id: 'subject', header: 'Subject', render: (l) => <CopyableId value={l.subjectId} size="sm" /> },
    { id: 'service', header: 'Service', cellClassName: 'font-mono text-xs', render: (l) => l.service },
    {
      id: 'status',
      header: 'State',
      render: (l) => <Badge color={STATUS_META[l.status]?.color ?? 'yellow'}>{STATUS_META[l.status]?.label ?? l.status}</Badge>,
    },
    { id: 'attempts', header: 'Attempts', cellClassName: 'font-mono text-xs', render: (l) => l.attempts },
    {
      id: 'error',
      header: 'Last error',
      cellClassName: 'text-xs text-fg-muted max-w-xs break-words',
      render: (l) => (l.lastError || l.lastStatusCode
        ? <span>{l.lastStatusCode ? <span className="font-mono">HTTP {l.lastStatusCode}</span> : null}{l.lastStatusCode && l.lastError ? ' · ' : null}{l.lastError}</span>
        : <span className="text-fg-subtle">—</span>),
    },
    {
      id: 'next',
      header: 'Next attempt',
      cellClassName: 'text-sm text-fg-muted',
      render: (l) => (l.status === 'pending' ? <RelativeTime value={l.nextAttemptAt} /> : <span className="text-fg-subtle">—</span>),
    },
    { id: 'updated', header: 'Updated', cellClassName: 'text-sm text-fg-muted', render: (l) => <RelativeTime value={l.updatedAt} /> },
    { id: 'created', header: 'Created', cellClassName: 'text-sm text-fg-muted', render: (l) => <RelativeTime value={l.createdAt} /> },
    {
      id: 'actions',
      header: '',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (l) => (l.status !== 'done' ? (
        <Button type="button" size="xs" variant="secondary" disabled={redrive.pending}
          readOnly={isReadOnly} disabledReason={canManage ? undefined : 'Requires orgs:manage'}
          onClick={() => setPending({ leg: l, resetAttempts: true, reason: '' })}>
          Redrive
        </Button>
      ) : null),
    },
  ];

  return (
    <DashboardLayout
      title="Cascade outbox"
      subtitle="Every downstream leg of an org purge or user erasure"
      breadcrumbs={[{ label: 'Platform settings', href: '/dashboard/admin/settings' }, { label: 'Cascade outbox' }]}
    >
      <div className="space-y-4">
        <ErrorAlert message={redrive.error} onDismiss={redrive.reset} />

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <Workflow className="w-5 h-5 text-fg-muted" />
              <h3 className="text-base font-semibold text-fg">Legs</h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FilterSelect aria-label="Filter by state" value={status}
                onChange={(e) => { setStatus(e.target.value as CascadeLegStatus | 'all'); setOffset(0); }}>
                <option value="all">All states</option>
                {(Object.keys(STATUS_META) as CascadeLegStatus[]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </FilterSelect>
              <FilterSelect aria-label="Filter by kind" value={kind}
                onChange={(e) => { setKind(e.target.value as CascadeKind | 'all'); setOffset(0); }}>
                <option value="all">All kinds</option>
                {(Object.keys(KIND_LABEL) as CascadeKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </FilterSelect>
              <form onSubmit={applySubject} className="flex items-center gap-2">
                <Input aria-label="Subject id" placeholder="Org or user id" value={subjectInput} maxLength={128}
                  onChange={(e) => setSubjectInput(e.target.value)} className="text-sm w-48" />
                <Button type="submit" size="sm" variant="secondary">Apply</Button>
              </form>
            </div>
          </div>
          {legs.error && <RetryError message={formatError(legs.error, 'Could not load the cascade outbox')} onRetry={legs.refetch} />}
          {!legs.error && (
            <DataTable
              data={rows}
              columns={columns}
              isLoading={legs.loading && !legs.data}
              animated={false}
              getRowKey={(l) => l.id}
              emptyState={{ icon: Workflow, title: 'No cascade legs', description: 'No leg matches these filters.' }}
            />
          )}
          {page && (page.offset > 0 || page.hasMore) && (
            <div className="flex items-center justify-end gap-2 mt-3 text-sm">
              <span className="text-fg-muted">{page.offset + 1}–{page.offset + rows.length} of {page.total}</span>
              <Button type="button" size="xs" variant="secondary" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}>Previous</Button>
              <Button type="button" size="xs" variant="secondary" disabled={!page.hasMore} onClick={() => setOffset(page.offset + PAGE_SIZE)}>Next</Button>
            </div>
          )}
        </Card>
      </div>

      {pending && (
        <StepUpModal
          title={`Redrive the ${pending.leg.service} leg?`}
          action={`Redrive the ${pending.leg.service} leg of ${KIND_LABEL[pending.leg.kind] ?? pending.leg.kind} ${pending.leg.subjectId}`}
          details={(
            <div className="space-y-3">
              <p>
                The leg goes back in the queue and is delivered on the next outbox tick. Fix the owning service first:
                its handler is idempotent, so a redrive is safe to repeat.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={pending.resetAttempts} onChange={(e) => setPending({ ...pending, resetAttempts: e.target.checked })} />
                <span>
                  Reset attempts
                  <span className="block text-xs text-fg-muted">
                    Off keeps the count, so a dead leg gets one more delivery before it goes dead again.
                  </span>
                </span>
              </label>
              <FormField label="Reason (optional, recorded in the audit log)">
                <Input value={pending.reason} maxLength={500} onChange={(e) => setPending({ ...pending, reason: e.target.value })} />
              </FormField>
            </div>
          )}
          onConfirmed={async (stepUpToken) => { await redrive.run(pending, stepUpToken); }}
          onClose={() => setPending(null)}
        />
      )}
    </DashboardLayout>
  );
}

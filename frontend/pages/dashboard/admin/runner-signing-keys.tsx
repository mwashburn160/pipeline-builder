// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform → Runner signing keys (system org).
 *
 * The operator's view of every organization's runner signing key: its mode
 * (own, or inherited from which ancestor), the active key id, its age,
 * rotation state and whether it can be decrypted — never key material. Filter
 * by over age, rotation, an in-progress switch and unreadable keys; each org
 * links to its drill-down.
 *
 * The two actions are the system-org ones: an emergency revoke of one org's
 * key, and the "Pause all pipeline runs" toggle. Because runners are the only
 * way a pipeline is started or stopped, pausing stops every run on the
 * deployment. Both need `orgs:manage` and a step-up; the page reads with
 * `orgs:read`.
 */

import { useState } from 'react';
import Link from 'next/link';
import { KeyRound, PauseCircle } from 'lucide-react';
import type { RunnerKeyStatusRow } from '@pipeline-builder/api-core/pipeline-runners';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
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
import type { RunnerKeyStatusQuery } from '@/lib/api/domains/pipelines';
import { MfaRequiredError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';

const PAGE_SIZE = 50;

/** The table's filter, as one select (each maps to one query parameter). */
const FILTERS = {
  all: { label: 'All organizations', query: {} },
  overAge: { label: 'Over age', query: { overAge: true } },
  pending: { label: 'Rotation pending', query: { rotation: 'pending' } },
  overlap: { label: 'Rotation overlap', query: { rotation: 'overlap' } },
  inTransition: { label: 'Key-mode switch in progress', query: { inTransition: true } },
  unreadable: { label: 'Unreadable', query: { unreadable: true } },
} as const satisfies Record<string, { label: string; query: RunnerKeyStatusQuery }>;
type FilterId = keyof typeof FILTERS;

type PendingAction =
  | { kind: 'pause'; paused: boolean; reason: string }
  | { kind: 'revoke'; row: RunnerKeyStatusRow; reason: string };

const ROTATION_LABEL = { none: 'None', pending: 'Pending', overlap: 'Overlap' } as const;

export default function RunnerSigningKeysPage() {
  const { accessDenied, isReady, user, can, isReadOnly } = useAuthGuard();
  const toast = useToast();
  const [filter, setFilter] = useState<FilterId>('all');
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const canManage = can('orgs:manage');

  const keys = useFetch(async (signal) => {
    if (!isReady || !user) return null;
    const r = await api.listRunnerSigningKeyStatus({ ...FILTERS[filter].query, limit: PAGE_SIZE, offset }, { signal });
    if (!r.success || !r.data) throw new Error(r.message || 'Failed to load runner signing keys');
    return r.data;
  }, [isReady, user?.id, filter, offset]);

  const deliveries = useFetch(async (signal) => {
    if (!isReady || !user) return null;
    const r = await api.getRunnerDeliveries({ signal });
    if (!r.success || !r.data) throw new Error(r.message || 'Failed to load the pause state');
    return r.data;
  }, [isReady, user?.id]);

  const action = useMutation({
    fn: async (p: PendingAction, stepUpToken: string) => {
      const reason = p.reason.trim() || undefined;
      const r = p.kind === 'pause'
        ? await api.setRunnerDeliveriesPaused({ paused: p.paused, reason }, stepUpToken)
        : await api.systemRevokeRunnerSigningKey(p.row.orgId, { reason }, stepUpToken);
      if (!r.success) throw new Error(r.message || 'The change was refused');
    },
    formatError: (e) => (e instanceof MfaRequiredError ? '' : formatError(e, 'Could not apply the change')),
    onSuccess: (_r, p) => {
      if (p.kind === 'pause') toast.success(p.paused ? 'All pipeline runs are paused' : 'Pipeline runs resumed');
      else toast.success(`Revoked the signing key of ${p.row.orgName ?? p.row.orgId}`);
      void deliveries.refetch();
      void keys.refetch();
    },
  });

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const paused = deliveries.data?.paused ?? false;
  const rows = keys.data?.orgs ?? [];
  const page = keys.data?.pagination;

  const columns: Column<RunnerKeyStatusRow>[] = [
    {
      id: 'org',
      header: 'Organization',
      render: (r) => <Link href={`/dashboard/admin/orgs/${encodeURIComponent(r.orgId)}`} className="action-link">{r.orgName ?? r.orgId}</Link>,
    },
    {
      id: 'mode',
      header: 'Mode',
      render: (r) => (r.mode === 'inherit'
        ? <span>Inherits{r.inheritedFrom ? <> from <Link href={`/dashboard/admin/orgs/${encodeURIComponent(r.inheritedFrom.orgId)}`} className="action-link">{r.inheritedFrom.orgName ?? r.inheritedFrom.orgId}</Link></> : null}</span>
        : <span>Own key</span>),
    },
    {
      id: 'kid',
      header: 'Active key',
      render: (r) => (r.activeKid ? <CopyableId value={r.activeKid} size="sm" /> : <span className="text-fg-subtle">—</span>),
    },
    {
      id: 'age',
      header: 'Age',
      render: (r) => (r.keyAgeDays === null ? <span className="text-fg-subtle">—</span> : (
        <span className="inline-flex items-center gap-1">
          {r.keyAgeDays} {r.keyAgeDays === 1 ? 'day' : 'days'}
          {r.overAge && <Badge color="yellow">Over age</Badge>}
        </span>
      )),
    },
    {
      id: 'rotation',
      header: 'Rotation',
      render: (r) => (
        <span className="inline-flex items-center gap-1">
          {ROTATION_LABEL[r.rotation] ?? r.rotation}
          {r.inTransition && <Badge color="blue">Switching</Badge>}
        </span>
      ),
    },
    {
      id: 'readable',
      header: 'Readable',
      render: (r) => (r.unreadable ? <Badge color="red">Unreadable</Badge> : <Badge color="green">OK</Badge>),
    },
    { id: 'runners', header: 'Runners', cellClassName: 'font-mono text-xs', render: (r) => r.runnerCount },
    {
      id: 'actions',
      header: '',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (r) => (r.mode === 'own' && r.activeKid ? (
        <Button type="button" size="xs" variant="danger-outline" disabled={action.pending}
          readOnly={isReadOnly} disabledReason={canManage ? undefined : 'Requires orgs:manage'}
          onClick={() => setPending({ kind: 'revoke', row: r, reason: '' })}>
          Revoke key
        </Button>
      ) : null),
    },
  ];

  return (
    <DashboardLayout
      title="Runner signing keys"
      subtitle="Every organization's runner signing key — status only, never key material"
      breadcrumbs={[{ label: 'Platform settings', href: '/dashboard/admin/settings' }, { label: 'Runner signing keys' }]}
    >
      <div className="space-y-4">
        <ErrorAlert message={action.error} onDismiss={action.reset} />

        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3" data-testid="runner-deliveries">
            <div className="flex items-start gap-2">
              <PauseCircle className="w-5 h-5 text-fg-muted mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-fg">Pause all pipeline runs</h3>
                <p className="text-sm text-fg-muted">
                  Stops all runner traffic at once, without a restart. Runners are the only way pipelines start and stop,
                  so this pauses every pipeline run on the deployment.
                </p>
                {deliveries.error && <RetryError message={formatError(deliveries.error, 'Could not load the pause state')} onRetry={deliveries.refetch} />}
                {deliveries.data && (
                  <p className="text-sm mt-1" data-testid="runner-deliveries-state">
                    {paused
                      ? <>
                        <Badge color="red">Paused</Badge>
                        {deliveries.data.pausedAt && <> since <RelativeTime value={deliveries.data.pausedAt} /></>}
                        {deliveries.data.reason && <> — {deliveries.data.reason}</>}
                      </>
                      : <Badge color="green">Running</Badge>}
                  </p>
                )}
              </div>
            </div>
            {deliveries.data && (
              <Button type="button" size="sm" variant={paused ? 'secondary' : 'danger'} disabled={action.pending}
                readOnly={isReadOnly} disabledReason={canManage ? undefined : 'Requires orgs:manage'}
                onClick={() => setPending({ kind: 'pause', paused: !paused, reason: '' })}>
                {paused ? 'Resume pipeline runs' : 'Pause all pipeline runs'}
              </Button>
            )}
          </div>
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-fg-muted" />
              <h3 className="text-base font-semibold text-fg">Organizations</h3>
            </div>
            <FilterSelect aria-label="Filter organizations" value={filter} onChange={(e) => { setFilter(e.target.value as FilterId); setOffset(0); }}>
              {Object.entries(FILTERS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
            </FilterSelect>
          </div>
          {keys.error && <RetryError message={formatError(keys.error, 'Could not load runner signing keys')} onRetry={keys.refetch} />}
          {!keys.error && (
            <DataTable
              data={rows}
              columns={columns}
              isLoading={keys.loading && !keys.data}
              animated={false}
              getRowKey={(r) => r.orgId}
              emptyState={{ icon: KeyRound, title: 'No organizations', description: 'No organization matches this filter.' }}
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
          title={pending.kind === 'pause'
            ? (pending.paused ? 'Pause all pipeline runs?' : 'Resume pipeline runs?')
            : `Revoke the signing key of ${pending.row.orgName ?? pending.row.orgId}?`}
          action={pending.kind === 'pause'
            ? (pending.paused ? 'Pause all runner traffic on the deployment' : 'Resume runner traffic on the deployment')
            : `Revoke the runner signing key of ${pending.row.orgName ?? pending.row.orgId}`}
          details={(
            <div className="space-y-3">
              {pending.kind === 'pause' && pending.paused && (
                <Callout variant="warning" title="This pauses every pipeline run">
                  <p>
                    Nothing is signed or delivered to any runner, and every Run and Stop on the deployment answers 409
                    RUNNERS_UNAVAILABLE until you resume. Pipeline pages show a banner while it is on.
                  </p>
                </Callout>
              )}
              {pending.kind === 'pause' && !pending.paused && <p>Runners are sent requests again, and queued runs resume.</p>}
              {pending.kind === 'revoke' && (
                <p>
                  The org&apos;s active key is retired at once and a new key signs from now on. Requests already signed with it
                  are refused and retried with the new one. The org&apos;s admins are notified.
                </p>
              )}
              <FormField label="Reason (optional, recorded in the audit log)">
                <Input value={pending.reason} maxLength={500} onChange={(e) => setPending({ ...pending, reason: e.target.value })} />
              </FormField>
            </div>
          )}
          onConfirmed={async (stepUpToken) => { await action.run(pending, stepUpToken); }}
          onClose={() => setPending(null)}
        />
      )}
    </DashboardLayout>
  );
}

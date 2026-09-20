// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline detail page.
 *
 * Lightweight surface that gives the recent-runs and executions tables a
 * real link target. Renders the pipeline identity (name, project,
 * organization), access/default/active badges, an inline edit + delete
 * flow, and a slim recent-runs summary derived from the execution-count
 * report (no per-pipeline executions endpoint exists yet, so the row is
 * filtered out of the org-wide aggregate).
 */

import { useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useUrlTab } from '@/hooks/useUrlTab';
import Link from 'next/link';
import { ArrowLeft, Ban, ExternalLink, GitBranch, LayoutTemplate, Pencil, Play, Rocket, Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useEntityFetch } from '@/hooks/useEntityFetch';
import { useFetch } from '@/hooks/useFetch';
import { useQuery } from '@/hooks/useQuery';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { TabBar } from '@/components/ui/TabBar';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RetryError } from '@/components/ui/RetryError';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Modal } from '@/components/ui/Modal';
import { ScorecardCard } from '@/components/pipeline/ScorecardCard';
import { PipelineContextCard } from '@/components/pipeline/PipelineContextCard';
import { LifecycleBadge } from '@/components/ui/LifecycleBadge';
import { canWritePipeline } from '@/lib/resource-helpers';
import api from '@/lib/api';
import { invalidate, queries } from '@/lib/api-cache';
import type { PipelineDeployment } from '@/lib/api/domains/pipelines';
import type { Pipeline } from '@/types';
import { formatError } from '@/lib/constants';
import { formatDuration } from '@/lib/format';

// The edit wizard and save-as-template modal load on first use.
const EditPipelineModal = dynamic(() => import('@/components/pipeline/EditPipelineModal'), { ssr: false });
const CreateTemplateModal = dynamic(() => import('@/components/pipeline/CreateTemplateModal').then((m) => m.CreateTemplateModal), { ssr: false });

/** Registry drain page size + runaway guard (~5k rows) for the deployment lookup. */
const REGISTRY_PAGE = 200;
const REGISTRY_MAX_PAGES = 25;

interface PipelineExecution {
  execution_id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  failing_stage: string | null;
  failing_action: string | null;
}

/** Map a rolled-up execution status to a Badge color. */
function statusColor(status: string): 'green' | 'red' | 'gray' | 'yellow' {
  if (status === 'succeeded') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'in-progress') return 'yellow';
  return 'gray'; // canceled / unknown
}


const DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Runs' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['id'];
const DETAIL_TAB_IDS: readonly DetailTab[] = DETAIL_TABS.map((t) => t.id);

export default function PipelineDetailPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const { accessDenied, isReady, user, isSuperAdmin, can } = useAuthGuard();
  const toast = useToast();

  // Detail sections split into Overview (metadata) + Runs (recent runs +
  // executions) so it isn't one long scroll. Deep-linkable via `?tab=` (kept
  // separate from the `?id` route param).
  const [activeTab, changeTab] = useUrlTab<DetailTab>('tab', DETAIL_TAB_IDS, 'overview');

  const fetchPipeline = useCallback(async (pipelineId: string): Promise<Pipeline> => {
    const response = await api.getPipelineById(pipelineId);
    if (!response.success || !response.data?.pipeline) {
      throw new Error(response.message || 'Pipeline not found');
    }
    return response.data.pipeline;
  }, []);
  const { entity: pipeline, fetching, error: fetchError, reload: reloadPipeline } = useEntityFetch<Pipeline>(
    id || null,
    fetchPipeline,
  );

  // Recent runs — filtered from the org-wide execution-count report (shared
  // cache: Executions and the home page read the same aggregate). The report
  // has no per-pipeline endpoint, so pick this pipeline's row. Non-blocking;
  // absence just hides the panel.
  const execCounts = useQuery(id ? queries.executionCount() : null);
  const execStats = useMemo(
    () => execCounts.data?.data?.pipelines.find((p) => p.id === id) ?? null,
    [execCounts.data, id],
  );

  // Resolve owner/creator/updater user-ids → usernames (raw ids are unfriendly).
  // Non-blocking: falls back to the id if the roster can't be loaded.
  const roster = useQuery(user?.organizationId ? queries.orgMembers(user.organizationId, { limit: 500 }) : null);
  const memberNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of roster.data?.data?.members ?? []) map[m.id] = m.username;
    return map;
  }, [roster.data]);

  // Live deployment (from the registry) for this pipeline — powers the Deployment
  // card + the "View stack in AWS" link. Non-blocking; absent → card hidden.
  // The registry endpoint is page-limited and has no per-pipeline filter, so
  // page through until this pipeline's row is found (early-exit) or the list is
  // drained — a single-page fetch would miss it in orgs with >200 deployments.
  const deploymentQ = useFetch(async (signal): Promise<{ id: string; match: PipelineDeployment | null }> => {
    if (!id) return { id, match: null };
    try {
      for (let i = 0, offset = 0; i < REGISTRY_MAX_PAGES; i++) {
        const r = await api.listPipelineDeployments({ limit: REGISTRY_PAGE, offset }, { signal });
        if (!r.data) break;
        const rows = r.data.registry;
        const match = rows.find((d) => d.pipelineId === id);
        if (match) return { id, match };
        if (!r.data.pagination.hasMore || rows.length === 0) break;
        offset += rows.length;
      }
    } catch {
      /* non-blocking — card just won't render */
    }
    return { id, match: null };
  }, [id]);
  // Keyed on the id it was read for: this page is reached by same-pathname
  // navigation (⌘K jumps between pipelines), so the component is NOT remounted
  // and the previous pipeline's card — and its "View stack in AWS" link — must
  // not linger while the new id's lookup is in flight.
  const deployment = deploymentQ.data?.id === id ? deploymentQ.data.match : null;

  // Per-pipeline execution history — list of recent runs from the reporting
  // service (the events the pipeline-events Lambda persists). The read is a
  // query against already-ingested data; the trigger/cancel actions below call
  // AWS CodePipeline directly, then refetch this list to surface the change.
  const execQ = useFetch(async (signal): Promise<PipelineExecution[] | null> => {
    if (!id) return null;
    const r = await api.listPipelineExecutions(id, { limit: 50 }, { signal });
    if (!r.success) throw new Error(r.message || 'Failed to load executions');
    return r.data?.executions ?? [];
  }, [id]);
  const executions = execQ.data;
  const execLoading = execQ.loading;
  const execError = execQ.error ? formatError(execQ.error, 'Failed to load executions') : null;
  const loadExecutions = execQ.refetch;

  // Write actions (AWS CodePipeline trigger / cancel). Ingestion of the new
  // event is asynchronous, so we refetch after a short delay to let the
  // pipeline-events Lambda persist the run before we re-query.
  const [triggering, setTriggering] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const REFETCH_DELAY_MS = 2500;

  const handleTrigger = useCallback(async () => {
    if (!id) return;
    setTriggering(true);
    setActionError(null);
    try {
      const res = await api.triggerPipelineExecution(id);
      if (!res.success) throw new Error(res.message || 'Failed to trigger execution');
      toast.success(`Started execution ${res.data?.executionId ?? ''}`.trim());
      setTimeout(loadExecutions, REFETCH_DELAY_MS);
    } catch (e) {
      setActionError(formatError(e, 'Failed to trigger execution'));
    } finally {
      setTriggering(false);
    }
  }, [id, loadExecutions, toast]);

  const confirmCancel = useCallback(async () => {
    if (!id || !cancelTarget) return;
    setCanceling(true);
    setActionError(null);
    try {
      const res = await api.stopPipelineExecution(id, cancelTarget, { reason: 'Canceled from dashboard' });
      if (!res.success) throw new Error(res.message || 'Failed to cancel execution');
      toast.success('Execution canceled');
      setTimeout(loadExecutions, REFETCH_DELAY_MS);
    } catch (e) {
      setActionError(formatError(e, 'Failed to cancel execution'));
    } finally {
      setCanceling(false);
      setCancelTarget(null);
    }
  }, [id, cancelTarget, loadExecutions, toast]);

  const [showEdit, setShowEdit] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const canWrite = can('pipelines:write');
  const canPublish = can('pipelines:publish');
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const confirmDelete = useCallback(async () => {
    if (!pipeline) return;
    setDeleting(true);
    try {
      const res = await api.deletePipeline(pipeline.id);
      if (!res.success) throw new Error(res.message || 'Delete failed');
      // Every cached pipeline list still holds the deleted row — drop them
      // before landing on the list page.
      invalidate.pipelines();
      toast.success('Pipeline deleted');
      router.push('/dashboard/pipelines');
    } catch (e) {
      setActionError(formatError(e, 'Failed to delete pipeline'));
    } finally {
      setDeleting(false);
      setShowDelete(false);
    }
  }, [pipeline, router, toast]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const execColumns: Column<PipelineExecution>[] = [
    { id: 'status', header: 'Status', render: (ex) => <Badge color={statusColor(ex.status)}>{ex.status}</Badge> },
    { id: 'started', header: 'Started', render: (ex) => (ex.started_at ? <RelativeTime value={ex.started_at} /> : <span className="text-fg-subtle">—</span>) },
    { id: 'duration', header: 'Duration', cellClassName: 'font-mono text-xs', render: (ex) => formatDuration(ex.duration_ms) },
    {
      id: 'failing',
      header: 'Failing step',
      render: (ex) => (ex.failing_stage || ex.failing_action
        ? <span className="text-red-600 dark:text-red-400">{ex.failing_stage || ex.failing_action}</span>
        : <span className="text-fg-subtle">—</span>),
    },
    { id: 'execution', header: 'Execution', render: (ex) => <CopyableId value={ex.execution_id} size="sm" /> },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (ex) => (ex.status === 'in-progress' ? (
        <Button
          variant="secondary"
          onClick={() => setCancelTarget(ex.execution_id)}
          disabled={!canEdit || (canceling && cancelTarget === ex.execution_id)}
          className="inline-flex items-center gap-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          title={canEdit ? 'Cancel this execution' : 'Read-only (public catalog entry)'}
        >
          {canceling && cancelTarget === ex.execution_id ? <LoadingSpinner size="sm" /> : <Ban className="w-3.5 h-3.5" />}
          Cancel
        </Button>
      ) : (
        <span className="text-fg-subtle">—</span>
      )),
    },
  ];

  // Write controls (run / cancel / edit / delete) require BOTH the
  // `pipelines:write` capability and ownership of the resource — the backend
  // gates every pipeline mutation on `pipelines:write`, so a read-only member
  // must not see them enabled (matches the list page).
  const canEdit = pipeline ? canWritePipeline(can, isSuperAdmin, pipeline, user?.id) : false;

  return (
    <DashboardLayout
      title={pipeline?.pipelineName || pipeline?.project || 'Pipeline'}
      subtitle="Pipeline detail"
      breadcrumbs={[
        { label: 'Pipelines', href: '/dashboard/pipelines' },
        { label: pipeline?.pipelineName || pipeline?.project || 'Pipeline' },
      ]}
      actions={pipeline ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={handleTrigger}
            disabled={!canEdit || triggering}
            className="inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            title={canEdit ? undefined : 'Read-only (public catalog entry)'}
          >
            {triggering ? <LoadingSpinner size="sm" /> : <Play className="w-4 h-4" />}
            {executions && executions.length > 0 ? 'Re-run' : 'Run pipeline'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShowEdit(true)}
            disabled={!canEdit}
            className="inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            title={canEdit ? undefined : 'Read-only (public catalog entry)'}
          >
            <Pencil className="w-4 h-4" /> Edit
          </Button>
          <Button
            variant="secondary"
            onClick={() => setShowSaveTemplate(true)}
            disabled={!canWrite}
            className="inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            title={canWrite ? 'Save this pipeline as a reusable golden-path template' : 'Requires pipelines:write'}
          >
            <LayoutTemplate className="w-4 h-4" /> Save as template
          </Button>
          <Button
            variant="danger"
            onClick={() => setShowDelete(true)}
            disabled={!canEdit}
            className="inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            title={canEdit ? undefined : 'Read-only (public catalog entry)'}
          >
            <Trash2 className="w-4 h-4" /> Delete
          </Button>
        </div>
      ) : undefined}
    >
      <div className="mb-4">
        <Link href="/dashboard/pipelines" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to pipelines
        </Link>
      </div>

      {fetchError && !pipeline && (
        <RetryError message={formatError(fetchError, 'Failed to load pipeline')} onRetry={reloadPipeline} className="mb-4" />
      )}
      <ErrorAlert message={actionError} onDismiss={() => setActionError(null)} />

      {fetching && !pipeline && <LoadingSpinner />}

      {pipeline && (
        <>
        <TabBar items={[...DETAIL_TABS]} activeId={activeTab} onSelect={(tabId) => changeTab(tabId as DetailTab)} className="mb-4" />

        {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Per-pipeline maturity scorecard (renders only when advanced_reporting is on) */}
          <ScorecardCard pipelineId={pipeline.id} />
          {/* Cross-resource context: plugins used + live compliance posture */}
          <PipelineContextCard pipeline={pipeline} />
          {/* Live deployment (registry) — where this pipeline is deployed + a
              deep link to its CloudFormation stack. Hidden until registered. */}
          {deployment && (
            <Card>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Rocket className="w-5 h-5 text-fg-muted" />
                  <h3 className="text-base font-semibold text-fg">Deployment</h3>
                </div>
                <Link href="/dashboard/deployments" className="action-link text-xs">All deployments →</Link>
              </div>
              <dl className="text-sm space-y-2">
                <div className="flex justify-between">
                  <dt className="text-fg-muted">Region</dt>
                  <dd>{deployment.region || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-muted">Stack</dt>
                  <dd className="font-mono text-xs truncate">{deployment.stackName || '—'}</dd>
                </div>
                {deployment.lastDeployed && (
                  <div className="flex justify-between">
                    <dt className="text-fg-muted">Deployed</dt>
                    <dd><RelativeTime value={deployment.lastDeployed} /></dd>
                  </div>
                )}
              </dl>
              {deployment.region && deployment.stackName && (
                <a
                  href={`https://${deployment.region}.console.aws.amazon.com/cloudformation/home?region=${deployment.region}#/stacks?filteringText=${encodeURIComponent(deployment.stackName)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="action-link text-xs inline-flex items-center gap-1 mt-3"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> View stack in AWS
                </a>
              )}
            </Card>
          )}
          {/* Identity card */}
          <Card>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <GitBranch className="w-5 h-5 text-fg-muted" />
                <h3 className="text-base font-semibold text-fg">Identity</h3>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Badge color={pipeline.visibility === 'public' ? 'green' : 'gray'}>{pipeline.visibility}</Badge>
                <Badge color={pipeline.isActive ? 'green' : 'red'}>{pipeline.isActive ? 'Active' : 'Inactive'}</Badge>
                {pipeline.isDefault && <Badge color="blue">Default</Badge>}
              </div>
            </div>
            <dl className="text-sm space-y-2">
              <div>
                <dt className="text-fg-muted">Pipeline id</dt>
                <dd><CopyableId value={pipeline.id} size="sm" /></dd>
              </div>
              <div>
                <dt className="text-fg-muted">Name</dt>
                <dd>{pipeline.pipelineName || <span className="text-fg-subtle">Unnamed</span>}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Project</dt>
                <dd>{pipeline.project}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Organization</dt>
                <dd>{pipeline.organization}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Owner</dt>
                <dd>
                  {pipeline.ownerId
                    ? <>{memberNames[pipeline.ownerId] ?? <code className="text-xs">{pipeline.ownerId}</code>}{pipeline.ownerType ? <span className="text-fg-subtle"> ({pipeline.ownerType})</span> : null}</>
                    : <span className="text-fg-subtle">Unassigned</span>}
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">Lifecycle</dt>
                <dd className="flex items-center gap-1">
                  <LifecycleBadge value={pipeline.lifecycle} />
                  {pipeline.criticality ? <span className="text-fg-subtle"> · {pipeline.criticality} criticality</span> : null}
                </dd>
              </div>
              {pipeline.description && (
                <div>
                  <dt className="text-fg-muted">Description</dt>
                  <dd>{pipeline.description}</dd>
                </div>
              )}
              {pipeline.keywords && pipeline.keywords.length > 0 && (
                <div>
                  <dt className="text-fg-muted">Keywords</dt>
                  <dd className="flex flex-wrap gap-1">
                    {pipeline.keywords.map((k, i) => (
                      <span key={`${k}-${i}`} className="px-2 py-0.5 rounded-full text-xs bg-surface-muted text-fg-muted">{k}</span>
                    ))}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-fg-muted">Created</dt>
                <dd><RelativeTime value={pipeline.createdAt} /> by {pipeline.createdBy ? (memberNames[pipeline.createdBy] ?? <code className="text-xs">{pipeline.createdBy}</code>) : '—'}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">Updated</dt>
                <dd><RelativeTime value={pipeline.updatedAt} /> by {pipeline.updatedBy ? (memberNames[pipeline.updatedBy] ?? <code className="text-xs">{pipeline.updatedBy}</code>) : '—'}</dd>
              </div>
            </dl>
          </Card>
        </div>
        )}

        {activeTab === 'runs' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Recent runs card — derived from org-wide execution-count
              aggregate. Absent if the pipeline has no recorded runs. */}
          <Card>
            <h3 className="text-base font-semibold text-fg mb-3">Recent runs</h3>
            {execStats ? (
              <dl className="text-sm space-y-1.5">
                <div className="flex justify-between">
                  <dt className="text-fg-muted">Total executions</dt>
                  <dd className="font-mono text-xs">{execStats.total}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-fg-muted">Succeeded</dt>
                  <dd className="font-mono text-xs text-green-600 dark:text-green-400">{execStats.succeeded}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-fg-muted">Failed</dt>
                  <dd className="font-mono text-xs text-red-600 dark:text-red-400">{execStats.failed}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-fg-muted">Canceled</dt>
                  <dd className="font-mono text-xs">{execStats.canceled}</dd>
                </div>
                {execStats.last_execution && (
                  <div className="flex justify-between">
                    <dt className="text-fg-muted">Last run</dt>
                    <dd><RelativeTime value={execStats.last_execution} /></dd>
                  </div>
                )}
                {executions && executions.length > 0 && (
                  <div className="pt-2 mt-1 border-t border-default space-y-1.5">
                    {executions.slice(0, 3).map((ex) => (
                      <div key={ex.execution_id} className="flex items-center justify-between">
                        <Badge color={statusColor(ex.status)}>{ex.status}</Badge>
                        <span className="text-xs text-fg-subtle">
                          {ex.started_at ? <RelativeTime value={ex.started_at} /> : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="pt-2">
                  <Link href="/dashboard/executions" className="action-link text-xs">
                    View all executions →
                  </Link>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-fg-muted">No recorded runs yet.</p>
            )}
          </Card>

          {/* Executions card — per-pipeline run history from the reporting
              service, plus the AWS CodePipeline trigger / cancel write path.
              "Run pipeline" calls StartPipelineExecution; per-row "Cancel"
              (in-progress only) calls StopPipelineExecution. Both refetch the
              list after a short delay so the change surfaces. */}
          <Card className="lg:col-span-2">
            <h3 className="text-base font-semibold text-fg mb-3">Executions</h3>
            {execLoading && !executions && <LoadingSpinner />}
            {execError && <RetryError message={execError} onRetry={loadExecutions} />}
            {!execLoading && !execError && executions && executions.length === 0 && (
              <p className="text-sm text-fg-muted">No executions recorded yet.</p>
            )}
            {!execError && executions && executions.length > 0 && (
              <div className="overflow-x-auto">
                <DataTable
                  data={executions}
                  columns={execColumns}
                  isLoading={false}
                  animated={false}
                  getRowKey={(ex) => ex.execution_id}
                  emptyState={{ icon: Play, title: 'No executions', description: 'No executions recorded yet.' }}
                />
              </div>
            )}
          </Card>
        </div>
        )}
        </>
      )}

      {showEdit && pipeline && (
        <EditPipelineModal
          pipeline={pipeline}
          canPublish={can('pipelines:publish')}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); reloadPipeline(); }}
        />
      )}

      {showSaveTemplate && pipeline && (
        <CreateTemplateModal
          pipeline={pipeline}
          canPublish={canPublish}
          onClose={() => setShowSaveTemplate(false)}
          onCreated={() => setShowSaveTemplate(false)}
        />
      )}

      {cancelTarget && (
        <Modal
          title="Cancel execution"
          onClose={() => { if (!canceling) setCancelTarget(null); }}
          footer={(
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setCancelTarget(null)} disabled={canceling}>
                Keep running
              </Button>
              <Button variant="danger" onClick={confirmCancel} disabled={canceling} className="inline-flex items-center gap-2">
                {canceling ? <LoadingSpinner size="sm" /> : <Ban className="w-4 h-4" />}
                Cancel execution
              </Button>
            </div>
          )}
        >
          <p className="text-sm text-fg-muted">
            Stop the in-progress execution <code className="text-xs">{cancelTarget}</code>? In-progress
            stages will be halted. This cannot be undone.
          </p>
        </Modal>
      )}

      {showDelete && pipeline && (
        <DeleteConfirmModal
          title="Delete pipeline"
          itemName={pipeline.pipelineName || 'Unnamed Pipeline'}
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </DashboardLayout>
  );
}

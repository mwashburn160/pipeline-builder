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

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ArrowLeft, Ban, ExternalLink, GitBranch, LayoutTemplate, Pencil, Play, Rocket, Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useEntityFetch } from '@/hooks/useEntityFetch';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { TabBar } from '@/components/ui/TabBar';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Modal } from '@/components/ui/Modal';
import EditPipelineModal from '@/components/pipeline/EditPipelineModal';
import { CreateTemplateModal } from '@/components/pipeline/CreateTemplateModal';
import { ScorecardCard } from '@/components/pipeline/ScorecardCard';
import { PipelineContextCard } from '@/components/pipeline/PipelineContextCard';
import { LifecycleBadge } from '@/components/ui/LifecycleBadge';
import { formatError } from '@/lib/constants';
import { canWritePipeline } from '@/lib/resource-helpers';
import api from '@/lib/api';
import type { PipelineDeployment } from '@/lib/api/domains/pipelines';
import type { Pipeline } from '@/types';

interface ExecutionRow {
  id: string;
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  first_execution: string | null;
  last_execution: string | null;
}

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

/** Human-friendly duration from milliseconds. */
function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

const DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Runs' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['id'];
const DETAIL_TAB_IDS = DETAIL_TABS.map((t) => t.id) as readonly string[];

export default function PipelineDetailPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const { isReady, user, isSuperAdmin, can } = useAuthGuard();
  const toast = useToast();

  // Detail sections split into Overview (metadata) + Runs (recent runs +
  // executions) so it isn't one long scroll. Deep-linkable via `?tab=` (kept
  // separate from the `?id` route param).
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  useEffect(() => {
    const raw = Array.isArray(router.query.tab) ? router.query.tab[0] : router.query.tab;
    if (raw && DETAIL_TAB_IDS.includes(raw) && raw !== activeTab) setActiveTab(raw as DetailTab);
  }, [router.query.tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeTab = (tabId: string) => {
    setActiveTab(tabId as DetailTab);
    void router.replace({ query: { ...router.query, tab: tabId } }, undefined, { shallow: true });
  };

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

  // Recent runs — filtered from the org-wide execution-count report.
  // The report has no per-pipeline endpoint, so we fetch the aggregate
  // and pick the row matching this pipeline. Non-blocking; absence just
  // hides the panel.
  const [execStats, setExecStats] = useState<ExecutionRow | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.getExecutionCount()
      .then((r) => {
        if (cancelled) return;
        const row = (r.data?.pipelines ?? []).find((p) => p.id === id) ?? null;
        setExecStats(row);
      })
      .catch(() => { /* non-blocking — panel just won't render */ });
    return () => { cancelled = true; };
  }, [id]);

  // Resolve owner/creator/updater user-ids → usernames (raw ids are unfriendly).
  // Non-blocking: falls back to the id if the roster can't be loaded.
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!user?.organizationId) return;
    let cancelled = false;
    api.getOrganizationMembers(user.organizationId, { limit: 500 })
      .then((r) => {
        if (cancelled || !r.data) return;
        const map: Record<string, string> = {};
        for (const m of r.data.members) map[m.id] = m.username;
        setMemberNames(map);
      })
      .catch(() => { /* non-blocking — fall back to raw ids */ });
    return () => { cancelled = true; };
  }, [user?.organizationId]);

  // Live deployment (from the registry) for this pipeline — powers the Deployment
  // card + the "View stack in AWS" link. Non-blocking; absent → card hidden.
  const [deployment, setDeployment] = useState<PipelineDeployment | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // The registry endpoint is page-limited and has no per-pipeline filter, so
    // page through until this pipeline's row is found (early-exit) or the list is
    // drained — a single-page fetch would miss it in orgs with >200 deployments.
    (async () => {
      const PAGE = 200;
      const MAX_PAGES = 25; // safety bound (~5k rows)
      for (let i = 0, offset = 0; i < MAX_PAGES && !cancelled; i++) {
        const r = await api.listPipelineDeployments({ limit: PAGE, offset });
        if (cancelled || !r.data) return;
        const rows = r.data.registry;
        const match = rows.find((d) => d.pipelineId === id);
        if (match) { setDeployment(match); return; }
        if (!r.data.pagination.hasMore || rows.length === 0) return;
        offset += rows.length;
      }
    })().catch(() => { /* non-blocking — card just won't render */ });
    return () => { cancelled = true; };
  }, [id]);

  // Per-pipeline execution history — list of recent runs from the reporting
  // service (the events the pipeline-events Lambda persists). The read is a
  // query against already-ingested data; the trigger/cancel actions below call
  // AWS CodePipeline directly, then refetch this list to surface the change.
  const [executions, setExecutions] = useState<PipelineExecution[] | null>(null);
  const [execLoading, setExecLoading] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const loadExecutions = useCallback(async () => {
    if (!id) return;
    setExecLoading(true);
    setExecError(null);
    try {
      const r = await api.listPipelineExecutions(id, { limit: 50 });
      if (!r.success) throw new Error(r.message || 'Failed to load executions');
      setExecutions(r.data?.executions ?? []);
    } catch (e) {
      setExecError(formatError(e, 'Failed to load executions'));
    } finally {
      setExecLoading(false);
    }
  }, [id]);
  useEffect(() => { void loadExecutions(); }, [loadExecutions]);

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
      setTimeout(() => { void loadExecutions(); }, REFETCH_DELAY_MS);
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
      setTimeout(() => { void loadExecutions(); }, REFETCH_DELAY_MS);
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
      toast.success('Pipeline deleted');
      router.push('/dashboard/pipelines');
    } catch (e) {
      setActionError(formatError(e, 'Failed to delete pipeline'));
    } finally {
      setDeleting(false);
      setShowDelete(false);
    }
  }, [pipeline, router, toast]);

  if (!isReady || !user) return <LoadingPage />;

  const execColumns: Column<PipelineExecution>[] = [
    { id: 'status', header: 'Status', render: (ex) => <Badge color={statusColor(ex.status)}>{ex.status}</Badge> },
    { id: 'started', header: 'Started', render: (ex) => (ex.started_at ? <RelativeTime value={ex.started_at} /> : <span className="text-gray-400">—</span>) },
    { id: 'duration', header: 'Duration', cellClassName: 'font-mono text-xs', render: (ex) => formatDuration(ex.duration_ms) },
    {
      id: 'failing',
      header: 'Failing step',
      render: (ex) => (ex.failing_stage || ex.failing_action
        ? <span className="text-red-600 dark:text-red-400">{ex.failing_stage || ex.failing_action}</span>
        : <span className="text-gray-400">—</span>),
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
        <span className="text-gray-400">—</span>
      )),
    },
  ];

  // Write controls (run / cancel / edit / delete) require BOTH the
  // `pipelines:write` capability and ownership of the resource — the backend
  // gates every pipeline mutation on `pipelines:write`, so a read-only member
  // must not see them enabled (matches the list page).
  const canEdit = pipeline ? canWritePipeline(can, isSuperAdmin, pipeline.accessModifier) : false;

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

      <ErrorAlert message={fetchError?.message} />
      <ErrorAlert message={actionError} onDismiss={() => setActionError(null)} />

      {fetching && !pipeline && <LoadingSpinner />}

      {pipeline && (
        <>
        <TabBar items={[...DETAIL_TABS]} activeId={activeTab} onSelect={changeTab} className="mb-4" />

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
                  <Rocket className="w-5 h-5 text-gray-500" />
                  <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Deployment</h3>
                </div>
                <Link href="/dashboard/deployments" className="action-link text-xs">All deployments →</Link>
              </div>
              <dl className="text-sm space-y-2">
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Region</dt>
                  <dd>{deployment.region || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-500 dark:text-gray-400">Stack</dt>
                  <dd className="font-mono text-xs truncate">{deployment.stackName || '—'}</dd>
                </div>
                {deployment.lastDeployed && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Deployed</dt>
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
                <GitBranch className="w-5 h-5 text-gray-500" />
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Identity</h3>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Badge color={pipeline.accessModifier === 'public' ? 'green' : 'gray'}>{pipeline.accessModifier}</Badge>
                <Badge color={pipeline.isActive ? 'green' : 'red'}>{pipeline.isActive ? 'Active' : 'Inactive'}</Badge>
                {pipeline.isDefault && <Badge color="blue">Default</Badge>}
              </div>
            </div>
            <dl className="text-sm space-y-2">
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Pipeline id</dt>
                <dd><CopyableId value={pipeline.id} size="sm" /></dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Name</dt>
                <dd>{pipeline.pipelineName || <span className="text-gray-400">Unnamed</span>}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Project</dt>
                <dd>{pipeline.project}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Organization</dt>
                <dd>{pipeline.organization}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Owner</dt>
                <dd>
                  {pipeline.ownerId
                    ? <>{memberNames[pipeline.ownerId] ?? <code className="text-xs">{pipeline.ownerId}</code>}{pipeline.ownerType ? <span className="text-gray-400"> ({pipeline.ownerType})</span> : null}</>
                    : <span className="text-gray-400">Unassigned</span>}
                </dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Lifecycle</dt>
                <dd className="flex items-center gap-1">
                  <LifecycleBadge value={pipeline.lifecycle} />
                  {pipeline.criticality ? <span className="text-gray-400"> · {pipeline.criticality} criticality</span> : null}
                </dd>
              </div>
              {pipeline.description && (
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">Description</dt>
                  <dd>{pipeline.description}</dd>
                </div>
              )}
              {pipeline.keywords && pipeline.keywords.length > 0 && (
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">Keywords</dt>
                  <dd className="flex flex-wrap gap-1">
                    {pipeline.keywords.map((k, i) => (
                      <span key={`${k}-${i}`} className="px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">{k}</span>
                    ))}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Created</dt>
                <dd><RelativeTime value={pipeline.createdAt} /> by {pipeline.createdBy ? (memberNames[pipeline.createdBy] ?? <code className="text-xs">{pipeline.createdBy}</code>) : '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Updated</dt>
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
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Recent runs</h3>
            {execStats ? (
              <dl className="text-sm space-y-1.5">
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Total executions</dt>
                  <dd className="font-mono text-xs">{execStats.total}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Succeeded</dt>
                  <dd className="font-mono text-xs text-green-600 dark:text-green-400">{execStats.succeeded}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Failed</dt>
                  <dd className="font-mono text-xs text-red-600 dark:text-red-400">{execStats.failed}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500 dark:text-gray-400">Canceled</dt>
                  <dd className="font-mono text-xs">{execStats.canceled}</dd>
                </div>
                {execStats.last_execution && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Last run</dt>
                    <dd><RelativeTime value={execStats.last_execution} /></dd>
                  </div>
                )}
                {executions && executions.length > 0 && (
                  <div className="pt-2 mt-1 border-t border-gray-200 dark:border-gray-700 space-y-1.5">
                    {executions.slice(0, 3).map((ex) => (
                      <div key={ex.execution_id} className="flex items-center justify-between">
                        <Badge color={statusColor(ex.status)}>{ex.status}</Badge>
                        <span className="text-xs text-gray-400">
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
              <p className="text-sm text-gray-500 dark:text-gray-400">No recorded runs yet.</p>
            )}
          </Card>

          {/* Executions card — per-pipeline run history from the reporting
              service, plus the AWS CodePipeline trigger / cancel write path.
              "Run pipeline" calls StartPipelineExecution; per-row "Cancel"
              (in-progress only) calls StopPipelineExecution. Both refetch the
              list after a short delay so the change surfaces. */}
          <Card className="lg:col-span-2">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Executions</h3>
            {execLoading && !executions && <LoadingSpinner />}
            <ErrorAlert message={execError} />
            {!execLoading && !execError && executions && executions.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">No executions recorded yet.</p>
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
          isSuperAdmin={isSuperAdmin}
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
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Stop the in-progress execution <code className="text-xs">{cancelTarget}</code>? In-progress
            stages will be halted. This cannot be undone.
          </p>
        </Modal>
      )}

      {showDelete && pipeline && (
        <DeleteConfirmModal
          title="Delete Pipeline"
          itemName={pipeline.pipelineName || 'Unnamed Pipeline'}
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </DashboardLayout>
  );
}

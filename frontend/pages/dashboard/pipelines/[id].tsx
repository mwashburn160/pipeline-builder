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
import { ArrowLeft, GitBranch, Pencil, Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useEntityFetch } from '@/hooks/useEntityFetch';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import EditPipelineModal from '@/components/pipeline/EditPipelineModal';
import { formatError } from '@/lib/constants';
import { canModify } from '@/lib/resource-helpers';
import api from '@/lib/api';
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

export default function PipelineDetailPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const { isReady, user, isSuperAdmin } = useAuthGuard();
  const toast = useToast();

  const fetchPipeline = useCallback(async (pipelineId: string): Promise<Pipeline> => {
    const response = await api.getPipelineById(pipelineId);
    if (!response.success || !response.data?.pipeline) {
      throw new Error(response.message || 'Pipeline not found');
    }
    return response.data.pipeline;
  }, []);
  const { entity: pipeline, fetching, error: fetchError } = useEntityFetch<Pipeline>(
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

  const [showEdit, setShowEdit] = useState(false);
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

  const canEdit = pipeline ? canModify(isSuperAdmin, pipeline.accessModifier) : false;

  return (
    <DashboardLayout
      title={pipeline?.pipelineName || pipeline?.project || 'Pipeline'}
      subtitle="Pipeline detail"
      breadcrumbs={[
        { label: 'Pipelines', href: '/dashboard/pipelines' },
        { label: pipeline?.pipelineName || pipeline?.project || 'Pipeline' },
      ]}
    >
      <div className="mb-4">
        <Link href="/dashboard/pipelines" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to pipelines
        </Link>
      </div>

      {fetchError && (
        <div className="alert-error">
          <p>{fetchError.message}</p>
        </div>
      )}
      {actionError && (
        <div className="alert-error">
          <p>{actionError}</p>
          <button onClick={() => setActionError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      {fetching && !pipeline && <LoadingSpinner />}

      {pipeline && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Identity card */}
          <div className="card">
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
                <dd><CopyableId value={pipeline.id} small /></dd>
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
                <dd><RelativeTime value={pipeline.createdAt} /> by <code className="text-xs">{pipeline.createdBy}</code></dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">Updated</dt>
                <dd><RelativeTime value={pipeline.updatedAt} /> by <code className="text-xs">{pipeline.updatedBy}</code></dd>
              </div>
            </dl>
          </div>

          {/* Recent runs card — derived from org-wide execution-count
              aggregate. Absent if the pipeline has no recorded runs. */}
          <div className="card">
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
                <div className="pt-2">
                  <Link href="/dashboard/executions" className="action-link text-xs">
                    View all executions →
                  </Link>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">No recorded runs yet.</p>
            )}
          </div>

          {/* Operations card */}
          <div className="card lg:col-span-2">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Operations</h3>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowEdit(true)}
                disabled={!canEdit}
                className="btn btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                title={canEdit ? undefined : 'Read-only (public catalog entry)'}
              >
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setShowDelete(true)}
                disabled={!canEdit}
                className="btn btn-danger inline-flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                title={canEdit ? undefined : 'Read-only (public catalog entry)'}
              >
                <Trash2 className="w-4 h-4" /> Delete pipeline
              </button>
            </div>
          </div>
        </div>
      )}

      {showEdit && pipeline && (
        <EditPipelineModal
          pipeline={pipeline}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); void router.replace(router.asPath); }}
        />
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

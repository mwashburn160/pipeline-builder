// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every read the pipeline detail page makes: the pipeline (with its
 * registration), the org-wide run totals, the member roster, the live
 * deployment, the execution history and the toolchain-change marker.
 */

import { useCallback, useMemo } from 'react';
import { useEntityFetch } from '@/hooks/useEntityFetch';
import { useFetch } from '@/hooks/useFetch';
import { useQuery } from '@/hooks/useQuery';
import api from '@/lib/api';
import { queries } from '@/lib/api-cache';
import type { PipelineDeployment } from '@/lib/api/domains/pipelines';
import { formatError } from '@/lib/constants';
import { awsStackConsoleUrl } from '@/lib/deploy-target';
import { toolchainChangeRunId } from '@/lib/pipeline-security';
import type { PipelineBuildImage } from '@/lib/api/pipeline-security-types';
import type { DetailTab, PipelineExecution, PipelineWithRegistration } from './pipeline-detail-model';

/** Registry drain page size + runaway guard (~5k rows) for the deployment lookup. */
const REGISTRY_PAGE = 200;
const REGISTRY_MAX_PAGES = 25;

export function usePipelineDetailData(id: string, organizationId: string | undefined, activeTab: DetailTab) {
  // The registration rides the SAME response as the pipeline, so it is carried on
  // the fetched entity rather than fetched again — one request, and the banner can
  // never disagree with the record it describes.
  const fetchPipeline = useCallback(async (pipelineId: string): Promise<PipelineWithRegistration> => {
    const response = await api.getPipelineById(pipelineId);
    if (!response.success || !response.data?.pipeline) {
      throw new Error(response.message || 'Pipeline not found');
    }
    return { ...response.data.pipeline, registration: response.data.registration };
  }, []);
  const { entity: pipeline, fetching, error: fetchError, reload: reloadPipeline } = useEntityFetch<PipelineWithRegistration>(
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
  const roster = useQuery(organizationId ? queries.allOrgMembers(organizationId) : null);
  const memberNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of roster.data ?? []) map[m.id] = m.username;
    return map;
  }, [roster.data]);

  // Live deployment (from the registry) for this pipeline — powers the Deployment
  // card + the "View stack in AWS" link. Non-blocking; absent → card hidden.
  // The registry endpoint is page-limited and has no per-pipeline filter, so
  // page through until this pipeline's row is found (early-exit) or the list is
  // drained — a single-page fetch would miss it in orgs with >200 deployments.
  const deploymentQ = useFetch(async (signal): Promise<{ match: PipelineDeployment | null }> => {
    if (!id) return { match: null };
    try {
      for (let i = 0, offset = 0; i < REGISTRY_MAX_PAGES; i++) {
        const r = await api.listPipelineDeployments({ limit: REGISTRY_PAGE, offset }, { signal });
        if (!r.data) break;
        const rows = r.data.registry;
        const match = rows.find((d) => d.pipelineId === id);
        if (match) return { match };
        if (!r.data.pagination.hasMore || rows.length === 0) break;
        offset += rows.length;
      }
    } catch {
      /* non-blocking — card just won't render */
    }
    return { match: null };
  }, [id]);
  const deployment = deploymentQ.data?.match ?? null;
  const stackConsoleUrl = awsStackConsoleUrl(deployment?.region, deployment?.stackName);

  // Per-pipeline execution history — list of recent runs from the reporting
  // service (the events the pipeline-events Lambda persists). The read is a
  // query against already-ingested data; the trigger/cancel actions call
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

  // The run-history "toolchain X → Y" marker: the Build image row's last
  // release change (from consecutive deploys' build-image entries), placed on
  // the first run after it. Read only on the Runs tab; non-blocking.
  const toolchainQ = useFetch(async (signal): Promise<PipelineBuildImage['change']> => {
    if (!id) return null;
    try {
      const r = await api.getPipelineSecurity(id, { signal });
      return r.success ? r.data?.buildImage?.change ?? null : null;
    } catch {
      return null;
    }
  }, [id], { enabled: activeTab === 'runs' });
  const toolchainChange = toolchainQ.data;
  const toolchainMarkerRunId = useMemo(() => toolchainChangeRunId(executions, toolchainChange), [executions, toolchainChange]);

  return {
    pipeline,
    fetching,
    fetchError,
    reloadPipeline,
    execCounts,
    execStats,
    memberNames,
    deployment,
    stackConsoleUrl,
    executions,
    execLoading,
    execError,
    loadExecutions,
    toolchainChange,
    toolchainMarkerRunId,
  };
}

export type PipelineDetailData = ReturnType<typeof usePipelineDetailData>;

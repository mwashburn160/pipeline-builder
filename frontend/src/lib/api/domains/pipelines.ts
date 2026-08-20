// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, CreatePipelineData, BuilderProps, Pipeline, PipelineScorecard } from '@/types';

/** A single pipeline spec accepted by the bulk-create endpoint. Mirrors the
 *  single-create body (PipelineCreateSchema on the server). */
export interface BulkPipelineSpec {
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords?: string[];
  props: BuilderProps;
  accessModifier?: 'public' | 'private';
}

/** Per-item result envelope returned by POST /pipelines/bulk/create. */
export interface BulkCreateResult {
  created: number;
  updated: number;
  failed: number;
  items: Array<{ index: number; accessModifier?: string; id?: string }>;
  errors: Array<{ index: number; error: string }>;
}

/** A deployed-pipeline registry row (ARN→pipelineId mapping written at deploy
 *  time). No AWS account id / ARN is ever returned by the server. */
export interface PipelineDeployment {
  id: string;
  pipelineId: string;
  pipelineName: string;
  region?: string;
  project?: string;
  organization?: string;
  stackName?: string;
  lastDeployed: string;
}

export function pipelinesApi(core: ApiCore) {
  return {
    // ============================================
    // Pipeline endpoints
    // ============================================
    listPipelines: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ pipelines: Pipeline[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/pipelines${buildQuery(params)}`);
    },

    getPipelineById: async (id: string) => {
      return core.request<ApiResponse<{ pipeline: Pipeline }>>(`/api/pipeline/${id}`);
    },

    /** Per-pipeline maturity scorecard (compliance posture + DORA bands). Requires `advanced_reporting`. */
    getPipelineScorecard: async (id: string) => {
      return core.request<ApiResponse<{ scorecard: PipelineScorecard }>>(`/api/pipelines/${id}/scorecard`);
    },

    createPipeline: async (data: CreatePipelineData) => {
      return core.request<ApiResponse<{ pipeline: Pipeline; warning?: string }>>('/api/pipeline', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    updatePipeline: async (id: string, data: { 
      pipelineName?: string;
      description?: string;
      keywords?: string[];
      props?: BuilderProps;
      accessModifier?: 'public' | 'private';
      isDefault?: boolean;
      isActive?: boolean;
    }) => {
      return core.request<ApiResponse<{ pipeline: Pipeline }>>(`/api/pipeline/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    deletePipeline: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/pipeline/${id}`, {
        method: 'DELETE',
      });
    },

    /** List the org's soft-deleted pipelines (tombstones), most-recent first —
     *  restorable until the retention sweep purges them. */
    listDeletedPipelines: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ pipelines: Pipeline[] }>>(`/api/pipelines/deleted${buildQuery(params)}`);
    },

    /** Restore a soft-deleted pipeline. Step-up gated (reverses a destructive
     *  action): pass the token from StepUpModal; the api forwards it as the
     *  `X-Step-Up-Token` header. */
    restorePipeline: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ pipeline: Pipeline }>>(`/api/pipelines/${id}/restore`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Permanently hard-delete a soft-deleted pipeline tombstone (bypasses the retention
     *  window). Irreversible + step-up gated like restore: pass the re-verified token. */
    purgePipeline: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/pipelines/${id}/purge`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    bulkDeletePipelines: async (ids: string[]) => {
      return core.request<ApiResponse<{ deleted: number; ids: string[] }>>('/api/pipelines/bulk/delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
    },

    bulkUpdatePipelines: async (ids: string[], data: Record<string, unknown>) => {
      return core.request<ApiResponse<{ updated: number }>>('/api/pipelines/bulk/update', {
        method: 'PUT',
        body: JSON.stringify({ ids, data }),
      });
    },

    /**
     * Create multiple pipelines in one request. Each item is validated per the
     * single-create schema server-side; the response reports per-item outcomes
     * so a partial success (some created, some failed) is surfaced, not masked.
     * Requires `pipelines:write` + the `bulk_operations` feature.
     */
    bulkCreatePipelines: async (pipelines: BulkPipelineSpec[]) => {
      return core.request<ApiResponse<BulkCreateResult>>('/api/pipelines/bulk/create', {
        method: 'POST',
        body: JSON.stringify({ pipelines }),
      });
    },

    /**
     * List the deployed-pipeline registry rows for the caller's org (each is an
     * ARN→pipelineId mapping written by CDK at deploy time). Powers the
     * deployments page. Distinct from `listPipelines`, which lists config.
     */
    listPipelineDeployments: async (params?: { limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{
        registry: PipelineDeployment[];
        pagination: { total: number; limit: number; offset: number; hasMore: boolean };
      }>>(`/api/pipelines/registry${buildQuery(params as Record<string, unknown> | undefined)}`);
    },

    /**
     * Register (upsert) a deployed pipeline in the registry by its stable
     * pipelineId. The server rejects a pipelineId the caller's org does not own
     * (404) or one already claimed by another org (409). Requires
     * `pipelines:write`.
     */
    registerPipelineDeployment: async (body: {
      pipelineId: string;
      pipelineName: string;
      region?: string;
      project?: string;
      organization?: string;
      stackName?: string;
    }) => {
      return core.request<ApiResponse<{ registry: PipelineDeployment }>>('/api/pipelines/registry', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    /**
     * Deregister a deployed pipeline by its registry row UUID (org-scoped on the
     * server). Used to reconcile drift after a stack is removed out-of-band.
     * Requires `pipelines:write`.
     */
    deregisterPipelineDeployment: async (id: string) => {
      return core.request<ApiResponse<{ id: string }>>(`/api/pipelines/registry/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    /**
     * Trigger a new AWS CodePipeline execution for a deployed pipeline.
     * Resolves the pipeline's registered CodePipeline name/region server-side
     * and calls StartPipelineExecution. Returns the new execution id (202).
     */
    triggerPipelineExecution: async (pipelineId: string) => {
      return core.request<ApiResponse<{ executionId: string }>>(`/api/pipelines/${pipelineId}/executions`, {
        method: 'POST',
      });
    },

    /**
     * Stop an in-flight AWS CodePipeline execution (StopPipelineExecution).
     * `abandon` skips graceful completion of in-progress actions.
     */
    stopPipelineExecution: async (pipelineId: string, executionId: string, body?: { reason?: string; abandon?: boolean }) => {
      return core.request<ApiResponse<{ stopped: boolean }>>(`/api/pipelines/${pipelineId}/executions/${executionId}/stop`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
    },

    getAIProviders: async () => {
      return core.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/pipeline/providers');
    },

    /**
     * Stream AI pipeline generation from a Git URL.
     * Yields analyzing → analyzed → partial → done events.
     */
    streamPipelineFromUrl: async function*(gitUrl: string, provider: string, model: string, apiKey?: string, repoToken?: string) {
      yield* core.streamRequest('/api/pipeline/generate/from-url/stream', {
        gitUrl, provider, model,
        ...(apiKey ? { apiKey } : {}),
        ...(repoToken ? { repoToken } : {}),
      });
    },

    /**
     * Stream AI pipeline generation from a free-text prompt.
     * Yields partial → done events (no repo-analysis / auto-plugin phases —
     * those are exclusive to the from-URL flow).
     */
    streamPipelineFromPrompt: async function*(prompt: string, provider: string, model: string, apiKey?: string) {
      yield* core.streamRequest('/api/pipeline/generate/stream', {
        prompt, provider, model,
        ...(apiKey ? { apiKey } : {}),
      });
    },
  };
}

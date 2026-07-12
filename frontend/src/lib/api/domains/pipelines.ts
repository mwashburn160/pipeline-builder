// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, CreatePipelineData, BuilderProps, Pipeline } from '@/types';

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
  };
}

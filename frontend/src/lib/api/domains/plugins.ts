// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery, API_URL } from '../util';
import { ApiError } from '../errors';
import type { ApiResponse, Plugin, QueueStatus } from '@/types';

export function pluginsApi(core: ApiCore) {
  return {
    // ============================================
    // Plugin endpoints
    // ============================================
    listPlugins: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ plugins: Plugin[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/plugins${buildQuery(params)}`);
    },

    getPluginById: async (id: string) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugin/${id}`);
    },

    uploadPlugin: async (file: File, accessModifier: 'public' | 'private' = 'private', options?: { signal?: AbortSignal }) => {
      await core.ensureFreshToken();

      const formData = new FormData();
      formData.append('plugin', file);
      formData.append('accessModifier', accessModifier);

      const response = await fetch(`${API_URL}/api/plugin/upload`, {
        method: 'POST',
        headers: core.authHeaders(),
        body: formData,
        credentials: 'same-origin',
        signal: options?.signal,
      });

      const data = await response.json().catch(() => ({ 
        statusCode: response.status, 
        message: 'Upload failed',
        success: false,
      }));
    
      const statusCode = data.statusCode || response.status;

      if (statusCode >= 400) {
        throw new ApiError(data.message || 'Upload failed', statusCode, data.code);
      }

      return data as ApiResponse<{
        requestId?: string;
        pluginName?: string;
        version?: string;
      }>;
    },

    getQueueStatus: async () => {
      return core.request<ApiResponse<QueueStatus>>('/api/plugin/queue/status');
    },

    /** Get failed jobs from the plugin build queue */
    getQueueFailed: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ jobs: { id: string; pluginName?: string; version?: string; error?: string; attemptsMade?: number; maxAttempts?: number; failedAt?: string }[]; total: number }>>(`/api/plugins/queue/failed${buildQuery(params)}`);
    },

    /** Get dead letter queue jobs */
    getQueueDlq: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ jobs: { id: string; pluginName?: string; version?: string; failureCategory?: string; lastError?: string; error?: string; attemptsMade?: number; maxAttempts?: number; createdAt?: string; failedAt?: string }[]; total: number }>>(`/api/plugins/queue/dlq${buildQuery(params)}`);
    },

    /**
     * Get grouped failure triage summary — failed-build queue and DLQ
     * bucketed by failure category with representative samples.
     */
    getQueueTriage: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{
        totalFailed: number;
        groups: Array<{
          category: string;
          count: number;
          pluginNames: string[];
          samples: Array<{
            id: string | number;
            pluginName: string | null;
            version: string | null;
            error: string | null;
            failedAt: string | null;
            source: 'queue' | 'dlq';
          }>;
        }>;
      }>>(`/api/plugins/queue/triage${buildQuery(params)}`);
    },

    /** Re-enqueue a single failed build onto the main build queue. Removes the failed entry on success. */
    retryFailedJob: async (jobId: string) => {
      return core.request<ApiResponse<{ retried: boolean; failedJobId: string; newJobId: string }>>(
        `/api/plugins/queue/failed/${encodeURIComponent(jobId)}/retry`,
        { method: 'POST' },
      );
    },

    /** Re-enqueue a single DLQ job onto the main build queue. Removes the DLQ entry on success. */
    replayDlqJob: async (jobId: string) => {
      return core.request<ApiResponse<{ replayed: boolean; dlqJobId: string; newJobId: string }>>(
        `/api/plugins/queue/dlq/${encodeURIComponent(jobId)}/replay`,
        { method: 'POST' },
      );
    },

    /** Purge the entire plugin-build dead-letter queue. Destructive; system-admin only (403 otherwise). */
    purgeDlq: async () => {
      return core.request<ApiResponse<{ message: string }>>('/api/plugins/queue/dlq', {
        method: 'DELETE',
      });
    },

    updatePlugin: async (id: string, data: {
      name?: string;
      description?: string;
      keywords?: string[];
      version?: string;
      metadata?: Record<string, string | number | boolean>;
      pluginType?: string;
      computeType?: string;
      env?: Record<string, string>;
      installCommands?: string[];
      commands?: string[];
      accessModifier?: 'public' | 'private';
      isDefault?: boolean;
      isActive?: boolean;
      primaryOutputDirectory?: string | null;
      timeout?: number | null;
      failureBehavior?: 'fail' | 'warn' | 'ignore';
      secrets?: Array<{ name: string; required: boolean; description?: string }>;
    }) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugin/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    deletePlugin: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/plugin/${id}`, {
        method: 'DELETE',
      });
    },

    bulkDeletePlugins: async (ids: string[]) => {
      return core.request<ApiResponse<{ deleted: number; ids: string[] }>>('/api/plugins/bulk/delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
    },

    bulkUpdatePlugins: async (ids: string[], data: Record<string, unknown>) => {
      return core.request<ApiResponse<{ updated: number }>>('/api/plugins/bulk/update', {
        method: 'PUT',
        body: JSON.stringify({ ids, data }),
      });
    },

    /** Counts pipelines (in caller's org) that reference each plugin name.
     *  Plugins with zero usage are absent from the map. */
    getPluginUsage: async () => {
      return core.request<ApiResponse<{ counts: Record<string, number> }>>('/api/plugins/plugin-usage');
    },

    // ============================================
    // Plugin AI generation endpoints
    // ============================================
    getPluginAIProviders: async () => {
      return core.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/plugin/providers');
    },

    deployGeneratedPlugin: async (data: {
      name: string;
      description?: string;
      version: string;
      pluginType: string;
      computeType: string;
      keywords?: string[];
      primaryOutputDirectory?: string;
      installCommands: string[];
      commands: string[];
      env?: Record<string, string>;
      dockerfile: string;
      accessModifier: 'public' | 'private';
    }) => {
      return core.request<ApiResponse<{
        requestId?: string;
        pluginName?: string;
        version?: string;
      }>>('/api/plugin/deploy-generated', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /**
     * Stream AI plugin generation with progressive partial results.
     */
    streamPluginGeneration: async function*(prompt: string, provider: string, model: string, apiKey?: string) {
      yield* core.streamRequest('/api/plugin/generate/stream', {
        prompt, provider, model, ...(apiKey ? { apiKey } : {}),
      });
    },
  };
}

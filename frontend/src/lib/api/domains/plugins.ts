// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery, API_URL } from '../util';
import { ApiError } from '../errors';
import type { ApiResponse, OwnerType, Plugin, QueueStatus , Visibility } from '@/types';

/**
 * Page envelope of the build-queue listings (`/plugins/queue/failed`, `/dlq`).
 * `total` is exact for system admins only — a tenant-scoped caller's total would
 * need a scan of every tenant's jobs, so the server omits it and `hasMore`
 * drives paging instead.
 */
export interface QueuePagination {
  total?: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Columns the plugins LIST view renders (table, detail modal, row gating) —
 * everything except the build spec (`dockerfile`, `commands`,
 * `installCommands`, `env`, `buildArgs`, `metadata`, `secrets`, …), which only
 * the edit modal needs and reads by id. `orgId`/`name`/`version` keep the
 * server-derived `uri` in the response. Sent as `fields`.
 */
export const PLUGIN_LIST_FIELDS = [
  'id', 'orgId', 'name', 'description', 'keywords', 'category', 'version', 'pluginType', 'computeType',
  'timeout', 'failureBehavior', 'visibility', 'isDefault', 'isActive', 'createdBy', 'createdAt', 'updatedAt',
  'buildType', 'imageDigest', 'imageSource',
] as const satisfies ReadonlyArray<keyof Plugin>;

/** A plugin row as the list view receives it (see {@link PLUGIN_LIST_FIELDS}). */
export type PluginSummary = Pick<Plugin, typeof PLUGIN_LIST_FIELDS[number] | 'uri'>;

export function pluginsApi(core: ApiCore) {
  return {
    // ============================================
    // Plugin endpoints
    // ============================================

    /**
     * Exchange the JWT for a short-lived, single-use SSE ticket for the build-log
     * stream (`GET /api/plugins/logs/:requestId`). Keeps the JWT out of the
     * EventSource query string. Mirrors `getNotificationTicket`; returns the
     * unwrapped ticket string so `useBuildStatus` can pipe it straight into the
     * stream URL. A 2xx without a ticket payload is treated as a 500.
     */
    getBuildLogTicket: async (requestId: string): Promise<string> => {
      // The ticket is subject-bound: the server stamps this requestId into the
      // single-use ticket so it can only open THIS build's log stream (not any
      // other org's by guessing a requestId). Must match the `:requestId` used
      // to open the SSE connection below.
      const res = await core.request<ApiResponse<{ ticket: string }>>('/api/plugins/logs/ticket', {
        method: 'POST',
        body: JSON.stringify({ requestId }),
      });
      if (!res.data?.ticket) throw new ApiError('Failed to obtain build-log ticket', 500);
      return res.data.ticket;
    },

    /** `params.fields` (comma-separated columns) trims each row to a sparse
     *  fieldset — `id` is always returned, and the server derives `uri` from
     *  `orgId`/`name`/`version`, so a list view that renders the URI must ask for
     *  those three. `nextCursor` is present when `hasMore` (keyset paging). */
    listPlugins: async (params?: Record<string, string>, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ plugins: Plugin[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean; nextCursor?: string } }>>(`/api/plugins${buildQuery(params)}`, { signal: opts?.signal });
    },

    getPluginById: async (id: string) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugins/${id}`);
    },

    /**
     * The plugin image's SPDX JSON SBOM as a file (`GET /plugins/:id/sbom`). The
     * server reads it from the image's SIGNED attestation, so a successful
     * download also proves the attestation verified; a 409
     * `IMAGE_VERIFICATION_FAILED` means it did not. A raw fetch (the body is a
     * file, not JSON), so failures are rebuilt from the error envelope here.
     */
    downloadPluginSbom: async (id: string): Promise<{ blob: Blob; filename: string }> => {
      await core.ensureFreshToken();
      const res = await fetch(`${API_URL}/api/plugins/${encodeURIComponent(id)}/sbom`, {
        headers: core.authHeaders() as Record<string, string>,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { code?: string; message?: string };
        throw new ApiError(data.message || 'SBOM download failed', res.status, data.code);
      }
      // Prefer the server's `<name>-<version>.spdx.json` over rebuilding one.
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      return { blob: await res.blob(), filename: match?.[1] ?? 'sbom.spdx.json' };
    },

    uploadPlugin: async (file: File, visibility: Visibility, options?: { signal?: AbortSignal }) => {
      await core.ensureFreshToken();

      const formData = new FormData();
      formData.append('plugin', file);
      formData.append('visibility', visibility);

      const response = await fetch(`${API_URL}/api/plugins/upload`, {
        method: 'POST',
        headers: core.authHeaders(),
        body: formData,
        credentials: 'same-origin',
        signal: options?.signal,
      });

      const data = await response.json().catch(() => ({
        message: 'Upload failed',
        success: false,
      }));

      // Success/failure is decided by the REAL HTTP status, never a body
      // `statusCode` field — a proxy or error page may omit/lie about it.
      const statusCode = response.status;

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
      return core.request<ApiResponse<QueueStatus>>('/api/plugins/queue/status');
    },

    /** One newest-first page of failed jobs from the plugin build queue (limit ≤ 200). */
    getQueueFailed: async (params: { limit: number; offset: number }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ jobs: { id: string; pluginName?: string; version?: string; error?: string; attemptsMade?: number; maxAttempts?: number; failedAt?: string }[]; pagination: QueuePagination }>>(`/api/plugins/queue/failed${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** One newest-first page of dead-letter-queue jobs (limit ≤ 200). */
    getQueueDlq: async (params: { limit: number; offset: number }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ jobs: { id: string; pluginName?: string; version?: string; failureCategory?: string; lastError?: string; error?: string; attemptsMade?: number; maxAttempts?: number; createdAt?: string; failedAt?: string }[]; pagination: QueuePagination }>>(`/api/plugins/queue/dlq${buildQuery(params)}`, { signal: opts?.signal });
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

    /**
     * Update a plugin in place.
     *
     * As with `updatePipeline`, there is deliberately no move/transfer: the
     * `plugins` table is FORCE'd RLS with
     * `WITH CHECK (current_is_sysadmin() OR org_id = current_org_id())`, so the
     * database itself rejects an UPDATE that rewrites `org_id`. Giving a TEAM a
     * plugin is `visibility: 'public'` (the rung a team org reads its parent's
     * rows at) plus `ownerId`/`ownerType` — see `CatalogOwnerFields`.
     *
     * `ownerId`/`ownerType` are admin-only server-side (a plain member's values
     * are dropped, not rejected), and the `public` rung needs `plugins:publish`.
     */
    updatePlugin: async (id: string, data: {
      name?: string;
      description?: string;
      keywords?: string[];
      version?: string;
      metadata?: Record<string, string | number | boolean>;
      pluginType?: string;
      computeType?: string;
      env?: Record<string, string>;
      buildArgs?: Record<string, string>;
      installCommands?: string[];
      commands?: string[];
      visibility?: Visibility;
      isDefault?: boolean;
      isActive?: boolean;
      primaryOutputDirectory?: string | null;
      timeout?: number | null;
      failureBehavior?: 'fail' | 'warn' | 'ignore';
      secrets?: Array<{ name: string; required: boolean; description?: string }>;
      /** Catalog owner: a user id (`ownerType: 'user'`) or a team org id
       *  (`ownerType: 'team'`). Not nullable — the server schema requires a
       *  non-empty string, so ownership is reassigned, never cleared. */
      ownerId?: string;
      ownerType?: OwnerType;
    }) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugins/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    deletePlugin: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/plugins/${id}`, {
        method: 'DELETE',
      });
    },

    /** List the org's soft-deleted plugins (tombstones), most-recent first —
     *  restorable until the retention sweep purges them. */
    listDeletedPlugins: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ plugins: Plugin[] }>>(`/api/plugins/deleted${buildQuery(params)}`);
    },

    /** Restore a soft-deleted plugin. Step-up gated (reverses a destructive
     *  action): pass the token from StepUpModal; the api forwards it as the
     *  `X-Step-Up-Token` header. */
    restorePlugin: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugins/${id}/restore`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Permanently hard-delete a soft-deleted plugin tombstone (bypasses the retention
     *  window). Irreversible + step-up gated like restore: pass the re-verified token. */
    purgePlugin: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/plugins/${id}/purge`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
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
      return core.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/plugins/providers');
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
      visibility: Visibility;
    }) => {
      return core.request<ApiResponse<{
        requestId?: string;
        pluginName?: string;
        version?: string;
      }>>('/api/plugins/deploy-generated', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /**
     * Stream AI plugin generation with progressive partial results.
     */
    streamPluginGeneration: async function*(prompt: string, provider: string, model: string, apiKey?: string) {
      yield* core.streamRequest('/api/plugins/generate/stream', {
        prompt, provider, model, ...(apiKey ? { apiKey } : {}),
      });
    },
  };
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import { ApiError } from '../errors';
import type {
  ApiResponse, Criticality, EntityLink, Lifecycle, OwnerType, Plugin, PluginCatalogEdits, PluginInspectResult, QueueStatus, Visibility,
} from '@/types';
import type { LookupWarning } from '@/lib/plugin-vulns';
import type {
  PluginSecurityNotificationPrefs, PluginSecurityNotificationPrefsWrite, PluginSecurityTestResult,
} from '@/types/plugin-security-notifications';

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
  // Version lifecycle: the Deprecated / Yanked badges and their actions.
  'deprecatedAt', 'deprecationMessage', 'yankedAt', 'yankReason',
  // Scan standing: the fixable / total, Unscanned and Flagged badges.
  'vulnCritical', 'vulnHigh', 'vulnCriticalFixable', 'vulnHighFixable', 'scannedAt', 'scanFlaggedAt', 'scanFlag',
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
     * `IMAGE_VERIFICATION_FAILED` means it did not. The server names the file
     * `<name>-<version>.spdx.json`.
     */
    downloadPluginSbom: async (id: string): Promise<{ blob: Blob; filename: string }> => {
      return core.requestBlob(`/api/plugins/${encodeURIComponent(id)}/sbom`, 'sbom.spdx.json', {
        errorMessage: 'SBOM download failed',
      });
    },

    /**
     * Dry-run parse of a plugin package (`POST /plugins/inspect`): every
     * descriptive catalog field with its detected value, source and — when the
     * detected value failed validation — the reason. Builds and stores nothing.
     * Multipart like the upload; no timeout, the package can be large.
     */
    inspectPlugin: async (file: File, options?: { signal?: AbortSignal }): Promise<PluginInspectResult> => {
      const formData = new FormData();
      formData.append('plugin', file);
      const data = await core.request<{ message?: string; code?: string; data?: PluginInspectResult }>('/api/plugins/inspect', {
        method: 'POST',
        body: formData,
        signal: options?.signal,
        timeoutMs: null,
        errorMessage: 'Could not read the plugin package',
      });
      if (!data.data?.fields) throw new ApiError(data.message || 'Could not read the plugin package', 500, data.code);
      return data.data;
    },

    /**
     * Upload a plugin package. `catalogEdits` are the catalog fields the user
     * EDITED in the Catalog details step (only those; `null` clears one) and go
     * as the `metadata` JSON part — omitted entirely when there are none, which
     * accepts every detected value.
     */
    uploadPlugin: async (
      file: File,
      visibility: Visibility,
      options?: { signal?: AbortSignal; catalogEdits?: PluginCatalogEdits },
    ) => {
      const formData = new FormData();
      formData.append('plugin', file);
      formData.append('visibility', visibility);
      const edits = options?.catalogEdits;
      if (edits && Object.keys(edits).length > 0) formData.append('metadata', JSON.stringify(edits));

      return core.request<ApiResponse<{
        requestId?: string;
        pluginName?: string;
        version?: string;
      }>>('/api/plugins/upload', {
        method: 'POST',
        body: formData,
        signal: options?.signal,
        timeoutMs: null,
        errorMessage: 'Upload failed',
      });
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
     *
     * Only the descriptive catalog fields and the operational ones are
     * accepted: the execution contract (commands, env, secrets, compute, name,
     * version, …) changes only by uploading a new version, and the server
     * refuses those keys with a 400. A version frozen by a publish request or
     * listing returns 409 for descriptive edits.
     */
    updatePlugin: async (id: string, data: PluginCatalogEdits & {
      visibility?: Visibility;
      isDefault?: boolean;
      isActive?: boolean;
      lifecycle?: Lifecycle;
      criticality?: Criticality | null;
      labels?: Record<string, string>;
      links?: EntityLink[];
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

    /**
     * Deprecate a version (`deprecated` defaults to true), or clear it with
     * `{ deprecated: false }`. It keeps resolving, but lookups carry a warning,
     * synth prints it, AI selection stops offering it, and the org approvers of
     * every org whose pipelines use it are notified. `plugins:write`, plus
     * `plugins:publish` for a public version.
     */
    deprecatePlugin: async (id: string, data: { deprecated?: boolean; message?: string } = {}) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugins/${id}/deprecate`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /**
     * Yank a version: ranges, `latest` and the default stop resolving to it; an
     * exact pin still resolves, with a warning carrying `reason`. Yanking the
     * default promotes the next version. There is no un-yank here; a version
     * published to the ecosystem answers 409 (request the yank there).
     */
    yankPlugin: async (id: string, reason: string) => {
      return core.request<ApiResponse<{ plugin: Plugin; promotedDefault?: { id: string; version: string } }>>(`/api/plugins/${id}/yank`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
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
      return core.request<ApiResponse<{ updated: number; skipped?: Array<{ id: string; reason: 'frozen' | 'listed'; statusCode: 409; code: string }> }>>('/api/plugins/bulk/update', {
        method: 'PUT',
        body: JSON.stringify({ ids, data }),
      });
    },

    /** Counts pipelines (in caller's org) that reference each plugin, keyed by
     *  the REFERENCE: `name` for unqualified references, `publisher/name` for
     *  qualified ones (see `pluginUsageKey`). Zero-usage plugins are absent. */
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
     * Stream AI plugin generation with progressive partial results. The `done`
     * event's data is a `PluginGenerationDone` (config, dockerfile, and the
     * `similarPlugins` reuse hint).
     */
    streamPluginGeneration: async function*(prompt: string, provider: string, model: string, apiKey?: string) {
      yield* core.streamRequest('/api/plugins/generate/stream', {
        prompt, provider, model, ...(apiKey ? { apiKey } : {}),
      });
    },

    // ============================================
    // Resolution preview + plugin security notifications
    // ============================================

    /**
     * Resolve one plugin reference exactly as synth will (`POST /plugins/lookup`):
     * the version it lands on plus the `warnings[]` synth prints (deprecated,
     * yanked, advisory, `VULN_FLAGGED`, …). A refusal throws an {@link ApiError}
     * carrying the server's code — `PLUGIN_VERSION_VULN_BLOCKED` when block mode
     * refuses an exact pin to a flagged version.
     */
    lookupPlugin: async (
      filter: { name: string; publisher?: string; version?: string; id?: string },
      opts?: { signal?: AbortSignal },
    ) => {
      return core.request<ApiResponse<{ plugin: Pick<Plugin, 'id' | 'name' | 'version'> & Record<string, unknown>; warnings: LookupWarning[] }>>('/api/plugins/lookup', {
        method: 'POST',
        body: JSON.stringify({ filter }),
        signal: opts?.signal,
      });
    },

    /** The org's plugin security notification settings (defaults when never saved). `plugins:read`. */
    getPluginSecurityNotifications: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ preferences: PluginSecurityNotificationPrefs }>>('/api/plugins/security-notifications', { signal: opts?.signal });
    },

    /** Save them (`org:settings`). A new external address is sent a confirmation link. */
    updatePluginSecurityNotifications: async (body: PluginSecurityNotificationPrefsWrite) => {
      return core.request<ApiResponse<{ preferences: PluginSecurityNotificationPrefs }>>('/api/plugins/security-notifications', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },

    /** Send a test notice to every configured channel (`org:settings`). */
    sendPluginSecurityNotificationTest: async () => {
      return core.request<ApiResponse<{ result: PluginSecurityTestResult }>>('/api/plugins/security-notifications/test', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
  };
}

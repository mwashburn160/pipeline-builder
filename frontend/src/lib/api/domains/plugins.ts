// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { StoragePruneResult, StorageReclaimPlan } from '@/types/storage-reclaim';
import type { TidyPreviewView, TidySettings, TidySettingsWrite } from '@/types/plugin-tidy';
import { buildQuery, type ProposedByOptions } from '../util';
import { ApiError } from '../errors';
import type {
  ApiResponse, Criticality, EntityLink, Lifecycle, OwnerType, Plugin, PluginCatalogEdits, PluginInspectResult, QueueStatus, Visibility,
} from '@/types';
import type { LookupWarning, VulnSeverity } from '@/lib/plugin-vulns';
import type { BuildClass, BuildSize } from '@pipeline-builder/api-core/build-catalog';
import type {
  ExposureTriageBody, KeptSetupImageView, PipelineExposureView, PipelineSecurity, PromotionResult,
} from '../pipeline-security-types';
import type {
  AdvisorySearchResult, FleetVulnerabilityPosture, PluginVersionFindings, PluginVersionUsage, VulnWaiversResponse,
} from '../plugin-vulnerability-types';
import type {
  PluginSecurityNotificationPrefs, PluginSecurityNotificationPrefsWrite, PluginSecurityTestResult,
} from '@/types/plugin-security-notifications';
import type {
  LibraryUpgradeLevel, PluginBatchActionResult, PluginDeleteAllResult, PluginDeletePreview, PluginRemediationDto,
  PluginRemediationList, PluginRemediationListQuery, PluginRemediationSettings, PluginRemediationSettingsView, PluginRemediationSettingsWrite,
} from '@/types/plugin-remediation';

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
  // Kept build source: the Storage section's per-version bytes (never its key or checksum, which the server refuses).
  'sourceKind', 'sourceSizeBytes',
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
     *
     * `buildClass` / `buildSize` are omitted when they are the defaults
     * (`standard` / `1x`) rather than sent explicitly: the route refuses a size
     * above the tier's ceiling, so sending `1x` when nothing asked for a size
     * would make a tier gate's error message reachable from a form that never
     * offered the choice.
     */
    uploadPlugin: async (
      file: File,
      visibility: Visibility,
      options?: { signal?: AbortSignal; catalogEdits?: PluginCatalogEdits; buildClass?: BuildClass; buildSize?: BuildSize },
    ) => {
      const formData = new FormData();
      formData.append('plugin', file);
      formData.append('visibility', visibility);
      const edits = options?.catalogEdits;
      if (edits && Object.keys(edits).length > 0) formData.append('metadata', JSON.stringify(edits));
      if (options?.buildClass && options.buildClass !== 'standard') formData.append('buildClass', options.buildClass);
      if (options?.buildSize && options.buildSize !== '1x') formData.append('buildSize', options.buildSize);

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
      return core.request<ApiResponse<{ jobs: { id: string; pluginName?: string; version?: string; error?: string; attemptsMade?: number; maxAttempts?: number; failedAt?: string; tier?: string }[]; pagination: QueuePagination }>>(`/api/plugins/queue/failed${buildQuery(params)}`, { signal: opts?.signal });
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

    /** The vulnerability-gate exemptions in force on this deployment (read-only;
     *  PLUGIN_VULN_WAIVERS is deployment config, there is no write counterpart). */
    listVulnWaivers: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<VulnWaiversResponse>>('/api/plugins/vuln-waivers', { signal: opts?.signal });
    },

    /** Which visible plugin versions, and which of the caller's pipelines, an advisory (CVE/GHSA/…) hits. */
    searchPluginAdvisory: async (advisoryId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<AdvisorySearchResult>>(
        `/api/plugins/vulnerabilities/${encodeURIComponent(advisoryId)}`, { signal: opts?.signal });
    },

    /** One plugin version's full finding list (a plugins row id or a listing version id). */
    getPluginFindings: async (id: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<PluginVersionFindings>>(
        `/api/plugins/${encodeURIComponent(id)}/findings`, { signal: opts?.signal });
    },

    /** A version's findings as a CSV file (`?format=csv`) — through the authenticated core,
     *  since a plain link would carry no bearer token. */
    downloadPluginFindingsCsv: async (id: string): Promise<{ blob: Blob; filename: string }> => {
      return core.requestBlob(`/api/plugins/${encodeURIComponent(id)}/findings?format=csv`, 'findings.csv', {
        errorMessage: 'Findings download failed',
      });
    },

    /** Cross-tenant vulnerability posture (`GET /plugins/vulnerabilities/fleet`; system org,
     *  `plugins:moderate` or `platform:read`, aal2). */
    getFleetVulnerabilityPosture: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<FleetVulnerabilityPosture>>('/api/plugins/vulnerabilities/fleet', { signal: opts?.signal });
    },

    /**
     * Re-enqueue a single failed build onto the main build queue. Removes the failed entry on success.
     * `tier` (from the failed row) names the exact queue: job ids repeat across tier queues.
     */
    retryFailedJob: async (jobId: string, tier?: string) => {
      return core.request<ApiResponse<{ retried: boolean; failedJobId: string; newJobId: string }>>(
        `/api/plugins/queue/failed/${encodeURIComponent(jobId)}/retry${tier ? `?tier=${encodeURIComponent(tier)}` : ''}`,
        { method: 'POST' },
      );
    },

    /**
     * Dismiss a single failed build: remove it from the failed set and release
     * what it still holds (quota slot, retained build context). `tier` as for retry.
     */
    dismissFailedJob: async (jobId: string, tier?: string) => {
      return core.request<ApiResponse<{ dismissed: boolean; failedJobId: string; contextReleased: boolean; retryingViaDlq: boolean }>>(
        `/api/plugins/queue/failed/${encodeURIComponent(jobId)}${tier ? `?tier=${encodeURIComponent(tier)}` : ''}`,
        { method: 'DELETE' },
      );
    },

    /** Re-enqueue a single DLQ job onto the main build queue. Removes the DLQ entry on success. */
    replayDlqJob: async (jobId: string) => {
      return core.request<ApiResponse<{ replayed: boolean; dlqJobId: string; newJobId: string }>>(
        `/api/plugins/queue/dlq/${encodeURIComponent(jobId)}/replay`,
        { method: 'POST' },
      );
    },

    /**
     * Purge the entire plugin-build dead-letter queue. Destructive; system-admin
     * only (403 otherwise) and step-up gated: the caller passes the token its own
     * StepUpModal minted, so the global dialog never replays it a second time.
     */
    purgeDlq: async (stepUpToken?: string) => {
      return core.request<ApiResponse<{ message: string }>>('/api/plugins/queue/dlq', {
        method: 'DELETE',
        replayOnStepUp: false,
        headers: core.stepUpHeader(stepUpToken),
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
      /** Optimistic concurrency: the `updatedAt` the edit was based on (412
       *  PRECONDITION_FAILED when the version changed since). Absent: last write wins. */
      expectedUpdatedAt?: string;
    }, opts?: ProposedByOptions) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugins/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
        headers: core.proposedByHeader(opts),
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
     * default promotes the next version ({@link unyankPlugin} reverses it); a
     * version published to the ecosystem answers 409 (request the yank there).
     */
    yankPlugin: async (id: string, reason: string) => {
      return core.request<ApiResponse<{ plugin: Plugin; promotedDefault?: { id: string; version: string } }>>(`/api/plugins/${id}/yank`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    },

    /**
     * Reverse a yank of the org's own version: it resolves for ranges and
     * `latest` again, back to `deprecated` when it was deprecated, else
     * `production` — but it does NOT become the default again. 409
     * `PLUGIN_VERSION_FROZEN` for a version published to the ecosystem, 409
     * `CONFLICT` when it is not yanked. Same gates as yank.
     */
    unyankPlugin: async (id: string, reason?: string) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugins/${id}/unyank`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      });
    },

    /** `promotedDefault` names the version that became the default when the
     *  deleted one was it. */
    deletePlugin: async (id: string) => {
      return core.request<ApiResponse<{ promotedDefault?: { id: string; version: string } }>>(`/api/plugins/${id}`, {
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
      return core.request<ApiResponse<{ deleted: number; ids: string[]; skipped?: Array<{ id: string; reason: 'frozen' | 'listed' | 'in_use' | 'managed_toolchain' }> }>>('/api/plugins/bulk/delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
    },

    bulkUpdatePlugins: async (ids: string[], data: Record<string, unknown>) => {
      return core.request<ApiResponse<{ updated: number; skipped?: Array<{ id: string; reason: 'frozen' | 'listed' | 'managed_toolchain'; statusCode: 400 | 409; code: string }> }>>('/api/plugins/bulk/update', {
        method: 'PUT',
        body: JSON.stringify({ ids, data }),
      });
    },

    /** Counts pipelines (in caller's org) that reference each plugin, keyed by
     *  the REFERENCE: `name` for unqualified references, `publisher/name` for
     *  qualified ones (see `pluginUsageKey`). Zero-usage plugins are absent. */
    getPluginUsage: async () => {
      return core.request<ApiResponse<{ counts: Record<string, number>; versions: PluginVersionUsage[] }>>('/api/plugins/plugin-usage');
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
      /** Scheduling class; omit for `standard`. */
      buildClass?: BuildClass;
      /** Machine size; omit for `1x`. The route refuses one above the tier's ceiling. */
      buildSize?: BuildSize;
    }, opts?: ProposedByOptions) => {
      return core.request<ApiResponse<{
        requestId?: string;
        pluginName?: string;
        version?: string;
      }>>('/api/plugins/deploy-generated', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: core.proposedByHeader(opts),
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
     * yanked, advisory, and the severity-graded VULN_* / scan / compliance
     * warnings) and their loudest `severity`. Vulnerability state never refuses
     * a lookup; a refusal (not found, a blocked listing, …) throws an
     * {@link ApiError} carrying the server's code.
     */
    lookupPlugin: async (
      filter: { name: string; publisher?: string; version?: string; id?: string },
      opts?: { signal?: AbortSignal },
    ) => {
      return core.request<ApiResponse<{ plugin: Pick<Plugin, 'id' | 'name' | 'version'> & Record<string, unknown>; warnings: LookupWarning[]; severity: VulnSeverity | null }>>('/api/plugins/lookup', {
        method: 'POST',
        body: JSON.stringify({ filter }),
        signal: opts?.signal,
      });
    },

    // ============================================
    // A pipeline's plugin security (api/plugin routes/pipeline-security.ts)
    // ============================================

    /** Per step: the declared resolution, the last lookup, the version's scan state + severity now, and its exposures. `pipelines:read`. */
    getPipelineSecurity: async (pipelineId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<PipelineSecurity>>(
        `/api/plugins/pipelines/${encodeURIComponent(pipelineId)}/security`, { signal: opts?.signal });
    },

    /** The pipeline's exposures (open / accepted / false positive; `includeFixed` adds closed ones). `pipelines:read`. */
    listPipelineExposures: async (pipelineId: string, params?: { includeFixed?: boolean }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ pipeline: { id: string; name: string | null }; exposures: PipelineExposureView[] }>>(
        `/api/plugins/pipelines/${encodeURIComponent(pipelineId)}/exposures${params?.includeFixed ? '?includeFixed=true' : ''}`,
        { signal: opts?.signal },
      );
    },

    /**
     * Triage one exposure for THIS pipeline: accept (reason + expiry ≤ 90 days;
     * `kev: true` when the version has KEV findings), false_positive (reason),
     * or reopen. Only changes how loud the finding is; audited. `pipelines:write`.
     */
    triagePipelineExposure: async (pipelineId: string, exposureId: string, body: ExposureTriageBody) => {
      return core.request<ApiResponse<{ exposures: PipelineExposureView[] }>>(
        `/api/plugins/pipelines/${encodeURIComponent(pipelineId)}/exposures/${encodeURIComponent(exposureId)}/triage`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    // ============================================
    // Kept setup images (system org + plugins:moderate + aal2)
    // ============================================

    /** Gate-refused images the setup catalog load kept for promotion, oldest first. */
    listKeptSetupImages: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ images: KeptSetupImageView[] }>>('/api/plugins/kept-setup-images', { signal: opts?.signal });
    },

    /** Re-gate a kept image with the CURRENT rules and store the version if it passes (409 with the remaining findings if not). */
    promoteKeptSetupImage: async (id: string) => {
      return core.request<ApiResponse<PromotionResult>>(`/api/plugins/kept-setup-images/${encodeURIComponent(id)}/promote`, {
        method: 'POST',
      });
    },

    /** The org's plugin security notification settings (defaults when never saved). `plugins:read`. */
    getPluginSecurityNotifications: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ preferences: PluginSecurityNotificationPrefs }>>('/api/plugins/security-notifications', { signal: opts?.signal });
    },

    /** Save them (`org_settings:write`). A new external address is sent a confirmation link. */
    updatePluginSecurityNotifications: async (body: PluginSecurityNotificationPrefsWrite, opts?: ProposedByOptions) => {
      return core.request<ApiResponse<{ preferences: PluginSecurityNotificationPrefs }>>('/api/plugins/security-notifications', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: core.proposedByHeader(opts),
      });
    },

    /** Send a test notice to every configured channel (`org_settings:write`). */
    sendPluginSecurityNotificationTest: async () => {
      return core.request<ApiResponse<{ result: PluginSecurityTestResult }>>('/api/plugins/security-notifications/test', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    // ============================================
    // Nightly CVE remediation (api/plugin routes/remediations.ts)
    // ============================================

    /**
     * The org's remediations, newest first, plus the operator knob (`enabled`),
     * today's count against the daily cap and the opted-out pipeline count.
     * `stage` filters to one stage or a comma list. `plugins:read`.
     */
    listPluginRemediations: async (query: PluginRemediationListQuery = {}, opts?: { signal?: AbortSignal }) => {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params[k] = String(v);
      return core.request<ApiResponse<PluginRemediationList>>(`/api/plugins/remediations${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** The remediation's patch diff as text (404 when none is stored). Never the source ZIP. `plugins:read`. */
    getPluginRemediationPatch: async (id: string) => {
      return core.requestText(`/api/plugins/remediations/${encodeURIComponent(id)}/patch`, { errorMessage: 'Could not load the patch' });
    },

    /** Official fixes: the patch re-rooted at `deploy/plugins/<name>/` for maintainers (system org, `plugins:write`). */
    downloadPluginRemediationExport: async (id: string): Promise<{ blob: Blob; filename: string }> => {
      return core.requestBlob(`/api/plugins/remediations/${encodeURIComponent(id)}/export`, 'remediation-export.diff', {
        errorMessage: 'Export download failed',
      });
    },

    /**
     * Approve and publish a fix held in propose mode (`awaiting_approval` only;
     * 409 REMEDIATION_STAGE_CONFLICT otherwise). `plugins:write` + step-up: pass
     * the token the caller's own StepUpModal minted.
     */
    approvePluginRemediation: async (id: string, body: { reason?: string } = {}, stepUpToken?: string) => {
      return core.request<ApiResponse<PluginRemediationDto>>(`/api/plugins/remediations/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify(body),
        replayOnStepUp: false,
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Reject a fix held in propose mode (moves it to failed / rejected). `plugins:write` + step-up. */
    rejectPluginRemediation: async (id: string, body: { reason?: string } = {}, stepUpToken?: string) => {
      return core.request<ApiResponse<PluginRemediationDto>>(`/api/plugins/remediations/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: JSON.stringify(body),
        replayOnStepUp: false,
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Start a new attempt of a failed / needs-owner / needs-review remediation (counts toward the daily cap; 429 over it). `plugins:write`. */
    retryPluginRemediation: async (id: string) => {
      return core.request<ApiResponse<PluginRemediationDto>>(`/api/plugins/remediations/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    /** The org's remediation settings, the root's inherited values for a team, and the operator knob. `plugins:read`. */
    getPluginRemediationSettings: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<PluginRemediationSettingsView>>('/api/plugins/remediation-settings', { signal: opts?.signal });
    },

    /** Save them (`org_settings:write`); editable even while the operator knob is off. */
    updatePluginRemediationSettings: async (body: PluginRemediationSettingsWrite, opts?: ProposedByOptions) => {
      // The PUT answers only the saved settings, not the whole view.
      return core.request<ApiResponse<{ settings: PluginRemediationSettings }>>('/api/plugins/remediation-settings', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: core.proposedByHeader(opts),
      });
    },

    /** One plugin's own library upgrade level (`null` = Follow organization). `plugins:write`. */
    setPluginRemediationLevel: async (name: string, level: LibraryUpgradeLevel | null) => {
      return core.request<ApiResponse<{ name: string; level: LibraryUpgradeLevel | null }>>(`/api/plugins/by-name/${encodeURIComponent(name)}/remediation-level`, {
        method: 'PUT',
        body: JSON.stringify({ level }),
      });
    },

    // ============================================
    // Delete / restore / purge a whole plugin (api/plugin routes/plugin-by-name.ts)
    // ============================================

    /** What "Delete plugin" would delete and skip, and why — the dialog shows exactly this. `plugins:write`. */
    getPluginDeletePreview: async (name: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<PluginDeletePreview>>(`/api/plugins/by-name/${encodeURIComponent(name)}/delete-preview`, { signal: opts?.signal });
    },

    /**
     * Soft-delete every eligible version of `name` (one batch). `force` also
     * deletes listed source versions. `plugins:write` + step-up; 10 per org per hour.
     */
    deletePluginByName: async (name: string, opts: { force?: boolean; stepUpToken?: string } = {}) => {
      return core.request<ApiResponse<PluginDeleteAllResult>>(`/api/plugins/by-name/${encodeURIComponent(name)}${opts.force ? '?force=true' : ''}`, {
        method: 'DELETE',
        replayOnStepUp: false,
        headers: core.stepUpHeader(opts.stepUpToken),
      });
    },

    /** Restore one "Delete plugin" batch, within the retention window. `plugins:write` + step-up. */
    restorePluginByName: async (name: string, batchId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<PluginBatchActionResult>>(
        `/api/plugins/by-name/${encodeURIComponent(name)}/restore${buildQuery({ batchId })}`, {
          method: 'POST',
          replayOnStepUp: false,
          headers: core.stepUpHeader(stepUpToken),
        });
    },

    /** Permanently purge one batch's soft-deleted versions (sources, image, remediation rows). `plugins:write` + step-up. */
    purgePluginByName: async (name: string, batchId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<PluginBatchActionResult>>(
        `/api/plugins/by-name/${encodeURIComponent(name)}/purge${buildQuery({ batchId })}`, {
          method: 'POST',
          replayOnStepUp: false,
          headers: core.stepUpHeader(stepUpToken),
        });
    },

    /**
     * What the org's registry storage is spent on, and what it can reclaim
     * (`plugins:read`). 503 when the registry cannot be read — the caller must
     * say so rather than render an empty list, which would read as "nothing to
     * free".
     */
    getStorageReclaim: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<StorageReclaimPlan>>('/api/plugins/storage', { signal: opts?.signal });
    },

    /**
     * Retire one version's image so its layers leave the storage total
     * (`plugins:write`). Eligibility is re-checked server-side at the moment of
     * deletion, so a 409 here is the honest answer and not a stale view.
     */
    pruneStorageVersion: async (repo: string, tag: string) => {
      return core.request<ApiResponse<StoragePruneResult>>('/api/plugins/storage/prune', {
        method: 'POST',
        body: JSON.stringify({ repo, tag }),
      });
    },

    // ============================================
    // Automatic plugin version tidying (api/plugin routes/tidy.ts)
    // ============================================

    /** The org's tidy settings and today's dry run (what would be warned / deactivated / deleted, and why the rest is skipped). `plugins:read`. */
    getPluginTidyPreview: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<TidyPreviewView>>('/api/plugins/tidy/preview', { signal: opts?.signal });
    },

    /** Save the mode and the days (`org_settings:write`). */
    updatePluginTidySettings: async (body: TidySettingsWrite) => {
      return core.request<ApiResponse<{ settings: TidySettings }>>('/api/plugins/tidy/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },

    /** Keep one version: restart its tidy clock (a deactivated one is active again). `plugins:write`. */
    keepPluginVersion: async (id: string) => {
      return core.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugins/tidy/versions/${encodeURIComponent(id)}/keep`, { method: 'POST' });
    },

    /** Set (or clear) a plugin's "never tidy". `plugins:write`. */
    setPluginNeverTidy: async (name: string, neverTidy: boolean) => {
      return core.request<ApiResponse<{ name: string; neverTidy: boolean; settings: TidySettings }>>(`/api/plugins/by-name/${encodeURIComponent(name)}/never-tidy`, {
        method: 'PUT',
        body: JSON.stringify({ neverTidy }),
      });
    },
  };
}

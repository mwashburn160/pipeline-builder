// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  InheritedPipelineRunnerDto, PipelineRunnerDto, PipelineRunnersListDto, QueuedRunRequestDto, RunnerDeliveriesDto,
  RunnerHealth, RunnerKeyMode, RunnerKeyRotationState, RunnerKeyStatusRow, RunnerLinkDto, RunnerSigningKeyDto,
  RunnerSigningKeySummary, RunnerStatus, RunRequestAction, RunRequestStatus,
} from '@pipeline-builder/api-core/pipeline-runners';
import type { PipelineRemediationElection } from '@pipeline-builder/api-core/plugin-scan';
import type { ApiCore } from '../core';
import type { PipelineRemediationUpgrades, PipelineRemediationUpgradeView } from '@/types/plugin-remediation';
import { buildQuery, type ProposedByOptions } from '../util';
import { ApiError } from '../errors';
import type {
  PipelinePluginWarning, PipelineSecurityReports, PluginUpgradeApplyResult, PluginUpgradePreview,
} from '../pipeline-security-types';
import type {
  ApiResponse, CreatePipelineData, BuilderProps, OrgScorecardHistory, OwnerType, Pipeline, PipelineScorecard, PipelineScorecardHistory,
  ScorecardHistoryQuery, ScorecardRollup, ScorecardRollupQuery, Visibility,
} from '@/types';

/** The grade-history query string (interval/periods/tz/weekStart). */
function scorecardHistoryParams(query: ScorecardHistoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.interval) params.set('interval', query.interval);
  if (query.periods !== undefined) params.set('periods', String(query.periods));
  if (query.tz) params.set('tz', query.tz);
  if (query.weekStart) params.set('weekStart', query.weekStart);
  return params;
}

/** A single pipeline spec accepted by the bulk-create endpoint. Mirrors the
 *  single-create body (PipelineCreateSchema on the server). */
export interface BulkPipelineSpec {
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords?: string[];
  props: BuilderProps;
  visibility?: Visibility;
}

/** Per-item result envelope returned by POST /pipelines/bulk/create. */
export interface BulkCreateResult {
  created: number;
  updated: number;
  failed: number;
  /** `pluginWarnings`: the created pipeline's severity-graded plugin warnings (never a refusal). */
  items: Array<{ index: number; visibility?: string; id?: string; pluginWarnings?: PipelinePluginWarning[] }>;
  errors: Array<{ index: number; error: string }>;
}

/** A deployed-pipeline registry row (ARN→pipelineId mapping written at deploy
 *  time). No AWS account id / ARN is ever returned by the server. */
/**
 * Whether a pipeline has a deploy registration. `registered: false` is why a
 * pipeline's reports are empty: the events Lambda resolves every event through the
 * registry, so an unregistered pipeline never produces one. Usual cause is a
 * deploy whose post-deploy registration call hasn't landed yet.
 */
export interface PipelineRegistrationStatus {
  registered: boolean;
  lastDeployed: string | null;
  stackName: string | null;
  region: string | null;
}

export interface PipelineDeployment {
  id: string;
  pipelineId: string;
  pipelineName: string;
  region?: string;
  project?: string;
  organization?: string;
  stackName?: string;
  lastDeployed: string;
  /** The pipeline runner Re-run / Stop go through — by LABEL only; null = not
   *  linked yet (the pipeline page reads the full link status separately). */
  runner?: { id: string; label: string } | null;
}

// -- Pipeline runners (the only way a pipeline is started or stopped) ----------

/** Delivery health: `unreachable` after failed health pings or deliveries in a
 *  row (a ping every minute; a success resumes delivery). */
export type PipelineRunnerHealth = RunnerHealth;
/** `pending`: registered but setup not finished (the ping has not answered yet). */
export type PipelineRunnerStatus = RunnerStatus;

/** A runner Lambda in a customer AWS account, pushed to by the platform at its
 *  Function URL (or API Gateway URL). Never carries an account number. Carries
 *  its own JWKS URL (the keys it verifies requests with) and how many
 *  pipelines are linked to it. */
export type PipelineRunner = PipelineRunnerDto;

/** A parent org's runner shared with this team — read-only here, and signed
 *  with the parent's key. */
export type InheritedPipelineRunner = InheritedPipelineRunnerDto;

/** `GET /pipelines/runners`. `available: false` = runners are unavailable on
 *  this deployment right now (paused, or secret encryption not set up). */
export type PipelineRunnersDto = PipelineRunnersListDto;

export type { RunnerSigningKeyDto, RunnerSigningKeySummary, RunnerLinkDto, RunnerKeyStatusRow, RunnerDeliveriesDto };

export type PipelineRunnerUpdate = { label?: string; shareWithTeams?: boolean; functionUrl?: string };

/** `POST /pipelines/runners/:id/test` — a signed ping. */
export interface PipelineRunnerTestResult {
  ok: boolean;
  outcome?: string | null;
  errorCode?: string | null;
}

/** `GET /pipelines/runners/:id/pipelines`: the pipelines linked to a runner. */
export interface RunnerPipelinesPage {
  pipelines: Array<{ id: string; name: string }>;
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
}

/** `GET /pipelines/admin/runner-signing-keys` filters (operators). */
export interface RunnerKeyStatusQuery {
  mode?: RunnerKeyMode;
  rotation?: RunnerKeyRotationState;
  overAge?: boolean;
  unreadable?: boolean;
  inTransition?: boolean;
  limit?: number;
  offset?: number;
}

export type { RunRequestStatus };

/** THE answer of Re-run and Stop (202): every run goes through a runner, so
 *  the request is queued and followed with {@link pipelinesApi}'s `getRunRequest`. */
export type QueuedRunRequest = QueuedRunRequestDto;

/** `GET /pipelines/:id/run-requests/:requestId`. */
export interface RunRequest {
  requestId: string;
  status: RunRequestStatus;
  action: RunRequestAction;
  runnerLabel: string | null;
  executionId: string | null;
  /** Once `started`: the execution's own state (running, succeeded, failed, …), when known. */
  executionStatus?: string | null;
  errorCode: string | null;
  attempts: number;
  requestedAt: string | null;
  expiresAt: string;
}

/** Pagination envelope of `GET /pipelines`. `total` is present only when the
 *  request passed `includeTotal=true`; `nextCursor` only when `hasMore`. */
export interface PipelineListPagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Opaque keyset cursor for the page after this one (send back as `cursor`). */
  nextCursor?: string;
}

/**
 * Columns the pipelines LIST view renders — everything except `props`, the
 * (large) BuilderProps document, which only the detail page and the edit modal
 * need, and both of those read the full record by id. Sent as `fields`.
 */
export const PIPELINE_LIST_FIELDS = [
  'id', 'orgId', 'project', 'organization', 'pipelineName', 'description', 'keywords',
  'visibility', 'isActive', 'isDefault', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt',
] as const satisfies ReadonlyArray<keyof Pipeline>;

/** A pipeline row as the list view receives it (see {@link PIPELINE_LIST_FIELDS}). */
export type PipelineSummary = Pick<Pipeline, typeof PIPELINE_LIST_FIELDS[number]>;

/** Page size for {@link pipelinesApi}'s `listAllPipelines` drain (the server max). */
const DRAIN_PAGE_SIZE = 1000;
/** Runaway guard for the drain — 50 × 1000 rows is far past any real org. */
const DRAIN_MAX_PAGES = 50;

export function pipelinesApi(core: ApiCore) {
  return {
    // ============================================
    // Pipeline endpoints
    // ============================================
    /** `opts.signal` cancels the request on the wire — supplied by the shared
     *  query cache and the debounced list hooks so a superseded read stops. */
    listPipelines: async (params?: Record<string, string>, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ pipelines: Pipeline[]; pagination: PipelineListPagination }>>(`/api/pipelines${buildQuery(params)}`, { signal: opts?.signal });
    },

    /**
     * EVERY pipeline matching `params`, trimmed to `fields` and drained page by
     * page with the keyset cursor. For joins that need the whole set (the
     * deployments drift check, the inbox's "pipelines I own") — a single capped
     * page silently misreports whatever falls past the cap. `id` is always
     * returned. Throws when a page fails, so a partial set is never mistaken
     * for the whole one.
     */
    listAllPipelines: async <K extends keyof Pipeline>(
      fields: readonly K[],
      params?: Record<string, string>,
      opts?: { signal?: AbortSignal },
    ): Promise<Array<Pick<Pipeline, K | 'id'>>> => {
      const out: Array<Pick<Pipeline, K | 'id'>> = [];
      let cursor: string | undefined;
      for (let page = 0; page < DRAIN_MAX_PAGES; page++) {
        const q: Record<string, string> = { ...params, limit: String(DRAIN_PAGE_SIZE), fields: fields.join(',') };
        if (cursor) q.cursor = cursor;
        const res = await core.request<ApiResponse<{ pipelines: Array<Pick<Pipeline, K | 'id'>>; pagination: PipelineListPagination }>>(
          `/api/pipelines${buildQuery(q)}`, { signal: opts?.signal },
        );
        if (!res.success || !res.data) throw new ApiError(res.message || 'Failed to list pipelines', res.statusCode ?? 500);
        out.push(...res.data.pipelines);
        cursor = res.data.pagination.hasMore ? res.data.pagination.nextCursor : undefined;
        if (!cursor) break;
      }
      return out;
    },

    /**
     * A pipeline plus its deploy REGISTRATION. Event ingest resolves every event
     * through the registry, so an unregistered pipeline produces no events at all
     * — its reports, DORA metrics and run history are legitimately empty, which is
     * indistinguishable from a broken dashboard unless the page says so.
     * `registration` is absent when the registry read failed (fail-soft server-side).
     */
    getPipelineById: async (id: string) => {
      return core.request<ApiResponse<{ pipeline: Pipeline; registration?: PipelineRegistrationStatus }>>(
        `/api/pipelines/${id}`);
    },

    /** Per-pipeline maturity scorecard (compliance posture + DORA bands). Requires `advanced_reporting`. */
    getPipelineScorecard: async (id: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ scorecard: PipelineScorecard }>>(`/api/pipelines/${id}/scorecard`, { signal: opts?.signal });
    },

    /**
     * Org-wide scorecard roll-up for ONE page of the org's own pipelines: a ranked
     * software-health leaderboard + aggregate stats over that page. Page with
     * `offset = rollup.pagination.nextOffset`. Requires `advanced_reporting`.
     */
    getOrgScorecardRollup: async (query: ScorecardRollupQuery = {}) => {
      const params = new URLSearchParams();
      if (query.offset) params.set('offset', String(query.offset));
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.project) params.set('project', query.project);
      if (query.pipelineName) params.set('pipelineName', query.pipelineName);
      const qs = params.toString();
      return core.request<ApiResponse<{ rollup: ScorecardRollup }>>(`/api/pipelines/scorecard${qs ? `?${qs}` : ''}`);
    },

    /**
     * Per-pipeline grade history: score + grade for each of the last `periods`
     * weekly/monthly windows (server cap 12). `pipelines:read` + `advanced_reporting`.
     */
    getPipelineScorecardHistory: async (id: string, query: ScorecardHistoryQuery = {}, opts?: { signal?: AbortSignal }) => {
      const qs = scorecardHistoryParams(query).toString();
      return core.request<ApiResponse<{ history: PipelineScorecardHistory }>>(
        `/api/pipelines/${encodeURIComponent(id)}/scorecard/history${qs ? `?${qs}` : ''}`, { signal: opts?.signal });
    },

    /**
     * Org grade history for ONE roll-up page (same paging/filter as
     * getOrgScorecardRollup): each window's org average + every row's points.
     * `reports:read` + `advanced_reporting`.
     */
    getOrgScorecardHistory: async (query: ScorecardRollupQuery & ScorecardHistoryQuery = {}) => {
      const params = scorecardHistoryParams(query);
      if (query.offset) params.set('offset', String(query.offset));
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.project) params.set('project', query.project);
      if (query.pipelineName) params.set('pipelineName', query.pipelineName);
      const qs = params.toString();
      return core.request<ApiResponse<{ history: OrgScorecardHistory }>>(`/api/pipelines/scorecard/history${qs ? `?${qs}` : ''}`);
    },

    /**
     * Create a pipeline. A taken (project, organization) slot is a 409 whose
     * `details` carry `pipelineId` and the `normalized` pair that collided —
     * `opts.upsert` re-sends it as an explicit overwrite, which is how the UI
     * confirms before replacing a live pipeline's props. Responds 200 with
     * `inserted: false` when it overwrote, 201 when it created. `pipeline` is the
     * saved row's identity, not the full record; `warnings` are why the DORA
     * deploy attribution this config produces may be wrong.
     */
    createPipeline: async (data: CreatePipelineData, opts?: ProposedByOptions & { upsert?: boolean }) => {
      return core.request<ApiResponse<{
        pipeline: Pick<Pipeline, 'id' | 'project' | 'organization' | 'pipelineName' | 'visibility' | 'isDefault' | 'isActive' | 'createdAt' | 'createdBy'>;
        inserted?: boolean;
        warnings?: string[];
        pluginWarnings?: PipelinePluginWarning[];
      }>>(
        opts?.upsert ? '/api/pipelines?upsert=true' : '/api/pipelines', {
          method: 'POST',
          body: JSON.stringify(data),
          headers: core.proposedByHeader(opts),
        });
    },

    /**
     * Update a pipeline in place.
     *
     * NOTE — there is deliberately no `movePipeline` / `transferPipeline` here.
     * A pipeline is immutably scoped to the org that created it: the Postgres
     * RLS policy on `pipelines` carries
     * `WITH CHECK (current_is_sysadmin() OR org_id = current_org_id())`, so an
     * UPDATE that rewrote `org_id` is rejected by the database itself, and every
     * dependent row (registry, events, deployment outcomes, incidents,
     * compliance scans) is independently org-scoped. Sharing a pipeline with a
     * TEAM is done on the two fields below instead: `visibility: 'public'` —
     * which a team org reads through its parent — and `ownerId`/`ownerType`,
     * the catalog owner. See `CatalogOwnerFields`.
     *
     * `ownerId`/`ownerType` are admin-only server-side (a plain member's values
     * are dropped, not rejected), and the `public` rung needs `pipelines:publish`.
     */
    updatePipeline: async (id: string, data: {
      pipelineName?: string;
      description?: string;
      keywords?: string[];
      props?: BuilderProps;
      visibility?: Visibility;
      isDefault?: boolean;
      isActive?: boolean;
      /** Catalog owner: a user id (`ownerType: 'user'`) or a team org id
       *  (`ownerType: 'team'`). Not nullable — the server schema requires a
       *  non-empty string, so ownership is reassigned, never cleared. */
      ownerId?: string;
      ownerType?: OwnerType;
      /** Plugin security fixes election. `apply` answers 403
       *  PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED when the org disallows it. */
      remediationUpgrades?: PipelineRemediationElection;
      /** Optimistic concurrency: the `updatedAt` the edit was based on. When the
       *  pipeline changed since, the server answers 412 PRECONDITION_FAILED
       *  (see `isConcurrencyConflict`). Absent: last write wins. */
      expectedUpdatedAt?: string;
    }, opts?: ProposedByOptions) => {
      return core.request<ApiResponse<{ pipeline: Pipeline; pluginWarnings?: PipelinePluginWarning[] }>>(`/api/pipelines/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
        headers: core.proposedByHeader(opts),
      });
    },

    deletePipeline: async (id: string) => {
      return core.request<ApiResponse<undefined>>(`/api/pipelines/${id}`, {
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

    /** `deleted` counts the rows actually removed — an id that didn't match (gone,
     *  another org's) is dropped silently, so it can be below `ids.length`. */
    bulkDeletePipelines: async (ids: string[]) => {
      return core.request<ApiResponse<{ deleted: number; ids: string[] }>>('/api/pipelines/bulk/delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
    },

    /** A 200 even when rows failed: `failed`/`errors` (index into `ids`) name the
     *  rows a compliance block or outage refused, and an unmatched id is simply
     *  not counted in `updated`. */
    bulkUpdatePipelines: async (ids: string[], data: Record<string, unknown>) => {
      return core.request<ApiResponse<{ updated: number; failed: number; errors: Array<{ index: number; error: string }>; pluginWarnings?: PipelinePluginWarning[] }>>('/api/pipelines/bulk/update', {
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
    listPipelineDeployments: async (params?: { limit?: number; offset?: number }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{
        registry: PipelineDeployment[];
        pagination: { total: number; limit: number; offset: number; hasMore: boolean };
      }>>(`/api/pipelines/registry${buildQuery(params as Record<string, unknown> | undefined)}`, { signal: opts?.signal });
    },

    /**
     * Register (upsert) a deployed pipeline in the registry by its stable
     * pipelineId. The server rejects a pipelineId the caller's org does not own
     * (404) or one already claimed by another org (409). Requires
     * `pipeline_registry:write`.
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
     * Requires `pipeline_registry:write`.
     */
    deregisterPipelineDeployment: async (id: string) => {
      return core.request<ApiResponse<{ id: string }>>(`/api/pipelines/registry/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    /**
     * Start a new execution of a deployed pipeline. Every run goes through the
     * pipeline's runner: 202 `{ requestId, status, runnerLabel }` (`status`
     * `delivering` when an in-flight start of the same pipeline is handed back
     * rather than a second one queued) — follow it with `getRunRequest`.
     * 409 NO_RUNNER when the org has no runner that can reach it.
     */
    triggerPipelineExecution: async (pipelineId: string) => {
      return core.request<ApiResponse<QueuedRunRequest>>(`/api/pipelines/${pipelineId}/executions`, {
        method: 'POST',
      });
    },

    /**
     * Stop an in-flight execution through the pipeline's runner. `abandon`
     * skips graceful completion of in-progress actions. The same queued 202 as
     * `triggerPipelineExecution`.
     */
    stopPipelineExecution: async (pipelineId: string, executionId: string, body?: { reason?: string; abandon?: boolean }) => {
      return core.request<ApiResponse<QueuedRunRequest>>(`/api/pipelines/${pipelineId}/executions/${executionId}/stop`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
    },

    /** A queued Re-run / Stop's progress (`pipelines:read`, org-scoped). */
    getRunRequest: async (pipelineId: string, requestId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<RunRequest>>(
        `/api/pipelines/${encodeURIComponent(pipelineId)}/run-requests/${encodeURIComponent(requestId)}`,
        { signal: opts?.signal },
      );
    },

    // ============================================
    // Pipeline runners (org admins: `org_settings:write`; every WRITE is also
    // step-up gated and MFA-grade — a single-factor session gets 401
    // `MFA_REQUIRED`). Registering is the CLI's job (`infra setup-runner`).
    // ============================================

    /** Own runners, and the ones a parent shares with this team. */
    getPipelineRunners: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<PipelineRunnersDto>>('/api/pipelines/runners', { signal: opts?.signal });
    },
    /** Rename / share with teams / new Function URL (re-pinged). */
    updatePipelineRunner: async (runnerId: string, body: PipelineRunnerUpdate, stepUpToken?: string) => {
      return core.request<ApiResponse<{ runner: PipelineRunner }>>(`/api/pipelines/runners/${encodeURIComponent(runnerId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Signed ping; resumes delivery when the runner answers. Rate-limited. */
    testPipelineRunner: async (runnerId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<PipelineRunnerTestResult>>(`/api/pipelines/runners/${encodeURIComponent(runnerId)}/test`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Revoke: stops delivery, clears pipeline links, expires pending requests. */
    revokePipelineRunner: async (runnerId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ runner?: PipelineRunner }>>(`/api/pipelines/runners/${encodeURIComponent(runnerId)}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** The pipelines linked to a runner (id and name), a page at a time. */
    getRunnerPipelines: async (runnerId: string, params?: { limit?: number; offset?: number }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<RunnerPipelinesPage>>(
        `/api/pipelines/runners/${encodeURIComponent(runnerId)}/pipelines${buildQuery(params ?? {})}`,
        { signal: opts?.signal },
      );
    },

    // -- The org's runner signing key. Every write is step-up gated, MFA-grade
    // and limited to 5 per org per hour; the answer is always the card's DTO
    // (key ids and dates, never key material).

    /** Generate the org's first key (created active). 409 RUNNER_KEY_EXISTS when it has one. */
    generateRunnerSigningKey: async (stepUpToken?: string) => {
      return core.request<ApiResponse<RunnerSigningKeyDto>>('/api/pipelines/runners/signing-key', {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Publish a `next` key that starts signing in 10 minutes. */
    rotateRunnerSigningKey: async (stepUpToken?: string) => {
      return core.request<ApiResponse<RunnerSigningKeyDto>>('/api/pipelines/runners/signing-key/rotate', {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Cancel a `next` key before it activates. */
    cancelRunnerSigningKeyRotation: async (stepUpToken?: string) => {
      return core.request<ApiResponse<RunnerSigningKeyDto>>('/api/pipelines/runners/signing-key/rotate', {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Retire the `retiring` key early (refused before its retire-after time). */
    finishRunnerSigningKeyRotation: async (stepUpToken?: string) => {
      return core.request<ApiResponse<RunnerSigningKeyDto>>('/api/pipelines/runners/signing-key/finish', {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Emergency: retire the active key now. `confirm` = the active kid's last 6 characters. */
    revokeRunnerSigningKey: async (confirm: string, stepUpToken?: string) => {
      return core.request<ApiResponse<RunnerSigningKeyDto>>('/api/pipelines/runners/signing-key/revoke', {
        method: 'POST',
        body: JSON.stringify({ confirm }),
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Inherit the parent's key, or use our own (sub-organizations only). */
    setRunnerSigningKeyMode: async (mode: RunnerKeyMode, stepUpToken?: string) => {
      return core.request<ApiResponse<RunnerSigningKeyDto>>('/api/pipelines/runners/signing-key/mode', {
        method: 'PUT',
        body: JSON.stringify({ mode }),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    // -- A pipeline's link to its runner (found by its pb.pipeline-id tag, never picked by hand).

    /** Status, runner label, last checked, runners checked. 404 = not registered. */
    getPipelineRunnerLink: async (pipelineId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<RunnerLinkDto>>(`/api/pipelines/${encodeURIComponent(pipelineId)}/runner-link`, { signal: opts?.signal });
    },
    /** Find runner again: queues a re-probe (202, `status: 'checking'`). Step-up gated. */
    refreshPipelineRunnerLink: async (pipelineId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<RunnerLinkDto>>(`/api/pipelines/${encodeURIComponent(pipelineId)}/runner-link/refresh`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    // -- Operators (system org): every org's signing-key status and the pause toggle.

    /** Every org's key status (never key material), filterable. */
    listRunnerSigningKeyStatus: async (query: RunnerKeyStatusQuery = {}, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ orgs: RunnerKeyStatusRow[]; pagination: RunnerPipelinesPage['pagination'] }>>(
        `/api/pipelines/admin/runner-signing-keys${buildQuery({ ...query })}`,
        { signal: opts?.signal },
      );
    },
    /** Emergency revoke of one org's active key (system org). Step-up gated. */
    systemRevokeRunnerSigningKey: async (orgId: string, body: { reason?: string }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ orgId: string; revokedKid: string | null; activeKid: string | null }>>(
        `/api/pipelines/admin/orgs/${encodeURIComponent(orgId)}/runner-signing-key/revoke`,
        { method: 'POST', body: JSON.stringify(body), headers: core.stepUpHeader(stepUpToken) },
      );
    },
    /** The platform pause toggle for all runner traffic. */
    getRunnerDeliveries: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<RunnerDeliveriesDto>>('/api/pipelines/admin/runner-deliveries', { signal: opts?.signal });
    },
    /** Pause or resume every pipeline run on the deployment. Step-up gated. */
    setRunnerDeliveriesPaused: async (body: { paused: boolean; reason?: string }, stepUpToken?: string) => {
      return core.request<ApiResponse<RunnerDeliveriesDto>>('/api/pipelines/admin/runner-deliveries', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    // ============================================
    // Plugin remediation + artifact security reports
    // ============================================

    /**
     * Which of a pipeline's plugin steps should move to a newer version, the
     * versions it would move to (inside the pin, or `widen` past it) and which
     * versions the move would leave unreferenced (`releases`). Writes nothing.
     * `pipelines:read`.
     */
    previewPluginUpgrades: async (pipelineId: string, opts?: { widen?: boolean; signal?: AbortSignal }) => {
      return core.request<ApiResponse<PluginUpgradePreview>>(
        `/api/pipelines/${encodeURIComponent(pipelineId)}/plugin-upgrades/preview${opts?.widen ? '?widen=true' : ''}`,
        { method: 'POST', signal: opts?.signal },
      );
    },

    /**
     * Rewrite the plugin steps' version pins across up to 50 pipelines through
     * the normal validated write path (`steps` narrows to those step keys;
     * `redeploy` starts an execution of each upgraded pipeline). Audited
     * `pipeline.plugin.upgraded`. `pipelines:write`.
     */
    applyPluginUpgrades: async (body: { pipelineIds: string[]; widen?: boolean; steps?: string[]; redeploy?: boolean }) => {
      return core.request<ApiResponse<PluginUpgradeApplyResult>>('/api/pipelines/plugin-upgrades/apply', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    /**
     * The pipeline's Plugin security fixes election, its effective mode (and
     * where it came from), and every remediation upgrade row: open proposals,
     * wave status and rollback history. `pipelines:read`.
     */
    getPipelineRemediationUpgrades: async (pipelineId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<PipelineRemediationUpgrades>>(
        `/api/pipelines/${encodeURIComponent(pipelineId)}/remediation-upgrades`, { signal: opts?.signal });
    },

    /** Apply an open remediation proposal through the normal validated upgrade path (audited `pipeline.plugin.upgraded`). `pipelines:write`. */
    applyPipelineRemediationUpgrade: async (pipelineId: string, upgradeId: string) => {
      return core.request<ApiResponse<{ upgrade: PipelineRemediationUpgradeView }>>(
        `/api/pipelines/${encodeURIComponent(pipelineId)}/remediation-upgrades/${encodeURIComponent(upgradeId)}/apply`,
        { method: 'POST', body: JSON.stringify({}) },
      );
    },

    /** Dismiss an open remediation proposal (the pipeline keeps its version). `pipelines:write`. */
    dismissPipelineRemediationUpgrade: async (pipelineId: string, upgradeId: string) => {
      return core.request<ApiResponse<{ upgrade: PipelineRemediationUpgradeView }>>(
        `/api/pipelines/${encodeURIComponent(pipelineId)}/remediation-upgrades/${encodeURIComponent(upgradeId)}/dismiss`,
        { method: 'POST', body: JSON.stringify({}) },
      );
    },

    /** The latest application-artifact scan report per (tool, stage) the pipeline's runs uploaded, plus summed counts. `pipelines:read`. */
    getPipelineSecurityReports: async (pipelineId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<PipelineSecurityReports>>(
        `/api/pipelines/${encodeURIComponent(pipelineId)}/security-reports`, { signal: opts?.signal });
    },

    /**
     * Remove ONE (tool, stage) report slot the pipeline no longer writes (a dropped
     * scanner, a renamed stage), so its last counts stop feeding the scorecard.
     * `stage` omitted / empty = the stage-less slot. `pipelines:write`; 404 when the
     * slot is empty. Audited `pipeline.security_report.delete`.
     */
    deletePipelineSecurityReport: async (pipelineId: string, slot: { tool: string; stage?: string }) => {
      const params = new URLSearchParams({ tool: slot.tool });
      if (slot.stage) params.set('stage', slot.stage);
      return core.request<ApiResponse<{ pipelineId: string; tool: string; stage: string; removed: string }>>(
        `/api/pipelines/${encodeURIComponent(pipelineId)}/security-reports?${params.toString()}`, { method: 'DELETE' });
    },

    getAIProviders: async () => {
      return core.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/pipelines/providers');
    },

    /**
     * Stream AI pipeline generation from a Git URL.
     * Yields analyzing → analyzed → partial → done events, then (when the config
     * references plugins) checking-plugins → missing-plugins: the plugins the org
     * lacks, PROPOSED — the stream creates nothing; see {@link createMissingPlugins}.
     */
    streamPipelineFromUrl: async function*(gitUrl: string, provider: string, model: string, apiKey?: string, repoToken?: string) {
      yield* core.streamRequest('/api/pipelines/generate/from-url/stream', {
        gitUrl, provider, model,
        ...(apiKey ? { apiKey } : {}),
        ...(repoToken ? { repoToken } : {}),
      });
    },

    /**
     * Create the placeholder plugins the user CONFIRMED from a from-URL
     * generation's `missing-plugins` proposal. The server re-checks every name
     * (already exists / a listed plugin / unsafe → refused) and creates each as
     * the user, so the plugin service's own `plugins:write` gate and audit apply.
     */
    createMissingPlugins: async (plugins: string[]) => {
      return core.request<ApiResponse<{
        created: string[];
        existing: string[];
        builds: Array<{ name: string; requestId?: string; error?: string }>;
      }>>('/api/pipelines/generate/missing-plugins', { method: 'POST', body: JSON.stringify({ plugins }) });
    },

    /**
     * Stream AI pipeline generation from a free-text prompt.
     * Yields partial → done events (no repo-analysis / auto-plugin phases —
     * those are exclusive to the from-URL flow).
     */
    streamPipelineFromPrompt: async function*(prompt: string, provider: string, model: string, apiKey?: string) {
      yield* core.streamRequest('/api/pipelines/generate/stream', {
        prompt, provider, model,
        ...(apiKey ? { apiKey } : {}),
      });
    },
  };
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery, type ProposedByOptions } from '../util';
import { ApiError } from '../errors';
import type { ApiResponse, CreatePipelineData, BuilderProps, OwnerType, Pipeline, PipelineScorecard, ScorecardRollup, Visibility } from '@/types';

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
  items: Array<{ index: number; visibility?: string; id?: string }>;
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

    getPipelineById: async (id: string) => {
      return core.request<ApiResponse<{ pipeline: Pipeline }>>(`/api/pipelines/${id}`);
    },

    /** Per-pipeline maturity scorecard (compliance posture + DORA bands). Requires `advanced_reporting`. */
    getPipelineScorecard: async (id: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ scorecard: PipelineScorecard }>>(`/api/pipelines/${id}/scorecard`, { signal: opts?.signal });
    },

    /** Org-wide scorecard roll-up: a ranked software-health leaderboard + aggregate stats. Requires `advanced_reporting`. */
    getOrgScorecardRollup: async () => {
      return core.request<ApiResponse<{ rollup: ScorecardRollup }>>('/api/pipelines/scorecard');
    },

    createPipeline: async (data: CreatePipelineData, opts?: ProposedByOptions) => {
      return core.request<ApiResponse<{ pipeline: Pipeline; warning?: string }>>('/api/pipelines', {
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
     * the catalog owner. See `PipelineOwnerFields`.
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
    }, opts?: ProposedByOptions) => {
      return core.request<ApiResponse<{ pipeline: Pipeline }>>(`/api/pipelines/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
        headers: core.proposedByHeader(opts),
      });
    },

    deletePipeline: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/pipelines/${id}`, {
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
      return core.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/pipelines/providers');
    },

    /**
     * Stream AI pipeline generation from a Git URL.
     * Yields analyzing → analyzed → partial → done events.
     */
    streamPipelineFromUrl: async function*(gitUrl: string, provider: string, model: string, apiKey?: string, repoToken?: string) {
      yield* core.streamRequest('/api/pipelines/generate/from-url/stream', {
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
      yield* core.streamRequest('/api/pipelines/generate/stream', {
        prompt, provider, model,
        ...(apiKey ? { apiKey } : {}),
      });
    },
  };
}

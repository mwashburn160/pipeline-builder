// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistence for runners, run requests and the registry's runner link.
 *
 * Every method runs ELEVATED (sysadmin tenant scope) with the org predicates
 * stated explicitly by the caller: the dispatcher and the sweep act outside any
 * user's org, and a team reads its ancestors' shared runners. The
 * service layer above is what decides which org ids a caller may name.
 */

import type { RunnerLinkDetail, RunnerLinkStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { pipelineRegistryRunnerLink, runWithTenantContext, schema, withTenantTx, type RunRequestStatus } from '@pipeline-builder/pipeline-data';
import { and, asc, count, eq, inArray, lt, lte, ne, sql } from 'drizzle-orm';

export type RunnerRow = typeof schema.pipelineRunner.$inferSelect;
export type RunnerInsert = typeof schema.pipelineRunner.$inferInsert;
export type RunRequestRow = typeof schema.pipelineRunRequest.$inferSelect;
export type RunRequestInsert = typeof schema.pipelineRunRequest.$inferInsert;

export { PENDING_STATUSES, TERMINAL_STATUSES } from './vocabulary.js';
import { PENDING_STATUSES } from './vocabulary.js';

/** The registry facts routing needs: the delivery hint and the runner link. */
export interface RegistryLink {
  pipelineName: string;
  region: string | null;
  runnerId: string | null;
  /** The last probe's outcome (`runner_link_status`); `unlinked` before any. */
  linkStatus?: RunnerLinkStatus;
  linkCheckedAt?: Date | null;
  linkDetail?: RunnerLinkDetail | null;
}

/** What one probe (discovery, rediscovery, the registration probe, Find runner again) records on the registry row. */
export interface RunnerLinkWrite {
  status: RunnerLinkStatus;
  checkedAt: Date;
  detail: RunnerLinkDetail | null;
  /** Set only by a single match; omitted, the existing `runner_id` is kept. */
  runnerId?: string;
}

export interface RunnerStore {
  insertRunner(row: RunnerInsert): Promise<RunnerRow>;
  getRunner(id: string): Promise<RunnerRow | null>;
  /** Runners of the given orgs (optionally active only), oldest first. */
  listRunners(orgIds: readonly string[], opts?: { activeOnly?: boolean }): Promise<RunnerRow[]>;
  /** Every active runner (the sweep). */
  listActiveRunners(): Promise<RunnerRow[]>;
  /** Pending + active runners of one org (the per-org cap). */
  countRunners(orgId: string): Promise<number>;
  updateRunner(id: string, patch: Partial<RunnerInsert>): Promise<RunnerRow | null>;
  /** Atomically bump the failure counter; returns the updated row. */
  recordRunnerFailure(id: string): Promise<RunnerRow | null>;
  /** healthy → unreachable, only if it is still healthy: the row when THIS call made the transition, else null. */
  markRunnerUnreachable(id: string): Promise<RunnerRow | null>;
  countUnhealthyRunners(): Promise<number>;

  insertRequest(row: RunRequestInsert): Promise<RunRequestRow>;
  getRequest(id: string): Promise<RunRequestRow | null>;
  /** Update a request, only while its status is one of `fromStatuses` (when given). */
  updateRequest(id: string, patch: Partial<RunRequestInsert>, fromStatuses?: readonly RunRequestStatus[]): Promise<RunRequestRow | null>;
  /** Pending requests whose expiry passed. */
  listExpired(now: Date): Promise<RunRequestRow[]>;
  /** A runner's requests in the given statuses (oldest first). */
  listRunnerRequests(runnerId: string, statuses: readonly RunRequestStatus[]): Promise<RunRequestRow[]>;
  /** Queued requests (the sweep re-kicks them: a lost job, a queue that was down, a signing key restored). */
  listQueued(limit: number): Promise<RunRequestRow[]>;
  /** An org's pending (queued|delivering) start/stop requests. */
  countPending(orgId: string): Promise<number>;
  /** A runner's deliveries in flight. */
  countDelivering(runnerId: string): Promise<number>;
  /** The pending START request for (org, pipeline), if one exists. */
  findPendingStart(orgId: string, pipelineId: string): Promise<RunRequestRow | null>;
  /** Whether any request names `id` as its parent (a re-discovery already ran). */
  hasChildRequests(id: string): Promise<boolean>;
  /** Delete `pending` runners created before `before`. */
  deletePendingRunnersBefore(before: Date): Promise<number>;
  /** Delete requests in `statuses` requested before `before` (retention). */
  deleteRequestsBefore(statuses: readonly RunRequestStatus[], before: Date): Promise<number>;

  getRegistryLink(pipelineId: string, orgId: string): Promise<RegistryLink | null>;
  /**
   * Set (or clear with null) a pipeline's runner link; `onlyIfRunnerId` makes a
   * clear conditional. Setting marks the link `linked`, clearing `unlinked`.
   */
  setRegistryRunner(pipelineId: string, orgId: string, runnerId: string | null, onlyIfRunnerId?: string): Promise<boolean>;
  /** Record a probe's state/outcome on the pipeline's registry row (no row: false). */
  writeRunnerLink(pipelineId: string, orgId: string, write: RunnerLinkWrite): Promise<boolean>;
  /**
   * Rows left `checking` since before `before` (a replica died mid-probe): put
   * back `linked` / `unlinked` by their runner_id. Returns how many.
   */
  resetStaleLinkChecks(before: Date): Promise<number>;
  /** Clear every pipeline link to a runner (status `unlinked`). */
  clearRunnerLinks(runnerId: string): Promise<number>;
  /** runnerId → how many registry rows link to it (any org). */
  pipelineCounts(runnerIds: readonly string[]): Promise<Map<string, number>>;
  /** The pipelines linked to a runner (any org), by name, paginated. */
  listRunnerPipelines(runnerId: string, limit: number, offset: number): Promise<{ rows: Array<{ id: string; name: string }>; total: number }>;
  /** The orgs OTHER than `ownerOrgId` with a pipeline linked to the runner (teams using a shared runner). */
  linkedOrgIds(runnerId: string, ownerOrgId: string): Promise<string[]>;
  /** pipelineId → its linked runner `{ id, label }` (the Deployment card), for one org's pipelines. */
  runnerLinks(pipelineIds: readonly string[], orgId: string): Promise<Map<string, { id: string; label: string }>>;
}

const elevated = <T>(fn: Parameters<typeof withTenantTx<T>>[0]): Promise<T> =>
  runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));

const R = schema.pipelineRunner;
const Q = schema.pipelineRunRequest;
// The registry through its runner-link mapping — the only one naming `runner_id`.
const G = pipelineRegistryRunnerLink;

/** The Drizzle/Postgres implementation. */
export function createDrizzleRunnerStore(): RunnerStore {
  return {
    insertRunner: (row) => elevated(async (tx) => (await tx.insert(R).values(row).returning())[0]!),
    getRunner: (id) => elevated(async (tx) => (await tx.select().from(R).where(eq(R.id, id)))[0] ?? null),
    listRunners: (orgIds, opts) => (orgIds.length === 0 ? Promise.resolve([]) : elevated((tx) => tx.select().from(R)
      .where(and(inArray(R.orgId, [...orgIds]), opts?.activeOnly ? eq(R.status, 'active') : undefined))
      .orderBy(asc(R.createdAt), asc(R.id)))),
    listActiveRunners: () => elevated((tx) => tx.select().from(R).where(eq(R.status, 'active'))),
    countRunners: (orgId) => elevated(async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(R)
      .where(and(eq(R.orgId, orgId), inArray(R.status, ['pending', 'active']))))[0]?.n ?? 0),
    updateRunner: (id, patch) => elevated(async (tx) => (await tx.update(R).set(patch).where(eq(R.id, id)).returning())[0] ?? null),
    recordRunnerFailure: (id) => elevated(async (tx) => (await tx.update(R)
      .set({ consecutiveFailures: sql`${R.consecutiveFailures} + 1` }).where(eq(R.id, id)).returning())[0] ?? null),
    markRunnerUnreachable: (id) => elevated(async (tx) => (await tx.update(R)
      .set({ health: 'unreachable' }).where(and(eq(R.id, id), eq(R.health, 'healthy'))).returning())[0] ?? null),
    countUnhealthyRunners: () => elevated(async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(R)
      .where(and(eq(R.status, 'active'), sql`${R.health} <> 'healthy'`)))[0]?.n ?? 0),

    insertRequest: (row) => elevated(async (tx) => (await tx.insert(Q).values(row).returning())[0]!),
    getRequest: (id) => elevated(async (tx) => (await tx.select().from(Q).where(eq(Q.id, id)))[0] ?? null),
    updateRequest: (id, patch, from) => elevated(async (tx) => (await tx.update(Q).set(patch)
      .where(and(eq(Q.id, id), from && from.length > 0 ? inArray(Q.status, [...from]) : undefined)).returning())[0] ?? null),
    listExpired: (now) => elevated((tx) => tx.select().from(Q)
      .where(and(inArray(Q.status, [...PENDING_STATUSES]), lte(Q.expiresAt, now))).limit(500)),
    listRunnerRequests: (runnerId, statuses) => elevated((tx) => tx.select().from(Q)
      .where(and(eq(Q.runnerId, runnerId), inArray(Q.status, [...statuses]))).orderBy(asc(Q.requestedAt)).limit(500)),
    listQueued: (limit) => elevated((tx) => tx.select().from(Q).where(eq(Q.status, 'queued')).orderBy(asc(Q.requestedAt)).limit(limit)),
    countPending: (orgId) => elevated(async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(Q)
      .where(and(eq(Q.orgId, orgId), inArray(Q.status, [...PENDING_STATUSES]), inArray(Q.action, ['start', 'stop']))))[0]?.n ?? 0),
    countDelivering: (runnerId) => elevated(async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(Q)
      .where(and(eq(Q.runnerId, runnerId), eq(Q.status, 'delivering'), inArray(Q.action, ['start', 'stop']))))[0]?.n ?? 0),
    findPendingStart: (orgId, pipelineId) => elevated(async (tx) => (await tx.select().from(Q)
      .where(and(eq(Q.orgId, orgId), eq(Q.pipelineId, pipelineId), eq(Q.action, 'start'), inArray(Q.status, [...PENDING_STATUSES])))
      .orderBy(asc(Q.requestedAt)).limit(1))[0] ?? null),
    hasChildRequests: (id) => elevated(async (tx) => (await tx.select({ id: Q.id }).from(Q).where(eq(Q.parentRequestId, id)).limit(1)).length > 0),
    deletePendingRunnersBefore: (before) => elevated(async (tx) => (await tx.delete(R)
      .where(and(eq(R.status, 'pending'), lt(R.createdAt, before))).returning({ id: R.id })).length),
    deleteRequestsBefore: (statuses, before) => elevated(async (tx) => (await tx.delete(Q)
      .where(and(inArray(Q.status, [...statuses]), lt(Q.requestedAt, before))).returning({ id: Q.id })).length),

    getRegistryLink: (pipelineId, orgId) => elevated(async (tx) => {
      const [row] = await tx.select({
        pipelineName: G.pipelineName,
        region: G.region,
        runnerId: G.runnerId,
        linkStatus: G.runnerLinkStatus,
        linkCheckedAt: G.runnerLinkCheckedAt,
        linkDetail: G.runnerLinkDetail,
      }).from(G).where(and(eq(G.pipelineId, pipelineId), eq(G.orgId, orgId)));
      return row ? {
        pipelineName: row.pipelineName,
        region: row.region ?? null,
        runnerId: row.runnerId ?? null,
        linkStatus: row.linkStatus,
        linkCheckedAt: row.linkCheckedAt ?? null,
        linkDetail: row.linkDetail ?? null,
      } : null;
    }),
    setRegistryRunner: (pipelineId, orgId, runnerId, onlyIfRunnerId) => elevated(async (tx) => {
      const rows = await tx.update(G).set({ runnerId, runnerLinkStatus: runnerId ? 'linked' : 'unlinked' })
        .where(and(eq(G.pipelineId, pipelineId), eq(G.orgId, orgId), onlyIfRunnerId ? eq(G.runnerId, onlyIfRunnerId) : undefined))
        .returning({ id: G.id });
      return rows.length > 0;
    }),
    writeRunnerLink: (pipelineId, orgId, write) => elevated(async (tx) => {
      const rows = await tx.update(G).set({
        runnerLinkStatus: write.status,
        runnerLinkCheckedAt: write.checkedAt,
        runnerLinkDetail: write.detail,
        ...(write.runnerId ? { runnerId: write.runnerId } : {}),
      }).where(and(eq(G.pipelineId, pipelineId), eq(G.orgId, orgId))).returning({ id: G.id });
      return rows.length > 0;
    }),
    resetStaleLinkChecks: (before) => elevated(async (tx) => (await tx.update(G)
      .set({ runnerLinkStatus: sql`CASE WHEN ${G.runnerId} IS NULL THEN 'unlinked' ELSE 'linked' END` })
      .where(and(eq(G.runnerLinkStatus, 'checking'), lt(G.runnerLinkCheckedAt, before))).returning({ id: G.id })).length),
    clearRunnerLinks: (runnerId) => elevated(async (tx) => (await tx.update(G).set({ runnerId: null, runnerLinkStatus: 'unlinked' })
      .where(eq(G.runnerId, runnerId)).returning({ id: G.id })).length),
    pipelineCounts: async (runnerIds) => {
      const unique = [...new Set(runnerIds)];
      if (unique.length === 0) return new Map();
      const rows = await elevated((tx) => tx.select({ runnerId: G.runnerId, n: count() }).from(G)
        .where(inArray(G.runnerId, unique)).groupBy(G.runnerId));
      return new Map(rows.filter((r) => r.runnerId).map((r) => [r.runnerId!, Number(r.n)]));
    },
    listRunnerPipelines: (runnerId, limit, offset) => elevated(async (tx) => {
      const rows = await tx.select({ id: G.pipelineId, name: G.pipelineName }).from(G)
        .where(eq(G.runnerId, runnerId)).orderBy(asc(G.pipelineName), asc(G.pipelineId)).limit(limit).offset(offset);
      const [total] = await tx.select({ n: count() }).from(G).where(eq(G.runnerId, runnerId));
      return { rows, total: Number(total?.n ?? 0) };
    }),
    linkedOrgIds: (runnerId, ownerOrgId) => elevated(async (tx) => (await tx.selectDistinct({ orgId: G.orgId }).from(G)
      .where(and(eq(G.runnerId, runnerId), ne(G.orgId, ownerOrgId)))).map((r) => r.orgId)),
    runnerLinks: async (pipelineIds, orgId) => {
      const unique = [...new Set(pipelineIds)];
      if (unique.length === 0) return new Map();
      const rows = await elevated((tx) => tx.select({ pipelineId: G.pipelineId, id: R.id, label: R.label })
        .from(G).innerJoin(R, eq(R.id, G.runnerId))
        .where(and(eq(G.orgId, orgId), inArray(G.pipelineId, unique))));
      return new Map(rows.map((r) => [r.pipelineId, { id: r.id, label: r.label }]));
    },
  };
}

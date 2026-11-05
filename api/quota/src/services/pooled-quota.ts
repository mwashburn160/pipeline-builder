// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org → team POOLED quota.
 *
 * Every counted dimension of an account is capped at the ROOT organization and
 * shared by the root plus all of its teams: the root's limit is measured
 * against the SUM of the whole subtree's live usage. A team's own quota row is
 * seeded `-1` on every dimension (organization-service `create` /
 * org-hierarchy-service `teamQuotas`) precisely because only the root's cap is
 * meant to bind.
 *
 * That makes pooling load-bearing rather than decorative: if the root cap can't
 * be resolved, falling back to a team's own row is not degraded enforcement, it
 * is NO enforcement. So everything here is written around a single rule —
 * a pooled resolution failure degrades to the last-known cap, and failing that
 * DENIES for a team (see {@link QuotaPoolUnavailableError}) while letting a
 * root / flat org fall through to its own (real) limits.
 *
 * `storageBytes` is HALF carved out. Its usage is measured live by the
 * image-registry rather than tracked in `org.usage`, so the pooled `used` for it
 * is structurally 0 and the push gate measures the org's own namespace instead.
 * Its LIMIT is pooled like everything else, though: excluding it would drop a
 * team through to its own row, and a team's own limits are -1. The registry
 * gate reads that as genuinely unlimited and skips enforcement, so every team
 * could push without bound past the root's cap — the silent "unlimited" this
 * module exists to prevent.
 *
 * ENFORCEMENT is a single atomic counter on the root (`poolUsage.<type>`,
 * moved by `QuotaService.incrementUsage` in one conditional update), so the
 * root and its teams can never jointly overshoot the shared cap. This module
 * resolves WHICH root an increment lands on ({@link resolveIncrementRoot}) and
 * reports pooled numbers for reads; the sum of each org's own `usage` is only
 * the fallback for a pool whose counter has not started yet.
 *
 * Split out of `quota-service.ts`, whose remaining job is the per-org Mongo
 * read/write surface.
 */

import { AppError, createLogger, emitCounter, enforcedQuotaLimit, ErrorCode, VALID_QUOTA_TYPES, nextQuotaResetDate, quotaPeriodDays } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaTier } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { expandOrgScope, findOrgWithHierarchy, getParentOrgId, resolveRootOrgId } from '../helpers/org-hierarchy.js';
import type { OrgHierarchyLookup } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { defaultLimitFor } from '../helpers/quota-helpers.js';
import type { OrgQuotaResponse, QuotaStatus } from '../helpers/quota-helpers.js';
import { Organization } from '../models/organization.js';

const logger = createLogger('pooled-quota');

/** Resolved org → team pool: the root that owns the shared caps + its whole subtree. */
export interface OrgPool {
  rootOrgId: string;
  /** Root + every descendant org id (always > 1 entry). */
  scope: string[];
}

/** Minimal org row shape the pooled computations read (lean projection). */
export interface PoolRow {
  _id?: unknown;
  name?: string;
  tier?: QuotaTier;
  quotas?: Partial<Record<QuotaType, number>>;
  usage?: Partial<Record<QuotaType, { used?: number; resetAt?: Date }>>;
  /** Root only: the atomic pooled counter enforcement moves. `limitAtPeriodStart`
   *  is the cap the period began with, so a mid-period reduction cannot strand a
   *  pooled account over a cap it already spent against (see `pooledStatusFromRows`). */
  poolUsage?: Partial<Record<QuotaType, { used?: number; resetAt?: Date; limitAtPeriodStart?: number }>>;
}

/**
 * Pooled status for one quota type from the subtree's rows: the ROOT's limit
 * (its tier's preset when unset) against the pool's usage. Returns null when no
 * limit resolves (caller falls back to per-org).
 *
 * Usage is the root's atomic pool counter (`poolUsage.<type>`) once it has
 * started — the exact number increment enforces; an EXPIRED counter reads 0
 * (the next increment rolls it). Before the first pooled increment there is no
 * counter, so the SUM of every org's live own usage stands in (a period whose
 * `resetAt` has passed counts as 0).
 *
 * `used` is already expiry-adjusted, so it must NOT go through
 * `computeQuotaStatus` (that would re-apply expiry against the ROOT's own
 * resetAt and zero the whole pool whenever the root's own period lapsed).
 */
/**
 * The usage period for one quota type, in days — the pooled path's copy of the
 * same rule the summary builder uses. `cpuCredits` is monthly; everything else
 * shares the global window.
 */
function periodDaysForType(quotaType: QuotaType): number {
  return quotaType === 'cpuCredits' ? quotaPeriodDays(quotaType) : config.quota.resetDays;
}

export function pooledStatusFromRows(rows: PoolRow[], rootOrgId: string, quotaType: QuotaType): QuotaStatus | null {
  const root = rows.find((r) => r._id !== undefined && String(r._id) === rootOrgId);
  const limit = root?.quotas?.[quotaType] ?? defaultLimitFor(root?.tier, quotaType);
  if (limit === undefined) return null;
  const now = Date.now();
  const live = (u: { used?: number; resetAt?: Date } | undefined): number => {
    if (!u) return 0;
    const resetAtMs = u.resetAt ? new Date(u.resetAt).getTime() : 0;
    return resetAtMs > now ? (u.used ?? 0) : 0;
  };
  const pool = root?.poolUsage?.[quotaType];
  const used = pool?.resetAt
    ? live(pool)
    : rows.reduce((sum, r) => sum + live(r.usage?.[quotaType]), 0);
  const resetAt = pool?.resetAt ?? root?.usage?.[quotaType]?.resetAt
    // Per TYPE: `config.quota.resetDays` is the global three-day window and
    // `cpuCredits` is monthly, so the global would report a reset date ten times
    // too near for the one quota whose forecast most depends on it.
    ?? nextQuotaResetDate(quotaType === 'cpuCredits' ? quotaPeriodDays(quotaType) : config.quota.resetDays);

  // CAPS ONLY RISE MID-PERIOD, on the pooled counter as on the per-org one. The
  // snapshot is absent before the first pooled increment (no period is
  // established yet), which correctly falls back to the current limit.
  const snapshot = pool?.resetAt && new Date(pool.resetAt).getTime() > now
    ? pool.limitAtPeriodStart
    : undefined;
  const effective = snapshot === undefined ? limit
    : (limit === -1 || snapshot === -1) ? -1
      : Math.max(limit, snapshot);

  return {
    limit: effective,
    used,
    remaining: effective === -1 ? -1 : Math.max(0, effective - used),
    // Binds on the ENFORCED cap (the automationCalls soft band); reports the nominal one.
    allowed: limit === -1 || used < enforcedQuotaLimit(quotaType, limit),
    unlimited: limit === -1,
    resetAt,
  };
}

// Pooled-cap fallback cache

/**
 * Counter emitted whenever the pooled root cap could not be resolved.
 * `outcome` says what enforcement did instead:
 *   - `cached`     — served the last-known root cap (stale but real enforcement);
 *   - `denied`     — the org is a team (its own limits are -1), so the call was
 *                    refused with {@link QuotaPoolUnavailableError};
 *   - `own_limits` — a root / flat org, whose own row still carries real limits.
 * Alert on `denied` (tenant-visible failures) and on any sustained rate at all.
 */
const POOL_FAILURE_METRIC = 'quota_pool_resolution_failed_total';

/** Last successfully resolved pooled status for one (org, quotaType). */
interface PoolCacheEntry {
  status: QuotaStatus;
  expires: number;
}

/**
 * Bound on the fallback cache. One entry per (pooled org × quota type); the
 * eviction below keeps a huge fleet from growing the map without limit.
 */
const POOL_CACHE_MAX_ENTRIES = 10_000;

const poolStatusCache = new Map<string, PoolCacheEntry>();

function poolCacheKey(orgId: string, quotaType: QuotaType): string {
  return `${orgId}::${quotaType}`;
}

/**
 * Memoize a freshly resolved pooled status so a later resolution FAILURE can
 * degrade to it instead of denying outright. Only the failure path ever reads
 * this — the happy path always re-resolves, so normal enforcement stays exact.
 */
function rememberPoolStatus(orgId: string, quotaType: QuotaType, status: QuotaStatus): void {
  const ttl = config.quota.poolFallbackTtlMs;
  if (!(ttl > 0)) return; // disabled (or unset) — every failure then denies
  if (poolStatusCache.size >= POOL_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of poolStatusCache) if (v.expires <= now) poolStatusCache.delete(k);
    // Map preserves insertion order, so the first key is the oldest write.
    if (poolStatusCache.size >= POOL_CACHE_MAX_ENTRIES) {
      const oldest = poolStatusCache.keys().next();
      if (!oldest.done) poolStatusCache.delete(oldest.value);
    }
  }
  poolStatusCache.set(poolCacheKey(orgId, quotaType), { status, expires: Date.now() + ttl });
}

/** The last-known pooled status for (org, quotaType) while still fresh. */
function recallPoolStatus(orgId: string, quotaType: QuotaType): QuotaStatus | null {
  const key = poolCacheKey(orgId, quotaType);
  const hit = poolStatusCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    poolStatusCache.delete(key);
    return null;
  }
  return hit.status;
}

/** Drop every memoized pooled cap (tests; also a safe operational reset). */
export function clearPoolStatusCache(): void {
  poolStatusCache.clear();
}

/**
 * 503 — the pooled (root) cap for a TEAM could not be resolved and no recent
 * cap was cached, so quota could not be enforced at all.
 *
 * Denying is deliberate. A team's own quota row is seeded `-1` on EVERY
 * dimension (organization-service `create` / org-hierarchy-service `teamQuotas`)
 * because only the root's pooled cap is meant to bind, and the per-org atomic
 * `$expr` short-circuits on `-1`. Falling back to the team's own row therefore
 * isn't degraded enforcement — it is no enforcement, unlimited, for every team
 * in the fleet. `AppError` so `withRoute` renders it as a clean 503 the UI can
 * show verbatim instead of a generic 500.
 */
export class QuotaPoolUnavailableError extends AppError {
  constructor(orgId: string) {
    super(
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      `Quota is temporarily unenforceable for organization ${orgId}: its account-level (pooled) limits could not be read. Please retry shortly.`,
    );
    this.name = 'QuotaPoolUnavailableError';
  }
}

// Pool resolution

/**
 * Resolve the org → team pool an org belongs to, from its
 * {@link findOrgWithHierarchy} lookup, or `null` when it is flat. A team walks
 * up from its parent to the root; a root with teams IS the pool root. A flat
 * org (no parent, no teams) returns null without any further query.
 */
async function resolvePool(orgId: string, lookup: OrgHierarchyLookup<unknown>): Promise<OrgPool | null> {
  let rootOrgId: string | undefined;
  if (lookup.parentOrgId) rootOrgId = await resolveRootOrgId(lookup.parentOrgId);
  else if (lookup.hasChildren) rootOrgId = orgId;
  if (!rootOrgId) return null; // flat org — no pool

  const scope = await expandOrgScope(rootOrgId);
  if (scope.length <= 1) return null; // defensive: resolved root has no subtree
  return { rootOrgId, scope };
}

/** Read the given projection for every org in the pool (root included), in one query. */
async function loadPoolRows(pool: OrgPool, fields: string): Promise<PoolRow[]> {
  return await Organization.find({ _id: { $in: pool.scope.map(toOrgId) } })
    .select(fields)
    .lean() as unknown as PoolRow[];
}

/**
 * Pooled (root) status for one quota type, or `null` when the org is flat or
 * the type is carved out of pooling. Shared by the gate read
 * ({@link pooledStatusOrFallback}) and the shared-cap pre-check
 * ({@link checkSharedRootCap}) so both enforce the same pooled numbers.
 */
async function pooledStatus(
  orgId: string,
  lookup: OrgHierarchyLookup<unknown>,
  quotaType: QuotaType,
): Promise<QuotaStatus | null> {
  // storageBytes is measured live by the image-registry, not tracked in
  // org.usage, so the pooled `used` below is structurally 0 for it — the push
  // gate measures the org's namespace itself and ignores `used`.
  //
  // The LIMIT still has to be pooled, though. Returning null here would drop the
  // caller through to the org's OWN row — and a team's own limits are -1. The
  // registry gate reads `status.limit`, treats a negative as genuinely unlimited
  // and skips enforcement entirely, so every team could push without bound past
  // the root's storage cap.
  const pool = await resolvePool(orgId, lookup);
  if (!pool) return null;
  const rows = await loadPoolRows(pool, `tier quotas.${quotaType} usage.${quotaType} poolUsage.${quotaType}`);
  const status = pooledStatusFromRows(rows, pool.rootOrgId, quotaType);
  if (status) rememberPoolStatus(orgId, quotaType, status);
  return status;
}

// Failure handling

/**
 * Is `orgId` a TEAM? Only consulted when a pooled resolution already failed
 * and the caller doesn't already know the answer. A failed probe answers
 * `true` — FAIL CLOSED: we cannot prove the org's own limits mean anything,
 * and a silent "unlimited" is the outcome this whole path exists to prevent.
 */
async function isPooledTeam(orgId: string): Promise<boolean> {
  try {
    return !!(await getParentOrgId(orgId));
  } catch (err) {
    logger.error('Pooled-quota parent probe failed; treating the org as pooled (fail closed)', {
      orgId, err: String(err),
    });
    return true;
  }
}

/**
 * Decide what enforcement does when the pooled root cap can't be resolved and
 * nothing is cached. Returns `null` when the org's OWN row still carries real
 * limits (a root, or a flat org that somehow reached here) so the caller can
 * fall through to per-org enforcement; throws {@link QuotaPoolUnavailableError}
 * for a team, whose row is -1 on every dimension.
 */
async function denyPooledFailure(orgId: string, label: string, err: unknown, isTeam?: boolean): Promise<null> {
  const team = isTeam ?? await isPooledTeam(orgId);
  if (team) {
    logger.error('Pooled root cap unresolvable for a team — DENYING (its own limits are -1)', {
      orgId, quotaType: label, err: String(err),
    });
    emitCounter(POOL_FAILURE_METRIC, { quotaType: label, outcome: 'denied' });
    throw new QuotaPoolUnavailableError(orgId);
  }
  logger.warn('Pooled root cap unresolvable; enforcing the org\'s own limits', {
    orgId, quotaType: label, err: String(err),
  });
  emitCounter(POOL_FAILURE_METRIC, { quotaType: label, outcome: 'own_limits' });
  return null;
}

/**
 * Single-dimension fallback after a failed pooled resolution: the last-known
 * root cap while it is fresh, otherwise {@link denyPooledFailure}.
 */
async function pooledFallbackStatus(
  orgId: string,
  quotaType: QuotaType,
  err: unknown,
  isTeam?: boolean,
): Promise<QuotaStatus | null> {
  const cached = recallPoolStatus(orgId, quotaType);
  if (cached) {
    logger.warn('Pooled root cap unresolvable; serving the last-known cap', {
      orgId, quotaType, err: String(err),
    });
    emitCounter(POOL_FAILURE_METRIC, { quotaType, outcome: 'cached' });
    return cached;
  }
  return denyPooledFailure(orgId, quotaType, err, isTeam);
}

/**
 * Whole-response fallback for {@link applyPooledQuotas} after a failed pooled
 * read: overlay whatever cached caps are still fresh, and if none are, apply the
 * same team-denies rule. `own` is mutated + returned for a root / flat org.
 */
async function pooledReadFallback(
  orgId: string,
  own: OrgQuotaResponse,
  isTeam: boolean,
  err: unknown,
): Promise<OrgQuotaResponse> {
  let served = 0;
  for (const type of VALID_QUOTA_TYPES) {
    if (type === 'storageBytes') continue;
    const cached = recallPoolStatus(orgId, type);
    if (!cached) continue;
    const { allowed: _allowed, ...summary } = cached;
    // The pooled path builds summaries by hand, so the per-type period has to be
    // attached here too — it is not carried on QuotaStatus.
    own.quotas[type] = { ...summary, periodDays: periodDaysForType(type) };
    served += 1;
  }
  if (served > 0) {
    logger.warn('Pooled quota read failed; serving the last-known caps', { orgId, dimensions: served, err: String(err) });
    emitCounter(POOL_FAILURE_METRIC, { quotaType: 'all', outcome: 'cached' });
    return own;
  }
  await denyPooledFailure(orgId, 'all', err, isTeam);
  return own;
}

// Entry points used by QuotaService

/**
 * Overlay pooled numbers onto an org's OWN quota response.
 *
 * Pooled org (a root with teams, or a team): every counted dimension reports
 * the ROOT's limit against the whole subtree's usage — the same numbers the
 * root and each of its teams see, and the same ones increment enforces.
 * storageBytes stays per-org (registry-measured, never pooled). Flat orgs get
 * `own` back unchanged after the single subtree probe.
 */
export async function applyPooledQuotas(
  orgId: string,
  own: OrgQuotaResponse,
  lookup: OrgHierarchyLookup<unknown>,
): Promise<OrgQuotaResponse> {
  let pool: OrgPool | null;
  let rows: PoolRow[];
  try {
    pool = await resolvePool(orgId, lookup);
    if (!pool) return own;
    rows = await loadPoolRows(pool, 'name tier quotas usage poolUsage');
  } catch (err) {
    // Reporting the org's OWN numbers here would tell a team it has unlimited
    // everything (its row is -1 on every dimension) while increment denies —
    // so serve the last-known pooled caps, or fail loudly. A root/flat org's
    // own row is real, so it just reports that.
    return pooledReadFallback(orgId, own, !!lookup.parentOrgId, err);
  }
  for (const type of VALID_QUOTA_TYPES) {
    // storageBytes included deliberately: its `used` is structurally 0 (nothing
    // increments it — the registry measures live), but its LIMIT must be the
    // root's, or a team reports the -1 sitting in its own row and both the
    // dashboard and the registry push gate read that as "unlimited".
    const status = pooledStatusFromRows(rows, pool.rootOrgId, type);
    if (!status) continue;
    rememberPoolStatus(orgId, type, status);
    const { allowed: _allowed, ...summary } = status;
    own.quotas[type] = { ...summary, periodDays: periodDaysForType(type) };
  }
  const root = rows.find((r) => String(r._id) === pool.rootOrgId);
  // A team's tier is inherited from its root — report the root's.
  if (root?.tier) own.tier = root.tier;
  own.pool = {
    rootOrgId: pool.rootOrgId,
    rootOrgName: root?.name ?? '',
    isRoot: pool.rootOrgId === orgId,
    orgCount: pool.scope.length,
  };
  return own;
}

/**
 * The pooled status for one quota type, with the failure policy applied, or
 * `null` when the org is flat (caller falls through to its own row).
 *
 * A resolution failure degrades to the last-known pooled cap, or — for a team,
 * whose own limits are -1 — raises {@link QuotaPoolUnavailableError} rather
 * than reporting "unlimited".
 */
export async function pooledStatusOrFallback(
  orgId: string,
  lookup: OrgHierarchyLookup<unknown>,
  quotaType: QuotaType,
): Promise<QuotaStatus | null> {
  try {
    return await pooledStatus(orgId, lookup, quotaType);
  } catch (err) {
    return pooledFallbackStatus(orgId, quotaType, err, !!lookup.parentOrgId);
  }
}

/**
 * The ROOT an increment's pooled counter lives on, or `null` when the org is
 * flat (its own atomic per-org increment is the whole enforcement). One
 * self-or-children lookup for a flat org; a team walks up to its root. Unlike
 * the read paths this never expands the subtree — the counter is on the root.
 *
 * A resolution FAILURE never falls through silently: a team (own limits -1)
 * raises {@link QuotaPoolUnavailableError}, while a root / flat org returns
 * `null` and is enforced against its own row. There is no last-known-cap
 * fallback here: enforcement has to WRITE the pooled counter, and a cached
 * number can't be incremented.
 */
export async function resolveIncrementRoot(orgId: string, quotaType: QuotaType): Promise<string | null> {
  if (quotaType === 'storageBytes') return null; // measured live; nothing increments it
  try {
    const lookup = await findOrgWithHierarchy<PoolRow>(orgId, '');
    if (lookup.parentOrgId) return await resolveRootOrgId(lookup.parentOrgId);
    return lookup.hasChildren ? orgId : null;
  } catch (err) {
    // `lookup` itself may be what failed, so parentage is unknown here and
    // `denyPooledFailure` probes for it.
    return denyPooledFailure(orgId, quotaType, err);
  }
}

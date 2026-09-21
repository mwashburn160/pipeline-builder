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
 * Its LIMIT is pooled like everything else, though: it used to be excluded
 * entirely, which dropped a team through to its own row, and a team's own limits
 * are -1. The registry gate reads that as genuinely unlimited and skips
 * enforcement, so every team could push without bound past the root's cap —
 * the silent "unlimited" this module exists to prevent, reached through the one
 * dimension that opted out of it.
 *
 * Split out of `quota-service.ts`, whose remaining job is the per-org Mongo
 * read/write surface.
 */

import { AppError, createLogger, emitCounter, ErrorCode } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaReserveResult } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { expandOrgScope, findOrgWithHierarchy, getParentOrgId, resolveRootOrgId } from '../helpers/org-hierarchy.js';
import type { OrgHierarchyLookup } from '../helpers/org-hierarchy.js';
import {
  buildReserveResult,
  getNextResetDate,
  toOrgId,
  VALID_QUOTA_TYPES,
} from '../helpers/quota-helpers.js';
import type { QuotaTier, OrgQuotaResponse, QuotaStatus } from '../helpers/quota-helpers.js';
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
}

/**
 * Pooled status for one quota type from the subtree's rows: the ROOT's limit
 * (tier default when unset) against the SUM of every org's live usage. A period
 * whose `resetAt` has passed counts as 0 — the atomic per-org increment resets
 * expired periods, so counting stale `used` would over-count. Returns null when
 * no limit resolves (caller falls back to per-org).
 *
 * `used` is already the expiry-adjusted subtree sum, so it must NOT go through
 * `computeQuotaStatus` (that would re-apply expiry against the ROOT's resetAt
 * and zero the whole pool whenever the root's own period lapsed).
 */
export function pooledStatusFromRows(rows: PoolRow[], rootOrgId: string, quotaType: QuotaType): QuotaStatus | null {
  const root = rows.find((r) => r._id !== undefined && String(r._id) === rootOrgId);
  const limit = root?.quotas?.[quotaType] ?? config.quota.defaults[quotaType];
  if (limit === undefined) return null;
  const now = Date.now();
  const used = rows.reduce((sum, r) => {
    const u = r.usage?.[quotaType];
    if (!u) return sum;
    const resetAtMs = u.resetAt ? new Date(u.resetAt).getTime() : 0;
    return sum + (resetAtMs > now ? (u.used ?? 0) : 0);
  }, 0);
  const resetAt = root?.usage?.[quotaType]?.resetAt ?? getNextResetDate(config.quota.resetDays);
  return {
    limit,
    used,
    remaining: limit === -1 ? -1 : Math.max(0, limit - used),
    allowed: limit === -1 || used < limit,
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
  // The LIMIT still has to be pooled, though. This used to `return null` for
  // storageBytes, which drops the caller through to the org's OWN row — and a
  // team's own limits are -1. The registry gate reads `status.limit`, treats a
  // negative as genuinely unlimited and skips enforcement entirely, so every
  // team could push without bound past the root's storage cap: exactly the
  // "silent unlimited" this module exists to prevent, arrived at through the
  // one type that opted out of it.
  const pool = await resolvePool(orgId, lookup);
  if (!pool) return null;
  const rows = await loadPoolRows(pool, `quotas.${quotaType} usage.${quotaType}`);
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
    own.quotas[type] = summary;
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
    rows = await loadPoolRows(pool, 'name tier quotas usage');
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
    own.quotas[type] = summary;
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
 * Org → team hierarchy shared-cap PRE-check for increment — applies to the
 * ROOT and to every team alike. Returns an `exceeded` result when pooled
 * usage + `amount` would breach the root's limit; otherwise `null` (proceed
 * with the per-org atomic increment). Null for flat orgs (one lookup query,
 * no walk) and unlimited (-1) root limits.
 *
 * A resolution FAILURE never falls through silently: it degrades to the
 * last-known root cap, and failing that raises
 * {@link QuotaPoolUnavailableError} for a team (see that class for why
 * per-org fallback is no enforcement at all).
 */
export async function checkSharedRootCap(
  orgId: string,
  quotaType: QuotaType,
  amount: number,
): Promise<QuotaReserveResult | null> {
  if (quotaType === 'storageBytes') return null;
  let pooled: QuotaStatus | null;
  try {
    const lookup = await findOrgWithHierarchy<PoolRow>(orgId, '');
    pooled = await pooledStatus(orgId, lookup, quotaType);
  } catch (err) {
    // `lookup` itself may be what failed, so parentage is unknown here and
    // `pooledFallbackStatus` probes for it.
    pooled = await pooledFallbackStatus(orgId, quotaType, err);
  }
  if (!pooled || pooled.limit === -1) return null; // flat / unlimited
  if (pooled.used + amount <= pooled.limit) return null; // within shared cap
  return buildReserveResult(quotaType, pooled.limit, pooled.used, pooled.resetAt, 'exceeded');
}

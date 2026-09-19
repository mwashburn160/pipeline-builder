// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isValidTier, ValidationError } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaReserveResult } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { expandOrgScope, findOrgWithHierarchy, resolveRootOrgId } from '../helpers/org-hierarchy.js';
import type { OrgHierarchyLookup } from '../helpers/org-hierarchy.js';
import {
  applyQuotaLimits,
  buildOrgQuotaResponse,
  buildDefaultOrgQuotaResponse,
  computeQuotaStatus,
  getNextResetDate,
  toOrgId,
  VALID_QUOTA_TYPES,
  QUOTA_TIERS,
} from '../helpers/quota-helpers.js';
import type { QuotaTier, OrgQuotaResponse, QuotaStatus } from '../helpers/quota-helpers.js';
import { Organization } from '../models/organization.js';

const logger = createLogger('quota-service');

/**
 * Build a {@link QuotaReserveResult} from raw usage figures. Centralizes the
 * unlimited (`limit === -1` ⇒ remaining `-1`) logic and resetAt serialization
 * so the read-back blocks across increment/decrement can't drift (they
 * previously hand-rolled this with subtly inconsistent `-1` handling).
 * `resetAt` accepts a Date or ISO string; `undefined` ⇒ omitted.
 */
function buildReserveResult(
  quotaType: QuotaType,
  limit: number,
  used: number,
  resetAt: Date | string | undefined,
  exceeded: boolean,
): QuotaReserveResult {
  return {
    exceeded,
    quota: {
      type: quotaType,
      limit,
      used,
      remaining: limit === -1 ? -1 : Math.max(0, limit - used),
      resetAt: resetAt ? new Date(resetAt).toISOString() : undefined,
    },
  };
}

/** Resolved org → team pool: the root that owns the shared caps + its whole subtree. */
interface OrgPool {
  rootOrgId: string;
  /** Root + every descendant org id (always > 1 entry). */
  scope: string[];
}

/** Minimal org row shape the pooled computations read (lean projection). */
interface PoolRow {
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
function pooledStatusFromRows(rows: PoolRow[], rootOrgId: string, quotaType: QuotaType): QuotaStatus | null {
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

// Error class

/** Thrown when an organization document is not found in MongoDB. */
export class OrgNotFoundError extends Error {
  constructor(orgId?: string) {
    super(orgId ? `Organization not found: ${orgId}` : 'Organization not found');
    this.name = 'OrgNotFoundError';
  }
}

// Result types

/** Data accepted by the update method. */
interface UpdateOrgData {
  name?: string;
  slug?: string;
  tier?: string;
  quotas?: Partial<Record<QuotaType, number>>;
}

/** Pagination options for list endpoints. */
interface ListOrgsOptions {
  limit?: number;
  offset?: number;
}

/**
 * Hard upper bound on a single {@link QuotaService.findAll} page. A caller that
 * omits `limit` (or passes something larger) is clamped to this so an unbounded
 * `Organization.find()` can never pull the entire collection into memory.
 */
const FIND_ALL_MAX_LIMIT = 1000;

/** Options for the increment flow. */
interface IncrementOptions {
  /** When true, skip the limit check (system-admin override). */
  bypassLimit?: boolean;
}

/** Options for the decrement flow. */
interface DecrementOptions {
  /**
   * The `resetAt` timestamp the caller observed at reserve time. When set,
   * the decrement is only applied if the current `resetAt` still matches —
   * preventing rollbacks from stealing from the next period after a roll-over.
   */
  resetAtSnapshot?: string;
}

// Service class

/**
 * Quota service encapsulating all Mongoose operations for organizations.
 *
 * Provides:
 * - findAll()  list every organisation with quotas (admin view)
 * - findByOrgId()  single-org quota summary
 * - getQuotaStatus()  per-type status for an org
 * - update()  update name/slug/tier/limits
 * - resetUsage()  zero-out usage counters
 * - delete()  drop the org document entirely
 * - incrementUsage()  atomic increment with limit enforcement
 * - decrementUsage()  roll back a previously reserved increment
 */
export class QuotaService {
  // Read operations

  /**
   * List all organizations with their quota information.
   * Used by the system-admin "GET /quotas/all" endpoint.
   */
  async findAll(options: ListOrgsOptions = {}): Promise<OrgQuotaResponse[]> {
    const query = Organization.find()
      .select('name slug tier quotas usage')
      .sort({ name: 1 });

    if (options.offset !== undefined) query.skip(options.offset);
    // Always bound the page. A caller that omits `limit` previously got an
    // unbounded scan of the whole collection; clamp to FIND_ALL_MAX_LIMIT.
    query.limit(Math.min(options.limit ?? FIND_ALL_MAX_LIMIT, FIND_ALL_MAX_LIMIT));

    const orgs = await query.lean();
    return orgs.map((org) => buildOrgQuotaResponse(org));
  }

  /**
   * Fetch quota information for a single organization.
   * Default-when-unknown-org behaviour: a logged-in caller from an org that
   * has not yet been provisioned in the quota service still gets a usable
   * response (tier=developer, defaults from config) so the dashboard renders.
   * This is a READ-ONLY multi-tenant fallback — it does NOT create the org
   * document. There is no lazy provisioning: the platform service owns org
   * creation, and `incrementUsage` on a missing org throws `OrgNotFoundError`
   * (it never inserts a document). So an unprovisioned org reads defaults here
   * but cannot reserve/enforce quota until the platform has created it.
   */
  async findByOrgId(orgId: string): Promise<OrgQuotaResponse> {
    type OrgRow = Parameters<typeof buildOrgQuotaResponse>[0];
    const lookup = await findOrgWithHierarchy<OrgRow>(orgId, 'tier quotas usage name slug');
    if (!lookup.self) return buildDefaultOrgQuotaResponse(orgId);
    const own = buildOrgQuotaResponse(lookup.self);

    // Pooled org (a root with teams, or a team): every counted dimension reports
    // the ROOT's limit against the whole subtree's usage — the same numbers the
    // root and each of its teams see, and the same ones increment enforces.
    // storageBytes stays per-org (registry-measured, never pooled). Flat orgs
    // stop here after the single lookup query.
    const pool = await this.resolvePool(orgId, lookup);
    if (!pool) return own;
    let rows: PoolRow[];
    try {
      rows = await this.loadPoolRows(pool, 'name tier quotas usage');
    } catch (err) {
      logger.warn('Pooled quota read failed; reporting per-org numbers', { orgId, err: String(err) });
      return own;
    }
    for (const type of VALID_QUOTA_TYPES) {
      if (type === 'storageBytes') continue;
      const status = pooledStatusFromRows(rows, pool.rootOrgId, type);
      if (!status) continue;
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
   * Get the status of a single quota type for an organization.
   * Computes limit, usage, remaining capacity, and reset date.
   */
  async getQuotaStatus(orgId: string, quotaType: QuotaType): Promise<QuotaStatus> {
    // Pooled orgs (a root with teams, or a team) report the ROOT's limit +
    // subtree usage so the gate read matches the shared-cap enforcement on
    // increment. Fail-safe → per-org on any hierarchy-resolution error.
    const lookup = await findOrgWithHierarchy<PoolRow>(orgId, `quotas.${quotaType} usage.${quotaType}`);
    const pooled = await this.pooledStatus(orgId, lookup, quotaType).catch((err) => {
      logger.warn('Pooled quota status failed; using per-org numbers', { orgId, quotaType, err: String(err) });
      return null;
    });
    if (pooled) return pooled;

    const org = lookup.self;
    const limit = org?.quotas?.[quotaType] ?? config.quota.defaults[quotaType];
    const stored = org?.usage?.[quotaType];
    const usage = stored
      ? { used: stored.used ?? 0, resetAt: stored.resetAt ?? getNextResetDate(config.quota.resetDays) }
      : { used: 0, resetAt: getNextResetDate(config.quota.resetDays) };

    return computeQuotaStatus(limit, usage);
  }

  // Write operations

  /**
   * Update an organization's name, slug, tier, and/or quota limits.
   * @throws {OrgNotFoundError} when the org document does not exist
   * @throws {ValidationError} when an invalid tier is supplied
   */
  async update(orgId: string, data: UpdateOrgData): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(toOrgId(orgId));
    if (!org) throw new OrgNotFoundError(orgId);

    // A team's tier is inherited and its limits are -1 by design: the caps are
    // pooled at the root. Writing them on the team would be silently ignored by
    // enforcement (which reads the root), so reject it outright.
    if ((data.tier !== undefined || data.quotas !== undefined) && org.parentOrgId) {
      throw new ValidationError(
        `Organization ${orgId} is a team: its tier and quota limits are pooled at its root organization. Edit the root organization instead.`,
      );
    }

    if (data.name !== undefined) org.name = data.name;
    if (data.slug !== undefined) org.slug = data.slug;

    if (data.tier !== undefined) {
      if (!isValidTier(data.tier)) {
        throw new ValidationError(`Invalid tier: ${data.tier}`);
      }
      const tier: QuotaTier = data.tier;
      org.tier = tier;
      applyQuotaLimits(org, QUOTA_TIERS[tier].limits);
    }
    if (data.quotas) applyQuotaLimits(org, data.quotas);

    await org.save();

    logger.info('Quota updated', { orgId });
    return buildOrgQuotaResponse(org);
  }

  /**
   * Reset usage counters for one or all quota types.
   * @throws {OrgNotFoundError} when the org document does not exist
   */
  async resetUsage(orgId: string, quotaType?: string): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(toOrgId(orgId));
    if (!org) throw new OrgNotFoundError(orgId);

    const resetDate = getNextResetDate(config.quota.resetDays);

    if (quotaType) {
      org.usage[quotaType as QuotaType] = { used: 0, resetAt: new Date(resetDate) };
    } else {
      // Fresh Date per slot — otherwise mutating one slot's resetAt would
      // mutate every other slot's via shared reference.
      for (const k of VALID_QUOTA_TYPES) {
        org.usage[k] = { used: 0, resetAt: new Date(resetDate) };
      }
    }

    await org.save();

    logger.info('Quota usage reset', { orgId, quotaType: quotaType || 'all' });
    return buildOrgQuotaResponse(org);
  }

  /**
   *  delete the org's Mongo document entirely. Idempotent: deleting
   * an already-missing org returns false (rather than throwing), which is
   * the right shape for the platform's cascade orchestrator (it doesn't
   * care whether the cleanup was a no-op).
   */
  async delete(orgId: string): Promise<boolean> {
    const result = await Organization.deleteOne({ _id: toOrgId(orgId) });
    if (result.deletedCount > 0) {
      logger.info('Quota org deleted', { orgId });
      return true;
    }
    return false;
  }

  /**
   * Resolve the org → team pool an org belongs to, from its
   * {@link findOrgWithHierarchy} lookup, or `null` when it is flat. A team walks
   * up from its parent to the root; a root with teams IS the pool root. A flat
   * org (no parent, no teams) returns null without any further query.
   */
  private async resolvePool(orgId: string, lookup: OrgHierarchyLookup<unknown>): Promise<OrgPool | null> {
    let rootOrgId: string | undefined;
    if (lookup.parentOrgId) rootOrgId = await resolveRootOrgId(lookup.parentOrgId);
    else if (lookup.hasChildren) rootOrgId = orgId;
    if (!rootOrgId) return null; // flat org — no pool

    const scope = await expandOrgScope(rootOrgId);
    if (scope.length <= 1) return null; // defensive: resolved root has no subtree
    return { rootOrgId, scope };
  }

  /** Read the given projection for every org in the pool (root included), in one query. */
  private async loadPoolRows(pool: OrgPool, fields: string): Promise<PoolRow[]> {
    return await Organization.find({ _id: { $in: pool.scope.map(toOrgId) } })
      .select(fields)
      .lean() as unknown as PoolRow[];
  }

  /**
   * Pooled (root) status for one quota type, or `null` when the org is flat or
   * the type is carved out of pooling. Shared by the gate read
   * ({@link getQuotaStatus}) and the shared-cap pre-check
   * ({@link checkSharedRootCap}) so both enforce the same pooled numbers.
   */
  private async pooledStatus(
    orgId: string,
    lookup: OrgHierarchyLookup<unknown>,
    quotaType: QuotaType,
  ): Promise<QuotaStatus | null> {
    // storageBytes is measured live by the image-registry, not tracked in
    // org.usage — aggregating usage counters would be meaningless. Carve it out;
    // storage is enforced by the registry push-gate per-org namespace instead.
    if (quotaType === 'storageBytes') return null;
    const pool = await this.resolvePool(orgId, lookup);
    if (!pool) return null;
    const rows = await this.loadPoolRows(pool, `quotas.${quotaType} usage.${quotaType}`);
    return pooledStatusFromRows(rows, pool.rootOrgId, quotaType);
  }

  /**
   * Org → team hierarchy shared-cap PRE-check for increment — applies to the
   * ROOT and to every team alike. Returns an `exceeded` result when pooled
   * usage + `amount` would breach the root's limit; otherwise `null` (proceed
   * with the per-org atomic increment). Null for flat orgs (one lookup query,
   * no walk) and unlimited (-1) root limits.
   */
  private async checkSharedRootCap(
    orgId: string,
    quotaType: QuotaType,
    amount: number,
  ): Promise<QuotaReserveResult | null> {
    if (quotaType === 'storageBytes') return null;
    const lookup = await findOrgWithHierarchy<PoolRow>(orgId, '');
    const pooled = await this.pooledStatus(orgId, lookup, quotaType);
    if (!pooled || pooled.limit === -1) return null; // flat / unlimited
    if (pooled.used + amount <= pooled.limit) return null; // within shared cap
    return buildReserveResult(quotaType, pooled.limit, pooled.used, pooled.resetAt, true);
  }

  /**
   * Increment usage for a quota type.
   *
   * Handles these distinct flows:
   * 1. **Sysadmin bypass**  increment without limit check.
   * 2. **Auto-reset**  atomically resets expired periods before incrementing.
   * 3. **Atomic increment**  single query that only succeeds when quota allows.
   * 4. **Shared root cap**  for pooled orgs (a root with teams, or a team), a
   *    pre-check rolls usage up to the root and enforces the root's shared limit.
   *
   * @throws {OrgNotFoundError} when the org document does not exist
   */
  async incrementUsage(
    orgId: string,
    quotaType: QuotaType,
    amount: number,
    { bypassLimit }: IncrementOptions = {},
  ): Promise<QuotaReserveResult> {
    const usagePath = `usage.${quotaType}`;

    // ----- Sysadmin bypass: increment without the limit check, but STILL
    // reset an expired period first. A plain `$inc` on an expired period piles
    // the new amount onto a stale `used` (and never advances `resetAt`), so the
    // period never rolls over for bypass traffic and `used` reads inflated. Use
    // the same reset-if-expired aggregation pipeline as the normal path, minus
    // the limit `$expr` guard. `updatePipeline:true` is REQUIRED for array
    // (pipeline) updates on Mongoose 9 — see increment-pipeline-update.test.ts.
    if (bypassLimit) {
      logger.info('Quota bypass increment', { orgId, quotaType, amount });
      const resetDays = config.quota.resetDays;
      const org = await Organization.findOneAndUpdate(
        { _id: toOrgId(orgId) },
        [
          {
            $set: {
              [`${usagePath}.used`]: {
                $cond: {
                  if: { $lte: [`$${usagePath}.resetAt`, '$$NOW'] },
                  then: amount,
                  else: { $add: [{ $ifNull: [`$${usagePath}.used`, 0] }, amount] },
                },
              },
              [`${usagePath}.resetAt`]: {
                $cond: {
                  if: { $lte: [`$${usagePath}.resetAt`, '$$NOW'] },
                  then: { $dateAdd: { startDate: '$$NOW', unit: 'day', amount: resetDays } },
                  else: `$${usagePath}.resetAt`,
                },
              },
            },
          },
        ],
        { returnDocument: 'after', updatePipeline: true },
      );
      if (!org) throw new OrgNotFoundError(orgId);

      const limit = org.quotas[quotaType] ?? config.quota.defaults[quotaType];
      const usage = org.usage[quotaType] ?? {
        used: amount,
        resetAt: getNextResetDate(config.quota.resetDays),
      };
      return buildReserveResult(quotaType, limit, usage.used, usage.resetAt, false);
    }

    // ----- Org → team hierarchy: shared root cap -----
    // When the org is part of a hierarchy, the root org's limit is shared
    // across the root + all descendant teams. Enforce it as a pre-check before
    // the org's own atomic increment — for the root itself as much as for its
    // teams. For flat orgs this costs one self-or-children lookup that
    // short-circuits before any hierarchy walk.
    // Note: the cross-org sum is not part of the single-doc atomic update, so a
    // tiny concurrent overshoot is possible — acceptable for rate-limit quotas.
    // Fail-safe: a hierarchy-resolution error must never block quota
    // enforcement — fall through to the per-org atomic check on any failure.
    let rootCap: QuotaReserveResult | null = null;
    try {
      rootCap = await this.checkSharedRootCap(orgId, quotaType, amount);
    } catch (err) {
      logger.warn('Shared root-cap check failed; using per-org limit only', { orgId, quotaType, err: String(err) });
    }
    if (rootCap) return rootCap;

    // ----- Atomic reset-if-expired + increment with limit check -----
    // Single pipeline-update driven by `$$NOW` so the filter `$expr` and the
    // `$set` `$cond` see the exact same server-side timestamp. The next-reset
    // value is computed from `$$NOW` via `$dateAdd` so the period boundary
    // is set by the server, not a captured `new Date()` from the API node.
    const resetDays = config.quota.resetDays;
    // Coalesce a MISSING stored limit to the tier default — Mongoose `default:` only
    // fires on insert, so a newly-added quota type on an un-backfilled org doc would
    // otherwise match no branch and hard-429 (the read + pooled paths already default).
    const limitExpr = { $ifNull: [`$quotas.${quotaType}`, config.quota.defaults[quotaType]] };
    const org = await Organization.findOneAndUpdate(
      {
        _id: toOrgId(orgId),
        $expr: {
          $or: [
            { $eq: [limitExpr, -1] },
            // Period expired: amount alone must fit within limit (post-reset).
            {
              $and: [
                { $lte: [`$${usagePath}.resetAt`, '$$NOW'] },
                { $lte: [amount, limitExpr] },
              ],
            },
            // Period not expired: current used + amount must fit.
            {
              $and: [
                { $gt: [`$${usagePath}.resetAt`, '$$NOW'] },
                // `$ifNull` like the bypass path: a subdoc with `resetAt` set but
                // `used` ABSENT made `$add` yield null, so `used` was written as
                // null and every later `$add: [null, amount]` stayed null — the
                // counter silently stopped incrementing AND stopped enforcing.
                { $lte: [{ $add: [{ $ifNull: [`$${usagePath}.used`, 0] }, amount] }, limitExpr] },
              ],
            },
          ],
        },
      },
      [
        {
          $set: {
            [`${usagePath}.used`]: {
              $cond: {
                if: { $lte: [`$${usagePath}.resetAt`, '$$NOW'] },
                then: amount,
                else: { $add: [{ $ifNull: [`$${usagePath}.used`, 0] }, amount] },
              },
            },
            [`${usagePath}.resetAt`]: {
              $cond: {
                if: { $lte: [`$${usagePath}.resetAt`, '$$NOW'] },
                then: { $dateAdd: { startDate: '$$NOW', unit: 'day', amount: resetDays } },
                else: `$${usagePath}.resetAt`,
              },
            },
          },
        },
      ],
      // `updatePipeline: true` is REQUIRED for aggregation-pipeline (array)
      // updates as of Mongoose 9 — without it the driver throws "Cannot pass an
      // array to query updates", which surfaces as a 500 on every increment.
      { returnDocument: 'after', updatePipeline: true },
    );

    // `findOneAndUpdate` returns null when the filter didn't match — could be
    // "quota exceeded" or "org missing". Disambiguate with a single read so
    // the caller (route) can choose between 429 and 404 cleanly.
    if (!org) {
      const existing = await Organization.findById(toOrgId(orgId));
      if (!existing) throw new OrgNotFoundError(orgId);

      const limit = existing.quotas[quotaType] ?? config.quota.defaults[quotaType];
      const currentUsage = existing.usage[quotaType] ?? {
        used: 0,
        resetAt: getNextResetDate(config.quota.resetDays),
      };
      return buildReserveResult(quotaType, limit, currentUsage.used, currentUsage.resetAt, true);
    }

    // Default a MISSING stored limit exactly as the exceeded/read paths do.
    // Without it the success path returned `limit: undefined` and
    // `remaining: Math.max(0, undefined - used)` = NaN, which flowed out to
    // every reserveQuota caller and the `/quotas` read surface.
    const limit = org.quotas[quotaType] ?? config.quota.defaults[quotaType];
    const usage = org.usage[quotaType];
    return buildReserveResult(quotaType, limit, usage.used ?? 0, usage.resetAt, false);
  }

  /**
   * Roll back a previously reserved increment. Used by the pre-flight
   * `reserve + commit` pattern in routes that gate on `incrementUsage`
   * before the action: if the action fails, the route calls this to give
   * the slot back. Floors at 0 to keep the counter non-negative even if
   * the period reset happens between reserve and rollback.
   *
   * When `resetAtSnapshot` is supplied, the decrement is conditional: it
   * only applies when the stored `resetAt` still matches. If the period
   * rolled over between reserve and rollback the decrement is a no-op so
   * we don't steal capacity from the new period.
   *
   * Idempotent: if the org doesn't exist, returns null silently so the
   * route can roll back without surfacing secondary errors when the
   * original action's failure was "org not found" or similar.
   */
  async decrementUsage(
    orgId: string,
    quotaType: QuotaType,
    amount: number,
    { resetAtSnapshot }: DecrementOptions = {},
  ): Promise<QuotaReserveResult | null> {
    const usagePath = `usage.${quotaType}`;

    const filter: Record<string, unknown> = { _id: toOrgId(orgId) };
    if (resetAtSnapshot) {
      const snap = new Date(resetAtSnapshot);
      filter.$expr = { $eq: [`$${usagePath}.resetAt`, snap] };
    }

    const org = await Organization.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            [`${usagePath}.used`]: {
              // Clamp to 0 so a rollback after a between-reserve-and-rollback
              // period reset doesn't go negative.
              $max: [0, { $subtract: [`$${usagePath}.used`, amount] }],
            },
          },
        },
      ],
      // Pipeline (array) update — see incrementUsage: Mongoose 9 requires
      // `updatePipeline: true` or it throws "Cannot pass an array to query updates".
      { returnDocument: 'after', updatePipeline: true },
    );

    if (!org) {
      // Either the org is gone (legitimate idempotent no-op) or the
      // snapshot mismatch fired (period rolled over). Disambiguate so the
      // caller sees the actually-current quota state.
      if (resetAtSnapshot) {
        const existing = await Organization.findById(toOrgId(orgId));
        if (!existing) return null;

        const limit = existing.quotas[quotaType] ?? config.quota.defaults[quotaType];
        const usage = existing.usage[quotaType] ?? {
          used: 0,
          resetAt: getNextResetDate(config.quota.resetDays),
        };
        logger.info('Decrement skipped: period rolled over', {
          orgId,
          quotaType,
          snapshot: resetAtSnapshot,
          currentResetAt: usage.resetAt?.toISOString(),
        });
        return buildReserveResult(quotaType, limit, usage.used, usage.resetAt, false);
      }
      return null;
    }

    // Default a MISSING stored limit exactly as the exceeded/read paths do.
    // Without it the success path returned `limit: undefined` and
    // `remaining: Math.max(0, undefined - used)` = NaN, which flowed out to
    // every reserveQuota caller and the `/quotas` read surface.
    const limit = org.quotas[quotaType] ?? config.quota.defaults[quotaType];
    const usage = org.usage[quotaType];
    return buildReserveResult(quotaType, limit, usage.used ?? 0, usage.resetAt, false);
  }
}

/**
 * Singleton instance of QuotaService.
 *
 * @example
 * ```typescript
 * import { quotaService } from '../services/quota-service.js';
 *
 * const quota = await quotaService.findByOrgId(orgId);
 * ```
 */
export const quotaService = new QuotaService();

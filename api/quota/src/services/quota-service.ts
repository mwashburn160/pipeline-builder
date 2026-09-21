// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isValidTier, ValidationError } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaReserveResult } from '@pipeline-builder/api-core';
import { applyPooledQuotas, checkSharedRootCap, pooledStatusFromRows, pooledStatusOrFallback } from './pooled-quota.js';
import type { PoolRow } from './pooled-quota.js';
import { config } from '../config.js';
import { findOrgWithHierarchy } from '../helpers/org-hierarchy.js';
import {
  applyQuotaLimits,
  buildOrgQuotaResponse,
  buildDefaultOrgQuotaResponse,
  buildReserveResult,
  computeQuotaStatus,
  getNextResetDate,
  toOrgId,
  VALID_QUOTA_TYPES,
  QUOTA_TIERS,
} from '../helpers/quota-helpers.js';
import type { QuotaTier, OrgQuotaResponse, QuotaStatus } from '../helpers/quota-helpers.js';
import { Organization } from '../models/organization.js';

const logger = createLogger('quota-service');

// Error classes

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

/**
 * The `$set` stage every increment runs: add `amount` to `usage.<type>.used`,
 * but treat an EXPIRED period as if `used` were 0 and advance `resetAt` by
 * `resetDays` in the same breath.
 *
 * Driven entirely by `$$NOW` so the stage and the caller's filter `$expr` see
 * the exact same server-side timestamp, and so the period boundary is set by
 * Mongo rather than by a captured `new Date()` on whichever API node handled
 * the request.
 *
 * The `$ifNull` around `used` is load-bearing: a subdoc with `resetAt` set but
 * `used` ABSENT made `$add` yield null, so `used` was written as null and every
 * later `$add: [null, amount]` stayed null — the counter silently stopped
 * incrementing AND stopped enforcing.
 *
 * Shared by the limit-checked path and the system-admin bypass so the two can
 * never drift on period roll-over (they were duplicated verbatim before).
 */
function resetIfExpiredStage(usagePath: string, amount: number, resetDays: number): Record<string, unknown> {
  return {
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
  };
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
/** One breached dimension for one ACCOUNT (pool root), as the at-risk scan reports it. */
export interface AtRiskEntry {
  orgId: string;
  name: string;
  slug: string;
  tier?: string;
  type: QuotaType;
  used: number;
  limit: number;
  percent: number;
}

export class QuotaService {
  // Read operations

  /**
   * List all organizations with their quota information.
   * Used by the system-admin "GET /quotas/all" endpoint.
   */
  /**
   * Every account at or above `threshold` percent on any counted dimension,
   * evaluated BY POOL.
   *
   * This cannot be done from `findAll`, which returns each org's OWN summarized
   * numbers — the wrong ones twice over for a pooled account. A team's own
   * limits are -1, so it reads as "unlimited" and was skipped entirely; and a
   * root shows only its own usage rather than the subtree's, so an account
   * sitting at 95% of its pooled cap looked idle and alerting never fired. The
   * per-org `/quotas/:orgId/at-risk` route already resolves the pool; this is
   * the cross-org scan catching up, through the SAME `pooledStatusFromRows`
   * enforcement uses, so the gate and the alert cannot disagree.
   *
   * Reports the ROOT, once per breached dimension — the root is the account.
   * Paged against Mongo so memory per round-trip stays flat, but grouped before
   * being judged, because a team and its root can land on different pages.
   */
  async findAtRisk(threshold: number, pageSize: number): Promise<AtRiskEntry[]> {
    type ScanRow = PoolRow & { _id: string; slug?: string; parentOrgId?: string | null };

    const rows: ScanRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await Organization.find()
        .select('name slug tier quotas usage parentOrgId')
        .sort({ name: 1 })
        .skip(offset)
        .limit(Math.min(pageSize, FIND_ALL_MAX_LIMIT))
        .lean() as unknown as ScanRow[];
      for (const r of page) rows.push({ ...r, _id: String(r._id) });
      if (page.length < pageSize) break; // collection exhausted
    }

    const byId = new Map(rows.map((r) => [r._id, r]));
    /** Walk to the pool root. Cycle-guarded: a corrupted parent chain must not
     *  hang the scan, so a repeat visit stops at the last good node. */
    const rootOf = (row: ScanRow): string => {
      const seen = new Set<string>([row._id]);
      let cur = row;
      while (cur.parentOrgId) {
        const parent = byId.get(cur.parentOrgId);
        if (!parent || seen.has(parent._id)) break;
        seen.add(parent._id);
        cur = parent;
      }
      return cur._id;
    };

    const pools = new Map<string, ScanRow[]>();
    for (const row of rows) {
      const root = rootOf(row);
      const group = pools.get(root);
      if (group) group.push(row); else pools.set(root, [row]);
    }

    const computed: AtRiskEntry[] = [];
    for (const [rootOrgId, group] of pools) {
      const root = byId.get(rootOrgId);
      if (!root) continue;
      for (const type of VALID_QUOTA_TYPES) {
        const status = pooledStatusFromRows(group, rootOrgId, type);
        if (!status || status.unlimited) continue;
        // limit === 0 means the account is permanently at risk (any use pushes
        // 100%+); report as 100%.
        const percent = status.limit === 0
          ? 100
          : Math.min(100, Math.round((status.used / status.limit) * 100));
        if (percent >= threshold) {
          computed.push({
            orgId: rootOrgId,
            name: root.name ?? '',
            slug: root.slug ?? '',
            tier: root.tier,
            type,
            used: status.used,
            limit: status.limit,
            percent,
          });
        }
      }
    }
    computed.sort((a, b) => b.percent - a.percent);
    return computed;
  }

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
    // Flat orgs stop here after the single lookup query. See pooled-quota.ts.
    return applyPooledQuotas(orgId, own, lookup);
  }

  /**
   * Get the status of a single quota type for an organization.
   * Computes limit, usage, remaining capacity, and reset date.
   */
  async getQuotaStatus(orgId: string, quotaType: QuotaType): Promise<QuotaStatus> {
    // Pooled orgs (a root with teams, or a team) report the ROOT's limit +
    // subtree usage so the gate read matches the shared-cap enforcement on
    // increment. A resolution failure degrades to the last-known pooled cap, or
    // — for a team, whose own limits are -1 — raises
    // {@link QuotaPoolUnavailableError} rather than reporting "unlimited".
    const lookup = await findOrgWithHierarchy<PoolRow>(orgId, `quotas.${quotaType} usage.${quotaType}`);
    const pooled = await pooledStatusOrFallback(orgId, lookup, quotaType);
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
   * System-admin bypass increment: apply `amount` without the limit check, but
   * STILL reset an expired period first.
   *
   * The reset is not an optimization. A plain `$inc` on an expired period piles
   * the new amount onto a stale `used` (and never advances `resetAt`), so the
   * period never rolls over for bypass traffic and `used` reads permanently
   * inflated. Hence the same reset-if-expired aggregation pipeline as the normal
   * path ({@link resetIfExpiredStage}), just without the limit `$expr` guard on
   * the filter.
   *
   * @throws {OrgNotFoundError} when the org document does not exist
   */
  private async incrementBypassingLimit(
    orgId: string,
    quotaType: QuotaType,
    amount: number,
  ): Promise<QuotaReserveResult> {
    logger.info('Quota bypass increment', { orgId, quotaType, amount });
    const org = await Organization.findOneAndUpdate(
      { _id: toOrgId(orgId) },
      [resetIfExpiredStage(`usage.${quotaType}`, amount, config.quota.resetDays)],
      // `updatePipeline: true` is REQUIRED for aggregation-pipeline (array)
      // updates as of Mongoose 9 — see increment-pipeline-update.test.ts.
      { returnDocument: 'after', updatePipeline: true },
    );
    if (!org) throw new OrgNotFoundError(orgId);

    const limit = org.quotas[quotaType] ?? config.quota.defaults[quotaType];
    const usage = org.usage[quotaType] ?? {
      used: amount,
      resetAt: getNextResetDate(config.quota.resetDays),
    };
    return buildReserveResult(quotaType, limit, usage.used, usage.resetAt, 'allowed');
  }

  /**
   * Increment usage for a quota type.
   *
   * Handles these distinct flows:
   * 1. **Sysadmin bypass**  increment without limit check
   *    ({@link incrementBypassingLimit}).
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

    if (bypassLimit) return this.incrementBypassingLimit(orgId, quotaType, amount);

    // ----- Org → team hierarchy: shared root cap -----
    // When the org is part of a hierarchy, the root org's limit is shared
    // across the root + all descendant teams. Enforce it as a pre-check before
    // the org's own atomic increment — for the root itself as much as for its
    // teams. For flat orgs this costs one self-or-children lookup that
    // short-circuits before any hierarchy walk.
    // Note: the cross-org sum is not part of the single-doc atomic update, so a
    // tiny concurrent overshoot is possible — acceptable for rate-limit quotas.
    // A resolution failure is handled INSIDE checkSharedRootCap: cached cap,
    // per-org fallback for a root/flat org, or a 503 for a team. It is
    // deliberately NOT swallowed here — the old catch-and-continue fell through
    // to the per-org `$expr`, which a team's -1 limits make a no-op, so every
    // team was unmetered for the duration of any hierarchy blip.
    const rootCap = await checkSharedRootCap(orgId, quotaType, amount);
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
      [resetIfExpiredStage(usagePath, amount, resetDays)],
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
      return buildReserveResult(quotaType, limit, currentUsage.used, currentUsage.resetAt, 'exceeded');
    }

    // Default a MISSING stored limit exactly as the exceeded/read paths do.
    // Without it the success path returned `limit: undefined` and
    // `remaining: Math.max(0, undefined - used)` = NaN, which flowed out to
    // every reserveQuota caller and the `/quotas` read surface.
    const limit = org.quotas[quotaType] ?? config.quota.defaults[quotaType];
    const usage = org.usage[quotaType];
    return buildReserveResult(quotaType, limit, usage.used ?? 0, usage.resetAt, 'allowed');
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
        return buildReserveResult(quotaType, limit, usage.used, usage.resetAt, 'allowed');
      }
      return null;
    }

    // Default a MISSING stored limit exactly as the exceeded/read paths do.
    // Without it the success path returned `limit: undefined` and
    // `remaining: Math.max(0, undefined - used)` = NaN, which flowed out to
    // every reserveQuota caller and the `/quotas` read surface.
    const limit = org.quotas[quotaType] ?? config.quota.defaults[quotaType];
    const usage = org.usage[quotaType];
    return buildReserveResult(quotaType, limit, usage.used ?? 0, usage.resetAt, 'allowed');
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

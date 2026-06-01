// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isValidTier, ValidationError } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaReserveResult } from '@pipeline-builder/api-core';
import { config } from '../config';
import {
  applyQuotaLimits,
  buildOrgQuotaResponse,
  buildDefaultOrgQuotaResponse,
  computeQuotaStatus,
  getNextResetDate,
  VALID_QUOTA_TYPES,
  QUOTA_TIERS,
} from '../helpers/quota-helpers';
import type { QuotaTier, OrgQuotaResponse, QuotaStatus } from '../helpers/quota-helpers';
import { Organization } from '../models/organization';

const logger = createLogger('quota-service');

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
export interface UpdateOrgData {
  name?: string;
  slug?: string;
  tier?: string;
  quotas?: Partial<Record<QuotaType, number>>;
}

/** Pagination options for list endpoints. */
export interface ListOrgsOptions {
  limit?: number;
  offset?: number;
}

/** Options for the increment flow. */
export interface IncrementOptions {
  /** When true, skip the limit check (system-admin override). */
  bypassLimit?: boolean;
}

/** Options for the decrement flow. */
export interface DecrementOptions {
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
 * Provides * - findAll()  list every organisation with quotas (admin view)
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
    if (options.limit !== undefined) query.limit(options.limit);

    const orgs = await query.lean();
    return orgs.map((org) => buildOrgQuotaResponse(org));
  }

  /**
   * Fetch quota information for a single organization.
   * Default-when-unknown-org behaviour: a logged-in caller from an org that
   * has not yet been provisioned in the quota service still gets a usable
   * response (tier=developer, defaults from config) so the dashboard renders.
   * This is the multi-tenant fallback path — first-touch provisioning is
   * handled lazily by the increment flow, not by reads.
   */
  async findByOrgId(orgId: string): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(orgId)
      .select('tier quotas usage name slug')
      .lean();

    if (!org) return buildDefaultOrgQuotaResponse(orgId);
    return buildOrgQuotaResponse(org);
  }

  /**
   * Get the status of a single quota type for an organization.
   * Computes limit, usage, remaining capacity, and reset date.
   */
  async getQuotaStatus(orgId: string, quotaType: QuotaType): Promise<QuotaStatus> {
    const org = await Organization.findById(orgId)
      .select('tier quotas usage')
      .lean();

    const limit = org?.quotas?.[quotaType] ?? config.quota.defaults[quotaType];
    const usage = org?.usage?.[quotaType] ?? {
      used: 0,
      resetAt: getNextResetDate(config.quota.resetDays),
    };

    return computeQuotaStatus(limit, usage);
  }

  // Write operations

  /**
   * Update an organization's name, slug, tier, and/or quota limits.
   * @throws {OrgNotFoundError} when the org document does not exist
   * @throws {ValidationError} when an invalid tier is supplied
   */
  async update(orgId: string, data: UpdateOrgData): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(orgId);
    if (!org) throw new OrgNotFoundError(orgId);

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
    const org = await Organization.findById(orgId);
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
    const result = await Organization.deleteOne({ _id: orgId });
    if (result.deletedCount > 0) {
      logger.info('Quota org deleted', { orgId });
      return true;
    }
    return false;
  }

  /**
   * Increment usage for a quota type.
   *
   * Handles three distinct flows   * 1. **Sysadmin bypass**  increment without limit check.
   * 2. **Auto-reset**  atomically resets expired periods before incrementing.
   * 3. **Atomic increment**  single query that only succeeds when quota allows.
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

    // ----- Sysadmin bypass: simple $inc, no limit check -----
    if (bypassLimit) {
      logger.info('Quota bypass increment', { orgId, quotaType, amount });
      const org = await Organization.findOneAndUpdate(
        { _id: orgId },
        { $inc: { [`${usagePath}.used`]: amount } },
        { returnDocument: 'after' },
      );
      if (!org) throw new OrgNotFoundError(orgId);

      const limit = org.quotas[quotaType];
      const usage = org.usage[quotaType] ?? {
        used: 0,
        resetAt: getNextResetDate(config.quota.resetDays),
      };
      return {
        exceeded: false,
        quota: {
          type: quotaType,
          limit,
          used: usage.used,
          remaining: limit === -1 ? -1 : Math.max(0, limit - usage.used),
          resetAt: usage.resetAt?.toISOString(),
        },
      };
    }

    // ----- Atomic reset-if-expired + increment with limit check -----
    // Single pipeline-update driven by `$$NOW` so the filter `$expr` and the
    // `$set` `$cond` see the exact same server-side timestamp. The next-reset
    // value is computed from `$$NOW` via `$dateAdd` so the period boundary
    // is set by the server, not a captured `new Date()` from the API node.
    const resetDays = config.quota.resetDays;
    const org = await Organization.findOneAndUpdate(
      {
        _id: orgId,
        $expr: {
          $or: [
            { $eq: [`$quotas.${quotaType}`, -1] },
            // Period expired: amount alone must fit within limit (post-reset).
            {
              $and: [
                { $lte: [`$${usagePath}.resetAt`, '$$NOW'] },
                { $lte: [amount, `$quotas.${quotaType}`] },
              ],
            },
            // Period not expired: current used + amount must fit.
            {
              $and: [
                { $gt: [`$${usagePath}.resetAt`, '$$NOW'] },
                { $lte: [{ $add: [`$${usagePath}.used`, amount] }, `$quotas.${quotaType}`] },
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
                else: { $add: [`$${usagePath}.used`, amount] },
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
      { returnDocument: 'after' },
    );

    // `findOneAndUpdate` returns null when the filter didn't match — could be
    // "quota exceeded" or "org missing". Disambiguate with a single read so
    // the caller (route) can choose between 429 and 404 cleanly.
    if (!org) {
      const existing = await Organization.findById(orgId);
      if (!existing) throw new OrgNotFoundError(orgId);

      const limit = existing.quotas[quotaType];
      const currentUsage = existing.usage[quotaType] ?? {
        used: 0,
        resetAt: getNextResetDate(config.quota.resetDays),
      };
      return {
        exceeded: true,
        quota: {
          type: quotaType,
          limit,
          used: currentUsage.used,
          remaining: Math.max(0, limit - currentUsage.used),
          resetAt: currentUsage.resetAt.toISOString(),
        },
      };
    }

    const limit = org.quotas[quotaType];
    const usage = org.usage[quotaType];
    return {
      exceeded: false,
      quota: {
        type: quotaType,
        limit,
        used: usage.used,
        remaining: limit === -1 ? -1 : Math.max(0, limit - usage.used),
        resetAt: usage.resetAt?.toISOString(),
      },
    };
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

    const filter: Record<string, unknown> = { _id: orgId };
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
      { returnDocument: 'after' },
    );

    if (!org) {
      // Either the org is gone (legitimate idempotent no-op) or the
      // snapshot mismatch fired (period rolled over). Disambiguate so the
      // caller sees the actually-current quota state.
      if (resetAtSnapshot) {
        const existing = await Organization.findById(orgId);
        if (!existing) return null;

        const limit = existing.quotas[quotaType];
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
        return {
          exceeded: false,
          quota: {
            type: quotaType,
            limit,
            used: usage.used,
            remaining: limit === -1 ? -1 : Math.max(0, limit - usage.used),
            resetAt: usage.resetAt?.toISOString(),
          },
        };
      }
      return null;
    }

    const limit = org.quotas[quotaType];
    const usage = org.usage[quotaType];
    return {
      exceeded: false,
      quota: {
        type: quotaType,
        limit,
        used: usage.used,
        remaining: limit === -1 ? -1 : Math.max(0, limit - usage.used),
        resetAt: usage.resetAt?.toISOString(),
      },
    };
  }
}

/**
 * Singleton instance of QuotaService.
 *
 * @example
 * ```typescript
 * import { quotaService } from '../services/quota-service';
 *
 * const quota = await quotaService.findByOrgId(orgId);
 * ```
 */
export const quotaService = new QuotaService();

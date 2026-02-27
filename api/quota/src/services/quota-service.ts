/**
 * @module services/quota-service
 * @description Service layer for quota CRUD operations on MongoDB organizations.
 *
 * Encapsulates all Mongoose database operations, keeping route handlers as thin
 * controllers. Unlike PipelineService/PluginService which extend the Drizzle-based
 * CrudService, this service works directly with Mongoose but follows the same
 * pattern: class with singleton export.
 */

import { createLogger } from '@mwashburn160/api-core';
import type { QuotaType } from '@mwashburn160/api-core';
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
import { Organization, OrganizationDocument } from '../models/organization';

const logger = createLogger('quota-service');

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Thrown when an organization document is not found in MongoDB. */
export class OrgNotFoundError extends Error {
  constructor(orgId?: string) {
    super(orgId ? `Organization not found: ${orgId}` : 'Organization not found');
    this.name = 'OrgNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result returned by incrementUsage — tells the caller whether the quota was exceeded. */
export interface IncrementResult {
  exceeded: boolean;
  quota: {
    type: QuotaType;
    limit: number;
    used: number;
    remaining: number;
    resetAt?: string;
  };
}

/** Data accepted by the update method. */
export interface UpdateOrgData {
  name?: string;
  slug?: string;
  tier?: string;
  quotas?: Partial<Record<QuotaType, number>>;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Quota service encapsulating all Mongoose operations for organizations.
 *
 * Provides:
 * - findAll() — list every organisation with quotas (admin view)
 * - findByOrgId() — single-org quota summary
 * - getQuotaStatus() — per-type status for an org
 * - update() — update name/slug/tier/limits
 * - resetUsage() — zero-out usage counters
 * - incrementUsage() — atomic increment with limit enforcement
 */
export class QuotaService {
  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * List all organizations with their quota information.
   * Used by the system-admin "GET /quotas/all" endpoint.
   */
  async findAll(): Promise<OrgQuotaResponse[]> {
    const orgs = await Organization.find()
      .select('name slug tier quotas usage')
      .sort({ name: 1 })
      .lean();

    return orgs.map((org) => buildOrgQuotaResponse(org as OrganizationDocument));
  }

  /**
   * Fetch quota information for a single organization.
   * Returns default quotas when the org document does not exist.
   */
  async findByOrgId(orgId: string): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(orgId)
      .select('tier quotas usage name slug')
      .lean();

    if (!org) return buildDefaultOrgQuotaResponse(orgId);
    return buildOrgQuotaResponse(org as OrganizationDocument);
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
    const usage = org?.usage?.[quotaType] ?? { used: 0, resetAt: new Date() };

    return computeQuotaStatus(limit, usage);
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Update an organization's name, slug, tier, and/or quota limits.
   * @throws {OrgNotFoundError} when the org document does not exist
   */
  async update(orgId: string, data: UpdateOrgData): Promise<OrgQuotaResponse> {
    const org = await Organization.findById(orgId);
    if (!org) throw new OrgNotFoundError(orgId);

    if (data.name !== undefined) org.name = data.name;
    if (data.slug !== undefined) org.slug = data.slug;

    if (data.tier !== undefined) {
      const tier = data.tier as QuotaTier;
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
    const freshUsage = { used: 0, resetAt: resetDate };

    if (quotaType) {
      org.usage[quotaType as QuotaType] = freshUsage;
    } else {
      for (const k of VALID_QUOTA_TYPES) org.usage[k] = { ...freshUsage };
    }

    await org.save();

    logger.info('Quota usage reset', { orgId, quotaType: quotaType || 'all' });
    return buildOrgQuotaResponse(org);
  }

  /**
   * Increment usage for a quota type.
   *
   * Handles three distinct flows:
   * 1. **System org bypass** — increment without limit check.
   * 2. **Auto-reset** — atomically resets expired periods before incrementing.
   * 3. **Atomic increment** — single query that only succeeds when quota allows.
   *
   * @throws {OrgNotFoundError} when the org document does not exist
   */
  async incrementUsage(
    orgId: string,
    quotaType: QuotaType,
    amount: number,
    bypassLimit: boolean,
  ): Promise<IncrementResult> {
    const usagePath = `usage.${quotaType}`;

    // ----- System org bypass: simple $inc, no limit check -----
    if (bypassLimit) {
      const org = await Organization.findOneAndUpdate(
        { _id: orgId },
        { $inc: { [`${usagePath}.used`]: amount } },
        { returnDocument: 'after' },
      );
      if (!org) throw new OrgNotFoundError(orgId);

      const limit = org.quotas[quotaType];
      return {
        exceeded: false,
        quota: {
          type: quotaType,
          limit,
          used: org.usage[quotaType].used,
          remaining: limit === -1 ? -1 : Math.max(0, limit - org.usage[quotaType].used),
          resetAt: org.usage[quotaType].resetAt?.toISOString(),
        },
      };
    }

    // ----- Auto-reset expired periods atomically -----
    await Organization.updateOne(
      { _id: orgId, [`${usagePath}.resetAt`]: { $lte: new Date() } },
      { $set: { [`${usagePath}.used`]: 0, [`${usagePath}.resetAt`]: getNextResetDate(config.quota.resetDays) } },
    );

    // ----- Atomic increment with limit check -----
    const org = await Organization.findOneAndUpdate(
      {
        _id: orgId,
        $or: [
          { [`quotas.${quotaType}`]: -1 },
          { $expr: { $lte: [{ $add: [`$${usagePath}.used`, amount] }, `$quotas.${quotaType}`] } },
        ],
      },
      { $inc: { [`${usagePath}.used`]: amount } },
      { returnDocument: 'after' },
    );

    if (!org) {
      // Distinguish "org not found" from "quota exceeded"
      const existingOrg = await Organization.findById(orgId);
      if (!existingOrg) throw new OrgNotFoundError(orgId);

      const limit = existingOrg.quotas[quotaType];
      const currentUsed = existingOrg.usage[quotaType].used;
      return {
        exceeded: true,
        quota: {
          type: quotaType,
          limit,
          used: currentUsed,
          remaining: Math.max(0, limit - currentUsed),
          resetAt: existingOrg.usage[quotaType].resetAt.toISOString(),
        },
      };
    }

    const limit = org.quotas[quotaType];
    return {
      exceeded: false,
      quota: {
        type: quotaType,
        limit,
        used: org.usage[quotaType].used,
        remaining: limit === -1 ? -1 : Math.max(0, limit - org.usage[quotaType].used),
        resetAt: org.usage[quotaType].resetAt?.toISOString(),
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

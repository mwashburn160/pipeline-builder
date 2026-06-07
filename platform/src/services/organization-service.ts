// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, QUOTA_TIERS, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { config } from '../config';
import { toOrgId } from '../helpers/controller-helper';
import {
  getOrganizationQuotaStatus,
  updateQuotaLimits,
  QuotaType,
} from '../middleware/quota';
import { Organization, OrgIdpConfig, User, UserOrganization } from '../models';
import { seedDefaultGroups } from './groups-service';
import type { QuotaTier } from '../models/organization';
import { withMongoTransaction } from '../utils/mongo-tx';
import { escapeRegex } from '../utils/regex';
import { wrapEncrypted } from '../utils/secret-blob';

const logger = createLogger('organization-service');

/** Typed error codes thrown by service methods  map to HTTP status in withController. */
export const ORG_NOT_FOUND = 'ORG_NOT_FOUND';
export const SYSTEM_ORG_DELETE_FORBIDDEN = 'SYSTEM_ORG_DELETE_FORBIDDEN';

/** Supported AI provider identifiers. */
const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'amazon-bedrock'] as const;

const QUOTA_TYPES = ['plugins', 'pipelines', 'apiCalls', 'aiCalls'] as const;
type QuotaTypeKey = (typeof QUOTA_TYPES)[number];

interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  memberCount: number;
  ownerId?: string;
  createdAt: Date;
  updatedAt: Date;
  /** Pricing tier — exposed so the orgs facet UI can filter by it. */
  tier?: QuotaTier;
  /** True iff `kmsConfig.keyId` is present on the org doc. Lets the UI
   *  badge KMS-configured orgs and filter for "no per-org CMK yet". */
  kmsConfigured: boolean;
  /** True iff an OrgIdpConfig document exists for this org. */
  idpConfigured: boolean;
  /** Parent org id when this org is a team (org-team-hierarchy); null = root. */
  parentOrgId?: string | null;
  /** Parent org's display name, when resolvable — for hierarchy display in the
   *  admin list. Absent for root orgs or when the parent is missing. */
  parentOrgName?: string;
}

interface ListParams {
  search?: string;
  /** Filter by pricing tier. Cheap (single-doc field). */
  tier?: QuotaTier;
  offset: number;
  limit: number;
}

interface OrgMember extends Record<string, unknown> {
  role: string;
  joinedAt?: Date;
}

interface OrgWithMembers extends Omit<OrgSummary, 'memberCount'> {
  memberCount: number;
  members: OrgMember[];
}

interface QuotaStatus {
  used: number;
  limit: number | string;
  remaining: number | string;
  resetAt: Date;
  resetPeriod: string;
  unlimited: boolean;
}

interface CreateOrgInput {
  name: string;
  description?: string;
  tier?: QuotaTier;
  /** When set, create as a team nested under this (root) org. */
  parentOrgId?: string;
}

interface UpdateOrgInput {
  name?: string;
  description?: string;
}

interface QuotaLimitsInput {
  plugins?: number;
  pipelines?: number;
  apiCalls?: number;
  aiCalls?: number;
}

/** Format a quota limit for API responses. -1 → 'unlimited'. */
function formatQuotaValue(value: number): number | string {
  return value === -1 ? 'unlimited': value;
}

class OrganizationService {
  /** List organizations with optional name/slug search + pagination. System-admin only at the route layer. */
  async list({ search, tier, offset, limit }: ListParams): Promise<{ organizations: OrgSummary[]; total: number }> {
    const filter: Record<string, unknown> = {};
    if (search) {
      // Treat the search term as a literal substring (escape metachars).
      // See utils/regex.ts for rationale.
      const safe = escapeRegex(search);
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { slug: { $regex: safe, $options: 'i' } },
      ];
    }
    if (tier) filter.tier = tier;

    const [organizations, total] = await Promise.all([
      Organization.find(filter)
        .populate('owner', 'username email')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Organization.countDocuments(filter),
    ]);

    // Cheap O(page) fan-out for member counts. Plus one extra Mongo
    // query for the set of orgs (in this page) that have an IdP config
    // — used to derive the `idpConfigured` facet without a per-row lookup.
    const orgIds = organizations.map((org) => org._id);
    const [memberCounts, idpOrgIds] = await Promise.all([
      Promise.all(orgIds.map((id) => UserOrganization.countDocuments({ organizationId: id, isActive: true }))),
      OrgIdpConfig.find({ orgId: { $in: orgIds.map((id) => id.toString()) } }).distinct('orgId'),
    ]);
    const idpSet = new Set(idpOrgIds.map((id) => String(id)));

    // Resolve parent-org display names for any teams on this page (one batched
    // lookup; no query at all while orgs are flat, i.e. no parentOrgId set).
    const parentIds = [...new Set(
      organizations
        .map((org) => (org as { parentOrgId?: string | null }).parentOrgId)
        .filter((p): p is string => !!p),
    )];
    const parentNames = parentIds.length
      ? new Map(
        (await Organization.find({ _id: { $in: parentIds.map(toOrgId) } }).select('name').lean())
          .map((p) => [p._id.toString(), p.name as string]),
      )
      : new Map<string, string>();

    return {
      organizations: organizations.map((org, idx) => {
        const parentOrgId = (org as { parentOrgId?: string | null }).parentOrgId ?? null;
        const parentOrgName = parentOrgId ? parentNames.get(parentOrgId) : undefined;
        return {
          id: org._id.toString(),
          name: org.name,
          slug: org.slug,
          description: org.description || '',
          memberCount: memberCounts[idx],
          ownerId: org.owner?.toString(),
          createdAt: org.createdAt,
          updatedAt: org.updatedAt,
          tier: (org as { tier?: QuotaTier }).tier,
          kmsConfigured: Boolean((org as { kmsConfig?: { keyId?: string } }).kmsConfig?.keyId),
          idpConfigured: idpSet.has(org._id.toString()),
          parentOrgId,
          ...(parentOrgName && { parentOrgName }),
        };
      }),
      total,
    };
  }

  /**
   * Create org + UserOrganization owner row + set user.lastActiveOrgId in a single
   * transaction. Quota limits seeded from tier config so subsequent quota lookups
   * have a baseline even before the quota service is ever called.
   */
  async create(userId: string, body: CreateOrgInput): Promise<{ id: string; name: string; slug: string; description: string; tier: QuotaTier; parentOrgId?: string }> {
    const tier = body.tier || 'developer';
    const tierConfig = config.quota.tier[tier];

    return withMongoTransaction(async (session) => {
      const orgData: Record<string, unknown> = {
        name: body.name,
        description: body.description || '',
        owner: userId,
        tier,
      };

      // Org → team hierarchy: nest under the parent when requested. Stored as a
      // string id so the descendant-expansion helpers match on string ids.
      if (body.parentOrgId) orgData.parentOrgId = String(body.parentOrgId);

      if (tierConfig) {
        orgData.quotas = {
          plugins: tierConfig.plugins,
          pipelines: tierConfig.pipelines,
          apiCalls: tierConfig.apiCalls,
          aiCalls: tierConfig.aiCalls,
        };
      }

      const [org] = await Organization.create([orgData], { session });
      await UserOrganization.create([{ userId, organizationId: org._id, role: 'owner' }], { session });
      // Seed the default permission groups (Administrators/Developers) and add
      // the creator to Administrators. The creator's role stays 'owner'.
      await seedDefaultGroups(org._id, userId, {}, session);
      await User.updateOne({ _id: userId }, { $set: { lastActiveOrgId: String(org._id) } }, { session });

      return {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        description: org.description || '',
        tier,
        ...(body.parentOrgId && { parentOrgId: String(body.parentOrgId) }),
      };
    });
  }

  /**
   * Validate a prospective team parent: it must exist and be a **root** org
   * (one level of nesting). Returns `'ok'`, `'not-found'`, or `'not-root'`.
   */
  async checkParentEligible(parentOrgId: string): Promise<'ok' | 'not-found' | 'not-root'> {
    const parent = await Organization.findById(toOrgId(parentOrgId)).select('parentOrgId').lean();
    if (!parent) return 'not-found';
    return parent.parentOrgId ? 'not-root' : 'ok';
  }

  /** Get a single org with its full member list. Returns null if not found. */
  async getById(id: string): Promise<OrgWithMembers | null> {
    const org = await Organization.findById(toOrgId(id))
      .populate('owner', 'username email')
      .lean();
    if (!org) return null;

    const [memberships, memberCount, idpDoc] = await Promise.all([
      UserOrganization.find({ organizationId: org._id }).populate('userId', 'username email').lean(),
      UserOrganization.countDocuments({ organizationId: org._id }),
      OrgIdpConfig.exists({ orgId: org._id.toString() }),
    ]);

    const members = memberships.map(m => ({
      ...(m.userId as unknown as Record<string, unknown>),
      role: m.role,
      joinedAt: m.joinedAt,
    }));

    return {
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      description: org.description || '',
      memberCount,
      ownerId: org.owner?.toString(),
      members,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
      tier: (org as { tier?: QuotaTier }).tier,
      kmsConfigured: Boolean((org as { kmsConfig?: { keyId?: string } }).kmsConfig?.keyId),
      idpConfigured: Boolean(idpDoc),
    };
  }

  /**
   * Change an org's pricing tier and reseed quota limits from the new
   * tier's config. Sysadmin-only at the route layer. Returns the
   * previous + new tier so the audit event can record the transition.
   *
   * The quota-microservice is NOT updated here — callers that care
   * about reflecting the new limits in the quota service should call
   * `updateQuotas` separately. We keep the two operations decoupled
   * because partial failure of the remote quota service shouldn't
   * leave the org-doc tier unchanged.
   */
  async setTier(id: string, newTier: QuotaTier): Promise<{ id: string; previousTier?: QuotaTier; tier: QuotaTier } | null> {
    const org = await Organization.findById(toOrgId(id));
    if (!org) return null;

    const previousTier = org.tier as QuotaTier | undefined;
    if (previousTier === newTier) {
      return { id: org._id.toString(), previousTier, tier: newTier };
    }

    org.tier = newTier;
    const tierConfig = config.quota.tier[newTier];
    if (tierConfig) {
      // Source all limits from QUOTA_TIERS so this stays in lockstep with
      // api-core's QuotaTierLimits — the schema now requires every field
      // (plugins/pipelines/apiCalls/aiCalls/storageBytes/dashboards/
      // alertRules/alertDestinations/idpConfigs), so cherry-picking would
      // drop the new caps.
      org.quotas = { ...QUOTA_TIERS[newTier].limits };
      org.markModified('quotas');
    }
    await org.save();

    return { id: org._id.toString(), previousTier, tier: newTier };
  }

  /** Update name/description. Returns null if not found. */
  async update(id: string, body: UpdateOrgInput): Promise<{ id: string; name: string; slug: string; description: string } | null> {
    const org = await Organization.findById(toOrgId(id));
    if (!org) return null;

    if (body.name !== undefined) org.name = body.name;
    if (body.description !== undefined) org.description = body.description;
    await org.save();

    return {
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      description: org.description || '',
    };
  }

  /**
   * Delete an org and all related rows in a single transaction   * - UserOrganization rows (memberships)
   * - User.lastActiveOrgId references
   * - The Organization itself
   *
   * Throws ORG_NOT_FOUND or SYSTEM_ORG_DELETE_FORBIDDEN  the controller maps
   * these to HTTP status via withController's error map.
   */
  async delete(id: string): Promise<void> {
    if (id === SYSTEM_ORG_ID) {
      throw new Error(SYSTEM_ORG_DELETE_FORBIDDEN);
    }

    await withMongoTransaction(async (session) => {
      const queryId = toOrgId(id);
      // Order: clear memberships + back-references first, then drop the org
      // doc — and use deleteOne's `deletedCount` as the existence probe so
      // we skip a redundant `findById` round-trip.
      await UserOrganization.deleteMany({ organizationId: queryId }).session(session);
      // `lastActiveOrgId` is stored as a string (with a validator that
      // accepts ObjectId-shape strings + the 'system' sentinel); the
      // filter must therefore compare against the stringified org id
      // for the BSON match to succeed.
      await User.updateMany({ lastActiveOrgId: String(queryId) }, { $unset: { lastActiveOrgId: '' } }).session(session);
      const res = await Organization.deleteOne({ _id: queryId }).session(session);
      if (!res.deletedCount) throw new Error(ORG_NOT_FOUND);
    });
  }

  /**
   * Fetch quota usage/limits per type from the quota microservice, falling back
   * to the org doc when the service is unavailable. Returns null if the org
   * doesn't exist.
   */
  async getQuotas(id: string, authHeader: string): Promise<Record<string, QuotaStatus> | null> {
    const org = await Organization.findById(toOrgId(id));
    if (!org) return null;

    const tierKey = (org.tier || 'developer') as QuotaTier;
    const tierConfig = config.quota.tier[tierKey];

    const results = await Promise.all( QUOTA_TYPES.map((type) => getOrganizationQuotaStatus(id, type as QuotaType, authHeader)),
    );

    const quotas: Record<string, QuotaStatus> = {};
    for (let i = 0; i < QUOTA_TYPES.length; i++) {
      const type = QUOTA_TYPES[i];
      const quotaStatus = results[i];

      if (quotaStatus) {
        quotas[type] = {
          used: quotaStatus.used,
          limit: formatQuotaValue(quotaStatus.limit),
          remaining: formatQuotaValue(quotaStatus.remaining),
          resetAt: new Date(quotaStatus.resetAt),
          resetPeriod: tierConfig.resetPeriod[type],
          unlimited: quotaStatus.unlimited,
        };
      } else {
        // Service unavailable: read from the org doc as a degraded fallback.
        const limit = org.quotas?.[type] ?? -1;
        const used = org.usage?.[type]?.used ?? 0;
        quotas[type] = {
          used,
          limit: formatQuotaValue(limit),
          remaining: formatQuotaValue(limit === -1 ? -1: Math.max(0, limit - used)),
          resetAt: org.usage?.[type]?.resetAt || new Date(),
          resetPeriod: tierConfig.resetPeriod[type],
          unlimited: limit === -1,
        };
      }
    }
    return quotas;
  }

  /**
   * Update quota limits via the quota service, falling back to direct Mongo
   * write when the service is unreachable so the limits still take effect.
   * Returns the final quota limits per type. Returns null if org not found.
   */
  async updateQuotas(id: string, quotaLimits: QuotaLimitsInput, authHeader: string): Promise<Record<QuotaTypeKey, { limit: number | string; unlimited: boolean }> | null> {
    const org = await Organization.findById(toOrgId(id));
    if (!org) return null;

    const serviceUpdated = await updateQuotaLimits(id, quotaLimits, authHeader);

    if (!serviceUpdated) {
      // Quota service unreachable  write to the org doc directly so the cap
      // is at least enforceable on the next request via the fallback path.
      if (!org.quotas) {
        // Same lockstep rationale as setTier above — spread the full
        // QuotaTierLimits shape so we don't drop newer fields.
        const tierKey = (org.tier as QuotaTier | undefined) ?? 'developer';
        org.quotas = { ...QUOTA_TIERS[tierKey].limits };
      }
      for (const [key, value] of Object.entries(quotaLimits)) {
        if (value !== undefined) {
          org.quotas[key as keyof typeof org.quotas] = value;
        }
      }
      await org.save();
      logger.info(`Organization ${id} quotas updated directly (service unavailable)`);
    } else {
      await org.save();
      logger.info(`Organization ${id} quotas updated via service`);
    }

    // `org.quotas` is the in-memory post-save state — no need to re-fetch.
    const finalQuotas = org.quotas;

    return {
      plugins: { limit: formatQuotaValue(finalQuotas.plugins), unlimited: finalQuotas.plugins === -1 },
      pipelines: { limit: formatQuotaValue(finalQuotas.pipelines), unlimited: finalQuotas.pipelines === -1 },
      apiCalls: { limit: formatQuotaValue(finalQuotas.apiCalls), unlimited: finalQuotas.apiCalls === -1 },
      aiCalls: { limit: formatQuotaValue(finalQuotas.aiCalls), unlimited: finalQuotas.aiCalls === -1 },
    };
  }

  /** Get the AI provider keys for an org as a configured/hint map. Returns null if org not found. */
  async getAIConfig(orgId: string): Promise<Record<string, { configured: boolean; hint?: string }> | null> {
    const org = await Organization.findById(toOrgId(orgId)).select('aiProviderKeys').lean();
    if (!org) return null;

    return this.buildProvidersMap(org.aiProviderKeys || {});
  }

  /**
   * Update AI provider keys for an org. `null`/`''` clears a key; an unset
   * field is left untouched. Returns the new providers map, or null if the
   * org doesn't exist.
   *
   * Values are always encrypted at write time and stored as the JSON-
   * stringified `EncryptedBlob`. `SECRET_ENCRYPTION_KEY` is a hard
   * requirement at platform boot (config/index.ts), so this path is
   * encrypted-only — there is no clear-text fallback.
   */
  async updateAIConfig(orgId: string, body: Record<string, unknown>): Promise<Record<string, { configured: boolean; hint?: string }> | null> {
    const org = await Organization.findById(toOrgId(orgId));
    if (!org) return null;

    if (!org.aiProviderKeys) org.aiProviderKeys = {};

    const orgIdStr = String(org._id);
    for (const p of AI_PROVIDERS) {
      const value = body[p];
      if (value === undefined) continue;
      if (value === null || value === '') {
        org.aiProviderKeys[p] = undefined;
      } else if (typeof value === 'string') {
        org.aiProviderKeys[p] = wrapEncrypted(value, orgIdStr);
      }
    }

    org.markModified('aiProviderKeys');
    await org.save();

    return this.buildProvidersMap(org.aiProviderKeys);
  }

  /** Build a `{ provider: { configured, hint? } }` map from a keys object.
   * All on-disk values are encrypted blobs, so every configured slot
   * reports the generic `***encrypted` hint — operators only need
   * "set / not set", not a ciphertext suffix. */
  private buildProvidersMap(keys: Record<string, string | undefined>): Record<string, { configured: boolean; hint?: string }> {
    const providers: Record<string, { configured: boolean; hint?: string }> = {};
    for (const p of AI_PROVIDERS) {
      const key = keys[p];
      providers[p] = key
        ? { configured: true, hint: '***encrypted' }
        : { configured: false };
    }
    return providers;
  }
}

export const organizationService = new OrganizationService();

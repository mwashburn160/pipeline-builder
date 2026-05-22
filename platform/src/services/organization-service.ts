// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, decryptSecret, encryptSecret, isEncryptedBlob, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { EncryptedBlob } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { config } from '../config';
import { toOrgId } from '../helpers/controller-helper';
import {
  getOrganizationQuotaStatus,
  updateQuotaLimits,
  QuotaType,
} from '../middleware/quota';
import { Organization, OrgIdpConfig, User, UserOrganization } from '../models';
import type { QuotaTier } from '../models/organization';
import { escapeRegex } from '../utils/regex';

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

    return {
      organizations: organizations.map((org, idx) => ({
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
      })),
      total,
    };
  }

  /**
   * Create org + UserOrganization owner row + set user.lastActiveOrgId in a single
   * transaction. Quota limits seeded from tier config so subsequent quota lookups
   * have a baseline even before the quota service is ever called.
   */
  async create(userId: string, body: CreateOrgInput): Promise<{ id: string; name: string; slug: string; description: string; tier: QuotaTier }> {
    const tier = body.tier || 'developer';
    const tierConfig = config.quota.tier[tier];

    const session = await mongoose.startSession();

    try {
      let result!: { id: string; name: string; slug: string; description: string; tier: QuotaTier };

      await session.withTransaction(async () => {
        const orgData: Record<string, unknown> = {
          name: body.name,
          description: body.description || '',
          owner: userId,
          tier,
        };

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
        await User.updateOne({ _id: userId }, { $set: { lastActiveOrgId: org._id } }).session(session);

        result = {
          id: org._id.toString(),
          name: org.name,
          slug: org.slug,
          description: org.description || '',
          tier,
        };
      });

      return result;
    } finally {
      await session.endSession();
    }
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
      org.quotas = {
        plugins: tierConfig.plugins,
        pipelines: tierConfig.pipelines,
        apiCalls: tierConfig.apiCalls,
        aiCalls: tierConfig.aiCalls,
      };
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

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const queryId = toOrgId(id);
        const org = await Organization.findById(queryId).session(session);
        if (!org) throw new Error(ORG_NOT_FOUND);

        await UserOrganization.deleteMany({ organizationId: queryId }).session(session);
        await User.updateMany({ lastActiveOrgId: queryId }, { $unset: { lastActiveOrgId: '' } }).session(session);
        await Organization.findByIdAndDelete(queryId).session(session);
      });
    } finally {
      await session.endSession();
    }
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
        const tierLimits = config.quota.tier[org.tier || 'developer'];
        org.quotas = {
          plugins: tierLimits.plugins,
          pipelines: tierLimits.pipelines,
          apiCalls: tierLimits.apiCalls,
          aiCalls: tierLimits.aiCalls,
        };
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

    const updatedOrg = await Organization.findById(toOrgId(id));
    const finalQuotas = updatedOrg?.quotas || org.quotas;

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
        org.aiProviderKeys[p] = encryptForStorage(value, orgIdStr);
      }
    }

    org.markModified('aiProviderKeys');
    await org.save();

    return this.buildProvidersMap(org.aiProviderKeys);
  }

  /**
   *  Fetch a single decrypted AI provider key for outbound API use.
   * Returns null when the org doesn't exist or the provider isn't set.
   *
   * On-disk shape: JSON-stringified `EncryptedBlob` written by
   * `encryptSecret`. The startup backfill (`backfillSecrets`) re-encrypts
   * any pre-encryption clear-text values; after that, every record is
   * encrypted and the read path enforces it strictly.
   *
   * Throws on tampered ciphertext / wrong-org binding / malformed blob —
   * we never silently mask a corrupted secret column as "not configured".
   */
  async getAiProviderKey(orgId: string, provider: string): Promise<string | null> {
    const org = await Organization.findById(toOrgId(orgId)).select('aiProviderKeys').lean();
    const raw = org?.aiProviderKeys?.[provider as keyof typeof org.aiProviderKeys];
    if (!raw) return null;
    return decryptStoredBlob(raw, String(org!._id), `aiProviderKeys.${provider}`);
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

// ---------------------------------------------------------------------------
// secret-encryption helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext secret for storage. `SECRET_ENCRYPTION_KEY` is a hard
 * requirement at platform boot (see config/index.ts); reaching this function
 * with the env unset is a programmer error and `encryptSecret` throws.
 */
function encryptForStorage(plaintext: string, orgId: string): string {
  return JSON.stringify(encryptSecret(plaintext, orgId));
}

/**
 * Decrypt a JSON-stringified `EncryptedBlob` from disk. Throws when the
 * stored value isn't a well-formed blob — the clear-text fallback was
 * removed alongside the mandatory-encryption cutover. The startup backfill
 * (`backfillSecrets`) re-encrypts any pre-encryption clear-text rows, so a
 * production read should never hit a malformed value.
 *
 * `fieldLabel` is included in the error so on-call can identify which
 * record needs repair without leaking the (encrypted) value itself.
 */
function decryptStoredBlob(raw: string, orgId: string, fieldLabel: string): string {
  if (!raw.startsWith('{')) {
    throw new Error(`Stored secret "${fieldLabel}" is not a JSON-encoded EncryptedBlob`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Stored secret "${fieldLabel}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isEncryptedBlob(parsed)) {
    throw new Error(`Stored secret "${fieldLabel}" does not match the EncryptedBlob shape`);
  }
  return decryptSecret(parsed as EncryptedBlob, orgId);
}

export const organizationService = new OrganizationService();

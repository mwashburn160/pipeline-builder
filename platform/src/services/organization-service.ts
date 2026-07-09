// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, DEFAULT_TIER, getServiceAuthHeader, QUOTA_TIERS, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { seedDefaultGroups } from './groups-service.js';
import { config } from '../config/index.js';
import { toOrgId } from '../helpers/controller-helper.js';
import { expandOrgScope, resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { pooledSeatUsage } from '../helpers/seats.js';
import {
  getOrganizationQuotaStatus,
  updateQuotaLimits,
  type QuotaType,
} from '../middleware/quota.js';
import { Organization, OrgIdpConfig, User, UserOrganization } from '../models/index.js';
import type { QuotaTier } from '../models/organization.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { escapeRegex } from '../utils/regex.js';
import { wrapEncrypted } from '../utils/secret-blob.js';

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
  /** Org → team hierarchy. `isTeam` = this org is a child (has a parent).
   *  `rootOrgId` is the account boundary (self for a root; the parent for a
   *  team, since nesting is one level deep). Drives pooled-at-root UI/gating. */
  parentOrgId?: string | null;
  isTeam: boolean;
  rootOrgId: string;
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
    return withMongoTransaction(async (session) => {
      // A team (child org) is a pooled sub-unit of the root: it inherits the
      // root's tier and gets locally-unlimited quotas (-1) so ONLY the root's
      // pooled cap binds (see docs/org-team-hierarchy.md §4/§5.1). A root org
      // seeds its own quotas from its tier preset (matches setTier).
      let tier: QuotaTier;
      let quotas: Record<string, number>;
      // A team inherits the root's purchased feature entitlements (bundle grants)
      // so it isn't missing them until the next billing sync (mirrors how
      // setSeatLimit propagates featureEntitlements to existing descendants).
      let inheritedFeatures: string[] = [];
      if (body.parentOrgId) {
        const parent = await Organization.findById(toOrgId(body.parentOrgId))
          .select('tier featureEntitlements').session(session).lean();
        tier = (parent?.tier as QuotaTier) ?? DEFAULT_TIER;
        inheritedFeatures = (parent?.featureEntitlements as string[] | undefined) ?? [];
        quotas = Object.fromEntries(
          Object.keys(QUOTA_TIERS[tier].limits).map((k) => [k, -1]),
        );
      } else {
        tier = body.tier || DEFAULT_TIER;
        quotas = { ...QUOTA_TIERS[tier].limits };
      }

      const orgData: Record<string, unknown> = {
        name: body.name,
        description: body.description || '',
        owner: userId,
        tier,
        quotas,
        ...(inheritedFeatures.length > 0 ? { featureEntitlements: inheritedFeatures } : {}),
      };

      // Org → team hierarchy: nest under the parent when requested. Stored as a
      // string id so the descendant-expansion helpers match on string ids.
      if (body.parentOrgId) orgData.parentOrgId = String(body.parentOrgId);

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
   * Validate a prospective team parent: it must exist, be a **root** org (one
   * level of nesting), and be on a tier that includes teams (`team`/`enterprise`).
   * Returns `'ok'`, `'not-found'`, `'not-root'`, or `'tier-forbidden'`.
   */
  async checkParentEligible(parentOrgId: string): Promise<'ok' | 'not-found' | 'not-root' | 'tier-forbidden'> {
    const parent = await Organization.findById(toOrgId(parentOrgId)).select('parentOrgId tier').lean();
    if (!parent) return 'not-found';
    if (parent.parentOrgId) return 'not-root';
    const tier = parent.tier as QuotaTier | undefined;
    if (tier !== 'team' && tier !== 'enterprise') return 'tier-forbidden';
    return 'ok';
  }

  /**
   * Set the account seat limit on the org's ROOT. Platform owns `seats` (it is
   * not a quota-service type), so billing syncs the effective seat entitlement
   * (tier base + bundles) here. Resolves to the root so a team id still targets
   * the account. Returns the resolved root id, or null if the org is missing.
   */
  async setSeatLimit(
    orgId: string,
    seats: number,
    features?: string[],
  ): Promise<{ rootOrgId: string; seats: number } | null> {
    const { rootOrgId } = await resolveOrgLineage(orgId);
    const set: Record<string, unknown> = { 'quotas.seats': seats };
    // Account-level purchased feature entitlements (bundles) also live on the
    // root and are synced by billing alongside the seat limit.
    if (features !== undefined) set.featureEntitlements = features;

    // Atomic: the root seat/entitlement write and its propagation onto descendant
    // teams must both land or neither, so a member's token can't carry a stale
    // entitlement set after a partial failure.
    return withMongoTransaction(async (session) => {
      const result = await Organization.updateOne(
        { _id: toOrgId(rootOrgId) },
        { $set: set },
        { session },
      );
      if (result.matchedCount === 0) return null;

      // Propagate feature entitlements onto descendant teams so a team member's
      // token carries them (they're account-level; mirrors tier propagation).
      if (features !== undefined) {
        const scope = await expandOrgScope(rootOrgId);
        const descendantIds = scope.filter((sid) => sid !== rootOrgId);
        if (descendantIds.length > 0) {
          await Organization.updateMany(
            { _id: { $in: descendantIds.map(toOrgId) } },
            { $set: { featureEntitlements: features } },
            { session },
          );
        }
      }
      return { rootOrgId, seats };
    });
  }

  /** Get a single org with its full member list. Returns null if not found. */
  async getById(id: string): Promise<OrgWithMembers | null> {
    const org = await Organization.findById(toOrgId(id))
      .populate('owner', 'username email')
      .lean();
    if (!org) return null;

    const parentOrgId = (org as { parentOrgId?: unknown }).parentOrgId;
    const isTeam = !!parentOrgId;
    const rootOrgId = isTeam ? String(parentOrgId) : org._id.toString();

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
      // Org → team hierarchy. One-level nesting means a team's parent IS the
      // root, so rootOrgId needs no extra query.
      parentOrgId: parentOrgId ? String(parentOrgId) : null,
      isTeam,
      rootOrgId,
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
  /**
   * Whether changing `orgId`'s account to `newTier` would drop a COUNT quota's
   * cap below current pooled usage (docs/billing-bundles.md §8) — mirrors the
   * billing over-cap gate for the sysadmin tier-change path. Guards seats
   * (pooled), plugins, pipelines (count quotas whose usage lives on the shared
   * org doc). Rate quotas (apiCalls/aiCalls) aren't guarded — they reset. Empty
   * array = safe.
   */
  async checkTierOvercap(
    orgId: string,
    newTier: QuotaTier,
  ): Promise<Array<{ quotaType: string; currentUsage: number; targetCap: number; overage: number }>> {
    const limits = QUOTA_TIERS[newTier].limits;
    const overages: Array<{ quotaType: string; currentUsage: number; targetCap: number; overage: number }> = [];

    // Resolve the account subtree once (shared by the team-stranding + pooled
    // usage checks below).
    const { rootOrgId } = await resolveOrgLineage(orgId);
    const scope = await expandOrgScope(rootOrgId);
    const scopeIds = scope.map(toOrgId);

    // Structural guard (mirrors the delete-path block): a team requires its
    // parent tier to be `team`/`enterprise` (checkParentEligible). Downgrading a
    // root that HAS teams to a team-forbidding tier (developer/pro) would strand
    // them, so surface it as an over-cap the sysadmin must `force` past.
    if (newTier !== 'team' && newTier !== 'enterprise') {
      const teamCount = scopeIds.length - 1; // subtree minus the root itself
      if (teamCount > 0) {
        overages.push({ quotaType: 'teams', currentUsage: teamCount, targetCap: 0, overage: teamCount });
      }
    }

    // seats (platform-owned, pooled)
    if (limits.seats !== -1) {
      const { used } = await pooledSeatUsage(orgId);
      if (used > limits.seats) {
        overages.push({ quotaType: 'seats', currentUsage: used, targetCap: limits.seats, overage: used - limits.seats });
      }
    }

    // Persistent COUNT quotas — usage pools across the subtree (a team's usage
    // counts against the root). These can't auto-shrink on downgrade, so a
    // downgrade below current usage is blocked. (Rate quotas apiCalls/aiCalls
    // reset per period, and storageBytes is measured live — not guarded here,
    // matching billing's checkEntitlementOvercap.)
    //
    // Authoritative read: ask the QUOTA SERVICE for each field's pooled usage —
    // it's the single authority for pooling + expired-period semantics.
    // `getOrganizationQuotaStatus` already rolls the subtree up to the root and
    // zeroes expired periods, so one read per field on `rootOrgId` equals the
    // subtree total. Degraded fallback: if the service is unreachable for a
    // field, read that field straight off the shared org docs (the prior
    // behavior — same underlying Mongo counters) so a transient outage doesn't
    // silently under-count and wave a stranding downgrade through.
    const COUNT_QUOTAS = ['plugins', 'pipelines', 'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs'] as const;
    const auth = getServiceAuthHeader({ serviceName: 'platform', orgId: rootOrgId, role: 'owner' });
    const statuses = await Promise.all(
      COUNT_QUOTAS.map((field) => getOrganizationQuotaStatus(rootOrgId, field as QuotaType, auth)),
    );

    let fallbackRows: Array<{ usage?: unknown }> | null = null;
    const usageFor = async (field: string, i: number): Promise<number> => {
      const status = statuses[i];
      if (status) return status.used;
      // Service unavailable for this field: degrade to the shared org-doc sum.
      if (!fallbackRows) {
        fallbackRows = await Organization.find({ _id: { $in: scopeIds } })
          .select('usage.plugins usage.pipelines usage.dashboards usage.alertRules usage.alertDestinations usage.idpConfigs').lean();
      }
      return fallbackRows.reduce((sum, r) => {
        const usage = r.usage as unknown as Record<string, { used?: number } | undefined> | undefined;
        return sum + (usage?.[field]?.used ?? 0);
      }, 0);
    };

    for (let i = 0; i < COUNT_QUOTAS.length; i++) {
      const field = COUNT_QUOTAS[i];
      if (limits[field] === -1) continue;
      const used = await usageFor(field, i);
      if (used > limits[field]) {
        overages.push({ quotaType: field, currentUsage: used, targetCap: limits[field], overage: used - limits[field] });
      }
    }
    return overages;
  }

  async setTier(id: string, newTier: QuotaTier): Promise<{ id: string; previousTier?: QuotaTier; tier: QuotaTier } | null> {
    const org = await Organization.findById(toOrgId(id));
    if (!org) return null;

    const previousTier = org.tier as QuotaTier | undefined;
    if (previousTier === newTier) {
      return { id: org._id.toString(), previousTier, tier: newTier };
    }

    org.tier = newTier;
    if (org.parentOrgId) {
      // Team: tier is derived (display-only). Its quotas stay pooled (-1) so the
      // ROOT's cap is the only binding one — do NOT reseed from the preset.
    } else if (config.quota.tier[newTier]) {
      // Root: reseed its OWN quotas from the new tier (source from QUOTA_TIERS
      // so every QuotaTierLimits field stays in lockstep).
      org.quotas = { ...QUOTA_TIERS[newTier].limits };
      org.markModified('quotas');
    }

    // Atomic: the root's tier/quota save and the tier propagation onto its
    // descendant teams must both land or neither — a failure between them would
    // otherwise leave the root on the new tier while teams keep the old.
    await withMongoTransaction(async (session) => {
      await org.save({ session });

      // Propagate the tier label to descendant teams so their derived tier tracks
      // the root (their quotas stay pooled at -1). No-op for a flat org / a team.
      if (!org.parentOrgId) {
        const scope = await expandOrgScope(org._id.toString());
        const descendantIds = scope.filter((sid) => sid !== org._id.toString());
        if (descendantIds.length > 0) {
          await Organization.updateMany(
            { _id: { $in: descendantIds.map(toOrgId) } },
            { $set: { tier: newTier } },
            { session },
          );
        }
      }
    });

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

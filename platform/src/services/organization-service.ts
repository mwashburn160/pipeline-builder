// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, QUOTA_TIERS, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { applyAIProviderKeyUpdates, buildProvidersMap, ORG_AI_KEY_TOO_LONG } from './organization-ai-secrets.js';
import {
  checkTierOvercap,
  getQuotas,
  setSeatLimit,
  setTier,
  updateQuotas,
  type QuotaLimitsInput,
  type QuotaStatus,
  type QuotaTypeKey,
} from './organization-quota.js';
import { seedDefaultRoles } from './roles-service.js';
import { toOrgId } from '../helpers/controller-helper.js';
import { Role, RoleAssignment, Organization, OrgIdpConfig, User, UserOrganization } from '../models/index.js';
import type { QuotaTier } from '../models/organization.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { escapeRegex } from '../utils/regex.js';

/** Typed error codes thrown by service methods  map to HTTP status in withController. */
export const ORG_NOT_FOUND = 'ORG_NOT_FOUND';
export const SYSTEM_ORG_DELETE_FORBIDDEN = 'SYSTEM_ORG_DELETE_FORBIDDEN';
// Re-exported from organization-ai-secrets.js to preserve the module's public API.
export { ORG_AI_KEY_TOO_LONG };

/** Default / hard cap on the member roster returned by {@link OrganizationService.getById}
 *  so a large org doesn't return its full membership on this hot read. */
const MEMBER_ROSTER_DEFAULT_LIMIT = 100;
const MEMBER_ROSTER_MAX_LIMIT = 500;

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

    // Member counts for the whole page in ONE aggregation (single $group over the
    // page's org ids) instead of a per-org countDocuments fan-out. Plus one extra
    // Mongo query for the set of orgs (in this page) that have an IdP config —
    // used to derive the `idpConfigured` facet without a per-row lookup.
    const orgIds = organizations.map((org) => org._id);
    const [memberCountRows, idpOrgIds] = await Promise.all([
      UserOrganization.aggregate<{ _id: unknown; count: number }>([
        { $match: { organizationId: { $in: orgIds }, isActive: true } },
        { $group: { _id: '$organizationId', count: { $sum: 1 } } },
      ]),
      OrgIdpConfig.find({ orgId: { $in: orgIds.map((id) => id.toString()) } }).distinct('orgId'),
    ]);
    const memberCountMap = new Map(memberCountRows.map((r) => [String(r._id), r.count]));
    const idpSet = new Set(idpOrgIds.map((id) => String(id)));

    // Resolve parent-org display names for any teams on this page (one batched
    // lookup; no query at all while orgs are flat, i.e. no parentOrgId set).
    const parentIds = [...new Set(
      organizations
        .map((org) => org.parentOrgId)
        .filter((p): p is string => !!p),
    )];
    const parentNames = parentIds.length
      ? new Map(
        (await Organization.find({ _id: { $in: parentIds.map(toOrgId) } }).select('name').lean())
          .map((p) => [p._id.toString(), p.name as string]),
      )
      : new Map<string, string>();

    return {
      organizations: organizations.map((org) => {
        const parentOrgId = org.parentOrgId ?? null;
        const parentOrgName = parentOrgId ? parentNames.get(parentOrgId) : undefined;
        return {
          id: org._id.toString(),
          name: org.name,
          slug: org.slug,
          description: org.description || '',
          memberCount: memberCountMap.get(org._id.toString()) ?? 0,
          ownerId: org.owner?.toString(),
          createdAt: org.createdAt,
          updatedAt: org.updatedAt,
          tier: org.tier,
          kmsConfigured: Boolean(org.kmsConfig?.keyId),
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
      // Seed the default permission Roles (Admin/Member) and add
      // the creator to Admin. The creator's role stays 'owner'.
      await seedDefaultRoles(org._id, userId, {}, session);
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
    return setSeatLimit(orgId, seats, features);
  }

  /**
   * Get a single org with a (bounded) page of its member list. Returns null if
   * not found. The roster is capped/paginated (`membersLimit`/`membersOffset`,
   * default cap {@link MEMBER_ROSTER_DEFAULT_LIMIT}) so a large org doesn't ship
   * its entire membership on this hot read; `memberCount` is always the full
   * count so the UI can page.
   */
  async getById(
    id: string,
    opts: { membersLimit?: number; membersOffset?: number } = {},
  ): Promise<OrgWithMembers | null> {
    const org = await Organization.findById(toOrgId(id))
      .populate('owner', 'username email')
      .lean();
    if (!org) return null;

    const membersLimit = Math.min(
      Math.max(1, opts.membersLimit ?? MEMBER_ROSTER_DEFAULT_LIMIT),
      MEMBER_ROSTER_MAX_LIMIT,
    );
    const membersOffset = Math.max(0, opts.membersOffset ?? 0);

    const parentOrgId = org.parentOrgId;
    const isTeam = !!parentOrgId;
    const rootOrgId = isTeam ? String(parentOrgId) : org._id.toString();

    const [memberships, memberCount, idpDoc] = await Promise.all([
      UserOrganization.find({ organizationId: org._id })
        .populate('userId', 'username email')
        .sort({ joinedAt: 1 })
        .skip(membersOffset)
        .limit(membersLimit)
        .lean(),
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
      tier: org.tier,
      kmsConfigured: Boolean(org.kmsConfig?.keyId),
      idpConfigured: Boolean(idpDoc),
      // Org → team hierarchy. One-level nesting means a team's parent IS the
      // root, so rootOrgId needs no extra query.
      parentOrgId: parentOrgId ? String(parentOrgId) : null,
      isTeam,
      rootOrgId,
    };
  }

  /**
   * Whether changing `orgId`'s account to `newTier` would drop a COUNT quota's
   * cap below current pooled usage — see {@link checkTierOvercap} in
   * organization-quota.js. Delegates to keep the pooled-usage/tier logic in one
   * place; the public method signature is unchanged.
   */
  async checkTierOvercap(
    orgId: string,
    newTier: QuotaTier,
  ): Promise<Array<{ quotaType: string; currentUsage: number; targetCap: number; overage: number }>> {
    return checkTierOvercap(orgId, newTier);
  }

  /**
   * Change an org's pricing tier and reseed quota limits from the new tier's
   * config — see {@link setTier} in organization-quota.js. Delegates; the public
   * method signature is unchanged.
   */
  async setTier(id: string, newTier: QuotaTier): Promise<{ id: string; previousTier?: QuotaTier; tier: QuotaTier } | null> {
    return setTier(id, newTier);
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
      // Drop the Roles + role assignments seeded on org create
      // (`seedDefaultRoles`); otherwise they orphan and a future org reusing
      // this id could inherit stale Role state.
      await RoleAssignment.deleteMany({ organizationId: queryId }).session(session);
      await Role.deleteMany({ organizationId: queryId }).session(session);
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
   * Fetch quota usage/limits per type from the quota microservice — see
   * {@link getQuotas} in organization-quota.js. Delegates; signature unchanged.
   */
  async getQuotas(id: string, authHeader: string): Promise<Record<string, QuotaStatus> | null> {
    return getQuotas(id, authHeader);
  }

  /**
   * Update quota limits via the quota service — see {@link updateQuotas} in
   * organization-quota.js. Delegates; signature unchanged.
   */
  async updateQuotas(id: string, quotaLimits: QuotaLimitsInput, authHeader: string): Promise<Record<QuotaTypeKey, { limit: number | string; unlimited: boolean }> | null> {
    return updateQuotas(id, quotaLimits, authHeader);
  }

  /** Get the AI provider keys for an org as a configured/hint map. Returns null if org not found. */
  async getAIConfig(orgId: string): Promise<Record<string, { configured: boolean; hint?: string }> | null> {
    const org = await Organization.findById(toOrgId(orgId)).select('aiProviderKeys').lean();
    if (!org) return null;

    return buildProvidersMap(org.aiProviderKeys || {});
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

    applyAIProviderKeyUpdates(org.aiProviderKeys, body, String(org._id));

    org.markModified('aiProviderKeys');
    await org.save();

    return buildProvidersMap(org.aiProviderKeys);
  }
}

export const organizationService = new OrganizationService();

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getServiceAuthHeader, QUOTA_TIERS, VALID_TIERS } from '@pipeline-builder/api-core';
import type { ClientSession } from 'mongoose';
import { config } from '../config/index.js';
import { toOrgId } from '../helpers/controller-helper.js';
import { expandOrgScope, resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { pooledSeatUsage } from '../helpers/seats.js';
import {
  getOrganizationQuotaStatus,
  updateQuotaLimits,
  type QuotaType,
} from '../middleware/quota.js';
import { Organization, User, UserOrganization } from '../models/index.js';
import type { QuotaTier } from '../models/organization.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('organization-service');

const QUOTA_TYPES = ['plugins', 'pipelines', 'apiCalls', 'aiCalls'] as const;
export type QuotaTypeKey = (typeof QUOTA_TYPES)[number];

/**
 * Invalidate every ACTIVE member's outstanding access tokens for `organizationId`
 * by bumping their `tokenVersion` inside the caller's transaction.
 *
 * The JWT bakes in the org's `tier` + resolved `features` (from `tier` +
 * `featureEntitlements`) at issue time. On an account-change that REDUCES access
 * — a tier downgrade or a bundle (feature) removal — those already-issued tokens
 * would keep granting the elevated tier / `requireFeature`-gated capabilities
 * (sso, audit_log, …) until natural expiry (~2 h). Bumping `tokenVersion` makes
 * `requireAuth` reject them on the next request; a refresh reissues a correctly
 * scoped JWT. Mirrors the bump in org-members-service.removeMember /
 * roles-service.recomputeUserOrgRole.
 *
 * Bounded + idempotent: callers invoke this ONLY on a genuine reduction, and a
 * no-member org is a no-op. An UPGRADE / feature-add never calls it — a stale
 * token that under-grants is safe.
 */
async function bumpActiveMembersTokenVersion(
  organizationId: string,
  session: ClientSession,
): Promise<void> {
  const userIds = await UserOrganization
    .distinct('userId', { organizationId: toOrgId(organizationId), isActive: true })
    .session(session);
  if (userIds.length === 0) return;
  await User.updateMany(
    { _id: { $in: userIds } },
    { $inc: { tokenVersion: 1 } },
    { session },
  );
}

export interface QuotaStatus {
  used: number;
  limit: number | string;
  remaining: number | string;
  resetAt: Date;
  resetPeriod: string;
  unlimited: boolean;
}

export interface QuotaLimitsInput {
  plugins?: number;
  pipelines?: number;
  apiCalls?: number;
  aiCalls?: number;
}

/** Format a quota limit for API responses. -1 → 'unlimited'. */
function formatQuotaValue(value: number): number | string {
  return value === -1 ? 'unlimited': value;
}

/**
 * Set the account seat limit on the org's ROOT. Platform owns `seats` (it is
 * not a quota-service type), so billing syncs the effective seat entitlement
 * (tier base + bundles) here. Resolves to the root so a team id still targets
 * the account. Returns the resolved root id, or null if the org is missing.
 */
export async function setSeatLimit(
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
    // Read the pre-change entitlements FIRST so we can detect a bundle removal
    // (a feature dropped vs the current set) before the $set overwrites them —
    // that's an access REDUCTION whose stale tokens must be invalidated below.
    let featureShrink = false;
    if (features !== undefined) {
      const current = await Organization.findById(toOrgId(rootOrgId))
        .select('featureEntitlements').session(session).lean();
      const nextFeatures = new Set(features);
      featureShrink = (current?.featureEntitlements ?? []).some((f) => !nextFeatures.has(f));
    }

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

    // A bundle removal strips `requireFeature`-gated capabilities (sso,
    // audit_log, …) from the account. Members' existing JWTs still carry the
    // removed feature until expiry, so invalidate them now. No bump when
    // features are only added / unchanged (a stale token then under-grants).
    if (featureShrink) {
      await bumpActiveMembersTokenVersion(rootOrgId, session);
    }
    return { rootOrgId, seats };
  });
}

/**
 * Whether changing `orgId`'s account to `newTier` would drop a COUNT quota's
 * cap below current pooled usage (docs/billing-bundles.md §8) — mirrors the
 * billing over-cap gate for the sysadmin tier-change path. Guards seats
 * (pooled), plugins, pipelines (count quotas whose usage lives on the shared
 * org doc). Rate quotas (apiCalls/aiCalls) aren't guarded — they reset. Empty
 * array = safe.
 */
export async function checkTierOvercap(
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
export async function setTier(id: string, newTier: QuotaTier): Promise<{ id: string; previousTier?: QuotaTier; tier: QuotaTier } | null> {
  const org = await Organization.findById(toOrgId(id));
  if (!org) return null;

  const previousTier = org.tier as QuotaTier | undefined;
  if (previousTier === newTier) {
    return { id: org._id.toString(), previousTier, tier: newTier };
  }

  // Detect a DOWNGRADE (new tier ranks below the old) from the pre-change tier.
  // VALID_TIERS is ordered developer < pro < team < enterprise, so a lower index
  // = a lesser tier. A downgrade drops the baked-in tier + `requireFeature`-gated
  // capabilities, so members' existing JWTs must be invalidated (below). An
  // UPGRADE (or a legacy no-tier → tier transition) never bumps: a stale token
  // then under-grants, which is safe.
  const previousRank = previousTier ? VALID_TIERS.indexOf(previousTier) : -1;
  const newRank = VALID_TIERS.indexOf(newTier);
  const isDowngrade = previousRank !== -1 && newRank !== -1 && newRank < previousRank;

  org.tier = newTier;
  if (org.parentOrgId) {
    // Team: tier is derived (display-only). Its quotas stay pooled (-1) so the
    // ROOT's cap is the only binding one — do NOT reseed from the preset.
  } else if (config.quota.tier[newTier]) {
    // Root: reseed its OWN quotas from the new tier (source from QUOTA_TIERS
    // so every QuotaTierLimits field stays in lockstep).
    //
    // PRESERVE purchased seat capacity across the reseed. `seats` is the one
    // quota dimension a bundle raises DIRECTLY on the org doc: billing's
    // seat_pack pushes the effective (tier base + bundle) seat limit here via
    // `setSeatLimit`/`pushSeatLimitToPlatform`. Every OTHER bundle-raised dim is
    // synced to the quota SERVICE (billing's `syncTierToQuotaService`), so
    // reseeding those on the org doc to the bare tier base is correct — but
    // clobbering `seats` with the tier base would silently discard paid-for
    // seats until (if ever) a later billing sync happened to restore them
    // (ordering-coupled, no guard). So keep the LARGER of {new tier base,
    // current seats}, treating -1 (unlimited) as the max. `featureEntitlements`
    // is a separate top-level field, so this quotas reseed never touches it.
    //
    // Only `seats` is preserved (not a blanket per-dim max): a blanket max
    // would also strand the PREVIOUS tier's higher base for non-bundle dims, so
    // a downgrade would never actually lower them. A genuine seat REDUCTION
    // never rides setTier — billing pushes it through `setSeatLimit` — so
    // keep-max here can't strand a removed seat bundle.
    const reseeded = { ...QUOTA_TIERS[newTier].limits };
    const currentSeats = org.quotas?.seats;
    if (typeof currentSeats === 'number' && typeof reseeded.seats === 'number') {
      if (currentSeats === -1) {
        reseeded.seats = -1; // current unlimited seats outrank any finite base
      } else if (reseeded.seats !== -1 && currentSeats > reseeded.seats) {
        reseeded.seats = currentSeats; // purchased/bundle-raised cap survives
      }
    }
    org.quotas = reseeded;
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

    // On a downgrade, invalidate active members' outstanding access tokens so
    // the reduced tier / lost features take effect immediately rather than at
    // token expiry. Same transaction as the tier write. No bump on an upgrade.
    if (isDowngrade) {
      await bumpActiveMembersTokenVersion(org._id.toString(), session);
    }
  });

  return { id: org._id.toString(), previousTier, tier: newTier };
}

/**
 * Fetch quota usage/limits per type from the quota microservice, falling back
 * to the org doc when the service is unavailable. Returns null if the org
 * doesn't exist.
 */
export async function getQuotas(id: string, authHeader: string): Promise<Record<string, QuotaStatus> | null> {
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
export async function updateQuotas(id: string, quotaLimits: QuotaLimitsInput, authHeader: string): Promise<Record<QuotaTypeKey, { limit: number | string; unlimited: boolean }> | null> {
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

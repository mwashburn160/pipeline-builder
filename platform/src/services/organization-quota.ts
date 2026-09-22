// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getServiceAuthHeader, QUOTA_TIERS, TIER_FEATURES, VALID_TIERS, tierAllowsTeams, type QuotaTierLimits } from '@pipeline-builder/api-core';
import type { ClientSession, Types } from 'mongoose';
import { ORG_SEAT_LIMIT_NOT_ROOT } from './org-errors.js';
import { config } from '../config/index.js';
import { expandOrgScope, resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { pooledSeatUsage } from '../helpers/seats.js';
import { publishUsersRevocation } from '../helpers/session-revocation.js';
import {
  getOrganizationQuotaStatus,
  type QuotaType,
} from '../middleware/quota.js';
import { Organization, User, UserOrganization } from '../models/index.js';
import type { QuotaTier } from '../models/organization.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('organization-service');

/**
 * BILLING-OWNED retention dimensions persisted ONLY to `dora_settings` (via the
 * billing→reporting retention-sync leg). They must NEVER land on the org doc's
 * `quotas`, so every reseed strips them from the tier preset.
 */
const RETENTION_DIMS = ['eventRetentionDays', 'doraRetentionDays'] as const;

/**
 * The org-doc `quotas` a tier's preset reseeds, from `QUOTA_TIERS[tier].limits`
 * (so every QuotaTierLimits field stays in lockstep) — never the billing-owned
 * {@link RETENTION_DIMS}, which live only on `dora_settings`.
 *
 * `seats` is the one dim a bundle raises DIRECTLY on the org doc (billing's
 * seat_pack pushes the effective tier base + bundles through `setSeatLimit`), so
 * a reseed never clobbers it with the bare base: it keeps the LARGER of the new
 * base and `currentSeats` (-1 = unlimited outranks any finite base). Only seats
 * keep-max: a blanket max would strand the previous tier's higher base on the
 * other dims, and a genuine seat REDUCTION never rides a tier change — billing
 * pushes it through `setSeatLimit`. Every other dim is synced to the quota
 * SERVICE by billing, so reseeding the org-doc copy to the new base is correct.
 */
export function tierBaseQuotaSet(tier: QuotaTier, currentSeats: number | undefined): QuotaTierLimits {
  const quotas: QuotaTierLimits = { ...QUOTA_TIERS[tier].limits };
  for (const dim of RETENTION_DIMS) delete (quotas as Partial<QuotaTierLimits>)[dim];
  if (typeof currentSeats === 'number' && typeof quotas.seats === 'number') {
    if (currentSeats === -1) quotas.seats = -1;
    else if (quotas.seats !== -1 && currentSeats > quotas.seats) quotas.seats = currentSeats;
  }
  return quotas;
}

/** Added/removed feature-entitlement delta (order-independent) for the audit trail. */
export interface FeatureDelta {
  added: string[];
  removed: string[];
}

/**
 * Order-independent set difference between two feature lists: `added = next \
 * prev`, `removed = prev \ next`. Shared by setSeatLimit (bundle-entitlement
 * sync) and setTier (tier-baseline downgrade) so both audit deltas are computed
 * one way. Duplicate entries within a list are collapsed.
 */
function computeFeatureDelta(prev: readonly string[], next: readonly string[]): FeatureDelta {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const added = [...nextSet].filter((f) => !prevSet.has(f));
  const removed = [...prevSet].filter((f) => !nextSet.has(f));
  return { added, removed };
}

/**
 * Invalidate every ACTIVE member's outstanding access tokens for `organizationId`
 * (a single org id, or an array spanning an account subtree) by bumping their
 * `claimsVersion` inside the caller's transaction.
 *
 * The JWT bakes in the org's `tier` + resolved `features` (from `tier` +
 * `featureEntitlements`) at issue time. On an account-change that REDUCES access
 * — a tier downgrade or a bundle (feature) removal — those already-issued tokens
 * would keep granting the elevated tier / `requireFeature`-gated capabilities
 * (sso, audit_log, …) until natural expiry (~15 min). Bumping `claimsVersion` makes
 * `requireAuth` reject them on the next request; a refresh reissues a correctly
 * scoped JWT. Mirrors the bump in org-members-service.removeMember /
 * roles-service.recomputeUserOrgRole.
 *
 * Because `tier` + `featureEntitlements` propagate to the ENTIRE subtree (root +
 * descendant teams), callers pass every affected org id so a team member's stale
 * token is invalidated too — not just the root's members. A member who belongs
 * to several orgs in the subtree is bumped exactly once: `distinct` collapses the
 * `userId` set across all matched memberships. A single-id (or single-element)
 * argument queries the scalar `organizationId` exactly as before.
 *
 * Bounded + idempotent: callers invoke this ONLY on a genuine reduction, and a
 * no-member subtree is a no-op. An UPGRADE / feature-add never calls it — a stale
 * token that under-grants is safe.
 *
 * Returns the affected member ids so the caller can PUBLISH each user's now-
 * current access version to the stateless services AFTER the transaction commits
 * (see `publishUsersRevocation`) — publishing must never run mid-transaction.
 */
async function bumpActiveMembersClaimsVersion(
  organizationId: string | string[],
  session: ClientSession,
): Promise<Types.ObjectId[]> {
  const orgIds = Array.isArray(organizationId) ? organizationId : [organizationId];
  // Single org → scalar match (identical query to the pre-subtree behavior);
  // multiple → `$in` across the whole subtree. `distinct` dedupes userIds, so a
  // member in several subtree orgs is returned (and bumped) exactly once.
  const orgFilter = orgIds.length === 1
    ? toOrgId(orgIds[0])
    : { $in: orgIds.map(toOrgId) };
  const userIds = await UserOrganization
    .distinct('userId', { organizationId: orgFilter, isActive: true })
    .session(session);
  if (userIds.length === 0) return [];
  await User.updateMany(
    { _id: { $in: userIds } },
    { $inc: { claimsVersion: 1 } },
    { session },
  );
  // `distinct` returns `any[]` (mongoose's `distinct<T>` overload doesn't infer
  // ObjectId cleanly for a mixed scalar/$in filter — it widens to `unknown[]`),
  // so cast to the known `userId` element type rather than fight the typings.
  return userIds as Types.ObjectId[];
}

/**
 * Whether moving from `prev` to `next` is a tier DOWNGRADE — a strictly lower
 * rank in the developer < pro < team < enterprise order (VALID_TIERS). Pure;
 * shared by setTier + setSeatLimit's billing tier-push so the rank comparison
 * can't drift. Both arguments are `QuotaTier`: `Organization.tier` is a required,
 * enum-constrained field with a default, so every org carries a valid tier.
 *
 * LOAD-BEARING INVARIANT: the rank is `VALID_TIERS.indexOf(...)`, and
 * `VALID_TIERS = Object.keys(QUOTA_TIERS)` — so downgrade semantics derive
 * ENTIRELY from the DECLARATION ORDER of `QUOTA_TIERS`' keys (developer < pro <
 * team < enterprise). Reordering those keys silently reorders the tier ranks and
 * flips what counts as a downgrade (and thus which changes invalidate tokens).
 * Keep `QUOTA_TIERS` keys in ascending-tier order.
 */
function isTierDowngrade(prev: QuotaTier, next: QuotaTier): boolean {
  return VALID_TIERS.indexOf(next) < VALID_TIERS.indexOf(prev);
}

/**
 * Propagate account-level fields (featureEntitlements and/or the tier label)
 * from a root org onto its descendant teams inside the caller's transaction, and
 * return the FULL subtree id set (`[root, ...descendants]`).
 *
 * Both setTier and setSeatLimit change fields that pool at the account root and
 * must be mirrored onto every descendant team so a team member's token carries
 * them. The returned subtree is exactly the propagation set, so the caller bumps
 * `claimsVersion` against precisely the orgs this write touched. A root with no
 * descendants performs no `updateMany` and returns `[root]`.
 */
async function propagateToSubtree(
  rootId: string,
  propagateFields: Record<string, unknown>,
  session: ClientSession,
): Promise<string[]> {
  const scope = await expandOrgScope(rootId);
  const descendantIds = scope.filter((sid) => sid !== rootId);
  if (descendantIds.length > 0) {
    await Organization.updateMany(
      { _id: { $in: descendantIds.map(toOrgId) } },
      { $set: propagateFields },
      { session },
    );
  }
  return scope;
}

/**
 * The shared tail of an account-level change (seat/entitlement sync, tier
 * change), inside the caller's transaction:
 *   1. propagate `propagate` (featureEntitlements and/or the tier label) from
 *      `orgId` onto its descendant teams — skipped when undefined or empty;
 *   2. on an access REDUCTION (`reduction` names why: a feature removed, a tier
 *      downgrade), invalidate every active member's outstanding tokens across
 *      exactly the orgs the propagation wrote to, and log the blast radius.
 * No bump on a pure add / upgrade — a stale token then under-grants, which is
 * safe. Returns the bumped member ids for the caller to publish AFTER commit.
 */
async function applyAccountAccessChange(
  orgId: string,
  change: { propagate?: Record<string, unknown>; reduction?: string; source: string },
  session: ClientSession,
): Promise<Types.ObjectId[]> {
  const subtreeIds = change.propagate && Object.keys(change.propagate).length > 0
    ? await propagateToSubtree(orgId, change.propagate, session)
    : [orgId];
  if (!change.reduction) return [];
  const bumped = await bumpActiveMembersClaimsVersion(subtreeIds, session);
  // Security-relevant outcome: how many members were invalidated across how
  // many subtree orgs, and why — so incident review can reconstruct the blast
  // radius of an access reduction.
  logger.info(`${change.source}: invalidated active members after access reduction`, {
    bumpedMembers: bumped.length,
    subtreeOrgs: subtreeIds.length,
    reason: change.reduction,
  });
  return bumped;
}

/**
 * Set the account seat limit on the org's ROOT. Platform owns `seats` (it is
 * not a quota-service type), so billing syncs the effective seat entitlement
 * (tier base + bundles) here. `orgId` MUST be the account root: a team id is
 * refused ({@link ORG_SEAT_LIMIT_NOT_ROOT}) rather than silently redirected, so
 * a sync aimed at a team can never rewrite the whole account's entitlement.
 * Returns the root id, or null if the org is missing.
 */
export async function setSeatLimit(
  orgId: string,
  seats: number,
  features?: string[],
  tier?: QuotaTier,
): Promise<{ rootOrgId: string; seats: number; featureDelta?: FeatureDelta } | null> {
  const { rootOrgId } = await resolveOrgLineage(orgId);
  if (String(rootOrgId) !== String(orgId)) throw new Error(ORG_SEAT_LIMIT_NOT_ROOT);
  const set: Record<string, unknown> = { 'quotas.seats': seats };
  // Account-level purchased feature entitlements (bundles) also live on the
  // root and are synced by billing alongside the seat limit.
  if (features !== undefined) set.featureEntitlements = features;

  // Members whose claimsVersion was bumped by an access reduction (feature shrink
  // or tier downgrade) — published after commit (never mid-transaction).
  let bumpedMemberIds: Types.ObjectId[] = [];
  // Atomic: the root seat/entitlement write and its propagation onto descendant
  // teams must both land or neither, so a member's token can't carry a stale
  // entitlement set after a partial failure.
  const outcome = await withMongoTransaction(async (session) => {
    // Read the pre-change tier + entitlements FIRST so we can detect a REDUCTION
    // (a feature dropped, or a tier downgrade) before the $set overwrites them —
    // access reductions must invalidate the affected members' stale tokens.
    let featureShrink = false;
    // Whether the passed feature set actually DIFFERS from the current one
    // (order-independent). An idempotent re-sync of the same set need not rewrite
    // `featureEntitlements` onto every descendant team — see the propagate guard.
    let featuresChanged = false;
    let tierDowngrade = false;
    // The added/removed feature delta (order-independent), so the audit trail can
    // reconstruct WHICH entitlements a sync granted or revoked — e.g. a DORA
    // (advanced_reporting) access grant/revoke — not just the resulting set.
    // Undefined when `features` was not part of this call (no entitlement change).
    let featureDelta: FeatureDelta | undefined;
    const needsPreRead = features !== undefined || tier !== undefined;
    const current = needsPreRead
      ? await Organization.findById(toOrgId(rootOrgId))
        .select('featureEntitlements tier').session(session).lean()
      : null;

    if (features !== undefined) {
      featureDelta = computeFeatureDelta(current?.featureEntitlements ?? [], features);
      featureShrink = featureDelta.removed.length > 0;
      // Set inequality: a removal (shrink) OR an addition. A reorder of the same
      // members leaves both empty → no descendant rewrite.
      featuresChanged = featureShrink || featureDelta.added.length > 0;
    }
    // Billing pushes the account tier alongside seats/features so a plan
    // DOWNGRADE invalidates stale tokens here (the JWT re-derives tier-included
    // features from `org.tier`, so a stale tier would keep granting them).
    if (tier !== undefined && current && current.tier !== tier) {
      set.tier = tier;
      tierDowngrade = isTierDowngrade(current.tier, tier);
      // Keep `org.tier` and the org-doc `quotas` CONSISTENT for the degraded read.
      // `getQuotas`' quota-service-down fallback reports limits straight off
      // `org.quotas`; if we bumped only the tier LABEL it would surface the OLD
      // tier's non-seat limits under the NEW tier label — a persistent mismatch.
      // So reseed the org-doc's NON-SEAT quota dimensions from the new tier's base
      // (mirrors `setTier`'s reseed). This changes ONLY the degraded fallback — the
      // quota SERVICE stays authoritative for the happy path.
      //
      // `seats` is left out: `set['quotas.seats']` above already carries
      // billing's effective (tier base + bundles) seat entitlement. The other
      // dims are written via dot-notation so they don't conflict with that key.
      for (const [dim, value] of Object.entries(tierBaseQuotaSet(tier, seats))) {
        if (dim !== 'seats') set[`quotas.${dim}`] = value;
      }
    }

    const result = await Organization.updateOne(
      { _id: toOrgId(rootOrgId) },
      { $set: set },
      { session },
    );
    if (result.matchedCount === 0) return null;

    // Propagate account-level fields (featureEntitlements and/or the tier label)
    // onto descendant teams so a team member's token carries them. Only
    // propagate featureEntitlements when the set actually changed — an
    // idempotent re-sync would otherwise rewrite identical values subtree-wide.
    const propagate: Record<string, unknown> = {};
    if (features !== undefined && featuresChanged) propagate.featureEntitlements = features;
    if (set.tier !== undefined) propagate.tier = tier;
    bumpedMemberIds = await applyAccountAccessChange(rootOrgId, {
      propagate,
      reduction: featureShrink && tierDowngrade
        ? 'feature_shrink+tier_downgrade'
        : featureShrink ? 'feature_shrink' : tierDowngrade ? 'tier_downgrade' : undefined,
      source: 'setSeatLimit',
    }, session);
    return { rootOrgId, seats, featureDelta };
  });
  // Post-commit: publish the affected members' now-current access version.
  await publishUsersRevocation(bumpedMemberIds);
  return outcome;
}

/**
 * Whether changing `orgId`'s account to `newTier` would drop a COUNT quota's
 * cap below current pooled usage — mirrors the
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
  if (!tierAllowsTeams(newTier)) {
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
  // `listings` is deliberately NOT guarded: a publisher over its new plan's
  // listing limit keeps every listing listed and is only refused NEW version /
  // listing-update requests (docs/plugin-publishing.md "Plans and limits").
  const COUNT_QUOTAS = ['plugins', 'pipelines', 'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs'] as const;
  // Only the dims the NEW tier actually caps (limit !== -1) can be over-cap; a
  // field left unlimited is `continue`-skipped below and contributes nothing. So
  // pre-filter BEFORE the round-trips — an unlimited dim shouldn't cost a
  // quota-service call. Result is identical (skipped dims added no overage).
  const guardedFields = COUNT_QUOTAS.filter((field) => limits[field] !== -1);
  const auth = getServiceAuthHeader({ serviceName: 'platform', orgId: rootOrgId, role: 'owner' });
  const statuses = await Promise.all(
    guardedFields.map((field) => getOrganizationQuotaStatus(rootOrgId, field as QuotaType, auth)),
  );

  let fallbackRows: Array<{ usage?: unknown }> | null = null;
  const usageFor = async (field: string, i: number): Promise<number> => {
    const status = statuses[i];
    if (status) return status.used;
    // Service unavailable for this field: degrade to the shared org-doc sum.
    if (!fallbackRows) {
      fallbackRows = await Organization.find({ _id: { $in: scopeIds } })
        .select('usage.plugins usage.pipelines usage.dashboards usage.alertRules usage.alertDestinations usage.idpConfigs usage.listings').lean();
    }
    return fallbackRows.reduce((sum, r) => {
      const usage = r.usage as unknown as Record<string, { used?: number } | undefined> | undefined;
      return sum + (usage?.[field]?.used ?? 0);
    }, 0);
  };

  for (let i = 0; i < guardedFields.length; i++) {
    const field = guardedFields[i];
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
 * about reflecting the new limits in the quota service update it
 * through the quota service's own `PUT /quotas`. We keep the two
 * operations decoupled because partial failure of the remote quota
 * service shouldn't leave the org-doc tier unchanged.
 */
export async function setTier(id: string, newTier: QuotaTier): Promise<{ id: string; previousTier: QuotaTier; tier: QuotaTier; featuresRemoved?: string[] } | null> {
  const org = await Organization.findById(toOrgId(id));
  if (!org) return null;

  const previousTier = org.tier;
  if (previousTier === newTier) {
    return { id: org._id.toString(), previousTier, tier: newTier };
  }

  // Detect a DOWNGRADE (new tier ranks below the old) from the pre-change tier.
  // VALID_TIERS is ordered developer < pro < team < enterprise, so a lower index
  // = a lesser tier. A downgrade drops the baked-in tier + `requireFeature`-gated
  // capabilities, so members' existing JWTs must be invalidated (below). An
  // UPGRADE never bumps: a stale token then under-grants, which is safe.
  const isDowngrade = isTierDowngrade(previousTier, newTier);

  // On a downgrade, compute the tier-included features the org LOSES
  // (`TIER_FEATURES[prev] \ TIER_FEATURES[next]`) so the audit trail records
  // WHICH capabilities the transition revoked — mirroring how `setSeatLimit`
  // records its `featureDelta.removed`. Purchased add-on bundles
  // (`featureEntitlements`) are unaffected by a tier change, so only the
  // tier-baseline delta is reported here. Undefined on an upgrade/no-op.
  let featuresRemoved: string[] | undefined;
  if (isDowngrade) {
    featuresRemoved = computeFeatureDelta(TIER_FEATURES[previousTier] ?? [], TIER_FEATURES[newTier] ?? []).removed;
  }

  org.tier = newTier;
  if (org.parentOrgId) {
    // Team: tier is derived (display-only). Its quotas stay pooled (-1) so the
    // ROOT's cap is the only binding one — do NOT reseed from the preset.
  } else if (config.quota.tier[newTier]) {
    // Root: reseed its OWN quotas from the new tier, keeping purchased seat
    // capacity (see `tierBaseQuotaSet`). `featureEntitlements` is a separate
    // top-level field, so this never touches it.
    const reseeded = tierBaseQuotaSet(newTier, org.quotas?.seats);
    org.quotas = reseeded;
    org.markModified('quotas');
  }

  // Members whose claimsVersion was bumped by a downgrade — published post-commit.
  let bumpedMemberIds: Types.ObjectId[] = [];
  // Atomic: the root's tier/quota save and the tier propagation onto its
  // descendant teams must both land or neither — a failure between them would
  // otherwise leave the root on the new tier while teams keep the old.
  await withMongoTransaction(async (session) => {
    await org.save({ session });

    // A root propagates the tier label to its descendant teams (their quotas
    // stay pooled at -1); a team or flat org has nothing below it.
    bumpedMemberIds = await applyAccountAccessChange(org._id.toString(), {
      propagate: org.parentOrgId ? undefined : { tier: newTier },
      reduction: isDowngrade ? 'tier_downgrade' : undefined,
      source: 'setTier',
    }, session);
  });
  // Post-commit: publish the affected members' now-current access version so the
  // reduced tier / lost features take effect on the stateless services now.
  await publishUsersRevocation(bumpedMemberIds);

  return {
    id: org._id.toString(),
    previousTier,
    tier: newTier,
    ...(featuresRemoved && featuresRemoved.length > 0 ? { featuresRemoved } : {}),
  };
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org → team hierarchy lifecycle: the recently-deleted team list, the checks a
 * TEAM restore needs on top of the generic org restore, and reparenting
 * (`POST /organization/:id/move`).
 *
 * Everything that POOLS at the account root — tier, purchased feature
 * entitlements, the quota pool and seats — is re-derived here whenever an org
 * changes which root it belongs to, using the same seeding rules as
 * `organizationService.create`:
 *   - a TEAM carries its root's tier + `featureEntitlements` and locally
 *     unlimited (-1) quotas, so only the root's pooled cap binds;
 *   - a ROOT carries its own tier's quota preset (retention dims stripped, as
 *     `setTier` does) and its own entitlements.
 * The quota pool itself needs no copying: the quota service sums usage over the
 * root's subtree at read time, so rewriting `parentOrgId` moves the org's usage
 * with it.
 */

import { createSafeClient, DEFAULT_TIER, getServiceAuthHeader, QUOTA_TIERS, SYSTEM_ORG_ID, tierAllowsTeams } from '@pipeline-builder/api-core';
import type { ClientSession, Types } from 'mongoose';
import {
  ORG_MOVE_BILLED,
  ORG_MOVE_BILLING_UNVERIFIED,
  ORG_MOVE_CYCLE,
  ORG_MOVE_DELETED,
  ORG_MOVE_HAS_TEAMS,
  ORG_MOVE_NOOP,
  ORG_MOVE_SELF,
  ORG_MOVE_SYSTEM,
  ORG_MOVE_TARGET_NOT_FOUND,
  ORG_MOVE_TARGET_NOT_ROOT,
  ORG_MOVE_TARGET_TIER,
  ORG_NOT_FOUND,
  ORG_RESTORE_PARENT_GONE,
  ORG_RESTORE_PARENT_INELIGIBLE,
  ORG_SEAT_LIMIT,
} from './org-errors.js';
import { config } from '../config/index.js';
import { expandOrgScope, hasAnyChildOrg, isAncestorOrg } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { publishUsersRevocation } from '../helpers/session-revocation.js';
import { Invitation, Organization, User, UserOrganization } from '../models/index.js';
import type { QuotaTier } from '../models/organization.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

/** Billing-owned retention dims that never live on the org doc (see organization-quota.ts). */
/**
 * Refuse to nest a root that still holds a billable subscription: once it is a
 * team its plan pools at the new root, yet its own subscription would keep
 * charging. Fails CLOSED — an unreachable billing service blocks the move rather
 * than risk that. A billing-disabled deployment has no subscriptions to check.
 */
async function assertNoBillableSubscription(orgId: string): Promise<void> {
  if (!config.billing.enabled) return;
  const client = createSafeClient({
    host: config.billing.serviceHost,
    port: config.billing.servicePort,
    timeout: config.billing.serviceTimeout,
  });
  const resp = await client.get(`/billing/subscriptions/by-org/${encodeURIComponent(orgId)}/billable`, {
    headers: {
      'Authorization': getServiceAuthHeader({ serviceName: 'platform', orgId: SYSTEM_ORG_ID, role: 'owner' }),
      'x-org-id': orgId,
    },
  });
  if (!resp || resp.statusCode >= 400) throw new Error(ORG_MOVE_BILLING_UNVERIFIED);
  const billable = (resp.body as { data?: { billable?: boolean } } | undefined)?.data?.billable;
  if (billable === undefined) throw new Error(ORG_MOVE_BILLING_UNVERIFIED);
  if (billable) throw new Error(ORG_MOVE_BILLED);
}

const RETENTION_DIMS = ['eventRetentionDays', 'doraRetentionDays'] as const;

/** A soft-deleted team still inside its retention window. */
export interface DeletedTeam {
  orgId: string;
  orgName: string;
  deletedAt: Date;
  purgeAfter: Date;
}

/** Locally-unlimited quotas for a team (only the root's pooled cap binds). */
function teamQuotas(tier: QuotaTier): Record<string, number> {
  return Object.fromEntries(Object.keys(QUOTA_TIERS[tier].limits).map((k) => [k, -1]));
}

/** A root's own quota preset for `tier`, retention dims stripped. */
function rootQuotas(tier: QuotaTier): Record<string, number> {
  const quotas: Record<string, number> = { ...QUOTA_TIERS[tier].limits } as unknown as Record<string, number>;
  for (const dim of RETENTION_DIMS) delete quotas[dim];
  return quotas;
}

/**
 * Pooled seat usage (distinct active humans + live pending invites) across
 * `orgIds`, the same count `seatCapacityAvailable` makes for one account.
 */
async function seatUsageAcross(orgIds: string[], session?: ClientSession | null): Promise<number> {
  const ids = orgIds.map(toOrgId);
  const [memberIds, pendingEmails] = await Promise.all([
    UserOrganization.distinct('userId', { organizationId: { $in: ids }, isActive: true }).session(session ?? null),
    Invitation.distinct('email', { organizationId: { $in: ids }, status: 'pending', expiresAt: { $gt: new Date() } }).session(session ?? null),
  ]);
  return memberIds.length + pendingEmails.length;
}

/**
 * Whether `joiningOrgId` joining the account whose live subtree is `scope` puts
 * it over `seatLimit`. Refused only when the join ADDS seats past the cap: a
 * join whose people already hold seats in the account (or an account already
 * over its cap for unrelated reasons, whose count this join doesn't raise) is
 * not the join's fault.
 */
async function joiningExceedsCap(
  scope: string[],
  joiningOrgId: string,
  seatLimit: number,
  session: ClientSession,
): Promise<boolean> {
  const after = await seatUsageAcross([...scope, joiningOrgId], session);
  if (after <= seatLimit) return false;
  const before = scope.length > 0 ? await seatUsageAcross(scope, session) : 0;
  return after > before;
}

/**
 * Invalidate the sessions scoped to `orgId`: its active members, plus anyone
 * working in it on INHERITED authority (no membership row — pinned by
 * `lastActiveOrgId`). Their tokens carry the org's hierarchy / tier claims,
 * which a move or restore just changed. Returns the ids for post-commit publish.
 */
async function bumpSessionsScopedTo(orgId: string, session: ClientSession): Promise<Types.ObjectId[]> {
  const [memberIds, pinned] = await Promise.all([
    UserOrganization.distinct('userId', { organizationId: toOrgId(orgId), isActive: true }).session(session),
    User.find({ lastActiveOrgId: String(orgId) }).select('_id').session(session).lean(),
  ]);
  const byId = new Map<string, Types.ObjectId>();
  for (const id of memberIds as Types.ObjectId[]) byId.set(String(id), id);
  for (const u of pinned) byId.set(String(u._id), u._id as Types.ObjectId);
  const ids = [...byId.values()];
  if (ids.length > 0) {
    await User.updateMany({ _id: { $in: ids } }, { $inc: { tokenVersion: 1 } }, { session });
  }
  return ids;
}

class OrgHierarchyService {
  /** The direct parent of `orgId` (live or soft-deleted org), or null when the
   *  org doesn't exist. `parentOrgId` is null for a root. */
  async getTeamParent(orgId: string): Promise<{ parentOrgId: string | null } | null> {
    const org = await Organization.findById(toOrgId(orgId)).select('parentOrgId').lean();
    if (!org) return null;
    return { parentOrgId: org.parentOrgId ? String(org.parentOrgId) : null };
  }

  /**
   * Soft-deleted teams of `parentOrgId` that can still be restored (purge
   * deadline not yet passed), most recently deleted first.
   */
  async listDeletedTeams(parentOrgId: string): Promise<{ teams: DeletedTeam[] }> {
    const docs = await Organization.find({
      parentOrgId: String(parentOrgId),
      deletedAt: { $ne: null },
      purgeAfter: { $gt: new Date() },
    }).select('_id name deletedAt purgeAfter').sort({ deletedAt: -1 }).lean();
    return {
      teams: docs.map((d) => ({
        orgId: String(d._id),
        orgName: d.name,
        deletedAt: d.deletedAt as Date,
        purgeAfter: d.purgeAfter as Date,
      })),
    };
  }

  /**
   * The extra work restoring a TEAM needs (called inside the restore
   * transaction, before the tombstone is cleared):
   *   - its parent must still be live, a root, and on a tier that includes teams;
   *   - its members come back into the pooled seat count (a deleted team's
   *     members stopped counting), so the account must have room for them;
   *   - tier + entitlements are re-synced from the root — propagation skipped the
   *     team while it was deleted.
   * Returns the `$set` to apply to the team doc.
   */
  async prepareTeamRestore(teamId: string, parentOrgId: string, session: ClientSession): Promise<Record<string, unknown>> {
    const parent = await Organization.findById(toOrgId(parentOrgId))
      .select('parentOrgId tier featureEntitlements deletedAt quotas.seats').session(session).lean();
    if (!parent || parent.deletedAt) throw new Error(ORG_RESTORE_PARENT_GONE);
    if (parent.parentOrgId || !tierAllowsTeams(parent.tier as QuotaTier | undefined)) {
      throw new Error(ORG_RESTORE_PARENT_INELIGIBLE);
    }
    const seatLimit = parent.quotas?.seats ?? -1;
    if (seatLimit !== -1) {
      const scope = await expandOrgScope(parentOrgId); // live scope — excludes this team
      if (await joiningExceedsCap(scope, teamId, seatLimit, session)) throw new Error(ORG_SEAT_LIMIT);
    }
    return {
      tier: parent.tier,
      featureEntitlements: parent.featureEntitlements ?? [],
    };
  }

  /**
   * Reparent `orgId` (sysadmin). `parentOrgId`:
   *   - a root id  → the org becomes (or moves to be) a team under it;
   *   - `null`     → a team becomes a standalone root.
   *
   * Refused (typed errors, see org-errors.ts): the system org, a soft-deleted
   * org, self-parenting, a destination inside the org's own subtree (cycle), an
   * org that has teams of its own (live OR soft-deleted — nesting is one level
   * deep), a destination that is missing / soft-deleted / itself a team / on a
   * tier without teams, a no-op, and a move that would put the destination
   * account over its seat cap.
   *
   * Re-sync on success (one transaction):
   *   - becoming a TEAM: `tier` + `featureEntitlements` from the new root, quotas
   *     -1 (the root's pool binds) — exactly how team creation seeds a team;
   *   - becoming a ROOT: the default new-org tier (`DEFAULT_TIER`) — the tier it
   *     carried was the old root's PAID plan, and no subscription follows it, so
   *     keeping it would be a free paid tier. Quotas reseeded from that preset,
   *     `featureEntitlements` cleared. A sysadmin sets the tier (`PATCH /:id/tier`)
   *     or the account subscribes.
   *   - a ROOT becoming a team is refused while it holds a billable subscription
   *     (checked with billing, fail-closed) — cancel it first.
   *   - every session scoped to the org is invalidated (tokens carry the old
   *     hierarchy and tier claims; a parent admin's inherited session would
   *     otherwise outlive the authority that granted it).
   */
  async move(orgId: string, parentOrgId: string | null): Promise<{
    orgId: string;
    fromParentOrgId: string | null;
    toParentOrgId: string | null;
    tier: QuotaTier;
    membersInvalidated: number;
  }> {
    if (orgId === SYSTEM_ORG_ID || parentOrgId === SYSTEM_ORG_ID) throw new Error(ORG_MOVE_SYSTEM);
    if (parentOrgId !== null && String(parentOrgId) === String(orgId)) throw new Error(ORG_MOVE_SELF);

    const org = await Organization.findById(toOrgId(orgId))
      .select('parentOrgId tier deletedAt isSystem').lean();
    if (!org) throw new Error(ORG_NOT_FOUND);
    if ((org as { isSystem?: boolean }).isSystem) throw new Error(ORG_MOVE_SYSTEM);
    if (org.deletedAt) throw new Error(ORG_MOVE_DELETED);

    const fromParentOrgId = org.parentOrgId ? String(org.parentOrgId) : null;
    if (fromParentOrgId === (parentOrgId === null ? null : String(parentOrgId))) throw new Error(ORG_MOVE_NOOP);

    type Destination = { tier?: QuotaTier; featureEntitlements?: string[]; quotas?: { seats?: number } };
    let target: Destination | null = null;
    if (parentOrgId !== null) {
      if (await isAncestorOrg(orgId, parentOrgId)) throw new Error(ORG_MOVE_CYCLE);
      if (await hasAnyChildOrg(orgId)) throw new Error(ORG_MOVE_HAS_TEAMS);
      // A root being nested: its own subscription must be gone first. (A team
      // moving between roots never held one — billing lives at the root.)
      if (!fromParentOrgId) await assertNoBillableSubscription(orgId);
      const dest = await Organization.findById(toOrgId(parentOrgId))
        .select('parentOrgId tier featureEntitlements deletedAt isSystem quotas.seats').lean();
      if (!dest || dest.deletedAt) throw new Error(ORG_MOVE_TARGET_NOT_FOUND);
      if ((dest as { isSystem?: boolean }).isSystem) throw new Error(ORG_MOVE_SYSTEM);
      if (dest.parentOrgId) throw new Error(ORG_MOVE_TARGET_NOT_ROOT);
      if (!tierAllowsTeams(dest.tier as QuotaTier | undefined)) throw new Error(ORG_MOVE_TARGET_TIER);
      target = dest as Destination;
    }

    const tier: QuotaTier = parentOrgId !== null ? (target!.tier as QuotaTier) : DEFAULT_TIER;
    const set: Record<string, unknown> = parentOrgId !== null
      ? {
        parentOrgId: String(parentOrgId),
        tier,
        featureEntitlements: target!.featureEntitlements ?? [],
        quotas: teamQuotas(tier),
      }
      : {
        parentOrgId: null,
        tier,
        featureEntitlements: [],
        quotas: rootQuotas(tier),
      };

    let bumped: Types.ObjectId[] = [];
    await withMongoTransaction(async (session) => {
      // Seats pool at the destination root: its live subtree plus the arriving
      // org. For a new standalone root, just the org against its own preset.
      const seatLimit = parentOrgId !== null
        ? (target!.quotas?.seats ?? -1)
        : ((set.quotas as Record<string, number>).seats ?? -1);
      if (seatLimit !== -1) {
        const scope = parentOrgId !== null ? await expandOrgScope(parentOrgId) : [];
        if (await joiningExceedsCap(scope, orgId, seatLimit, session)) throw new Error(ORG_SEAT_LIMIT);
      }
      await Organization.updateOne({ _id: toOrgId(orgId) }, { $set: set }, { session });
      bumped = await bumpSessionsScopedTo(orgId, session);
    });
    await publishUsersRevocation(bumped);

    return {
      orgId: String(orgId),
      fromParentOrgId,
      toParentOrgId: parentOrgId === null ? null : String(parentOrgId),
      tier,
      membersInvalidated: bumped.length,
    };
  }
}

export const orgHierarchyService = new OrgHierarchyService();

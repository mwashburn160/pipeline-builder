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

import {
  createSafeClient,
  DEFAULT_TIER,
  expandOrgScopeWith,
  getServiceAuthHeader,
  isAncestorOrgWith,
  QUOTA_TIERS,
  SYSTEM_ORG_ID,
  tierAllowsTeams,
  toOrgIdString,
} from '@pipeline-builder/api-core';
import type { ClientSession, Types } from 'mongoose';
import {
  ORG_MOVE_BILLED,
  ORG_MOVE_BILLING_UNVERIFIED,
  ORG_MOVE_CONFLICT,
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
import { expandOrgScope } from '../helpers/org-hierarchy.js';
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

// ---------------------------------------------------------------------------
// Session-scoped hierarchy walks
// ---------------------------------------------------------------------------
//
// `helpers/org-hierarchy.ts` reads OUTSIDE any transaction, which is right for
// the read paths but wrong for `move`: a check that ran before the transaction
// (or on an unsessioned connection inside one) sees a snapshot another
// concurrent move can invalidate before this one commits. These are the same
// api-core walks (cycle-safe, depth-capped) bound to the move's own session, so
// every structural assertion and the write itself observe ONE snapshot.

/** `parentOrgId` of `orgId`, read inside `session`. */
function sessionParentOrgId(session: ClientSession) {
  return async (orgId: string): Promise<string | undefined> => {
    const org = await Organization.findById(toOrgId(orgId)).select('parentOrgId').session(session).lean();
    return toOrgIdString(org?.parentOrgId);
  };
}

/** True when `ancestorOrgId` is an ancestor of `candidateOrgId`, inside `session`. */
function isAncestorOrgInSession(ancestorOrgId: string, candidateOrgId: string, session: ClientSession): Promise<boolean> {
  return isAncestorOrgWith(ancestorOrgId, candidateOrgId, sessionParentOrgId(session));
}

/** ANY org — live or soft-deleted — naming `orgId` as its parent, inside `session`. */
async function hasAnyChildOrgInSession(orgId: string, session: ClientSession): Promise<boolean> {
  return !!(await Organization.exists({ parentOrgId: String(orgId) }).session(session));
}

/** `[self, ...live descendants]`, inside `session`. */
function expandOrgScopeInSession(orgId: string, session: ClientSession): Promise<string[]> {
  return expandOrgScopeWith(orgId, async (frontier) => {
    const children = await Organization.find({ parentOrgId: { $in: frontier }, deletedAt: null })
      .select('_id').session(session).lean();
    return children.map((c) => toOrgIdString(c._id)).filter((id): id is string => !!id);
  });
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
    if (parent.parentOrgId || !tierAllowsTeams(parent.tier)) {
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
   *
   * CONCURRENCY: every structural check is re-asserted INSIDE the transaction
   * (on the session), and the write is a compare-and-set on the `parentOrgId`
   * this request read — so of two interleaved moves exactly one commits and the
   * other raises `ORG_MOVE_CONFLICT` having written nothing. The pre-flight read
   * below is only there to shape the request (no-op detection, and the one
   * check that must stay outside a transaction: billing's HTTP call).
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

    // `tier` is required: `Organization.tier` is an enum field with a default,
    // so a destination row always carries one.
    type Destination = { tier: QuotaTier; featureEntitlements?: string[]; quotas?: { seats?: number } };

    // The ONLY check that cannot move inside the transaction: it is a remote
    // HTTP call, and holding a Mongo transaction open across a network timeout
    // is worse than the (bounded) staleness. The conditional write below still
    // makes it safe — the move only lands if the org is still the ROOT this
    // check was made for, so a concurrent move can't smuggle a billed root in.
    if (parentOrgId !== null && !fromParentOrgId) await assertNoBillableSubscription(orgId);

    let bumped: Types.ObjectId[] = [];
    const tier = await withMongoTransaction(async (session) => {
      // Re-assert EVERY structural precondition inside the session. Read
      // outside it, two concurrent sysadmin moves each saw a tree the other was
      // about to change — enough to nest a root under its own descendant
      // (a parent cycle), which silently corrupts pooled quota, seats and
      // tier/entitlement propagation for both accounts.
      const current = await Organization.findById(toOrgId(orgId))
        .select('parentOrgId deletedAt isSystem').session(session).lean();
      if (!current) throw new Error(ORG_NOT_FOUND);
      if ((current as { isSystem?: boolean }).isSystem) throw new Error(ORG_MOVE_SYSTEM);
      if (current.deletedAt) throw new Error(ORG_MOVE_DELETED);
      const currentParent = current.parentOrgId ? String(current.parentOrgId) : null;
      if (currentParent !== fromParentOrgId) throw new Error(ORG_MOVE_CONFLICT);

      let target: Destination | null = null;
      if (parentOrgId !== null) {
        if (await isAncestorOrgInSession(orgId, parentOrgId, session)) throw new Error(ORG_MOVE_CYCLE);
        if (await hasAnyChildOrgInSession(orgId, session)) throw new Error(ORG_MOVE_HAS_TEAMS);
        const dest = await Organization.findById(toOrgId(parentOrgId))
          .select('parentOrgId tier featureEntitlements deletedAt isSystem quotas.seats').session(session).lean();
        if (!dest || dest.deletedAt) throw new Error(ORG_MOVE_TARGET_NOT_FOUND);
        if ((dest as { isSystem?: boolean }).isSystem) throw new Error(ORG_MOVE_SYSTEM);
        if (dest.parentOrgId) throw new Error(ORG_MOVE_TARGET_NOT_ROOT);
        if (!tierAllowsTeams(dest.tier)) throw new Error(ORG_MOVE_TARGET_TIER);
        target = dest as Destination;
      }

      const newTier: QuotaTier = parentOrgId !== null ? target!.tier : DEFAULT_TIER;
      const set: Record<string, unknown> = parentOrgId !== null
        ? {
          parentOrgId: String(parentOrgId),
          tier: newTier,
          featureEntitlements: target!.featureEntitlements ?? [],
          quotas: teamQuotas(newTier),
        }
        : {
          parentOrgId: null,
          tier: newTier,
          featureEntitlements: [],
          quotas: rootQuotas(newTier),
        };

      // Seats pool at the destination root: its live subtree plus the arriving
      // org. For a new standalone root, just the org against its own preset.
      const seatLimit = parentOrgId !== null
        ? (target!.quotas?.seats ?? -1)
        : ((set.quotas as Record<string, number>).seats ?? -1);
      if (seatLimit !== -1) {
        const scope = parentOrgId !== null ? await expandOrgScopeInSession(parentOrgId, session) : [];
        if (await joiningExceedsCap(scope, orgId, seatLimit, session)) throw new Error(ORG_SEAT_LIMIT);
      }

      // COMPARE-AND-SET on the parent this request validated against. `null`
      // matches an absent field too, so a root is matched by `parentOrgId: null`.
      // A racing move that committed first leaves this matching nothing, and the
      // loser aborts having written nothing at all.
      const res = await Organization.updateOne(
        { _id: toOrgId(orgId), parentOrgId: fromParentOrgId },
        { $set: set },
        { session },
      );
      if (res.matchedCount === 0) throw new Error(ORG_MOVE_CONFLICT);

      bumped = await bumpSessionsScopedTo(orgId, session);
      return newTier;
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

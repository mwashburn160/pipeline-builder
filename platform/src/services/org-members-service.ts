// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, parsePage } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { revokePendingInvitationsSentBy, type RevokedInvitation } from './inviter-exit.js';
import { OM_ORG_NOT_FOUND, OM_USER_NOT_FOUND, OM_ALREADY_MEMBER, OM_NOT_A_MEMBER, OM_CANNOT_REMOVE_OWNER, OM_OWNER_MEMBERSHIP_NOT_FOUND, OM_NEW_OWNER_MUST_BE_MEMBER, OM_ALREADY_OWNER, OM_MEMBERSHIP_NOT_FOUND, OM_ALREADY_INACTIVE, OM_ALREADY_ACTIVE, OM_TARGETS_OUT_OF_SCOPE, OM_SEAT_LIMIT } from './org-members-errors.js';
import type { RoleAssignmentActor } from './role-authority.js';
import { assertActorMayStripMemberRoles, assertActorMayWieldMemberRoles } from './role-crud.js';
import { assertActorMayAssignBuiltinAdmin, assignBuiltinAdminRole, ensureBaselineRole, recomputeUserOrgRole } from './roles-service.js';
import { isAdminOrgRole, type OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import { assertDirectAddConsented } from '../helpers/account-membership.js';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { withSeatGuard } from '../helpers/seats.js';
import { publishUserRevocation, publishUsersRevocation } from '../helpers/session-revocation.js';
import { orgFeatureOverridesPath } from '../helpers/user-response.js';
import { Organization, RoleAssignment, User, UserOrganization } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { escapeRegex } from '../utils/regex.js';

const logger = createLogger('org-members-service');

/** Default member-roster page size when the caller omits a limit. */
const MEMBER_LIST_DEFAULT_LIMIT = 25;
/** Hard cap on a single member-roster page (bounds a hostile ?limit). */
const MEMBER_LIST_MAX_LIMIT = 200;
/** Longest roster search term honoured; the rest is ignored. Usernames and
 *  emails are far shorter, so this only ever trims a hostile input. */
const MEMBER_SEARCH_MAX_LENGTH = 100;
/** Server-side time budget for the joined (search / user-field sort) roster
 *  read, so one pathological query can't hold a connection indefinitely. */
const MEMBER_SEARCH_MAX_TIME_MS = 5_000;

/**
 * Whitelist of member-roster sort keys → the field they order by and which
 * collection that field lives on. Anything NOT in this map is rejected (the
 * roster falls back to its default join-time order) so a hostile `?sortBy`
 * can't order by an arbitrary — or non-indexed — field.
 *
 * `role`/`status`/`joinedAt` are UserOrganization-native, so they sort the
 * membership query directly. `username`/`email` live on the joined User doc,
 * and `find().populate()` cannot order by a populated field — those (and any
 * search) run as one aggregation that starts from the org's memberships and
 * `$lookup`s each one's user, so the cost is bounded by the org's size.
 */
const MEMBER_SORT_FIELDS: Record<string, { field: string; on: 'membership' | 'user' }> = {
  joinedAt: { field: 'joinedAt', on: 'membership' },
  role: { field: 'role', on: 'membership' },
  status: { field: 'isActive', on: 'membership' },
  username: { field: 'username', on: 'user' },
  email: { field: 'email', on: 'user' },
};

/** One descendant team annotated with the target member's membership state. */
export interface MemberTeam {
  orgId: string;
  orgName: string;
  /** Present when the team is nested (always set for a descendant). */
  parentOrgId?: string;
  /** True when the member already belongs to this team. */
  isMember: boolean;
  /** The member's role on the team, when a member. */
  role?: string;
  /** The membership's active flag, when a member. */
  isActive?: boolean;
}

/** Outcome of a single team in a bulk-add operation. `seat_limit` = the team
 *  was at its seat cap and the member was NOT added (non-fatal; other teams
 *  still process). */
export interface BulkAddResult {
  orgId: string;
  status: 'added' | 'already_member' | 'seat_limit';
}

/** A descendant team of a context org (roster, no per-member annotation). */
export interface TeamSummary {
  orgId: string;
  orgName: string;
  parentOrgId?: string;
}

interface MemberSummary {
  id: string;
  username: string;
  email: string;
  role: string;
  isEmailVerified: boolean;
  /** Membership active flag — powers the Active/Inactive status badge and the
   *  deactivate/reactivate toggle. */
  isActive: boolean;
  isOwner: boolean;
  joinedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  /** The permission Roles this member holds in the org (id + name), so the UI
   *  renders role chips WITHOUT an O(members×roles) client-side scan. */
  roles: Array<{ id: string; name: string }>;
}

interface OrgMembersPage {
  organizationId: string;
  organizationName: string;
  ownerId?: string;
  members: MemberSummary[];
  /** Total memberships matching the (search/role) filter — the full count so
   *  the client can page; `members` is only the requested window. */
  total: number;
  offset: number;
  limit: number;
}

class OrgMembersService {
  /**
   * A bounded, filterable page of an org's members (joining UserOrganization +
   * User), each annotated with the permission Roles it holds. Returns null if
   * the org doesn't exist. Skips memberships whose user record was deleted out
   * from under them.
   *
   * `search` matches a literal substring of username/email (case-insensitive,
   * regex-escaped, capped at {@link MEMBER_SEARCH_MAX_LENGTH}); `role` narrows to a
   * coarse membership role; `isActive` narrows to active/inactive memberships.
   * All are applied at the DB level (never in memory), and `total` reflects the
   * full filtered count so the client can page.
   *
   * `sortBy`/`sortOrder` order the roster server-side, restricted to the
   * {@link MEMBER_SORT_FIELDS} whitelist (an unknown field falls back to the
   * default join-time order). By default the roster is sorted by join time for
   * a stable window across pages.
   */
  async listMembers(
    orgId: string,
    opts: {
      limit?: number;
      offset?: number;
      search?: string;
      role?: OrgRole;
      isActive?: boolean;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    } = {},
  ): Promise<OrgMembersPage | null> {
    const org = await Organization.findById(toOrgId(orgId))
      .select('name owner')
      .lean();
    if (!org) return null;

    const { limit, offset } = parsePage(opts as Record<string, unknown>, {
      def: MEMBER_LIST_DEFAULT_LIMIT,
      max: MEMBER_LIST_MAX_LIMIT,
    });

    const filter: Record<string, unknown> = { organizationId: toOrgId(orgId) };
    if (opts.role) filter.role = opts.role;
    if (opts.isActive !== undefined) filter.isActive = opts.isActive;

    // Resolve the requested sort against the whitelist; an unrecognized key is
    // ignored so a hostile ?sortBy silently falls back to the default order.
    // OWN keys only: a bare index would resolve `constructor` / `__proto__` /
    // `toString` through Object.prototype to a truthy non-spec value.
    const sortSpec = opts.sortBy && Object.hasOwn(MEMBER_SORT_FIELDS, opts.sortBy)
      ? MEMBER_SORT_FIELDS[opts.sortBy]
      : undefined;
    const sortDir = opts.sortOrder === 'desc' ? -1 : 1;
    // Escaped (a literal substring, never a pattern) and length-capped, so a
    // hostile ?search can neither change the match semantics nor feed the regex
    // engine an unbounded string.
    const search = opts.search?.trim().slice(0, MEMBER_SEARCH_MAX_LENGTH) ?? '';

    type PopulatedUser = {
      _id: mongoose.Types.ObjectId;
      username: string;
      email: string;
      isEmailVerified: boolean;
      createdAt?: Date;
      updatedAt?: Date;
    };
    type PageMembership = { userId: PopulatedUser; role: string; isActive: boolean; joinedAt?: Date };

    let present: PageMembership[];
    let total: number;

    if (search || sortSpec?.on === 'user') {
      // The filter or the order needs the joined User doc, which
      // find().populate() can neither filter nor sort by. One aggregation that
      // STARTS from this org's memberships (index on organizationId) and joins
      // each to its user by _id — so the work is bounded by the org's size,
      // never by the whole `users` collection — then filters, orders and pages
      // in the database. `$unwind` drops memberships whose user was deleted.
      const rx = search ? new RegExp(escapeRegex(search), 'i') : undefined;
      const userSort: Record<string, 1 | -1> = sortSpec?.on === 'user'
        ? { [`user.${sortSpec.field}`]: sortDir, _id: 1 }
        : sortSpec
          ? { [sortSpec.field]: sortDir, _id: 1 }
          : { joinedAt: 1, _id: 1 };
      type FacetRow = {
        page: Array<{ user: PopulatedUser; role: string; isActive: boolean; joinedAt?: Date }>;
        total: Array<{ n: number }>;
      };
      const [facet] = await UserOrganization.aggregate<FacetRow>([
        { $match: filter },
        { $project: { userId: 1, role: 1, isActive: 1, joinedAt: 1 } },
        {
          $lookup: {
            from: User.collection.name,
            localField: 'userId',
            foreignField: '_id',
            as: 'user',
            pipeline: [
              ...(rx ? [{ $match: { $or: [{ username: rx }, { email: rx }] } }] : []),
              { $project: { username: 1, email: 1, isEmailVerified: 1, createdAt: 1, updatedAt: 1 } },
            ],
          },
        },
        { $unwind: '$user' },
        { $sort: userSort },
        {
          $facet: {
            page: [{ $skip: offset }, { $limit: limit }],
            total: [{ $count: 'n' }],
          },
        },
      ]).option({ maxTimeMS: MEMBER_SEARCH_MAX_TIME_MS });
      total = facet?.total[0]?.n ?? 0;
      present = (facet?.page ?? []).map((r) => ({
        userId: r.user, role: r.role, isActive: r.isActive, joinedAt: r.joinedAt,
      }));
    } else {
      const membershipSort: Record<string, 1 | -1> = sortSpec
        ? { [sortSpec.field]: sortDir, _id: 1 }
        : { joinedAt: 1, _id: 1 };
      const [memberships, count] = await Promise.all([
        UserOrganization.find(filter)
          .populate<{ userId: PopulatedUser }>({ path: 'userId', select: '_id username email isEmailVerified createdAt updatedAt' })
          .sort(membershipSort)
          .skip(offset)
          .limit(limit)
          .lean(),
        UserOrganization.countDocuments(filter),
      ]);
      present = memberships.filter((m) => m.userId);
      total = count;
    }

    // Per-member assigned Role names — one query for the whole page, grouped by
    // user, so the client renders role chips without an O(members×roles) scan.
    const pageUserIds = present.map(m => m.userId._id);
    const rolesByUser = new Map<string, Array<{ id: string; name: string }>>();
    if (pageUserIds.length > 0) {
      const assignments = await RoleAssignment.find({
        organizationId: toOrgId(orgId), userId: { $in: pageUserIds },
      })
        .populate<{ roleId: { _id: mongoose.Types.ObjectId; name: string } | null }>(
          { path: 'roleId', select: '_id name' },
        )
        .lean();
      for (const a of assignments) {
        if (!a.roleId) continue;
        const uid = String(a.userId);
        const list = rolesByUser.get(uid) ?? [];
        list.push({ id: String(a.roleId._id), name: a.roleId.name });
        rolesByUser.set(uid, list);
      }
    }

    const members = present.map(m => {
      const uid = m.userId._id.toString();
      return {
        id: uid,
        username: m.userId.username,
        email: m.userId.email,
        role: m.role,
        isEmailVerified: m.userId.isEmailVerified,
        isActive: m.isActive,
        isOwner: m.role === 'owner',
        joinedAt: m.joinedAt,
        createdAt: m.userId.createdAt,
        updatedAt: m.userId.updatedAt,
        roles: (rolesByUser.get(uid) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      };
    });

    return {
      organizationId: orgId,
      organizationName: org.name,
      ownerId: org.owner?.toString(),
      members,
      total,
      offset,
      limit,
    };
  }

  /**
   * True iff `userId` holds an ACTIVE membership in `orgId`. Used by the message
   * service (over HTTP) to reject a per-user DM addressed to someone who isn't a
   * member of the recipient org — otherwise the message black-holes (nobody in
   * that org is scoped to see it). A malformed user id (not a valid ObjectId)
   * yields false rather than throwing a CastError.
   */
  async isActiveMember(orgId: string, userId: string): Promise<boolean> {
    try {
      const hit = await UserOrganization.exists({
        userId, organizationId: toOrgId(orgId), isActive: true,
      });
      return !!hit;
    } catch {
      // Cast error on a non-ObjectId userId (or a transient query error) → treat
      // as "not a member"; the caller decides its fail-open/closed policy.
      return false;
    }
  }

  /**
   * Add a member by user-id or email. Defaults role to 'member'. Wraps
   * the existence + duplicate checks + insert in a single transaction.
   * Throws OM_ORG_NOT_FOUND / OM_USER_NOT_FOUND / OM_ALREADY_MEMBER.
   */
  async addMember(
    orgId: string,
    body: { userId?: string; email?: string; role?: OrgRole },
    actor: RoleAssignmentActor,
  ): Promise<void> {
    const notice = await withMongoTransaction(async (session) => {
      const org = await Organization.findById(toOrgId(orgId)).session(session);
      // A soft-deleted (tombstoned) org or team is gone to every product
      // surface — a membership written into it would hold a seat nobody can use.
      if (!org || org.deletedAt) throw new Error(OM_ORG_NOT_FOUND);
      // Adding someone AS AN ADMIN grants the built-in Admin Role: the same
      // assignment ceiling as granting it through the Roles API, so a
      // `members:manage` delegate can't mint admins (themselves included).
      if ((body.role ?? 'member') !== 'member') await assertActorMayAssignBuiltinAdmin(toOrgId(orgId), actor, session);

      const user = body.userId
        ? await User.findById(body.userId).session(session)
        : await User.findOne({ email: body.email!.toLowerCase() }).session(session);
      if (!user) throw new Error(OM_USER_NOT_FOUND);

      const existing = await UserOrganization.findOne({
        userId: user._id, organizationId: toOrgId(orgId),
      }).session(session);
      if (existing) throw new Error(OM_ALREADY_MEMBER);

      // CONSENT: a direct add has nothing for the person to accept, so it is
      // only allowed for someone already in this account, or at an address
      // whose domain the account has verified (the SCIM / SSO authority rule).
      // Anyone else is invited instead (OM_CONSENT_REQUIRED) — otherwise any
      // admin could staple a membership onto any account on the platform.
      await assertDirectAddConsented({ user, orgId, actor, session });

      // Seat-cap enforcement — pooled at the account root (same cap the invite
      // path enforces); a direct add must not bypass it. A user who already holds
      // a seat elsewhere in the account consumes no new seat.
      await withSeatGuard({ userId: user._id, orgId, session, errorCode: OM_SEAT_LIMIT }, async () => {
        const addedRole = body.role || 'member';
        await UserOrganization.create(
          [{ userId: user._id, organizationId: toOrgId(orgId), role: addedRole }],
          { session },
        );

        // Single-source RBAC: give EVERY membership the built-in Member Role floor
        // so they resolve to the member bundle (they'd hold zero permissions
        // otherwise). An admin/owner add ALSO gets the built-in Admin Role so their
        // effective PERMISSIONS match the coarse role — setting `role='admin'` alone
        // yields coarse-admin/zero-perms and is reverted by the next recompute. We
        // assign Roles and let recomputeUserOrgRole DERIVE the cached role (mirrors
        // user-admin-service.createUser).
        await ensureBaselineRole(user._id, toOrgId(orgId), session);
        if (isAdminOrgRole(addedRole)) {
          await assignBuiltinAdminRole(user._id, toOrgId(orgId), session);
          await recomputeUserOrgRole(user._id, toOrgId(orgId), session);
        }
      });

      // Carry what the notice needs OUT of the transaction; sending in here
      // would be a non-idempotent side effect inside a retryable body — the
      // same reason the invite path sends after commit.
      // `RoleAssignmentActor` carries authority (isSuperAdmin / isOrgAdmin /
      // permissions), not an identity, so the adder is described by role rather
      // than named. The audit record has the actor id if anyone needs it, and
      // threading one through this signature only to decorate an email is not
      // worth the surface.
      return {
        email: user.email,
        recipientName: user.username,
        addedByName: 'An administrator',
        organizationName: org.name,
        role: body.role || 'member',
      };
    });

    // A direct add grants access to another tenant with NOTHING to accept, so
    // the person gaining it is told; the invite path already tells them and
    // this one said nothing at all. Best-effort: the membership is committed,
    // and a mail failure must neither fail the request nor undo it.
    try {
      // Imported ON DEMAND, like `bootstrap-admin` does with the model graph:
      // a static import pulls `utils/email` -> `config` into this service's
      // graph, and config THROWS without SECRET_ENCRYPTION_KEY. That turned
      // seven member-service suites — which deliberately keep this graph
      // narrow — into load failures, for a notice none of them exercise.
      const { emailService } = await import('../utils/email.js');
      await emailService.sendAddedToOrganization(
        notice.email, notice.recipientName, notice.addedByName, notice.organizationName, notice.role,
      );
    } catch (err) {
      logger.warn('Member added, but the notification email failed', { orgId, error: errorMessage(err) });
    }
  }

  /**
   * List every descendant team of `contextOrgId` (org → team hierarchy), sorted
   * by name. The context org itself is excluded. Returns `[]` for a flat org
   * with no teams. Roster used by the "add to teams" picker (no member context).
   */
  async listTeams(contextOrgId: string): Promise<{ teams: TeamSummary[] }> {
    const subtree = await expandOrgScope(contextOrgId); // includes contextOrgId
    const teamIds = subtree.filter((id) => id !== contextOrgId);
    if (teamIds.length === 0) return { teams: [] };

    // `expandOrgScope` is already the live scope; the filter here keeps the
    // roster honest against a team deleted between the two reads.
    const orgs = await Organization.find({ _id: { $in: teamIds.map(toOrgId) }, deletedAt: null })
      .select('_id name parentOrgId').lean();
    const teams: TeamSummary[] = orgs.map((o) => {
      const parent = o.parentOrgId;
      return { orgId: String(o._id), orgName: o.name, ...(parent ? { parentOrgId: String(parent) } : {}) };
    });
    teams.sort((a, b) => a.orgName.localeCompare(b.orgName));
    return { teams };
  }

  /**
   * The {@link listTeams} roster, each entry annotated with whether `memberId`
   * belongs to it (and their role/active state). Powers the admin "manage teams"
   * view. Returns `[]` for a flat org with no teams.
   */
  async listMemberTeams(contextOrgId: string, memberId: string): Promise<{ teams: MemberTeam[] }> {
    const { teams: roster } = await this.listTeams(contextOrgId);
    if (roster.length === 0) return { teams: [] };

    const memberships = await UserOrganization.find({
      userId: memberId, organizationId: { $in: roster.map((t) => toOrgId(t.orgId)) },
    }).select('organizationId role isActive').lean();
    const byOrg = new Map(memberships.map((m) => [String(m.organizationId), m]));

    const teams: MemberTeam[] = roster.map((t) => {
      const m = byOrg.get(t.orgId);
      return { ...t, isMember: !!m, ...(m ? { role: m.role, isActive: m.isActive } : {}) };
    });
    return { teams };
  }

  /**
   * Add a single user (by id or email) to multiple teams in one transaction.
   * Every target must lie within `contextOrgId`'s subtree — the controller has
   * already verified the actor administers `contextOrgId`, and a parent admin
   * inherits admin over descendants, so subtree membership is the authorization
   * boundary. Idempotent per team: an existing membership is reported
   * `already_member` rather than erroring, so re-saving the manage-teams modal
   * is safe. Throws OM_USER_NOT_FOUND / OM_TARGETS_OUT_OF_SCOPE.
   */
  async bulkAddMemberToTeams(
    contextOrgId: string,
    body: { userId?: string; email?: string; orgIds: string[]; role?: OrgRole },
    actor: RoleAssignmentActor,
  ): Promise<{ results: BulkAddResult[] }> {
    const subtree = await expandOrgScope(contextOrgId);
    const subtreeSet = new Set(subtree);
    const outOfScope = body.orgIds.filter((id) => !subtreeSet.has(id));
    if (outOfScope.length > 0) throw new Error(OM_TARGETS_OUT_OF_SCOPE);

    return withMongoTransaction(async (session) => {
      const user = body.userId
        ? await User.findById(body.userId).session(session)
        : await User.findOne({ email: body.email!.toLowerCase() }).session(session);
      if (!user) throw new Error(OM_USER_NOT_FOUND);

      // CONSENT, as in addMember: every target lies in `contextOrgId`'s account,
      // so one check against it covers them all — before any write.
      await assertDirectAddConsented({ user, orgId: contextOrgId, actor, session });

      // Seats pool at the account ROOT and count DISTINCT humans, so adding
      // this one user to N teams consumes at most ONE seat — one guard around
      // all the inserts.
      const results = await withSeatGuard({ userId: user._id, orgId: contextOrgId, session, errorCode: OM_SEAT_LIMIT }, async () => {
        const addedRole = body.role || 'member';
        // An admin add is an Admin-Role GRANT in each team — checked per team,
        // through the same ceiling as addMember.
        if (addedRole !== 'member') {
          for (const orgId of body.orgIds) await assertActorMayAssignBuiltinAdmin(toOrgId(orgId), actor, session);
        }
        const outcomes: BulkAddResult[] = [];
        for (const orgId of body.orgIds) {
          const existing = await UserOrganization.findOne({
            userId: user._id, organizationId: toOrgId(orgId),
          }).session(session);
          if (existing) {
            outcomes.push({ orgId, status: 'already_member' });
            continue;
          }
          await UserOrganization.create(
            [{ userId: user._id, organizationId: toOrgId(orgId), role: addedRole }],
            { session },
          );
          // Single-source RBAC: EVERY membership gets the built-in Member Role
          // floor; an admin add ALSO gets the built-in Admin Role, and the cached
          // coarse role is DERIVED from the Roles (exactly as addMember does) —
          // `role: 'admin'` alone would be coarse-admin with zero permissions and
          // reverted by the next recompute.
          await ensureBaselineRole(user._id, toOrgId(orgId), session);
          if (isAdminOrgRole(addedRole)) {
            await assignBuiltinAdminRole(user._id, toOrgId(orgId), session);
            await recomputeUserOrgRole(user._id, toOrgId(orgId), session);
          }
          outcomes.push({ orgId, status: 'added' });
        }
        return outcomes;
      });
      return { results };
    });
  }

  /**
   * Remove a member from an org. Refuses if the target is the org owner
   * (transfer first). Also clears `User.lastActiveOrgId` if it pointed at
   * this org so the next login picks a different default.
   *
   * Removing someone deletes every Role they hold here, so `actor` must be
   * allowed to take each one away — the same guards `removeUserFromRole`
   * runs (superadmin-only Roles, the permission ceiling, never emptying a
   * privileged Role); see `assertActorMayStripMemberRoles`.
   *
   * Ends access to THIS org only ({@link endOrgAccess}): a claims bump, so every
   * outstanding access token is stale on the next request, while the person's
   * sessions — which span every org they belong to — survive. One org's admin
   * has no say over the person's other orgs.
   */
  async removeMember(orgId: string, userId: string, actor: RoleAssignmentActor): Promise<MemberExitResult> {
    let revokedInvitations: RevokedInvitation[] = [];
    await withMongoTransaction(async (session) => {
      const membership = await UserOrganization.findOne({
        userId, organizationId: toOrgId(orgId),
      }).session(session);
      if (!membership) throw new Error(OM_NOT_A_MEMBER);
      if (membership.role === 'owner') throw new Error(OM_CANNOT_REMOVE_OWNER);

      const { heldSuperadmin } = await assertActorMayStripMemberRoles(orgId, userId, actor, session);

      await UserOrganization.deleteOne({ _id: membership._id }).session(session);
      // Delete this org's RoleAssignment rows for the user in the SAME tx as the
      // membership removal. Otherwise the assignments (e.g. a built-in Admin grant)
      // are orphaned: re-adding the user later runs recomputeUserOrgRole, which
      // reads ALL assignments for the org and silently re-derives the former admin
      // role — a privilege resurrection. Orphans also inflate role member counts,
      // defeating the last-privileged-member guard. Mirrors the user-delete /
      // org-purge paths, which already clean assignments.
      await RoleAssignment.deleteMany({ userId, organizationId: toOrgId(orgId) }, { session });
      // This org's feature overrides go with the membership, in the same tx:
      // left behind, a stale grant silently re-applies if the person rejoins.
      await User.updateOne({ _id: userId }, { $unset: { [orgFeatureOverridesPath(orgId)]: '' } }, { session });
      // A superadmin-granting assignment just went with them: re-derive the
      // platform flag (recompute only touches it in an org that defines a
      // superadmin Role — the system org), exactly as removeUserFromRole does.
      if (heldSuperadmin) await recomputeUserOrgRole(userId, toOrgId(orgId), session);
      await endOrgAccess(userId, orgId, session);
      // Reassigned per attempt: a retried body re-reads the (rolled-back) rows.
      revokedInvitations = await revokePendingInvitationsSentBy(userId, orgId, session);
    });
    // Post-commit: publish the removed user's now-current access version.
    await publishUserRevocation(userId);
    return { revokedInvitations };
  }

  /**
   * Atomically swap ownership: demote current owner to admin, promote
   * new owner from member/admin to owner, update Organization.owner.
   * Caller is responsible for verifying the actor (owner or sysadmin).
   *
   * Bumps BOTH users' `claimsVersion` in the same transaction. The membership
   * `role` is baked into each user's JWT at issue time, so without this the
   * demoted ex-owner would keep an owner-role token (~15 min) and the new owner's
   * elevation wouldn't take effect until their token refreshed. The bump makes
   * `requireAuth` reject both users' outstanding ACCESS tokens; their sessions
   * stay valid, so the next refresh reissues them with the swapped role.
   */
  async transferOwnership(orgId: string, newOwnerId: string): Promise<void> {
    let oldOwnerId: string | undefined;
    await withMongoTransaction(async (session) => {
      const org = await Organization.findById(toOrgId(orgId)).session(session);
      // A soft-deleted org is gone for every member-facing write: ownership of
      // one cannot be handed on during its retention window.
      if (!org || (org as { deletedAt?: Date | null }).deletedAt) throw new Error(OM_ORG_NOT_FOUND);

      const oldOwnerMembership = await UserOrganization.findOne({
        organizationId: toOrgId(orgId), role: 'owner',
      }).session(session);
      if (!oldOwnerMembership) throw new Error(OM_OWNER_MEMBERSHIP_NOT_FOUND);
      // Self-transfer: the two lookups would hydrate the SAME row twice, so the
      // demotion below saves and the promotion is a no-op write — the owner ends
      // up an 'admin' membership while `org.owner` still names them.
      if (String(oldOwnerMembership.userId) === newOwnerId) throw new Error(OM_ALREADY_OWNER);

      // ACTIVE members only: a deactivated member can't sign in to the org they
      // would own.
      const newOwnerMembership = await UserOrganization.findOne({
        userId: newOwnerId, organizationId: toOrgId(orgId), isActive: true,
      }).session(session);
      if (!newOwnerMembership) throw new Error(OM_NEW_OWNER_MUST_BE_MEMBER);

      oldOwnerId = String(oldOwnerMembership.userId);
      oldOwnerMembership.role = 'admin';
      await oldOwnerMembership.save({ session });
      newOwnerMembership.role = 'owner';
      await newOwnerMembership.save({ session });

      // Single-source RBAC: an owner must resolve to admin-level PERMISSIONS, which
      // come ONLY from assigned Roles. A new owner promoted from a plain member holds
      // just the Member Role, so grant the built-in Admin Role (idempotent upsert) —
      // the coarse 'owner' label alone yields zero admin permissions. No recompute is
      // needed here: `newOwnerMembership.role` is set to 'owner' explicitly (recompute
      // preserves 'owner'), and BOTH users' claimsVersion is bumped below, so the new
      // owner's next token already reflects the added permissions.
      await assignBuiltinAdminRole(newOwnerId, toOrgId(orgId), session);

      org.owner = new mongoose.Types.ObjectId(newOwnerId);
      await org.save({ session });

      // Invalidate both users' outstanding access tokens so the role swap takes
      // effect immediately (the JWT carries the issue-time membership role).
      await User.updateMany(
        { _id: { $in: [oldOwnerMembership.userId, newOwnerId] } },
        { $inc: { claimsVersion: 1 } },
        { session },
      );
    });
    // Post-commit: publish BOTH users' now-current access version so the role swap
    // takes effect on the stateless services immediately.
    await publishUsersRevocation([oldOwnerId, newOwnerId].filter((v): v is string => !!v));
  }

  /** Check if the caller is the org owner — used by ownership-transfer authz. */
  async isOrgOwner(orgId: string, userId: string): Promise<boolean> {
    const org = await Organization.findById(toOrgId(orgId));
    // Nobody owns a soft-deleted org for authorization purposes.
    return !!org && !(org as { deletedAt?: Date | null }).deletedAt && org.owner.toString() === userId;
  }

  /**
   * Soft-deactivate a member: sets isActive=false and clears their
   * lastActiveOrgId if it pointed here. They keep the membership record
   * but lose access. Refuses to touch the owner.
   *
   * Deactivating withdraws every Role the person holds here as surely as
   * removing them, so it runs the same unassign guards (see
   * {@link removeMember}); the assignments themselves are kept for reactivation.
   *
   * Ends access to THIS org only ({@link endOrgAccess}, mirrors removeMember).
   * `requireAuth` trusts the JWT claims and only re-reads the access version —
   * it does NOT re-check `isActive` — so the claims bump is what makes the loss
   * of access immediate. The next refresh re-mints into an org they are still
   * active in, never this one (token issuance requires a live membership).
   */
  async deactivateMember(orgId: string, userId: string, actor: RoleAssignmentActor): Promise<MemberExitResult> {
    let revokedInvitations: RevokedInvitation[] = [];
    await withMongoTransaction(async (session) => {
      const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId) }).session(session);
      if (!membership) throw new Error(OM_MEMBERSHIP_NOT_FOUND);
      if (membership.role === 'owner') throw new Error(OM_CANNOT_REMOVE_OWNER);
      if (!membership.isActive) throw new Error(OM_ALREADY_INACTIVE);

      await assertActorMayStripMemberRoles(orgId, userId, actor, session);

      membership.isActive = false;
      await membership.save({ session });

      await endOrgAccess(userId, orgId, session);
      revokedInvitations = await revokePendingInvitationsSentBy(userId, orgId, session);
    });
    // Post-commit: publish the deactivated user's now-current access version.
    await publishUserRevocation(userId);
    return { revokedInvitations };
  }

  /**
   * Re-activate a previously deactivated member. Their Role assignments were
   * kept, so reactivating puts every one back to work: the actor must be able to
   * wield each (the ceiling deactivation enforced), or a `members:manage`-only
   * delegate could restore an admin an owner had just deactivated.
   */
  async activateMember(orgId: string, userId: string, actor: RoleAssignmentActor): Promise<void> {
    await withMongoTransaction(async (session) => {
      const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId) }).session(session);
      if (!membership) throw new Error(OM_MEMBERSHIP_NOT_FOUND);
      if (membership.isActive) throw new Error(OM_ALREADY_ACTIVE);

      await assertActorMayWieldMemberRoles(orgId, userId, actor, session);

      // Reactivation re-occupies a seat, so it must honor the pooled cap the
      // invite/add paths enforce — otherwise deactivate→reactivate churn could
      // push an account over its seat limit.
      await withSeatGuard({ userId, orgId, session, errorCode: OM_SEAT_LIMIT }, async () => {
        membership.isActive = true;
        await membership.save({ session });
      });
    });
  }
}

/** What a member removal / deactivation did beyond the membership itself. */
export interface MemberExitResult {
  /** The person's pending invitations into the org, revoked with them. */
  revokedInvitations: RevokedInvitation[];
}

/**
 * End a person's access to ONE org — the org-scoped revocation SCIM uses
 * (`services/scim-users.ts` endOrgAccess).
 *
 * A CLAIMS bump, not a session kill: every outstanding access token goes stale
 * on the next request (here, and on the stateless services via the post-commit
 * publish), but the person's sessions survive. They are the person's, spanning
 * every org they belong to, and one org's admin must not be able to sign them
 * out of the others — repeatedly, by re-adding and removing them. The next
 * refresh re-mints into an org they are still active in (issuance requires a
 * live membership), never this one; the pin to it is dropped here.
 */
async function endOrgAccess(userId: string, orgId: string, session: mongoose.ClientSession): Promise<void> {
  await User.updateOne({ _id: userId }, { $inc: { claimsVersion: 1 } }, { session });
  await User.updateOne(
    { _id: userId, lastActiveOrgId: String(toOrgId(orgId)) },
    { $unset: { lastActiveOrgId: '' } },
    { session },
  );
}

export const orgMembersService = new OrgMembersService();
logger.info('OrgMembersService ready');

/**
 * Stamp this membership as active, at most once a day.
 *
 * The seat offer's DISQUALIFIER: an
 * account at its seat cap whose members have not signed in is a churn save
 * rather than an expansion, and a pressure-only profile cannot tell the two
 * apart.
 *
 * ONCE A DAY, not per request, and that is the whole design. The precision the
 * signal needs is "did this person use their seat during the period", where a
 * period is days long — so a day-granular stamp answers it exactly, and a
 * write per request would put a database round trip on every authenticated
 * call to buy nothing.
 *
 * BEST-EFFORT and never thrown: a sign-in must not fail because a sales signal
 * could not be recorded. A dropped stamp makes the member look idle for one
 * day, which the sustained-pressure rules are deliberately tolerant of.
 */
export async function stampMembershipActivity(userId: string, organizationId: string): Promise<void> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    await UserOrganization.updateOne(
      {
        userId: new mongoose.Types.ObjectId(userId),
        organizationId: new mongoose.Types.ObjectId(organizationId),
        // The conditional is what makes this cheap: a membership already
        // stamped today matches nothing and no write happens.
        $or: [{ lastActiveAt: { $exists: false } }, { lastActiveAt: { $lte: dayAgo } }],
      },
      { $set: { lastActiveAt: new Date() } },
    );
  } catch (err) {
    logger.debug('Could not stamp membership activity', {
      userId, organizationId, error: errorMessage(err),
    });
  }
}

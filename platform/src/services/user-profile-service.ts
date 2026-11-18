// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isoOrNull, createLogger, ECOSYSTEM_EMAIL_PREFERENCE_FIELD_NAMES } from '@pipeline-builder/api-core';
import { isAdminOrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import { Types } from 'mongoose';
import { apiKeyService } from './api-key-service.js';
import { authService } from './auth-service.js';
import { deleteAllSlots, findSlot, listSlots, type RefreshSession } from './session/session-store.js';
import { deleteUserCascade } from './user-cascade.js';
import { PROFILE_USER_NOT_FOUND, PROFILE_EMAIL_TAKEN, PROFILE_EMAIL_SSO_MANAGED, PROFILE_INVALID_CREDENTIALS, USER_OWNER_HAS_ORGS } from './user-errors.js';
import { loadActiveOrgInfo } from '../helpers/active-org-info.js';
import { toOrgId } from '../helpers/org-id.js';
import { assertNewPasswordAcceptable } from '../helpers/password-policy.js';
import { publishUserRevocation, publishUserDeletionRevocation } from '../helpers/session-revocation.js';
import { User, Organization, UserOrganization, Role, RoleAssignment, type EcosystemEmailPreferences, type NotificationPreferences, UserPreferences } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('user-profile-service');

/** How a sign-in email is stored: trimmed and lower-cased. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** A user's per-org preferences as the API returns them (defaults filled in). */
export interface UserPreferencesView {
  favorites: string[];
  recents: string[];
  notifications: NotificationPreferences;
}

/** A partial update: only the provided fields change. */
export interface PreferencesPatch {
  favorites?: string[];
  recents?: string[];
  notifications?: {
    muteQuotaWarnings?: boolean;
    ecosystem?: Partial<EcosystemEmailPreferences>;
  };
}

type StoredNotifications = { muteQuotaWarnings?: boolean; ecosystem?: Partial<EcosystemEmailPreferences> };

function toPreferencesView(
  doc: { favorites?: string[]; recents?: string[]; notifications?: StoredNotifications } | null | undefined,
): UserPreferencesView {
  // Ecosystem emails default ON: only an explicit `false` opts out.
  const eco = doc?.notifications?.ecosystem;
  return {
    favorites: doc?.favorites ?? [],
    recents: doc?.recents ?? [],
    notifications: {
      muteQuotaWarnings: doc?.notifications?.muteQuotaWarnings === true,
      ecosystem: Object.fromEntries(
        ECOSYSTEM_EMAIL_PREFERENCE_FIELD_NAMES.map((f) => [f, eco?.[f] !== false]),
      ) as EcosystemEmailPreferences,
    },
  };
}

interface OrgInfo {
  id: string;
  name: string;
  slug?: string;
  tier?: string;
  /** Account-level feature entitlements (e.g. add-on bundle grants). */
  featureEntitlements?: string[];
}

interface MembershipInfo {
  organizationId: string;
  organizationName: string;
  slug?: string;
  role: string;
  isActive: boolean;
  joinedAt?: string;
  /** Parent org id when this org is a team (org → team hierarchy); omitted for root orgs. */
  parentOrgId?: string;
  /** The parent's display name (teams only) — lets the switcher label a team
   *  whose parent the user is not a member of. */
  parentOrgName?: string;
  /** Org's plan tier — lets the UI gate tier-gated actions (e.g. only team/enterprise roots may parent teams). */
  tier?: string;
  /** Live (not soft-deleted) teams nested directly under this org. The UI shows
   *  its hierarchy surfaces (team lists, rollup toggles, per-team breakdowns)
   *  only when this is > 0, without a per-page descendants lookup. Nesting is
   *  one level deep, so direct children are all descendants. */
  childOrgCount: number;
  /** Set on a row synthesized for a team the user may enter on admin authority
   *  INHERITED from its parent — no membership row exists (see listOrganizations). */
  viaAncestor?: true;
  /**
   * The names of the Roles assigned to the user IN this org, in catalog order.
   *
   * The switcher used to label each row with `role` — the coarse
   * owner/admin/member word, which is the one field this model says grants
   * nothing ("survives only for isAdmin/ownership/display, never to grant
   * permissions", api-core `permissions.ts`). So the only surface that answers
   * "what am I in this organization?" was naming the thing that is not the
   * answer: somebody holding a `Release Manager` Role in one org and plain
   * membership in another read as "member" in both.
   *
   * Empty for an inherited-authority row (there is no membership, so there are
   * no Roles — the authority is the parent's) and for an org whose Roles have
   * not been assigned yet. The UI falls back to `role` in both cases.
   */
  roleNames: string[];
  /**
   * The org requires an MFA-grade session for admin actions
   * (`adminActionsRequireMfa`, its own or an ancestor's in force over it).
   *
   * `switch-org` REFUSES an aal-1 session switching into such an org
   * (`MFA_POLICY_ERROR_MAP`), so without this the switcher can only report the
   * refusal after the click. With it the row can say so first.
   */
  requiresMfa?: true;
}

interface ProfileData {
  user: Awaited<ReturnType<typeof User.findById>> extends infer U
    ? U extends null ? never : NonNullable<U>
    : never;
  /** Per-org join records for the user. */
  memberships: Array<{
    organizationId: Types.ObjectId | string;
    role: string;
  }>;
  /** Lookup map from org-id → name/tier for callers that mix the two. */
  orgMap: Map<string, OrgInfo>;
}

/**
 * The user fields GET /user/profile reads. A field read off the profile's user
 * document but missing here is silently `undefined` (the read is `.lean()` over
 * this projection), so add to it whenever the controller starts reading one.
 */
export const PROFILE_USER_FIELDS =
  '_id username email isEmailVerified isSuperAdmin lastActiveOrgId featureOverrides tokenVersion mfaResetGraceUntil mfaNudge';

class UserProfileService {
  /**
   * Resolve the user + their org memberships + a name/tier lookup for the
   * orgs they belong to. One round-trip per logical fetch (user, memberships,
   * orgs) so the controller can shape its response without further DB calls.
   * Throws PROFILE_USER_NOT_FOUND when the user record is gone.
   */
  async getProfileWithOrgs(userId: string): Promise<ProfileData> {
    const user = await User.findById(userId)
      // isSuperAdmin must be selected here — formatUserResponse echoes
      // it to /api/user/profile so the frontend can gate sysadmin-only
      // sidebar entries. Without it in the projection, the API always
      // returned isSuperAdmin: false regardless of mongo state.
      //
      // mfaNudge, for the same reason: GET /user/profile reports the
      // password-only prompt's snooze/decline from it (reportableMfaNudge).
      // Left out of this projection, every "Not now" and "Don't ask again" was
      // WRITTEN (POST /user/mfa-prompt/* answered 200) but never READ back, so
      // the banner returned on every page load. test/user-profile-projection
      // pins the fields the profile controller reads.
      .select(PROFILE_USER_FIELDS)
      .lean();
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);

    const memberships = await UserOrganization.find({ userId: user._id }).lean();
    const orgIds = memberships.map(m => m.organizationId);
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug tier featureEntitlements').lean()
      : [];

    const orgMap = new Map<string, OrgInfo>(
      orgs.map(o => [o._id.toString(), { id: o._id.toString(), name: o.name, slug: o.slug, tier: o.tier, featureEntitlements: o.featureEntitlements }]),
    );

    return { user: user as never, memberships, orgMap };
  }

  /**
   * Every org the user can switch into, as a flat array:
   *   1. their membership rows, sorted by `joinedAt` (oldest first — keeps
   *      "Personal org" at the top of the dashboard switcher);
   *   2. then one `viaAncestor: true` row per LIVE team of an org they
   *      administer (active `admin`/`owner` membership in a live parent) where
   *      they have NO membership row — the teams switch-org admits them to on
   *      inherited authority (helpers/org-authority.ts), with the role that
   *      session gets (`admin`). These rows are synthesized for the switcher
   *      only: no `UserOrganization` row exists, so seats, rosters and every
   *      membership read are unaffected.
   *
   * Each row also names the ROLES the user holds in that org, which is what the
   * switcher labels itself with (see `MembershipInfo.roleNames`), and flags an
   * org whose `adminActionsRequireMfa` policy would refuse an aal-1 switch.
   *
   * FIVE reads regardless of org count: memberships, their orgs, the live
   * children of those orgs (which yields both `childOrgCount` and the
   * inherited-team rows), the user's Role assignments, and the Roles those
   * assignments name. Parent names of member teams whose parent the user isn't
   * in cost one more read, only when there are such teams. The MFA flag is
   * computed from orgs already in hand rather than per-org policy resolution —
   * nesting is one level deep, so an org and its parent are the whole chain.
   */
  async listOrganizations(userId: string): Promise<MembershipInfo[]> {
    const memberships = await UserOrganization.find({ userId }).sort({ joinedAt: 1 }).lean();
    const orgIds = memberships.map(m => m.organizationId);
    if (orgIds.length === 0) return [];
    const orgs = await Organization.find({ _id: { $in: orgIds } })
      .select('_id name slug parentOrgId tier deletedAt adminActionsRequireMfa').lean();
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o]));
    // `parentOrgId` is stored as a string id (see the Organization model).
    const children = await Organization.find({ parentOrgId: { $in: orgIds.map(String) }, deletedAt: null })
      .select('_id name slug parentOrgId tier adminActionsRequireMfa').lean();

    // The Roles this user holds, per org. Two reads for the whole list: the
    // assignments (indexed on userId) and the Roles they name. `organizationId`
    // is denormalized onto the assignment, so no join is needed to bucket them.
    const assignments = await RoleAssignment.find({ userId }).select('roleId organizationId').lean();
    const roleNamesByOrg = new Map<string, string[]>();
    if (assignments.length > 0) {
      const roleDocs = await Role.find({ _id: { $in: assignments.map(a => a.roleId) } }).select('_id name').lean();
      const roleNameById = new Map(roleDocs.map(r => [r._id.toString(), r.name as string]));
      for (const a of assignments) {
        const name = roleNameById.get(String(a.roleId));
        // A dangling assignment (its Role was deleted) is skipped rather than
        // rendered as a blank chip.
        if (!name) continue;
        const key = String(a.organizationId);
        const list = roleNamesByOrg.get(key) ?? [];
        if (!list.includes(name)) list.push(name);
        roleNamesByOrg.set(key, list);
      }
      for (const list of roleNamesByOrg.values()) list.sort();
    }

    /**
     * Whether an aal-1 session would be refused on switching INTO `orgId`.
     * An org's own policy, or its parent's in force over it — the whole chain,
     * since a team never parents teams.
     */
    const requiresMfa = (orgId: string, parentOrgId?: string): boolean => {
      const own = orgMap.get(orgId)?.adminActionsRequireMfa === true;
      if (own) return true;
      return !!parentOrgId && orgMap.get(parentOrgId)?.adminActionsRequireMfa === true;
    };
    const childCountByOrg = new Map<string, number>();
    for (const c of children) {
      const parent = String(c.parentOrgId);
      childCountByOrg.set(parent, (childCountByOrg.get(parent) ?? 0) + 1);
    }

    // Parent names: from orgs already in hand, reading only the parents the
    // user isn't a member of.
    const nameById = new Map(orgs.map(o => [o._id.toString(), o.name]));
    const missingParents = [...new Set(
      orgs.map(o => (o.parentOrgId ? String(o.parentOrgId) : undefined))
        .filter((p): p is string => !!p && !nameById.has(p)),
    )];
    if (missingParents.length > 0) {
      const parents = await Organization.find({ _id: { $in: missingParents.map(toOrgId) } }).select('_id name').lean();
      for (const p of parents) nameById.set(p._id.toString(), p.name);
    }

    const rows: MembershipInfo[] = memberships.map(m => {
      const org = orgMap.get(m.organizationId.toString());
      const parentOrgId = org?.parentOrgId ? String(org.parentOrgId) : undefined;
      const parentOrgName = parentOrgId ? nameById.get(parentOrgId) : undefined;
      return {
        organizationId: m.organizationId.toString(),
        organizationName: org?.name || 'Unknown',
        slug: org?.slug,
        role: m.role,
        isActive: m.isActive,
        joinedAt: m.joinedAt?.toISOString(),
        ...(parentOrgId && { parentOrgId }),
        ...(parentOrgName && { parentOrgName }),
        ...(org?.tier && { tier: org.tier as string }),
        childOrgCount: childCountByOrg.get(m.organizationId.toString()) ?? 0,
        roleNames: roleNamesByOrg.get(m.organizationId.toString()) ?? [],
        ...(requiresMfa(m.organizationId.toString(), parentOrgId) && { requiresMfa: true as const }),
      };
    });

    // Inherited-authority teams (the same rule switch-org applies).
    const memberOrgIds = new Set(orgIds.map(String));
    const administered = new Set(
      memberships
        .filter(m => m.isActive && isAdminOrgRole(m.role))
        .map(m => m.organizationId.toString())
        .filter(id => !orgMap.get(id)?.deletedAt),
    );
    for (const team of children) {
      const teamId = team._id.toString();
      const parentOrgId = String(team.parentOrgId);
      if (!administered.has(parentOrgId) || memberOrgIds.has(teamId)) continue;
      const parentOrgName = nameById.get(parentOrgId);
      rows.push({
        organizationId: teamId,
        organizationName: team.name,
        slug: team.slug,
        role: 'admin',
        isActive: true,
        parentOrgId,
        ...(parentOrgName && { parentOrgName }),
        ...(team.tier && { tier: team.tier as string }),
        // Nesting is one level deep: a team never parents teams.
        childOrgCount: 0,
        // No membership row means no Roles: the authority IS the parent's, and
        // the switcher labels such a row "via parent" rather than with a Role.
        roleNames: [],
        ...(team.adminActionsRequireMfa === true || orgMap.get(parentOrgId)?.adminActionsRequireMfa === true
          ? { requiresMfa: true as const }
          : {}),
        viaAncestor: true,
      });
    }
    return rows;
  }

  /**
   * Whether `email` would CHANGE this user's sign-in address — the case
   * `PATCH /user/profile` step-up gates. A missing user counts as a change, so
   * the gate fails closed (the update then answers PROFILE_USER_NOT_FOUND).
   */
  async isEmailChange(userId: string, email: string): Promise<boolean> {
    const current = await User.findById(userId).select('email').lean();
    return !current || normalizeEmail(email) !== current.email;
  }

  /**
   * Update username and/or email on the user record. An email CHANGE clears
   * `isEmailVerified` (and any outstanding verification link, which was mailed
   * to the old address) so the user re-verifies, and `previousEmail` names the old
   * address so the caller can tell its owner; re-sending the current address is
   * not a change and touches nothing. Throws PROFILE_EMAIL_TAKEN when the new
   * email is already in use, PROFILE_EMAIL_SSO_MANAGED when the CURRENT address
   * is under an "SSO required" policy of an account the user belongs to, and
   * PROFILE_USER_NOT_FOUND when the user is gone.
   */
  async updateProfile(userId: string, body: { username?: string; email?: string }) {
    const updates: Partial<{ username: string; email: string; isEmailVerified: boolean }> = {};
    if (body.username) updates.username = body.username.trim().toLowerCase();
    let previousEmail: string | undefined;
    if (body.email) {
      const current = await User.findById(userId).select('email').lean();
      if (!current) throw new Error(PROFILE_USER_NOT_FOUND);
      const email = normalizeEmail(body.email);
      if (email !== current.email) {
        updates.email = email;
        previousEmail = current.email;
      }
    }

    if (updates.email) {
      const existing = await User.findOne({
        email: updates.email,
        _id: { $ne: new Types.ObjectId(userId) },
      });
      if (existing) throw new Error(PROFILE_EMAIL_TAKEN);
      // SSO ESCAPE: "SSO required" keys on the CURRENT address's domain, so a
      // member who moved their email off it would keep the membership yet sign
      // in by password again. While the address is governed for an account they
      // belong to, it is the org's to manage. Fails closed on an unreadable
      // lineage. Imported on demand: sso-enforcement's graph is wide.
      const { findSsoEnforcementForEmail } = await import('../helpers/sso-enforcement.js');
      const enforcement = await findSsoEnforcementForEmail(previousEmail!);
      if (enforcement) {
        const { hasMembershipInAccount } = await import('../helpers/account-membership.js');
        const member = await hasMembershipInAccount(userId, enforcement.orgId).catch(() => true);
        if (member) throw new Error(PROFILE_EMAIL_SSO_MANAGED);
      }
      updates.isEmailVerified = false;
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      {
        $set: updates,
        // A verification link already mailed proves control of the OLD address
        // only. Left in place it verified the NEW one: request a link to an
        // address you own, change the email to `someone@bigcorp.com`, click —
        // and domain-based join (which trusts `isEmailVerified` alone) let you in.
        ...(updates.email ? { $unset: { emailVerificationToken: '', emailVerificationExpires: '' } } : {}),
      },
      { returnDocument: 'after', runValidators: true },
    ).lean();
    if (!updated) throw new Error(PROFILE_USER_NOT_FOUND);

    const { organizationName, activeOrgRole } = await loadActiveOrgInfo(updated._id, updated.lastActiveOrgId?.toString());
    return { user: updated, organizationName, activeOrgRole, ...(previousEmail ? { previousEmail } : {}) };
  }

  /**
   * Delete the caller's own account and everything keyed to it (see
   * {@link deleteUserCascade}). An org the caller owns and is the ONLY member
   * of is soft-deleted with it (see `services/account-deletion.ts`); any other
   * owned org blocks. Returns the orgs that were soft-deleted.
   *
   * Throws USER_OWNER_HAS_ORGS (an owned org has other members, has teams, or
   * is the system org), RL_LAST_PRIVILEGED_MEMBER, ORG_SNAPSHOT_FAILED (an org's
   * recovery snapshot could not be written — nothing is deleted), or
   * PROFILE_USER_NOT_FOUND if the user is already gone.
   */
  async deleteAccount(userId: string): Promise<{ orgsDeleted: Array<{ orgId: string; name: string; purgeAfter: Date; snapshotId: string }> }> {
    // Lazily imported: account deletion is the only caller of these here.
    const [{ planAccountDeletion }, { assertNotLastPrivilegedMember }] = await Promise.all([
      import('./account-deletion.js'),
      import('./role-crud.js'),
    ]);
    const plan = await planAccountDeletion(userId);
    if (!plan.canDelete) throw new Error(USER_OWNER_HAS_ORGS);
    const orgIds = plan.orgsDeleted.map((o) => new Types.ObjectId(o.orgId));
    // Pre-flight the Role lockout guard BEFORE any org is tombstoned, so a
    // refusal leaves everything as it was. The sole owner's own org Roles are
    // exempt — nobody is left in that org to be locked out.
    await withMongoTransaction((session) => assertNotLastPrivilegedMember(session, new Types.ObjectId(userId), undefined, orgIds));

    // Lazily imported: the cascade pulls in the Postgres + peer-service graph,
    // which nothing else in this module needs.
    const { softDeleteOrg } = await import('./org-cascade-service.js');
    const orgsDeleted: Array<{ orgId: string; name: string; purgeAfter: Date; snapshotId: string }> = [];
    for (const org of plan.orgsDeleted) {
      const r = await softDeleteOrg(org.orgId, org.orgId, userId);
      orgsDeleted.push({ ...org, purgeAfter: r.purgeAfter, snapshotId: r.snapshotId });
    }

    const deleted = await withMongoTransaction((session) => deleteUserCascade(session, userId));
    if (!deleted) throw new Error(PROFILE_USER_NOT_FOUND);
    // Revoke the deleted user's outstanding tokens on the stateless services.
    await publishUserDeletionRevocation(userId, deleted.accessVersion);
    // GDPR: the person's ecosystem content (listing reviews) is scrubbed by the
    // plugin service through the cascade outbox leg `deleteUserCascade` wrote in
    // the same transaction — on this self-service path exactly as on the admin
    // one, because the cascade itself carries it.
    logger.info('Account deleted', { userId, orgsDeleted: orgsDeleted.map((o) => o.orgId) });
    return { orgsDeleted };
  }

  /**
   * Verify the current password and update to the new one. Bumps
   * `tokenVersion` so all existing access tokens are immediately invalid, and
   * revokes every access key (keys are decoupled from `tokenVersion`). Returns
   * how many keys were revoked.
   * Throws PROFILE_USER_NOT_FOUND or PROFILE_INVALID_CREDENTIALS.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ accessKeysRevoked: number }> {
    const user = await User.findById(userId).select('+password +tokenVersion');
    if (!user || !user.password) throw new Error(PROFILE_USER_NOT_FOUND);

    if (!await user.comparePassword(currentPassword)) throw new Error(PROFILE_INVALID_CREDENTIALS);
    // Org password policy (strictest across the person's orgs) + the
    // breached-password check — throws a 400-shaped PasswordPolicyServiceError.
    await assertNewPasswordAcceptable(newPassword, { userId });

    user.password = newPassword;
    // HARD revocation: every session ends (tokenVersion) and every refresh slot
    // is dropped — a password change is what someone does when they fear theft.
    user.tokenVersion += 1;
    await user.save();
    await deleteAllSlots(user._id);
    // Post-commit: publish the now-current tokenVersion so the stateless services
    // reject every outstanding token immediately (best-effort).
    await publishUserRevocation(String(userId));
    // A key on the stolen laptop must die with the sessions.
    const accessKeysRevoked = await apiKeyService.revokeAllForUser(String(userId));
    return { accessKeysRevoked };
  }

  /** Fetch a user with `tokenVersion` AND `isSuperAdmin` selected, suitable
   *  for issuing tokens. Both fields are `select: false` on the schema, and
   *  `issueTokens` -> `createAccessTokenPayload` reads `user.isSuperAdmin`
   *  to bake the sysadmin claim into the JWT. Omitting `+isSuperAdmin` here
   *  silently mints non-sysadmin tokens for promoted users (e.g. when a
   *  sysadmin clicks "regenerate API token" on the dashboard). */
  async findForTokenIssue(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion +isSuperAdmin');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    return user;
  }

  /**
   * Return the user's recent token-issuance history with status computed
   * per token: expired if past expiry, revoked if tokenVersion bumped past
   * the issue-time value, otherwise active. JWT is stateless so revocation
   * is derived from `user.tokenVersion`, not stored per-token.
   */
  async listTokenHistory(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion issuedTokens');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);

    const now = Date.now();
    return (user.issuedTokens ?? []).map((t) => {
      const expiresAt = t.expiresAt instanceof Date ? t.expiresAt : new Date(t.expiresAt);
      const createdAt = t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt);
      let status: 'active' | 'expired' | 'revoked';
      if (expiresAt.getTime() <= now) status = 'expired';
      else if (t.tokenVersionAtIssue !== user.tokenVersion) status = 'revoked';
      else status = 'active';
      return {
        id: t.id,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status,
      };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ── Personalization (server-persisted favorites / recents, per user+org) ──

  private readonly MAX_FAVORITES = 500;
  private readonly MAX_RECENTS = 50;

  /** Read a user's per-org preferences. Defaults when unset. */
  async getPreferences(userId: string, organizationId: string): Promise<UserPreferencesView> {
    const doc = await UserPreferences.findOne({ userId, organizationId }).lean();
    return toPreferencesView(doc);
  }

  /**
   * Update a user's per-org preferences (upsert). Each provided list replaces
   * the stored one, de-duplicated and capped; each provided notification
   * preference is set individually. Anything not provided is left unchanged.
   */
  async updatePreferences(
    userId: string,
    organizationId: string,
    patch: PreferencesPatch,
  ): Promise<UserPreferencesView> {
    // Cap element length too (not just array count) so a user can't bloat the
    // document toward the 16MB BSON limit with a few giant strings.
    const clean = (arr: string[], cap: number) =>
      [...new Set(arr.filter((s) => typeof s === 'string' && s && s.length <= 256))].slice(0, cap);
    const set: Record<string, string[] | boolean> = {};
    if (patch.favorites !== undefined) set.favorites = clean(patch.favorites, this.MAX_FAVORITES);
    if (patch.recents !== undefined) set.recents = clean(patch.recents, this.MAX_RECENTS);
    if (patch.notifications?.muteQuotaWarnings !== undefined) {
      set['notifications.muteQuotaWarnings'] = patch.notifications.muteQuotaWarnings;
    }
    for (const [field, value] of Object.entries(patch.notifications?.ecosystem ?? {})) {
      if (typeof value === 'boolean') set[`notifications.ecosystem.${field}`] = value;
    }
    const doc = await UserPreferences.findOneAndUpdate(
      { userId, organizationId },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return toPreferencesView(doc);
  }

  // ── Sessions and devices (refresh-session slots) ─────────────────────────

  /** One refresh-session slot as the API returns it. */
  private serializeSession(slot: RefreshSession) {
    return {
      id: slot.id,
      kind: slot.kind,
      createdAt: new Date(slot.createdAt).toISOString(),
      // For a machine slot this is the last RENEWAL; for an interactive one the
      // last refresh / org switch.
      lastUsedAt: new Date(slot.lastUsedAt).toISOString(),
      // A machine credential's fixed end (null = ends with its refresh token).
      expiresAt: isoOrNull(slot.expiresAt),
      signedInAt: new Date(slot.authTime).toISOString(),
      userAgent: slot.userAgent ?? null,
      lastIp: slot.lastIp ?? null,
      scope: slot.scope ?? null,
      // A permission-scoped machine token's subset (null = full permissions).
      permissions: Array.isArray(slot.permissions) ? [...slot.permissions] : null,
      amr: slot.amr ?? [],
    };
  }

  /**
   * The user's live sessions, newest first. Interactive sessions are signed-in
   * devices; machine sessions are the stored credentials `generate-token`
   * opened (listed separately, labelled by scope). IPs are returned as stored —
   * they live only as long as the slot.
   */
  async listSessions(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion').lean();
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    // Live slots only: one opened before the last hard revocation is dead.
    const slots = (await listSlots(userId, user.tokenVersion)).map((s) => this.serializeSession(s));
    const byNewest = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);
    return {
      sessions: slots.filter((s) => s.kind === 'interactive').sort(byNewest),
      machineSessions: slots.filter((s) => s.kind === 'machine').sort(byNewest),
    };
  }

  /**
   * Revoke ONE session slot: that device is signed out, or that stored machine
   * credential stops. Its current access token dies with it — platform checks
   * the slot, and `revoke:sid:<sid>` is published for every other service (see
   * `authService.revokeRefreshSession`). Returns the
   * revoked slot's kind, or null when the user has no such slot.
   */
  async revokeSession(userId: string, sessionId: string): Promise<{ kind: RefreshSession['kind'] } | null> {
    const slot = await findSlot(userId, sessionId);
    if (!slot) return null;
    await authService.revokeRefreshSession(userId, sessionId);
    return { kind: slot.kind };
  }

  /**
   * "Sign out everywhere" — routes through `authService.invalidateAllSessions`,
   * the SAME path auth logout uses, so the profile "revoke all" behaves
   * identically: bump `tokenVersion`, CLEAR every refresh-session slot, AND
   * publish the revocation to the stateless services. Also revokes the user's
   * access keys (which are decoupled from `tokenVersion`, so a durable
   * credential must be killed explicitly). Returns the user with `tokenVersion`
   * selected so the caller can issue a fresh replacement token.
   */
  async revokeAllSessions(userId: string) {
    const user = await User.findById(userId).select('+tokenVersion issuedTokens');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    // Revoke the DURABLE credentials (access keys) FIRST — if the
    // session-invalidate step below were to throw after keys were left live, the
    // user would believe "sign out everywhere" succeeded while a key kept
    // exchanging for fresh tokens.
    await apiKeyService.revokeAllForUser(userId);
    // Authoritative session revocation: $inc tokenVersion + clear refresh-session slots
    // in the DB and publish the revocation (best-effort) — all inside the service.
    await authService.invalidateAllSessions(String(userId));
    // The service bumped tokenVersion via $inc in the DB; mirror that on the doc
    // we return so the caller mints the replacement token at the new version.
    user.tokenVersion += 1;
    return user;
  }
}

export const userProfileService = new UserProfileService();

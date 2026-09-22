// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM 2.0 provisioning — RFC 7643 (schema) / RFC 7644 (protocol).
 *
 * Before this, a person removed from the customer's identity provider kept their
 * Pipeline Builder access until an admin noticed and removed them here. Now the
 * directory is the source of truth for WHO is in the org and WHICH groups they
 * are in, pushed over `/scim/v2/Users` and `/scim/v2/Groups`.
 *
 * WHAT A SCIM RESOURCE IS HERE
 *   - a SCIM **User** is one ORG MEMBERSHIP (`UserOrganization`). Its `id` is the
 *     platform user id — stable across deactivate/reactivate, and the same id the
 *     audit trail names. The directory-owned attributes (externalId, userName as
 *     sent, names, group keys) live in `membership.scim`, NEVER on the `User`
 *     account: a tenant's directory must not be able to rewrite the email or
 *     username of a person who also belongs to another org.
 *   - a SCIM **Group** is one `IdpGroupMapping` row — the SAME rows the SSO
 *     group → Role editor writes. SCIM owns the group's NAME and its
 *     MEMBERS; it never sets `roleIds`. What a group is WORTH stays an
 *     in-product decision made by a human holding `roles:manage`, so a
 *     compromised SCIM key can move people between groups but cannot invent a
 *     group that grants admin.
 *
 * HOW A ROLE FOLLOWS FROM A GROUP
 *   Every membership change resolves the member's current group keys through
 *   the {@link IdpGroupMappingService.resolveMappedRoles} and reconciles the
 *   result with `syncMappedRoles`, which only ever removes rows it owns
 *   (`source: 'jit'`). A Role an admin granted by hand therefore survives every
 *   sync — the same guarantee the SSO sign-in path gives.
 *
 * THE RULES, AND WHERE EACH LIVES
 *   AUTH        — a service-account key carrying the `scim` scope, and nothing
 *                 else (`middleware/require-scim-scope.ts`). The org is the
 *                 token's own org; there is no org id in any path, so a key can
 *                 only ever act on the org it was minted in.
 *   ENTITLEMENT — inside the existing `sso` entitlement. After a downgrade the
 *                 surface becomes REMOVAL-ONLY: deactivate and delete still work
 *                 (so removing someone in the IdP still removes their access),
 *                 reads still work (an IdP must look a user up before it can
 *                 deactivate them), and create/update are refused with a 403
 *                 naming the reason. Admins are notified once per day.
 *   SEATS       — the same pooled check the invite and JIT paths run. Over the
 *                 limit, the create is refused with the seat reason; nothing is
 *                 over-provisioned and no overage is billed.
 *   AUTHORITY   — a user may only be provisioned at an email whose domain the
 *                 org (or its account root) has VERIFIED, exactly as an SSO
 *                 identity must be. Otherwise a tenant could staple a membership
 *                 onto any account on the platform by knowing its address.
 *   NEVER       — the org owner is never deactivated or removed (transfer
 *                 ownership first), and a platform administrator is never
 *                 provisioned, deactivated or touched at all.
 *   REVOCATION  — a deactivation ends access to THIS org on the next request
 *                 everywhere — not at token expiry — by bumping `claimsVersion`
 *                 (every outstanding access token is stale) and publishing it.
 *                 The person's sessions themselves survive: one org's directory
 *                 has no say over their other orgs, and the next refresh simply
 *                 re-mints into an org they are still active in.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { Types, type ClientSession } from 'mongoose';
import { idpGroupMappingService } from './idp-group-mapping-service.js';
import { syncMappedRoles } from './mapped-roles.js';
import { ensureBaselineRole, recomputeUserOrgRole } from './roles-service.js';
import {
  scimInvalidValue,
  scimMutability,
  scimNotEntitled,
  scimNotFound,
  scimOwnerProtected,
  scimPlatformAdmin,
  scimSeatLimit,
  scimUniqueness,
} from './scim-errors.js';
import {
  asBoolean,
  assertIntentAllowed,
  normalizePatchOps,
  parseScimFilter,
  parseScimPagination,
  patchPairs,
  type ScimContext,
  type ScimListQuery,
  type ScimListResponse,
  type ScimUserResource,
  type ScimWriteOutcome,
} from './scim-filter.js';
import { groupIndex, scimBaseUrl, userResource } from './scim-render.js';
import { SCIM_LIST_SCHEMA } from '../constants/scim.js';
import { toOrgId } from '../helpers/org-id.js';
import { pooledSeatUsage, withSeatGuard } from '../helpers/seats.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { emailDomain, ownsVerifiedDomain } from '../helpers/sso-enforcement.js';
import UserOrganization, { type ScimMembershipState, type UserOrganizationDocument } from '../models/user-organization.js';
import User, { type UserDocument } from '../models/user.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('scim-service');

/** The membership a SCIM `id` names, or 404. The id is the platform user id. */
export async function requireMembership(orgId: string, id: string): Promise<UserOrganizationDocument> {
  if (!Types.ObjectId.isValid(id)) throw scimNotFound('User');
  const membership = await UserOrganization.findOne({ userId: new Types.ObjectId(id), organizationId: toOrgId(orgId) });
  if (!membership) throw scimNotFound('User');
  return membership;
}

/** Refuse to touch a platform administrator through a tenant's directory. */
export async function assertNotPlatformAdmin(userId: Types.ObjectId | string): Promise<void> {
  const user = await User.findById(userId).select('+isSuperAdmin').lean();
  if (user?.isSuperAdmin === true) throw scimPlatformAdmin();
}

/**
 * Reconcile ONE member's Role set against the groups the directory now puts them
 * in, and force a token reissue when the effective grants moved.
 *
 * Identical in substance to the JIT sign-in path: resolve through the shared
 * resolver, `syncMappedRoles` (which only removes `source: 'jit'` rows, so
 * hand-granted Roles survive), recompute the cached coarse role, bump
 * `claimsVersion`, then publish the revocation post-commit so the stateless
 * services drop the older access tokens immediately.
 */
export async function resyncMemberRoles(orgId: string, userId: Types.ObjectId | string, groups: readonly string[]): Promise<void> {
  const { roleIds } = await idpGroupMappingService.resolveMappedRoles(orgId, groups);
  const oid = toOrgId(orgId);
  const changed = await withMongoTransaction(async (session) => {
    const { added, removed } = await syncMappedRoles(oid, userId, roleIds, session);
    if (added.length === 0 && removed.length === 0) return false;
    await recomputeUserOrgRole(userId, oid, session);
    await User.updateOne({ _id: userId }, { $inc: { claimsVersion: 1 } }, { session });
    return true;
  });
  if (changed) await publishUserRevocation(String(userId));
}

/**
 * End a member's access to ONE org whose directory just withdrew it.
 *
 * `requireAuth` trusts an access token's claims and only re-reads the access
 * version, so without a bump a deactivated member would keep acting in this org
 * until their token expired. The bump is a CLAIMS bump: every outstanding access
 * token goes stale (here, and — via the post-commit publish — on the stateless
 * services), but the person's sessions are NOT ended. They are the person's,
 * spanning every org they belong to; this org's directory only owns this org.
 * The next refresh re-mints into an org they are still active in — never this
 * one, whose membership is now inactive (and whose pin is dropped below).
 */
export async function endOrgAccess(userId: Types.ObjectId | string, orgId: string, session: ClientSession): Promise<void> {
  await User.updateOne({ _id: userId }, { $inc: { claimsVersion: 1 } }, { session });
  await User.updateOne(
    { _id: userId, lastActiveOrgId: String(toOrgId(orgId)) },
    { $unset: { lastActiveOrgId: '' } },
    { session },
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Attributes a Users filter may name. */
const USER_FILTER_ATTRS = ['userName', 'externalId', 'active', 'emails.value'] as const;

export async function listUsers(ctx: ScimContext, query: ScimListQuery): Promise<ScimListResponse<ScimUserResource>> {
  const parsed = parseScimFilter(query.filter, USER_FILTER_ATTRS);
  const { skip, limit, startIndex } = parseScimPagination(query);
  const oid = toOrgId(ctx.orgId);

  const where: Record<string, unknown> = { organizationId: oid };
  if (parsed?.attribute === 'externalid') {
    where['scim.externalId'] = parsed.value;
  } else if (parsed?.attribute === 'active') {
    where.isActive = parsed.value.toLowerCase() === 'true';
  } else if (parsed) {
    // `userName eq` / `emails.value eq`: the directory's spelling OR the platform
    // email, so a filter matches whether or not SCIM created the membership.
    const email = parsed.value.toLowerCase();
    const users = await User.find({ email }).select('_id').lean();
    const ids = users.map((u) => u._id);
    where.$or = [{ 'scim.userName': parsed.value }, ...(ids.length > 0 ? [{ userId: { $in: ids } }] : [])];
  }

  const totalResults = await UserOrganization.countDocuments(where);
  const memberships = limit === 0
    ? []
    : await UserOrganization.find(where).sort({ joinedAt: 1, _id: 1 }).skip(skip).limit(limit).lean();

  const [users, groups, baseUrl] = await Promise.all([
    User.find({ _id: { $in: memberships.map((m) => m.userId) } }).select('email username createdAt').lean(),
    groupIndex(ctx.orgId),
    scimBaseUrl(),
  ]);
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const Resources = memberships
    .map((m) => {
      const user = byId.get(String(m.userId));
      // A membership whose account was hard-deleted out from under it: skip
      // rather than render a resource with no identity.
      return user ? userResource(user, m, groups, baseUrl) : null;
    })
    .filter((r): r is ScimUserResource => r !== null);

  return { schemas: [SCIM_LIST_SCHEMA], totalResults, startIndex, itemsPerPage: Resources.length, Resources };
}

export async function getUser(ctx: ScimContext, id: string): Promise<ScimUserResource> {
  const membership = await requireMembership(ctx.orgId, id);
  const [user, groups, baseUrl] = await Promise.all([
    User.findById(membership.userId).select('email username createdAt').lean(),
    groupIndex(ctx.orgId),
    scimBaseUrl(),
  ]);
  if (!user) throw scimNotFound('User');
  return userResource(user, membership, groups, baseUrl);
}

/** The email a SCIM User body identifies: the primary email, else the first one,
 *  else `userName` when that is itself an address. */
function resolveEmail(body: Record<string, unknown>): string {
  const emails = Array.isArray(body.emails) ? (body.emails as Array<Record<string, unknown>>) : [];
  const primary = emails.find((e) => e.primary === true) ?? emails[0];
  const candidate = (typeof primary?.value === 'string' && primary.value) || (typeof body.userName === 'string' ? body.userName : '');
  const email = candidate.trim().toLowerCase();
  if (!email || !emailDomain(email)) {
    throw scimInvalidValue('A User must carry an email address, either in `emails` or as an email-shaped `userName`.');
  }
  return email;
}

/** Directory-owned attributes read off a User body (create or replace). */
function scimAttributes(body: Record<string, unknown>): {
  externalId: string | null;
  userName: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
} {
  const name = (body.name ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 254) : null);
  return {
    externalId: str(body.externalId),
    userName: str(body.userName),
    givenName: str(name.givenName),
    familyName: str(name.familyName),
    displayName: str(body.displayName),
  };
}

/**
 * POST /Users — provision a membership.
 *
 * Creates the platform account when the address is new, and always creates the
 * membership. Refuses (in this order, all before any write): the entitlement, an
 * unverified email domain, a platform administrator, an existing membership
 * (`uniqueness` — the IdP should PATCH the resource its GET found), and the
 * pooled seat cap.
 */
export async function createUser(ctx: ScimContext, body: Record<string, unknown>): Promise<ScimWriteOutcome<ScimUserResource>> {
  assertIntentAllowed(ctx, 'create');

  const email = resolveEmail(body);
  const attrs = scimAttributes(body);
  const active = body.active === undefined ? true : body.active === true;

  // AUTHORITY: the org must have proven it owns the address's domain, exactly as
  // an SSO identity must be trusted before it becomes a membership. Without this
  // a tenant could add any platform account to its org by knowing the address.
  const domain = emailDomain(email)!;
  if (!(await ownsVerifiedDomain(ctx.orgId, domain))) {
    throw scimInvalidValue(
      `'${domain}' is not a verified domain of this organization. Verify it under Settings → Domains before provisioning users at that domain.`,
    );
  }

  const oid = toOrgId(ctx.orgId);
  const existingUser = await User.findOne({ email }).select('+isSuperAdmin +tokenVersion');
  if (existingUser?.isSuperAdmin === true) throw scimPlatformAdmin();
  if (existingUser) {
    const already = await UserOrganization.exists({ userId: existingUser._id, organizationId: oid });
    // An IdP that re-creates instead of re-activating must be told the resource
    // exists, not handed a second membership.
    if (already) throw scimUniqueness(`A user with userName '${attrs.userName ?? email}' already exists in this organization.`);
  }

  const userId = await createMembership(ctx, { email, attrs, active, existingUser });

  logger.info('[SCIM] provisioned member', { orgId: ctx.orgId, userId: String(userId), active });
  return { resource: await getUser(ctx, String(userId)), action: 'create', changed: ['userName', 'active'] };
}

/**
 * The transactional half of {@link createUser}, split out so the duplicate-key
 * race has one place to be translated.
 *
 * Two concurrent POSTs for the same person both pass the pre-checks; the loser
 * hits the `(userId, organizationId)` unique index (or the account's unique
 * email/username). That is the SAME situation the pre-check reports as
 * `uniqueness`, and an IdP knows what to do with a 409 — so it is reported
 * identically rather than as a 500 the sync would retry forever.
 */
/** The SCIM seat-limit refusal, carrying the account's current cap. */
function seatLimitRefusal(orgId: string): () => Promise<Error> {
  return async () => scimSeatLimit((await pooledSeatUsage(orgId)).limit);
}

async function createMembership(
  ctx: ScimContext,
  input: {
    email: string;
    attrs: ReturnType<typeof scimAttributes>;
    active: boolean;
    existingUser: (UserDocument & { _id: Types.ObjectId }) | null;
  },
): Promise<Types.ObjectId> {
  const { email, attrs, active } = input;
  const oid = toOrgId(ctx.orgId);
  try {
    return await withMongoTransaction(async (session): Promise<Types.ObjectId> =>
      // SEATS: an inactive membership occupies none, so only an active create is
      // charged. Distinct humans — someone already seated elsewhere in the
      // account costs nothing to add here.
      withSeatGuard({
        userId: input.existingUser?._id,
        orgId: ctx.orgId,
        session,
        consumesSeat: active,
        refuse: seatLimitRefusal(ctx.orgId),
      }, async () => {
        let user: (UserDocument & { _id: Types.ObjectId }) | null = input.existingUser;
        if (!user) {
          // The local part may already be someone's username; probe for a free one
          // (same loop as the invitation and OAuth provisioning paths).
          const base = email.split('@')[0].replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'user';
          let username = base;
          for (let suffix = 1; await User.exists({ username }).session(session); suffix += 1) username = `${base}${suffix}`;
          user = new User({
            email,
            username,
            // The directory authenticated the address and the org has proven it owns
            // the domain — the same standing an SSO-provisioned identity gets.
            isEmailVerified: true,
            tokenVersion: 0,
          });
          await user.save({ session });
        }

        await UserOrganization.create([{
          userId: user._id,
          organizationId: oid,
          // Always a plain member. A mapped Role may raise the effective role;
          // ownership is never provisioned by a directory.
          role: 'member',
          isActive: active,
          scim: { ...attrs, groups: [], managed: true, lastSyncedAt: new Date() },
        }], { session });
        // Single-source RBAC: without the built-in Member floor the membership would
        // resolve to zero permissions. Stamped `manual`, so no sync ever strips it.
        await ensureBaselineRole(user._id, oid, session);
        return user._id;
      }));
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw scimUniqueness(`A user with userName '${attrs.userName ?? email}' already exists in this organization.`);
    }
    throw err;
  }
}

/**
 * Apply directory-owned attributes to a membership, returning what moved.
 *
 * `userName` is write-ONCE. It is the SCIM identity attribute, and the platform
 * account behind the membership is addressed by `User.email`, which a tenant's
 * directory may not rewrite: re-pointing an existing membership at a new address
 * would be an account takeover by rename, and silently accepting the change while
 * leaving the email alone would leave the IdP believing a rename it can never see
 * took effect. A first claim (a membership SCIM adopts, whose `scim.userName` is
 * still unset) is fine; a later CHANGE is `mutability`.
 */
function applyAttributes(membership: UserOrganizationDocument, attrs: Partial<ReturnType<typeof scimAttributes>>): string[] {
  // `membership.scim` is a Mongoose SUB-DOCUMENT: spreading it directly copies
  // its internals (`$__`, `_doc`, …) and NONE of the schema fields, which
  // silently emptied `current` — and with it the write-once check below. Convert
  // through `toObject()` when it is one.
  const stored = membership.scim as (ScimMembershipState & { toObject?: () => ScimMembershipState }) | undefined;
  const current: ScimMembershipState = stored
    ? { ...(typeof stored.toObject === 'function' ? stored.toObject() : stored) }
    : {};
  if (attrs.userName && current.userName && attrs.userName !== current.userName) {
    throw scimMutability(
      'userName is immutable: it identifies the Pipeline Builder account behind this membership. '
      + 'Remove this user and provision the new address instead.',
    );
  }
  const changed: string[] = [];
  for (const key of ['externalId', 'userName', 'givenName', 'familyName', 'displayName'] as const) {
    const next = attrs[key];
    if (next === undefined) continue;
    if ((current[key] ?? null) !== next) changed.push(key);
    current[key] = next;
  }
  current.managed = true;
  current.lastSyncedAt = new Date();
  membership.set('scim', { ...current, groups: current.groups ?? [] });
  return changed;
}

/**
 * Flip a membership's active flag, with every consequence that carries.
 *
 * Deactivating revokes the member's sessions in the SAME transaction and drops
 * the Roles their groups granted (manual ones stay — the admin's decision
 * outlives the directory's). Activating re-charges a seat through the pooled cap
 * and restores the Roles their current groups map to.
 */
async function setActive(ctx: ScimContext, membership: UserOrganizationDocument, active: boolean): Promise<string[]> {
  if (membership.isActive === active) return [];
  if (membership.role === 'owner') throw scimOwnerProtected();
  await assertNotPlatformAdmin(membership.userId);

  if (active) {
    assertIntentAllowed(ctx, 'update');
    await withMongoTransaction((session) => withSeatGuard(
      { userId: membership.userId, orgId: ctx.orgId, session, refuse: seatLimitRefusal(ctx.orgId) },
      async () => { await UserOrganization.updateOne({ _id: membership._id }, { $set: { isActive: true } }, { session }); },
    ));
    membership.isActive = true;
    await resyncMemberRoles(ctx.orgId, membership.userId, membership.scim?.groups ?? []);
    return ['active'];
  }

  assertIntentAllowed(ctx, 'deactivate');
  await withMongoTransaction(async (session) => {
    await UserOrganization.updateOne({ _id: membership._id }, { $set: { isActive: false } }, { session });
    await endOrgAccess(membership.userId, ctx.orgId, session);
  });
  membership.isActive = false;
  // Post-commit: make the revocation true on the stateless services too.
  await publishUserRevocation(String(membership.userId));
  // The directory says they are gone: the Roles it granted go with them.
  await resyncMemberRoles(ctx.orgId, membership.userId, []);
  logger.info('[SCIM] deactivated member and ended their access to the org', { orgId: ctx.orgId, userId: String(membership.userId) });
  return ['active'];
}

/** PUT /Users/:id — replace the directory-owned attributes and the active flag. */
export async function replaceUser(ctx: ScimContext, id: string, body: Record<string, unknown>): Promise<ScimWriteOutcome<ScimUserResource>> {
  const membership = await requireMembership(ctx.orgId, id);
  const active = body.active === undefined ? membership.isActive : body.active === true;

  // A PUT that only turns someone off IS a deactivation and survives a
  // downgrade; anything else in the body is an update and does not. Decided on
  // the REQUESTED state, not on whether it differs: re-sending `active:false`
  // for someone already deactivated must stay a no-op success, not become an
  // "update" a downgraded org is refused.
  const deactivating = active === false;
  if (!deactivating) assertIntentAllowed(ctx, 'update');

  const changed: string[] = [];
  // When the org is entitled the whole body applies; when it is not, this line
  // is only reached for a deactivation, and the attributes are deliberately
  // ignored rather than half-applied.
  if (ctx.entitled) {
    changed.push(...applyAttributes(membership, scimAttributes(body)));
    if (changed.length > 0) await membership.save();
  }
  changed.push(...await setActive(ctx, membership, active));

  return {
    resource: await getUser(ctx, id),
    action: deactivating ? 'deactivate' : 'update',
    changed,
  };
}
/**
 * PATCH /Users/:id (RFC 7644 §3.5.2).
 *
 * Supported paths: `active`, `userName`, `externalId`, `displayName`,
 * `name.givenName`, `name.familyName`. An attribute this API does not model
 * (phone numbers, addresses, the enterprise-user extension …) is IGNORED rather
 * than refused: Entra and Okta both send them unconditionally, and answering 400
 * would fail the whole provisioning run over an attribute that changes nothing
 * here. Malformed operations still fail with `invalidSyntax`.
 */
export async function patchUser(ctx: ScimContext, id: string, ops: unknown): Promise<ScimWriteOutcome<ScimUserResource>> {
  const operations = normalizePatchOps(ops);
  const membership = await requireMembership(ctx.orgId, id);

  const attrs: Partial<ReturnType<typeof scimAttributes>> = {};
  let nextActive: boolean | undefined;
  let ignored = 0;

  for (const { op, raw } of operations) {
    for (const [path, value] of patchPairs(raw)) {
      const attr = path.toLowerCase();
      const cleared = op === 'remove' ? null : value;
      switch (attr) {
        case 'active': nextActive = op === 'remove' ? false : asBoolean(value); break;
        case 'username': attrs.userName = cleared === null ? null : String(cleared); break;
        case 'externalid': attrs.externalId = cleared === null ? null : String(cleared); break;
        case 'displayname': attrs.displayName = cleared === null ? null : String(cleared); break;
        case 'name.givenname': attrs.givenName = cleared === null ? null : String(cleared); break;
        case 'name.familyname': attrs.familyName = cleared === null ? null : String(cleared); break;
        default: ignored += 1; break;
      }
    }
  }

  // Decided on the REQUESTED state, not on whether it differs from the current
  // one: an IdP that re-sends `active:false` for someone already deactivated
  // must get the same no-op success, including after a downgrade.
  const deactivating = nextActive === false;
  const attributeChange = Object.keys(attrs).length > 0;
  // The asymmetry at its narrowest: after a downgrade a PATCH is accepted only
  // when it is a deactivation and NOTHING else.
  if (!ctx.entitled && (!deactivating || attributeChange)) throw scimNotEntitled();
  if (attributeChange) assertIntentAllowed(ctx, 'update');

  const changed = attributeChange ? applyAttributes(membership, attrs) : [];
  if (changed.length > 0) await membership.save();
  if (nextActive !== undefined) changed.push(...await setActive(ctx, membership, nextActive));

  if (ignored > 0) logger.debug('[SCIM] ignored unmodelled PATCH attributes', { orgId: ctx.orgId, ignored });
  return {
    resource: await getUser(ctx, id),
    action: deactivating ? 'deactivate' : nextActive === true ? 'activate' : 'update',
    changed,
  };
}

/**
 * DELETE /Users/:id — the directory removed the person.
 *
 * Deactivates the membership and revokes their sessions immediately (the plan's
 * requirement), drops every Role the directory granted, and empties their group
 * set. The membership ROW is kept deliberately: it carries the audit trail, the
 * hand-granted Roles an admin may want back, and the seat accounting — and a
 * deactivated membership grants nothing. Idempotent: deleting an already-removed
 * user answers 204 again.
 */
export async function deleteUser(ctx: ScimContext, id: string): Promise<ScimWriteOutcome<{ id: string }>> {
  assertIntentAllowed(ctx, 'delete');
  const membership = await requireMembership(ctx.orgId, id);
  if (membership.role === 'owner') throw scimOwnerProtected();
  await assertNotPlatformAdmin(membership.userId);

  const hadGroups = (membership.scim?.groups ?? []).length > 0;
  if (membership.isActive || hadGroups) {
    await withMongoTransaction(async (session) => {
      await UserOrganization.updateOne(
        { _id: membership._id },
        { $set: { 'isActive': false, 'scim.groups': [], 'scim.lastSyncedAt': new Date() } },
        { session },
      );
      await endOrgAccess(membership.userId, ctx.orgId, session);
    });
    await publishUserRevocation(String(membership.userId));
    await resyncMemberRoles(ctx.orgId, membership.userId, []);
    logger.info('[SCIM] removed member (deactivated + org access ended)', { orgId: ctx.orgId, userId: id });
  }
  return { resource: { id }, action: 'delete', changed: ['active'] };
}

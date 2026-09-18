// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM 2.0 provisioning (3b) — RFC 7643 (schema) / RFC 7644 (protocol).
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
 *     group → Role editor (3a) writes. SCIM owns the group's NAME and its
 *     MEMBERS; it never sets `roleIds`. What a group is WORTH stays an
 *     in-product decision made by a human holding `roles:manage`, so a
 *     compromised SCIM key can move people between groups but cannot invent a
 *     group that grants admin.
 *
 * HOW A ROLE FOLLOWS FROM A GROUP
 *   Every membership change resolves the member's current group keys through
 *   3a's {@link IdpGroupMappingService.resolveMappedRoles} and reconciles the
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
 *   REVOCATION  — a deactivation bumps `tokenVersion`, clears the refresh-session
 *                 slots and publishes the revocation, so access ends on the next
 *                 request everywhere — not at token expiry.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { Types, type ClientSession } from 'mongoose';
import { idpGroupMappingService, MAX_MAPPINGS_PER_ORG } from './idp-group-mapping-service.js';
import { ensureBaselineRole, recomputeUserOrgRole, syncMappedRoles } from './roles-service.js';
import {
  scimInvalidFilter,
  scimInvalidSyntax,
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
  SCIM_GROUP_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_MAX_COUNT,
  SCIM_MAX_MEMBERS_PER_REQUEST,
  SCIM_DEFAULT_COUNT,
  SCIM_USER_SCHEMA,
} from '../constants/scim.js';
import { groupKey } from '../helpers/idp-claims.js';
import { toOrgId } from '../helpers/org-id.js';
import { pooledSeatUsage, seatCapacityAvailable, seatCapacityStillWithinCap, userHasSeatInAccount } from '../helpers/seats.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { emailDomain, ownsVerifiedDomain } from '../helpers/sso-enforcement.js';
import IdpGroupMapping, { type IdpGroupMappingDocument } from '../models/idp-group-mapping.js';
import UserOrganization, { type ScimMembershipState, type UserOrganizationDocument } from '../models/user-organization.js';
import User, { type UserDocument } from '../models/user.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('scim-service');

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface ScimMeta {
  resourceType: 'User' | 'Group';
  created: string;
  lastModified: string;
  location: string;
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  displayName?: string;
  emails: Array<{ value: string; type: 'work'; primary: true }>;
  active: boolean;
  groups: Array<{ value: string; display: string; type: 'direct' }>;
  meta: ScimMeta;
}

export interface ScimGroupResource {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members: Array<{ value: string; display: string; type: 'User' }>;
  meta: ScimMeta;
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/** One PATCH operation (RFC 7644 §3.5.2). */
export interface ScimPatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

/** Query parameters every list endpoint accepts. */
export interface ScimListQuery {
  filter?: string;
  startIndex?: string;
  count?: string;
}

/**
 * What a write actually did, for the audit row and the metric. The controller
 * turns `action` into the audit action; `changed` names the attributes that
 * moved, never their values.
 */
export interface ScimWriteOutcome<T> {
  resource: T;
  action: 'create' | 'update' | 'activate' | 'deactivate' | 'delete' | 'members';
  changed: string[];
  /** Users whose Role set the write reconciled (audited as the blast radius). */
  affectedUserIds?: string[];
}

/**
 * The org a SCIM request acts on, plus whether it still holds the entitlement.
 * Built once per request by the controller from the VERIFIED token, so nothing
 * below ever reads an org id from the path or the body.
 */
export interface ScimContext {
  orgId: string;
  /** The org's live `sso` entitlement. False ⇒ removal-only (see the header). */
  entitled: boolean;
}

/** What a write is trying to do, for the post-downgrade asymmetry. */
type ScimIntent = 'create' | 'update' | 'deactivate' | 'delete';

/**
 * The downgrade gate, in one place: after the entitlement lapses, only writes
 * that REMOVE access are accepted. Reads never reach here — an IdP has to look a
 * user up before it can deactivate them, so refusing GET would break the very
 * path this asymmetry exists to keep working.
 */
function assertIntentAllowed(ctx: ScimContext, intent: ScimIntent): void {
  if (ctx.entitled) return;
  if (intent === 'deactivate' || intent === 'delete') return;
  throw scimNotEntitled();
}

// ---------------------------------------------------------------------------
// Filter + pagination parsing
// ---------------------------------------------------------------------------

/** `attr eq "value"` (and the unquoted `attr eq true` Okta sends for `active`) —
 *  the only filter form the plan requires, and the only one Okta/Entra send for
 *  the provisioning flows. Anything else is refused with `invalidFilter` rather
 *  than silently returning everything, which would make an IdP conclude a user
 *  doesn't exist and create a duplicate. */
const EQ_FILTER = /^\s*([A-Za-z][\w.]*)\s+eq\s+(?:"((?:[^"\\]|\\.)*)"|(true|false))\s*$/i;

export interface ParsedFilter {
  attribute: string;
  value: string;
}

/** Parse a supported `eq` filter, or undefined when the client sent none. */
export function parseScimFilter(filter: string | undefined, supported: readonly string[]): ParsedFilter | undefined {
  if (filter === undefined || filter.trim() === '') return undefined;
  const m = EQ_FILTER.exec(filter);
  if (!m) {
    throw scimInvalidFilter(`Unsupported filter. This endpoint supports only: ${supported.map((a) => `${a} eq "…"`).join(', ')}`);
  }
  const attribute = m[1];
  if (!supported.some((s) => s.toLowerCase() === attribute.toLowerCase())) {
    throw scimInvalidFilter(`Filtering on '${attribute}' is not supported. Supported attributes: ${supported.join(', ')}`);
  }
  // Unescape the two sequences JSON-ish SCIM filter strings may carry.
  const raw = m[2] !== undefined ? m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : m[3];
  return { attribute: attribute.toLowerCase(), value: raw };
}

/** 1-based `startIndex` + bounded `count` (RFC 7644 §3.4.2.4). Out-of-range
 *  values are CLAMPED, never refused: the RFC says a startIndex < 1 is
 *  interpreted as 1, and a negative count as zero. */
export function parseScimPagination(query: ScimListQuery): { skip: number; limit: number; startIndex: number } {
  const rawStart = Number.parseInt(query.startIndex ?? '', 10);
  const startIndex = Number.isFinite(rawStart) && rawStart > 1 ? rawStart : 1;
  const rawCount = Number.parseInt(query.count ?? '', 10);
  const limit = Number.isFinite(rawCount)
    ? Math.max(0, Math.min(rawCount, SCIM_MAX_COUNT))
    : SCIM_DEFAULT_COUNT;
  return { skip: startIndex - 1, limit, startIndex };
}

// ---------------------------------------------------------------------------
// Resource rendering
// ---------------------------------------------------------------------------

/** Public base URL of the SCIM endpoint, used for `meta.location`. Resolved
 *  from configuration (never from the request) so a spoofed Host header can't
 *  point an IdP's follow-up calls somewhere else. */
async function scimBaseUrl(): Promise<string> {
  const { config } = await import('../config/index.js');
  return `${config.app.frontendUrl.replace(/\/+$/, '')}/api/scim/v2`;
}

type MembershipLike = Pick<UserOrganizationDocument, 'isActive' | 'role' | 'joinedAt' | 'scim'> & {
  userId: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
};

type UserLike = { _id: unknown; email: string; username: string; createdAt?: Date };

function userResource(
  user: UserLike,
  membership: MembershipLike,
  groupsByKey: Map<string, { id: string; display: string }>,
  baseUrl: string,
): ScimUserResource {
  const s = membership.scim ?? {};
  const id = String(user._id);
  const given = s.givenName ?? undefined;
  const family = s.familyName ?? undefined;
  const formatted = [given, family].filter(Boolean).join(' ') || undefined;
  return {
    schemas: [SCIM_USER_SCHEMA],
    ...(s.externalId ? { externalId: s.externalId } : {}),
    id,
    userName: s.userName || user.email,
    ...(given || family ? { name: { ...(given ? { givenName: given } : {}), ...(family ? { familyName: family } : {}), ...(formatted ? { formatted } : {}) } } : {}),
    ...(s.displayName ? { displayName: s.displayName } : {}),
    emails: [{ value: user.email, type: 'work', primary: true }],
    active: membership.isActive,
    // Read-only per RFC 7643 §4.1.2: group membership is changed through the
    // Groups endpoint, never by writing this back on a User.
    groups: (s.groups ?? [])
      .map((key) => groupsByKey.get(key))
      .filter((g): g is { id: string; display: string } => !!g)
      .map((g) => ({ value: g.id, display: g.display, type: 'direct' as const })),
    meta: {
      resourceType: 'User',
      created: new Date(membership.joinedAt ?? membership.createdAt ?? Date.now()).toISOString(),
      lastModified: new Date(membership.updatedAt ?? membership.joinedAt ?? Date.now()).toISOString(),
      location: `${baseUrl}/Users/${id}`,
    },
  };
}

/** Enough of a mapping row to render — satisfied by both a document and a lean object. */
type GroupLike = {
  _id: unknown;
  group: string;
  scimExternalId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

function groupResource(
  doc: GroupLike,
  members: Array<{ value: string; display: string }>,
  baseUrl: string,
): ScimGroupResource {
  const id = String(doc._id);
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    ...(doc.scimExternalId ? { externalId: doc.scimExternalId } : {}),
    id,
    displayName: doc.group,
    members: members.map((m) => ({ ...m, type: 'User' as const })),
    meta: {
      resourceType: 'Group',
      created: new Date(doc.createdAt ?? Date.now()).toISOString(),
      lastModified: new Date(doc.updatedAt ?? Date.now()).toISOString(),
      location: `${baseUrl}/Groups/${id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

/** Every group mapping of the org, keyed by `groupKey` (for rendering a user's
 *  `groups` without a query per member). */
async function groupIndex(orgId: string): Promise<Map<string, { id: string; display: string }>> {
  const docs = await IdpGroupMapping.find({ orgId }).select('group groupKey').lean();
  return new Map(docs.map((d) => [d.groupKey, { id: String(d._id), display: d.group }]));
}

/** The membership a SCIM `id` names, or 404. The id is the platform user id. */
async function requireMembership(orgId: string, id: string): Promise<UserOrganizationDocument> {
  if (!Types.ObjectId.isValid(id)) throw scimNotFound('User');
  const membership = await UserOrganization.findOne({ userId: new Types.ObjectId(id), organizationId: toOrgId(orgId) });
  if (!membership) throw scimNotFound('User');
  return membership;
}

/** Refuse to touch a platform administrator through a tenant's directory. */
async function assertNotPlatformAdmin(userId: Types.ObjectId | string): Promise<void> {
  const user = await User.findById(userId).select('+isSuperAdmin').lean();
  if (user?.isSuperAdmin === true) throw scimPlatformAdmin();
}

/**
 * Reconcile ONE member's Role set against the groups the directory now puts them
 * in, and force a token reissue when the effective grants moved.
 *
 * Identical in substance to the JIT sign-in path: resolve through 3a's shared
 * resolver, `syncMappedRoles` (which only removes `source: 'jit'` rows, so
 * hand-granted Roles survive), recompute the cached coarse role, bump
 * `tokenVersion`, then publish the revocation post-commit so the stateless
 * services drop the older access tokens immediately.
 */
async function resyncMemberRoles(orgId: string, userId: Types.ObjectId | string, groups: readonly string[]): Promise<void> {
  const { roleIds } = await idpGroupMappingService.resolveMappedRoles(orgId, groups);
  const oid = toOrgId(orgId);
  const changed = await withMongoTransaction(async (session) => {
    const { added, removed } = await syncMappedRoles(oid, userId, roleIds, session);
    if (added.length === 0 && removed.length === 0) return false;
    await recomputeUserOrgRole(userId, oid, session);
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }, { session });
    return true;
  });
  if (changed) await publishUserRevocation(String(userId));
}

/**
 * End every live session of a member whose access was just withdrawn.
 *
 * `requireAuth` trusts an access token's claims and only re-reads `tokenVersion`,
 * so without the bump a deactivated member would keep full access until their
 * token expired. Clearing the refresh slots blocks a silent re-issue, and the
 * post-commit publish makes the same true on the stateless services. Exactly what
 * `orgMembersService.deactivateMember` does — reproduced here rather than called
 * because that method refuses an already-inactive membership (SCIM must be
 * idempotent) and emits its own member-lifecycle audit.
 */
async function revokeSessions(userId: Types.ObjectId | string, orgId: string, session: ClientSession): Promise<void> {
  await User.updateOne(
    { _id: userId },
    { $inc: { tokenVersion: 1 }, $set: { refreshSessions: [] } },
    { session },
  );
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
  const byId = new Map(users.map((u) => [String(u._id), u as unknown as UserLike]));

  const Resources = memberships
    .map((m) => {
      const user = byId.get(String(m.userId));
      // A membership whose account was hard-deleted out from under it: skip
      // rather than render a resource with no identity.
      return user ? userResource(user, m as unknown as MembershipLike, groups, baseUrl) : null;
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
  return userResource(user as unknown as UserLike, membership as unknown as MembershipLike, groups, baseUrl);
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

  // SEATS: an inactive membership occupies none, so only an active create is
  // charged. Distinct humans — someone already seated elsewhere in the account
  // costs nothing to add here.
  const alreadySeated = existingUser ? await userHasSeatInAccount(existingUser._id, ctx.orgId) : false;
  if (active && !alreadySeated && !(await seatCapacityAvailable(ctx.orgId, 1))) {
    throw scimSeatLimit((await pooledSeatUsage(ctx.orgId)).limit);
  }

  const userId = await createMembership(ctx, { email, attrs, active, alreadySeated, existingUser });

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
async function createMembership(
  ctx: ScimContext,
  input: {
    email: string;
    attrs: ReturnType<typeof scimAttributes>;
    active: boolean;
    alreadySeated: boolean;
    existingUser: (UserDocument & { _id: Types.ObjectId }) | null;
  },
): Promise<Types.ObjectId> {
  const { email, attrs, active, alreadySeated } = input;
  const oid = toOrgId(ctx.orgId);
  try {
    return await withMongoTransaction(async (session): Promise<Types.ObjectId> => {
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

      // Post-write re-check (the G5 pattern every seat-consuming write runs): a
      // concurrent invite or sign-in must not leave the account over its cap.
      if (active && !alreadySeated && !(await seatCapacityStillWithinCap(ctx.orgId, session))) {
        throw scimSeatLimit((await pooledSeatUsage(ctx.orgId)).limit);
      }
      return user._id;
    });
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
    const alreadySeated = await userHasSeatInAccount(membership.userId, ctx.orgId);
    if (!alreadySeated && !(await seatCapacityAvailable(ctx.orgId, 1))) {
      throw scimSeatLimit((await pooledSeatUsage(ctx.orgId)).limit);
    }
    await withMongoTransaction(async (session) => {
      await UserOrganization.updateOne({ _id: membership._id }, { $set: { isActive: true } }, { session });
      if (!alreadySeated && !(await seatCapacityStillWithinCap(ctx.orgId, session))) {
        throw scimSeatLimit((await pooledSeatUsage(ctx.orgId)).limit);
      }
    });
    membership.isActive = true;
    await resyncMemberRoles(ctx.orgId, membership.userId, membership.scim?.groups ?? []);
    return ['active'];
  }

  assertIntentAllowed(ctx, 'deactivate');
  await withMongoTransaction(async (session) => {
    await UserOrganization.updateOne({ _id: membership._id }, { $set: { isActive: false } }, { session });
    await revokeSessions(membership.userId, ctx.orgId, session);
  });
  membership.isActive = false;
  // Post-commit: make the revocation true on the stateless services too.
  await publishUserRevocation(String(membership.userId));
  // The directory says they are gone: the Roles it granted go with them.
  await resyncMemberRoles(ctx.orgId, membership.userId, []);
  logger.info('[SCIM] deactivated member and revoked sessions', { orgId: ctx.orgId, userId: String(membership.userId) });
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

/** Value of a PATCH op, tolerating both `{path:'active', value:false}` and the
 *  path-less `{value:{active:false}}` form every major IdP also emits. */
function patchPairs(op: ScimPatchOperation): Array<[string, unknown]> {
  if (typeof op.path === 'string' && op.path.trim() !== '') return [[op.path.trim(), op.value]];
  if (op.value && typeof op.value === 'object' && !Array.isArray(op.value)) return Object.entries(op.value as Record<string, unknown>);
  throw scimInvalidSyntax('Each PATCH operation must carry a `path`, or a `value` object of attributes.');
}

/** Coerce the many spellings of a boolean an IdP may send for `active`. */
function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  throw scimInvalidValue('`active` must be a boolean.');
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
  if (!Array.isArray(ops) || ops.length === 0) {
    throw scimInvalidSyntax('A PatchOp must carry a non-empty `Operations` array.');
  }
  const membership = await requireMembership(ctx.orgId, id);

  const attrs: Partial<ReturnType<typeof scimAttributes>> = {};
  let nextActive: boolean | undefined;
  let ignored = 0;

  for (const raw of ops as ScimPatchOperation[]) {
    const op = String(raw?.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw scimInvalidSyntax(`Unsupported PATCH op '${raw?.op}'. Use add, replace or remove.`);
    }
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
      await revokeSessions(membership.userId, ctx.orgId, session);
    });
    await publishUserRevocation(String(membership.userId));
    await resyncMemberRoles(ctx.orgId, membership.userId, []);
    logger.info('[SCIM] removed member (deactivated + sessions revoked)', { orgId: ctx.orgId, userId: id });
  }
  return { resource: { id }, action: 'delete', changed: ['active'] };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const GROUP_FILTER_ATTRS = ['displayName', 'externalId'] as const;

/** Members of the given group keys, as `{ groupKey → [{value, display}] }`. */
async function membersOf(orgId: string, keys: readonly string[]): Promise<Map<string, Array<{ value: string; display: string }>>> {
  const out = new Map<string, Array<{ value: string; display: string }>>(keys.map((k) => [k, []]));
  if (keys.length === 0) return out;
  const memberships = await UserOrganization.find({ 'organizationId': toOrgId(orgId), 'scim.groups': { $in: keys } })
    .select('userId scim.groups').lean();
  if (memberships.length === 0) return out;
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } }).select('email').lean();
  const emailById = new Map(users.map((u) => [String(u._id), u.email]));
  for (const m of memberships) {
    const entry = { value: String(m.userId), display: emailById.get(String(m.userId)) ?? String(m.userId) };
    for (const key of ((m as { scim?: { groups?: string[] } }).scim?.groups ?? [])) {
      out.get(key)?.push(entry);
    }
  }
  return out;
}

export async function listGroups(ctx: ScimContext, query: ScimListQuery): Promise<ScimListResponse<ScimGroupResource>> {
  const parsed = parseScimFilter(query.filter, GROUP_FILTER_ATTRS);
  const { skip, limit, startIndex } = parseScimPagination(query);

  const where: Record<string, unknown> = { orgId: ctx.orgId };
  if (parsed?.attribute === 'externalid') where.scimExternalId = parsed.value;
  else if (parsed) where.groupKey = groupKey(parsed.value);

  const totalResults = await IdpGroupMapping.countDocuments(where);
  const docs = limit === 0 ? [] : await IdpGroupMapping.find(where).sort({ groupKey: 1 }).skip(skip).limit(limit).lean();
  const [members, baseUrl] = await Promise.all([membersOf(ctx.orgId, docs.map((d) => d.groupKey)), scimBaseUrl()]);

  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: docs.length,
    Resources: docs.map((d) => groupResource(d as unknown as GroupLike, members.get(d.groupKey) ?? [], baseUrl)),
  };
}

async function requireGroup(orgId: string, id: string): Promise<IdpGroupMappingDocument> {
  if (!Types.ObjectId.isValid(id)) throw scimNotFound('Group');
  const doc = await IdpGroupMapping.findOne({ _id: new Types.ObjectId(id), orgId });
  if (!doc) throw scimNotFound('Group');
  return doc;
}

export async function getGroup(ctx: ScimContext, id: string): Promise<ScimGroupResource> {
  const doc = await requireGroup(ctx.orgId, id);
  const [members, baseUrl] = await Promise.all([membersOf(ctx.orgId, [doc.groupKey]), scimBaseUrl()]);
  return groupResource(doc as unknown as GroupLike, members.get(doc.groupKey) ?? [], baseUrl);
}

/**
 * Validate a `members` array and resolve it to memberships of THIS org.
 *
 * `verify: false` skips the "must already be provisioned here" check, used for
 * REMOVALS: a directory that removes someone from a group after an admin already
 * removed their membership must still succeed — the removal is a no-op, and
 * failing it would stall the whole sync on an outcome that is already true.
 */
async function resolveMembers(orgId: string, raw: unknown, opts: { verify?: boolean } = {}): Promise<Types.ObjectId[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw scimInvalidSyntax('`members` must be an array.');
  if (raw.length > SCIM_MAX_MEMBERS_PER_REQUEST) {
    throw scimInvalidValue(`At most ${SCIM_MAX_MEMBERS_PER_REQUEST} members may be sent in one request — page the change.`);
  }
  const ids = raw.map((m) => {
    const value = typeof m === 'string' ? m : (m as Record<string, unknown>)?.value;
    if (typeof value !== 'string' || !Types.ObjectId.isValid(value)) {
      throw scimInvalidValue('Each member must carry a `value` naming a user provisioned in this organization.');
    }
    return new Types.ObjectId(value);
  });
  if (ids.length === 0) return [];
  if (opts.verify === false) return [...new Map(ids.map((id) => [String(id), id])).values()];

  // Every member must already be a membership of this org: a group is a set of
  // people the directory has provisioned here, not a way to reach into another
  // tenant's roster.
  const found = await UserOrganization.find({ organizationId: toOrgId(orgId), userId: { $in: ids } }).select('userId').lean();
  const known = new Set(found.map((m) => String(m.userId)));
  const missing = ids.map(String).filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw scimInvalidValue(`Not provisioned in this organization: ${missing.slice(0, 5).join(', ')}. Create the user before adding them to a group.`);
  }
  return [...new Map(ids.map((id) => [String(id), id])).values()];
}

/** Add/remove one group key across a set of memberships, then reconcile each
 *  member's Roles. Returns the ids actually touched. */
async function applyGroupMembership(
  orgId: string,
  key: string,
  add: readonly Types.ObjectId[],
  remove: readonly Types.ObjectId[],
): Promise<string[]> {
  const oid = toOrgId(orgId);
  if (add.length > 0) {
    await UserOrganization.updateMany(
      { organizationId: oid, userId: { $in: add } },
      { $addToSet: { 'scim.groups': key }, $set: { 'scim.managed': true, 'scim.lastSyncedAt': new Date() } },
    );
  }
  if (remove.length > 0) {
    await UserOrganization.updateMany(
      { organizationId: oid, userId: { $in: remove } },
      { $pull: { 'scim.groups': key }, $set: { 'scim.lastSyncedAt': new Date() } },
    );
  }

  const touched = [...new Set([...add, ...remove].map(String))];
  // Reconcile sequentially: each is its own transaction, and a group push is a
  // background sync — bounded work matters more than latency here.
  for (const userId of touched) {
    const membership = await UserOrganization.findOne({ organizationId: oid, userId: new Types.ObjectId(userId) })
      .select('scim.groups').lean();
    await resyncMemberRoles(orgId, userId, (membership as { scim?: { groups?: string[] } } | null)?.scim?.groups ?? []);
  }
  return touched;
}

/**
 * POST /Groups — push a directory group.
 *
 * The row this creates grants NOTHING until someone holding `roles:manage` maps
 * it to Roles in the SSO settings editor: SCIM owns the group's name and its
 * members, never its `roleIds`. That is what keeps a stolen SCIM key from being
 * a privilege-escalation primitive.
 */
export async function createGroup(ctx: ScimContext, body: Record<string, unknown>): Promise<ScimWriteOutcome<ScimGroupResource>> {
  assertIntentAllowed(ctx, 'create');
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName) throw scimInvalidValue('`displayName` is required.');

  const key = groupKey(displayName);
  if (await IdpGroupMapping.exists({ orgId: ctx.orgId, groupKey: key })) {
    throw scimUniqueness(`A group named '${displayName}' already exists in this organization.`);
  }
  if (await IdpGroupMapping.countDocuments({ orgId: ctx.orgId }) >= MAX_MAPPINGS_PER_ORG) {
    throw scimInvalidValue(`An organization can hold at most ${MAX_MAPPINGS_PER_ORG} directory groups.`);
  }
  const members = await resolveMembers(ctx.orgId, body.members);

  const doc = await IdpGroupMapping.create({
    orgId: ctx.orgId,
    group: displayName,
    groupKey: key,
    // Never set by SCIM — see the function docs.
    roleIds: [],
    scimExternalId: typeof body.externalId === 'string' ? body.externalId.slice(0, 256) : null,
    scimManaged: true,
    createdBy: 'scim',
    updatedBy: 'scim',
  });
  const affectedUserIds = await applyGroupMembership(ctx.orgId, key, members, []);

  logger.info('[SCIM] created directory group', { orgId: ctx.orgId, group: key, members: members.length });
  return { resource: await getGroup(ctx, String(doc._id)), action: 'create', changed: ['displayName', 'members'], affectedUserIds };
}

/**
 * PUT /Groups/:id — replace the group's name and its member set.
 *
 * `members` ABSENT from the body leaves the membership untouched; an explicit
 * array (empty included) replaces it. A strict reading of PUT would clear an
 * absent multi-valued attribute, but a client that renames a group with a
 * name-only PUT would then silently empty it — and with it every Role the group
 * mapped to. Clearing has to be asked for.
 */
export async function replaceGroup(ctx: ScimContext, id: string, body: Record<string, unknown>): Promise<ScimWriteOutcome<ScimGroupResource>> {
  const doc = await requireGroup(ctx.orgId, id);
  const replacesMembers = body.members !== undefined;
  const members = await resolveMembers(ctx.orgId, body.members);
  const current = await membersOf(ctx.orgId, [doc.groupKey]);
  const currentIds = new Set((current.get(doc.groupKey) ?? []).map((m) => m.value));
  const nextIds = new Set(members.map(String));
  const removing = replacesMembers ? [...currentIds].filter((mid) => !nextIds.has(mid)) : [];
  const adding = replacesMembers ? members.filter((mid) => !currentIds.has(String(mid))) : [];

  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : doc.group;
  const renaming = displayName !== doc.group;
  // Removal-only after a downgrade: dropping members still works, adding or
  // renaming does not.
  if (renaming || adding.length > 0) assertIntentAllowed(ctx, 'update');

  const changed: string[] = [];
  if (renaming) {
    const key = groupKey(displayName);
    if (key !== doc.groupKey && await IdpGroupMapping.exists({ orgId: ctx.orgId, groupKey: key, _id: { $ne: doc._id } })) {
      throw scimUniqueness(`A group named '${displayName}' already exists in this organization.`);
    }
    await renameGroupKey(ctx.orgId, doc, displayName, key);
    changed.push('displayName');
  }
  if (typeof body.externalId === 'string' && body.externalId !== doc.scimExternalId) {
    doc.scimExternalId = body.externalId.slice(0, 256);
    await doc.save();
    changed.push('externalId');
  }

  const affectedUserIds = await applyGroupMembership(
    ctx.orgId,
    doc.groupKey,
    adding,
    removing.map((mid) => new Types.ObjectId(mid)),
  );
  if (affectedUserIds.length > 0) changed.push('members');

  return { resource: await getGroup(ctx, id), action: renaming || adding.length > 0 ? 'update' : 'members', changed, affectedUserIds };
}

/** Rename a group, carrying every member's stored key across with it. */
async function renameGroupKey(orgId: string, doc: IdpGroupMappingDocument, displayName: string, key: string): Promise<void> {
  const previous = doc.groupKey;
  doc.group = displayName;
  doc.groupKey = key;
  doc.updatedBy = 'scim';
  await doc.save();
  if (previous !== key) {
    // Members carry the KEY, so a rename must move them or everyone silently
    // drops out of the group (and loses the Roles it maps to).
    await UserOrganization.updateMany(
      { 'organizationId': toOrgId(orgId), 'scim.groups': previous },
      { $set: { 'scim.groups.$': key } },
    );
  }
}

/**
 * PATCH /Groups/:id — the member add/remove an IdP actually sends.
 *
 * Supported: `members` add / remove / replace (with `path: members[value eq "…"]`
 * for a single removal, which Okta emits), and a `displayName` replace.
 */
export async function patchGroup(ctx: ScimContext, id: string, ops: unknown): Promise<ScimWriteOutcome<ScimGroupResource>> {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw scimInvalidSyntax('A PatchOp must carry a non-empty `Operations` array.');
  }
  const doc = await requireGroup(ctx.orgId, id);
  const current = await membersOf(ctx.orgId, [doc.groupKey]);
  const currentIds = new Set((current.get(doc.groupKey) ?? []).map((m) => m.value));

  const add = new Set<string>();
  const remove = new Set<string>();
  let displayName: string | undefined;
  let externalId: string | undefined;
  let replacedMembers = false;

  for (const raw of ops as ScimPatchOperation[]) {
    const op = String(raw?.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw scimInvalidSyntax(`Unsupported PATCH op '${raw?.op}'. Use add, replace or remove.`);
    }
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    // `members[value eq "<id>"]` — a targeted removal with no body.
    const filtered = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
    if (filtered) {
      if (op !== 'remove') throw scimInvalidSyntax('A filtered `members[...]` path is only supported with op "remove".');
      remove.add(filtered[1]);
      continue;
    }
    if (path.toLowerCase() === 'members' || (path === '' && (raw.value as Record<string, unknown>)?.members !== undefined)) {
      const value = path === '' ? (raw.value as Record<string, unknown>).members : raw.value;
      const ids = (await resolveMembers(ctx.orgId, value ?? [], { verify: op !== 'remove' })).map(String);
      if (op === 'remove') {
        // A bare `remove` on `members` with no value clears the group.
        (value === undefined || (Array.isArray(value) && value.length === 0) ? [...currentIds] : ids).forEach((v) => remove.add(v));
      } else if (op === 'replace') {
        replacedMembers = true;
        ids.forEach((v) => add.add(v));
        [...currentIds].filter((v) => !ids.includes(v)).forEach((v) => remove.add(v));
      } else {
        ids.forEach((v) => add.add(v));
      }
      // A PATH-LESS op may carry other attributes alongside `members`, so it
      // still falls through to the attribute loop (which skips `members`); a
      // `path: members` op carries nothing else and is done.
      if (path !== '') continue;
    }
    for (const [attr, value] of patchPairs(raw)) {
      switch (attr.toLowerCase()) {
        case 'displayname': displayName = String(value ?? '').trim(); break;
        case 'externalid': externalId = String(value ?? '').slice(0, 256); break;
        case 'members': break; // handled above
        default: break; // unmodelled attribute — ignored, as on Users
      }
    }
  }

  // Never re-add someone who is already in the group, and never remove someone
  // an operation in the same request added.
  for (const id2 of add) remove.delete(id2);
  const adding = [...add].filter((v) => !currentIds.has(v)).map((v) => new Types.ObjectId(v));
  const removing = [...remove].filter((v) => currentIds.has(v)).map((v) => new Types.ObjectId(v));

  const renaming = displayName !== undefined && displayName !== '' && displayName !== doc.group;
  if (renaming || adding.length > 0 || externalId !== undefined) assertIntentAllowed(ctx, 'update');
  else if (removing.length > 0) assertIntentAllowed(ctx, 'delete');

  const changed: string[] = [];
  if (renaming) {
    const key = groupKey(displayName!);
    if (key !== doc.groupKey && await IdpGroupMapping.exists({ orgId: ctx.orgId, groupKey: key, _id: { $ne: doc._id } })) {
      throw scimUniqueness(`A group named '${displayName}' already exists in this organization.`);
    }
    await renameGroupKey(ctx.orgId, doc, displayName!, key);
    changed.push('displayName');
  }
  if (externalId !== undefined && externalId !== doc.scimExternalId) {
    doc.scimExternalId = externalId;
    await doc.save();
    changed.push('externalId');
  }

  const affectedUserIds = await applyGroupMembership(ctx.orgId, doc.groupKey, adding, removing);
  if (affectedUserIds.length > 0) changed.push('members');

  return {
    resource: await getGroup(ctx, id),
    action: renaming || externalId !== undefined || replacedMembers ? 'update' : 'members',
    changed,
    affectedUserIds,
  };
}

/**
 * DELETE /Groups/:id — the directory removed the group.
 *
 * Every member drops out of it and their mapped Roles fall away with it (manual
 * Roles stay). The mapping row goes too, so an admin sees the group disappear
 * from the editor rather than a rule that can never match again. Accepted after a
 * downgrade: it only ever removes access.
 */
export async function deleteGroup(ctx: ScimContext, id: string): Promise<ScimWriteOutcome<{ id: string }>> {
  assertIntentAllowed(ctx, 'delete');
  const doc = await requireGroup(ctx.orgId, id);
  const members = (await membersOf(ctx.orgId, [doc.groupKey])).get(doc.groupKey) ?? [];

  await IdpGroupMapping.deleteOne({ _id: doc._id });
  const affectedUserIds = await applyGroupMembership(
    ctx.orgId,
    doc.groupKey,
    [],
    members.map((m) => new Types.ObjectId(m.value)),
  );

  logger.info('[SCIM] deleted directory group', { orgId: ctx.orgId, group: doc.groupKey, members: members.length });
  return { resource: { id }, action: 'delete', changed: ['members'], affectedUserIds };
}

// ---------------------------------------------------------------------------
// Discovery documents (RFC 7643 §§5-6) — what a validator fetches first
// ---------------------------------------------------------------------------

/** `GET /ServiceProviderConfig`: exactly what this implementation supports, so a
 *  client never attempts bulk, sort or a complex filter and gets a 400. */
export async function serviceProviderConfig(): Promise<Record<string, unknown>> {
  const baseUrl = await scimBaseUrl();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://pipeline-builder.dev/docs/authentication',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'A service-account key carrying the `scim` scope, presented as `Authorization: Bearer pb_sa_…`.',
      specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
      primary: true,
    }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl}/ServiceProviderConfig` },
  };
}

/** `GET /ResourceTypes` — the two resources this service exposes. */
export async function resourceTypes(): Promise<ScimListResponse<Record<string, unknown>>> {
  const baseUrl = await scimBaseUrl();
  const Resources = [
    { id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER_SCHEMA, description: 'Organization member' },
    { id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCIM_GROUP_SCHEMA, description: 'Directory group mapped to roles' },
  ].map((r) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    ...r,
    schemaExtensions: [],
    meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/${r.id}` },
  }));
  return { schemas: [SCIM_LIST_SCHEMA], totalResults: Resources.length, startIndex: 1, itemsPerPage: Resources.length, Resources };
}

/** `GET /Schemas` — the attributes actually honoured, so a client can map to
 *  them rather than discovering by trial. Only the modelled subset is declared. */
export async function schemas(): Promise<ScimListResponse<Record<string, unknown>>> {
  const attr = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    type: 'string',
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...over,
  });
  const Resources = [
    {
      id: SCIM_USER_SCHEMA,
      name: 'User',
      description: 'Organization member',
      attributes: [
        attr('userName', { required: true, uniqueness: 'server' }),
        attr('externalId'),
        attr('displayName'),
        { ...attr('name'), type: 'complex', subAttributes: [attr('givenName'), attr('familyName'), attr('formatted')] },
        { ...attr('emails'), type: 'complex', multiValued: true, subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })] },
        attr('active', { type: 'boolean' }),
        { ...attr('groups'), type: 'complex', multiValued: true, mutability: 'readOnly', subAttributes: [attr('value'), attr('display')] },
      ],
    },
    {
      id: SCIM_GROUP_SCHEMA,
      name: 'Group',
      description: 'Directory group mapped to roles',
      attributes: [
        attr('displayName', { required: true, uniqueness: 'server' }),
        attr('externalId'),
        { ...attr('members'), type: 'complex', multiValued: true, subAttributes: [attr('value'), attr('display')] },
      ],
    },
  ];
  const baseUrl = await scimBaseUrl();
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: Resources.length,
    startIndex: 1,
    itemsPerPage: Resources.length,
    Resources: Resources.map((s) => ({
      ...s,
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${s.id}` },
    })),
  };
}

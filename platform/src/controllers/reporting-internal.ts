// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/reporting/*` — the identity facts the reporting service cannot
 * know on its own. INTERNAL: the `reporting` service's signed token only.
 *
 * A stakeholder report is produced by a SCHEDULER, with no request and no caller.
 * That is the whole reason these exist: the run has to be authorized as the
 * definition's OWNER, and the only service that knows whether that person is
 * still an active member with the right permissions — and whether the org still
 * holds the add-on — is this one.
 *
 *  - `GET /internal/reporting/report-authority/:orgId/:userId` — may this user
 *    still produce and publish reports in this org, and does the account still
 *    hold `stakeholder_reports`? Answered fresh from the membership graph, NOT
 *    from a cached push: an entitlement that lapsed or a permission that was
 *    revoked has to stop the NEXT run, not the next sync.
 *
 *  - `GET /internal/reporting/recipient-check/:orgId?email=…` — is this ONE
 *    address an active member of this org? Deliberately a single-address question
 *    rather than "list the org's members": a report recipient check does not need
 *    the org's address book, and shipping one across a service boundary would
 *    make every reporting bug a PII incident. The caller already holds the address
 *    it is asking about, so the answer discloses nothing it did not have.
 *
 *  - `GET /internal/reporting/report-readers/:orgId` — the user ids (ids only,
 *    capped) of the members who hold `reports:read` here: who a published report's
 *    in-app notice goes to. The one list on this router, and deliberately the
 *    narrowest one that does the job — no names, no addresses, no roles.
 *
 *  - `GET /internal/reporting/access-posture/:orgId` — counts only (members,
 *    second-factor coverage, SSO, service accounts, live keys, permission changes).
 *
 * All are reads. None returns an address, a role name, or any permission outside
 * the `reports:*` family; the one name is recipient-check's display name for the
 * address the caller already holds.
 */

import {
  ALL_PERMISSIONS,
  type Permission,
  PLATFORM_INTERNAL,
  contractErrorMessage,
  isServicePrincipal,
  parseContractParams,
  parseContractQuery,
  sendError,
  sendSuccess,
  resolveUserFeatures,
  resolveUserPermissions,
} from '@pipeline-builder/api-core';
import { withController } from '../helpers/controller-helper.js';
import { toOrgId } from '../helpers/org-id.js';
import { orgFeatureOverrides, type StoredFeatureOverrides } from '../helpers/user-response.js';
import type { AuditAction } from '../models/audit-event.js';
import {
  AuditEvent,
  OrgIdpConfig,
  PersonalAccessToken,
  ServiceAccount,
  User,
  UserOrganization,
  UserTotp,
  WebAuthnCredential,
} from '../models/index.js';
import { membershipForOrg } from '../services/session/membership-context.js';

/**
 * Params and query are validated by the endpoints' contracts (api-core
 * `PLATFORM_INTERNAL`), which carry this router's 400 messages: the org and user
 * id shapes, the deliberately loose recipient address (only ever compared, never
 * delivered to) and the posture window.
 */
const {
  reportAuthority: AUTHORITY,
  reportRecipientCheck: RECIPIENT,
  reportAccessPosture: POSTURE,
  reportReaders: READERS,
} = PLATFORM_INTERNAL;

/** Answer order for the `reports:*` family: escalating authority, so the
 *  response never reshuffles when the catalog is re-ordered. A verb added to the
 *  catalog later sorts after these, alphabetically. */
const REPORT_VERB_ORDER = ['read', 'write', 'publish', 'rollup'];
const reportVerbRank = (p: string): number => {
  const i = REPORT_VERB_ORDER.indexOf(p.slice('reports:'.length));
  return i === -1 ? REPORT_VERB_ORDER.length : i;
};

/** The only permissions this endpoint will talk about: api-core's whole
 *  `reports:*` family, derived from the catalog so a new one is never missed. */
export const REPORT_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS
  .filter((p) => p.startsWith('reports:'))
  .sort((a, b) => reportVerbRank(a) - reportVerbRank(b) || a.localeCompare(b));

/**
 * GET /internal/reporting/report-authority/:orgId/:userId
 *
 * `active: false` covers every way a run should stop — no membership, membership
 * deactivated, org soft-deleted — without telling the caller which, because the
 * caller's behaviour is the same for all of them: pause the definition.
 */
export const getReportAuthority = withController('Report authority', async (req, res) => {
  const params = parseContractParams(AUTHORITY, req);
  if (!params.ok) return sendError(res, 400, contractErrorMessage(params));
  const { orgId, userId } = params.value;

  const user = await User.findById(userId).select('+isSuperAdmin featureOverrides').lean();
  // `membershipForOrg` is the authority on "may this person act in this org": it
  // requires a LIVE membership (or inherited admin authority) and refuses a
  // soft-deleted org outright, which is every reason a run should stop.
  const membership = user ? await membershipForOrg(userId, orgId) : undefined;
  if (!user || !membership) {
    return sendSuccess(res, 200, { active: false, permissions: [], features: [] });
  }

  const isSuperAdmin = (user as { isSuperAdmin?: boolean }).isSuperAdmin === true;
  const held = new Set(resolveUserPermissions(membership.rolePermissions, isSuperAdmin));
  const features = resolveUserFeatures(membership.tier ?? 'developer', {
    // Only THIS org's overrides — another org's grant must not authorize a run here.
    overrides: orgFeatureOverrides((user as { featureOverrides?: StoredFeatureOverrides }).featureOverrides, orgId) ?? null,
    isSuperAdmin,
    accountFeatures: membership.featureEntitlements ?? null,
  });

  sendSuccess(res, 200, {
    active: true,
    // Only the reporting family. A scheduler has no business learning what else
    // this person can do.
    permissions: REPORT_PERMISSIONS.filter((p) => held.has(p)),
    features,
    ...(membership.tier ? { tier: membership.tier } : {}),
  });
});

/**
 * GET /internal/reporting/recipient-check/:orgId?email=…
 *
 * A member address needs no email confirmation — the org has already established
 * that the person belongs to it — and is admissible whatever the allowed-domain
 * policy says. Anything else falls through to the policy check in reporting.
 */
export const getRecipientCheck = withController('Report recipient check', async (req, res) => {
  const params = parseContractParams(RECIPIENT, req);
  if (!params.ok) return sendError(res, 400, contractErrorMessage(params));
  const query = parseContractQuery(RECIPIENT, req);
  if (!query.ok) return sendError(res, 400, contractErrorMessage(query));
  const { orgId } = params.value;
  const { email } = query.value;

  const user = await User.findOne({ email }).select('_id username').lean();
  if (!user) return sendSuccess(res, 200, { member: false });
  const userId = String(user._id);
  // The MEMBERSHIP carries the active flag, not the account — a person can be live
  // platform-wide and deactivated in this one org, and it is this org that decides
  // whether their address skips report verification.
  const membership = await UserOrganization.findOne({
    userId: user._id,
    organizationId: toOrgId(orgId),
    isActive: true,
  }).select('_id').lean();
  if (!membership) return sendSuccess(res, 200, { member: false });

  const displayName = (user as { username?: string }).username?.trim();
  sendSuccess(res, 200, { member: true, userId, ...(displayName ? { displayName } : {}) });
});

/**
 * The permission-changing actions the posture panel counts.
 *
 * Role membership and role DEFINITION changes both count: adding someone to a role
 * and widening what that role grants have the same effect on who can do what, and a
 * count that only saw the first would read as quiet during the more consequential
 * change.
 */
const PERMISSION_CHANGE_ACTIONS = [
  'org.role.member.add',
  'org.role.member.remove',
  'org.role.create',
  'org.role.update',
  'org.role.delete',
  'sso.jit.role.change',
] as const satisfies readonly AuditAction[];

/**
 * GET /internal/reporting/access-posture/:orgId?from=…&to=…
 *
 * COUNTS ONLY, and that is a security property, not a formatting choice. A report
 * that named the members without a second factor would be a ready-made target list,
 * and it would reach managers who have no permission to see that in the product. So
 * the panel can say "14 of 18 members have a second factor" and cannot say who the
 * four are.
 *
 * MFA is DERIVED here exactly as it is everywhere else in platform — a confirmed
 * authenticator enrolment or a registered passkey — never a flag. A boolean that
 * says "MFA enabled" is a boolean that can disagree with the factors on the account.
 *
 * Like report-authority and recipient-check (and unlike report-readers), this one is
 * called with reporting's system-org token rather than one scoped to the path org: the caller is a scheduler with no
 * tenant, iterating over orgs it found in its own due scan. The gate is therefore the
 * service identity alone, which is why nothing here returns a row, a name or an id.
 */
export const getAccessPosture = withController('Access posture', async (req, res) => {
  const params = parseContractParams(POSTURE, req);
  if (!params.ok) return sendError(res, 400, contractErrorMessage(params));
  const { orgId } = params.value;
  const organizationId = toOrgId(orgId);

  const query = parseContractQuery(POSTURE, req);
  if (!query.ok) return sendError(res, 400, contractErrorMessage(query));
  const window = query.value;

  const memberships = await UserOrganization.find({ organizationId, isActive: true })
    .select('userId').lean();
  const userIds = memberships.map((m) => m.userId);

  const [totpUsers, passkeyUsers, idp, serviceAccounts, apiKeys, permissionChanges] = await Promise.all([
    // A confirmed enrolment only: one nobody finished is not a factor, and counting it
    // would report an org as protected when it is not.
    userIds.length > 0
      ? UserTotp.distinct('userId', { userId: { $in: userIds }, activatedAt: { $ne: null } })
      : Promise.resolve([] as unknown[]),
    // DISTINCT users, not credentials: somebody with three passkeys is one protected
    // account, and counting credentials would report coverage above 100%.
    userIds.length > 0
      ? WebAuthnCredential.distinct('userId', { userId: { $in: userIds } })
      : Promise.resolve([] as unknown[]),
    OrgIdpConfig.findOne({ organizationId }).select('ssoRequired').lean(),
    ServiceAccount.countDocuments({ organizationId, disabled: false }),
    PersonalAccessToken.countDocuments({
      organizationId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }),
    AuditEvent.countDocuments({
      // `affectedOrgId` rather than `orgId`: a sysadmin acting on this org carries the
      // SYSTEM org in `orgId`, and a permission change made by one is exactly the kind
      // the org most wants counted.
      affectedOrgId: orgId,
      action: { $in: PERMISSION_CHANGE_ACTIONS },
      createdAt: { $gte: window.from, $lt: window.to },
    }),
  ]);

  // A passkey OR a confirmed authenticator protects an account, and somebody may hold
  // BOTH. So the two sets are unioned rather than summed: adding the counts would report
  // an org with one well-protected admin as having two protected accounts, and could put
  // coverage above the member count.
  const protectedUsers = new Set([
    ...(passkeyUsers as unknown[]).map((id) => String(id)),
    ...(totpUsers as unknown[]).map((id) => String(id)),
  ]);

  sendSuccess(res, 200, {
    members: memberships.length,
    membersWithMfa: protectedUsers.size,
    ssoRequired: (idp as { ssoRequired?: boolean } | null)?.ssoRequired === true,
    serviceAccounts,
    activeApiKeys: apiKeys,
    permissionChanges,
  });
});

/** The most reader ids one answer carries. */
export const REPORT_READERS_CAP = 500;

/** How many memberships are resolved at once — bounded so one org cannot flood Mongo. */
const READER_RESOLVE_BATCH = 25;

/**
 * GET /internal/reporting/report-readers/:orgId → `{ userIds, truncated }`
 *
 * The members of this org who may READ its reports: an ACTIVE membership row here,
 * an account that still exists, and `reports:read` among the permissions
 * `membershipForOrg` + `resolveUserPermissions` resolve — the exact resolution
 * `report-authority` uses, so "may read the report" means the same thing on both.
 * A published report's in-app notice goes to exactly these people; without this,
 * the notice went org-wide and announced a report to members who could not open it.
 *
 * DIRECT members only. An ancestor's admin who reaches a team through inherited
 * authority has no membership row here, and is not notified about the team's
 * reports (they read them from the team when they enter it).
 *
 * SCOPED to the path org: the service token's org claim must equal `:orgId`, so a
 * token minted for one org cannot list another's readers.
 *
 * CAPPED at {@link REPORT_READERS_CAP}, in a stable order (by user id), with
 * `truncated: true` when more members hold the permission.
 */
export const getReportReaders = withController('Report readers', async (req, res) => {
  const params = parseContractParams(READERS, req);
  if (!params.ok) return sendError(res, 400, contractErrorMessage(params));
  const { orgId } = params.value;
  if (!isServicePrincipal(req) || String(req.user?.organizationId ?? '').toLowerCase() !== orgId) {
    return sendError(res, 403, 'The service token must be scoped to the organization it asks about');
  }

  const memberships = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true })
    .select('userId').lean();
  const memberIds = [...new Set(memberships.map((m) => String(m.userId)))].sort();
  const users = memberIds.length > 0
    ? await User.find({ _id: { $in: memberIds } }).select('+isSuperAdmin').lean()
    : [];
  const superAdmin = new Map(users.map((u) => [String(u._id), (u as { isSuperAdmin?: boolean }).isSuperAdmin === true]));

  const readers: string[] = [];
  // One past the cap is enough to know the answer was truncated.
  for (let i = 0; i < memberIds.length && readers.length <= REPORT_READERS_CAP; i += READER_RESOLVE_BATCH) {
    const batch = memberIds.slice(i, i + READER_RESOLVE_BATCH).filter((id) => superAdmin.has(id));
    const resolved = await Promise.all(batch.map(async (userId) => {
      const membership = await membershipForOrg(userId, orgId);
      if (!membership) return null;
      const held = resolveUserPermissions(membership.rolePermissions, superAdmin.get(userId) === true);
      return held.includes('reports:read') ? userId : null;
    }));
    for (const id of resolved) if (id) readers.push(id);
  }

  sendSuccess(res, 200, {
    userIds: readers.slice(0, REPORT_READERS_CAP),
    truncated: readers.length > REPORT_READERS_CAP,
  });
});

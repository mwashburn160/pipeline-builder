// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/reporting/*` — the two identity facts the reporting service cannot
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
 * Both are reads. Neither returns a member list, a role name, or any permission
 * outside the `reports:*` family.
 */

import { getParam, sendError, sendSuccess, resolveUserFeatures, resolveUserPermissions } from '@pipeline-builder/api-core';
import { withController } from '../helpers/controller-helper.js';
import { toOrgId } from '../helpers/org-id.js';
import { toOverridesRecord } from '../helpers/user-response.js';
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

const ORG_ID = /^[a-f0-9]{24}$/i;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Deliberately loose — the address is only ever compared, never delivered to. */
const EMAIL = /^[^\s@]+@[^\s@]{1,253}$/;

/** The only permissions this endpoint will talk about. */
const REPORT_PERMISSIONS = ['reports:read', 'reports:author', 'reports:share', 'reports:rollup'] as const;

/**
 * GET /internal/reporting/report-authority/:orgId/:userId
 *
 * `active: false` covers every way a run should stop — no membership, membership
 * deactivated, org soft-deleted — without telling the caller which, because the
 * caller's behaviour is the same for all of them: pause the definition.
 */
export const getReportAuthority = withController('Report authority', async (req, res) => {
  const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
  const userId = getParam(req.params, 'userId') ?? '';
  if (!ORG_ID.test(orgId)) return sendError(res, 400, 'orgId must be an organization id');
  if (!USER_ID.test(userId)) return sendError(res, 400, 'userId must be a user id');

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
    overrides: toOverridesRecord((user as { featureOverrides?: Map<string, boolean> }).featureOverrides) ?? null,
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
  const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!ORG_ID.test(orgId)) return sendError(res, 400, 'orgId must be an organization id');
  if (!EMAIL.test(email) || email.length > 320) return sendError(res, 400, 'email must be an email address');

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
] as const;

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
 * Unlike the other two endpoints on this router, this one takes the org in the PATH
 * and is called with reporting's system-org token: the caller is a scheduler with no
 * tenant, iterating over orgs it found in its own due scan. The gate is therefore the
 * service identity alone, which is why nothing here returns a row, a name or an id.
 */
export const getAccessPosture = withController('Access posture', async (req, res) => {
  const orgId = (getParam(req.params, 'orgId') ?? '').toLowerCase();
  if (!ORG_ID.test(orgId)) return sendError(res, 400, 'orgId must be an organization id');
  const organizationId = toOrgId(orgId);

  const window = parseWindow(req.query as Record<string, unknown>);
  if (typeof window === 'string') return sendError(res, 400, window);

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

/** Parse `from`/`to` into a window, or return the reason it could not be. */
function parseWindow(query: Record<string, unknown>): { from: Date; to: Date } | string {
  const from = new Date(String(query.from ?? ''));
  const to = new Date(String(query.to ?? ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return 'from and to must both be ISO timestamps';
  }
  if (from.getTime() >= to.getTime()) return 'from must be before to';
  return { from, to };
}

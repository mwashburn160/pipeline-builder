// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, requireAssurance, requirePermission, requireStepUp, STRONG_STEP_UP_METHODS } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  getMyOrganization,
  createOrganization,
  getOrgAIConfig,
  updateOrgAIConfig,
  getOrganizationById,
  getOrganizationDescendants,
  getOrganizationNames,
  getOrganizationParent,
  updateOrganization,
  updateOrganizationIdentity,
  updateOrganizationTier,
  updateOrganizationSeatLimit,
  getOrganizationSeatUsage,
  getOrganizationFeatureEntitlements,
  getOrganizationMembers,
  checkOrganizationMembership,
  getOrganizationTeams,
  getMemberTeams,
  addMemberToOrganization,
  bulkAddMemberToTeams,
  removeMemberFromOrganization,
  transferOrganizationOwnership,
  deactivateMember,
  activateMember,
  deleteOrganization,
  restoreOrganization,
  listDeletedTeams,
  deleteTeam,
  moveOrganization,
  exportOrganization,
  getOrganizationRoles,
  createOrganizationRole,
  updateOrganizationRole,
  deleteOrganizationRole,
  addRoleMember,
  removeRoleMember,
  getOrganizationServiceAccounts,
  getOrganizationServiceAccount,
  createOrganizationServiceAccount,
  updateOrganizationServiceAccount,
  deleteOrganizationServiceAccount,
  createOrganizationServiceAccountKey,
  revokeOrganizationServiceAccountKey,
  listOrgDomains,
  addOrgDomain,
  verifyOrgDomain,
  setOrgDomainMode,
  deleteOrgDomain,
  listOrgJoinRequests,
  decideOrgJoinRequest,
} from '../controllers/index.js';
import {
  createOrgIdpGroupMapping,
  deleteOrgIdpGroupMapping,
  listOrgIdpGroupMappings,
  updateOrgIdpGroupMapping,
} from '../controllers/org-idp-mappings.js';
import {
  getOwnOrgIdpConfig,
  putOwnOrgIdpConfig,
  patchOwnOrgIdpConfig,
  deleteOwnOrgIdpConfig,
} from '../controllers/org-idp-self.js';
import {
  getImpersonationPolicy,
  updateImpersonationPolicy,
} from '../controllers/org-impersonation-policy.js';
import {
  getMfaPolicy,
  updateMfaPolicy,
} from '../controllers/org-mfa-policy.js';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';
import { createLimiter, userOrIpKey } from '../middleware/rate-limiter.js';

const router: Router = Router();

/** Per-user limiter for domain verification — each call triggers an outbound DNS
 *  TXT lookup, so bound it tighter than the global limiter (keyed per-user;
 *  requireAuth runs first). */
const domainVerifyLimiter = createLimiter({
  name: 'domain-verify',
  windowMs: 60_000,
  max: 10,
  keyGenerator: userOrIpKey,
  message: 'Too many verification attempts. Please wait a minute and try again.',
});

/*
 * Current User's Organization
 */

/** GET /organization - Get current user's organization */
router.get('/', requireAuth, getMyOrganization);

/** POST /organization - Create a new organization (admin or owner only).
 *  Note: self-serve org creation for brand-new users goes through
 *  /auth/register (which creates a paired user+org), NOT this endpoint.
 *  This route is for already-org-bound admins/owners adding *additional*
 *  orgs to their account. */
router.post('/', requireAuth, requirePermission('org:settings'), audited('org.create'), createOrganization);

/** POST /organization/names — internal batch id→name resolver (service principal
 *  only; gate enforced in the controller). Used by the message service to label
 *  conversation rows with the counterparty org's name. Literal path, so it's
 *  declared before the `/:id` routes and never shadowed by the id matcher. */
router.post('/names', requireAuth, getOrganizationNames);

/*
 * AI Provider Configuration (must be before /:id routes)
 */

/** GET /organization/ai-config - Get org AI provider config */
router.get('/ai-config', requireAuth, getOrgAIConfig);

/** PUT /organization/ai-config - Update org AI provider keys (admin only).
 *  Step-up-gated: it persists per-org provider SECRETS, like the KMS-config and
 *  IdP routes. The frontend (AIProviderConfig) mirrors OrgKmsConfigModal — it
 *  acquires a step-up token via StepUpModal and forwards it as `X-Step-Up-Token`. */
router.put('/ai-config', requireAuth, requirePermission('org:settings'), requireStepUp, audited('admin.org.ai-config.update'), updateOrgAIConfig);

/*
 * Organization CRUD (system admin can access any org)
 */

/** GET /organization/:id - Get organization by ID */
router.get('/:id', requireAuth, getOrganizationById);

/** GET /:id/descendants - org→team subtree ids (self + descendants) */
router.get('/:id/descendants', requireAuth, getOrganizationDescendants);

/** GET /:id/parent — internal: direct parent id (service principal or org-admin,
 *  checked in the controller). Compliance's detached scheduled scans use it to
 *  evaluate parent `propagateToChildren` rules. */
router.get('/:id/parent', requireAuth, getOrganizationParent);

/** PUT /organization/:id - Update organization (sysadmin only).
 *  `requireSystemAdmin` mirrors the controller's own check at the route layer
 *  so org admins/owners are rejected here, not deeper in. Step-up gated like the
 *  sibling sysadmin mutations (`PATCH /:id/tier`, `DELETE /:id`). */
router.put('/:id', requireAuth, requireSystemAdmin, requireStepUp, audited('org.update'), updateOrganization);

/** PATCH /organization/:id/identity - Self-serve org identity edit (name/slug).
 *  Owner/admin reachable (NOT sysadmin-only): `requirePermission('org:settings')`
 *  is the capability gate (admin/owner bundle) and the controller's
 *  `canAdministerOrg` is the tenancy gate (own org or a managed team). Mirrors
 *  the export route's gating. */
router.patch('/:id/identity', requireAuth, requirePermission('org:settings'), audited('org.update'), updateOrganizationIdentity);

/** GET/PATCH /organization/:id/impersonation-policy — whether platform operators
 *  may view as this org's members, and on what terms.
 *
 *  Gated by its OWN capability, `org:impersonation`, not `org:settings` — split
 *  out for the same reason as `org:idp`/`org:kms`: a custom role that manages
 *  general settings must not thereby control who can view the org's data.
 *  `canAdministerOrg` remains the tenancy gate (own org or a managed team).
 *
 *  The WRITE additionally requires step-up. Loosening this policy widens who can
 *  see the org's data. Reading the current policy needs no re-auth. */
router.get('/:id/impersonation-policy', requireAuth, requirePermission('org:impersonation'), getImpersonationPolicy);
router.patch('/:id/impersonation-policy', requireAuth, requirePermission('org:impersonation'), requireStepUp, audited('org.update'), updateImpersonationPolicy);

/** GET/PATCH /organization/:id/mfa-policy — whether this org requires two-factor
 *  authentication of its members (#8), with the grace period that follows
 *  turning it on, and whether the org's own IdP enforces MFA (which is what
 *  makes an SSO sign-in count as MFA-grade).
 *
 *  Gated on `org:settings` — unlike impersonation and IdP/KMS, this is an
 *  ordinary org-security setting an admin manages, not a separate authority. The
 *  WRITE additionally requires step-up: turning the requirement OFF removes a
 *  control for everyone in the org, so it must not be reachable from a session
 *  alone. Tenancy is `canAdministerOrg` in the controller, as on the siblings. */
router.get('/:id/mfa-policy', requireAuth, requirePermission('org:settings'), getMfaPolicy);
router.patch('/:id/mfa-policy', requireAuth, requirePermission('org:settings'), requireStepUp, audited('org.mfa_policy.update'), updateMfaPolicy);

// -- Domain-based join (P2b) — owner/admin manage verified domains + approve
//    join requests. Gated by `org:settings` (capability) + `canAdministerOrg`
//    (tenancy) in each controller, same as the identity route above.
router.get('/:id/domains', requireAuth, requirePermission('org:settings'), listOrgDomains);
router.post('/:id/domains', requireAuth, requirePermission('org:settings'), audited('org.domain.add'), addOrgDomain);
router.post('/:id/domains/:domainId/verify', requireAuth, requirePermission('org:settings'), domainVerifyLimiter, audited('org.domain.verify'), verifyOrgDomain);
router.patch('/:id/domains/:domainId', requireAuth, requirePermission('org:settings'), audited('org.domain.mode'), setOrgDomainMode);
router.delete('/:id/domains/:domainId', requireAuth, requirePermission('org:settings'), audited('org.domain.delete'), deleteOrgDomain);
router.get('/:id/join-requests', requireAuth, requirePermission('org:settings'), listOrgJoinRequests);
router.post('/:id/join-requests/:reqId/:decision', requireAuth, requirePermission('org:settings'), audited('org.join.approve', 'org.join.deny'), decideOrgJoinRequest);

/** PATCH /organization/:id/tier - Change pricing tier (sysadmin only).
 *  Step-up gated because the change resizes quota limits and affects billing. */
router.patch('/:id/tier', requireAuth, requireSystemAdmin, requireStepUp, audited('admin.org.tier.update'), updateOrganizationTier);

/** DELETE /organization/:id - Soft-delete organization (sysadmin only).
 *  Enters a retention window (snapshot taken, sessions cut) instead of an
 *  immediate hard delete; the purge sweep runs the destructive cascade after
 *  the window. Restorable via POST /:id/restore until then. */
router.delete('/:id', requireAuth, requireSystemAdmin, requireStepUp, audited('org.soft_delete'), deleteOrganization);

/** POST /organization/:id/move - Reparent an org (sysadmin only): a team to
 *  another root, a team out as a standalone root (`parentOrgId: null`), or a
 *  root with no teams in under a root. Re-syncs tier, entitlements, quota
 *  seeding and seats; step-up gated like the other sysadmin org mutations. */
router.post('/:id/move', requireAuth, requireSystemAdmin, requireStepUp, audited('admin.org.move'), moveOrganization);

/** POST /organization/:id/restore - Restore a soft-deleted org within its
 *  retention window. `requirePermission('org:settings')` is the capability gate;
 *  the controller's `canAdministerOrg` is the tenancy gate (sysadmin or an
 *  admin/owner of the org / a managing parent). Step-up gated like DELETE. */
router.post('/:id/restore', requireAuth, requirePermission('org:settings'), requireStepUp, audited('org.restore'), restoreOrganization);

/** GET /organization/:id/export - GDPR portability dump (org admin or sysadmin).
 *  Controller gates with `canAdministerOrg` (target-org scope); `requirePermission`
 *  is the capability gate (org:settings, in the admin/owner bundle). */
router.get('/:id/export', requireAuth, requirePermission('org:settings'), exportOrganization);

/** PUT /organization/:id/seat-limit — internal seat-entitlement sync from billing.
 *  Service-principal or sysadmin (checked in the controller); NO step-up, so the
 *  billing service can sync effective seats without a human MFA gate. */
router.put('/:id/seat-limit', requireAuth, audited('admin.org.seatLimit.update'), updateOrganizationSeatLimit);

/** GET /organization/:id/seat-usage — internal pooled seat usage read for
 *  billing's over-cap gate. Service-principal or sysadmin (checked in controller). */
router.get('/:id/seat-usage', requireAuth, getOrganizationSeatUsage);

/** GET /organization/:id/feature-entitlements — internal account feature-entitlement
 *  read for billing's entitlement-drift reconciler. Same gate as seat-usage:
 *  service-principal or organization-admin (checked in controller). */
router.get('/:id/feature-entitlements', requireAuth, getOrganizationFeatureEntitlements);

/*
 * Per-org SSO / IdP self-service (customer org-admin manages THEIR OWN org's
 * SSO). `requirePermission('org:idp')` is the capability gate — the sensitive
 * SSO/IdP capability that was split OUT of `org:settings` so a custom role can
 * grant general settings WITHOUT the login-controlling IdP config (it stays in
 * the admin/owner bundles, so existing admins are unaffected; superadmins bypass
 * via `hasPermission`). The controllers add the tenancy gate (`requireOrgScope`:
 * own org / managed team) AND an `sso`-entitlement check. Secret-bearing writes
 * are step-up gated, just like the superadmin `/admin/org-idp/*` fleet routes.
 * The two-segment `/:id/idp` path never collides with the single-segment
 * `GET /:id` read above.
 */

/** GET /organization/:id/idp - Read own-org IdP config (config: null if unset) */
router.get('/:id/idp', requireAuth, requirePermission('org:idp'), getOwnOrgIdpConfig);

/*
 * ASSURANCE (#8) on every IdP WRITE, self-serve and fleet alike: whoever
 * controls an org's IdP can sign in as any of its members, so the session must
 * be MFA-grade (`minAssurance: 2`) and the confirmation must be earned by a
 * SECOND FACTOR (`STRONG_STEP_UP_METHODS`) rather than by re-entering the
 * password the session was opened with. Reading the config is unchanged.
 */

/** PUT /organization/:id/idp - Upsert own-org IdP config (step-up: secret-bearing) */
router.put('/:id/idp', requireAuth, requirePermission('org:idp'), requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.org-idp.upsert'), putOwnOrgIdpConfig);

/** PATCH /organization/:id/idp - Partial update of own-org IdP config (step-up) */
router.patch('/:id/idp', requireAuth, requirePermission('org:idp'), requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.org-idp.upsert'), patchOwnOrgIdpConfig);

/** DELETE /organization/:id/idp - Remove own-org IdP config (step-up) */
router.delete('/:id/idp', requireAuth, requirePermission('org:idp'), requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.org-idp.delete'), deleteOwnOrgIdpConfig);

/*
 * IdP group → Role mappings (3a) — what the IdP's groups are worth inside the
 * org. Gated on `roles:manage`, NOT `org:idp`: a mapping grants Roles, so it
 * belongs to whoever manages Roles, and an org can delegate the login connection
 * and the Role policy to different people. The controller adds the own-org /
 * managed-team scope and the `sso` entitlement; the service applies the Role
 * ceiling and refuses any Role conferring ownership or platform-admin.
 *
 * No step-up: this is the same class of action as adding a member to a Role
 * (`POST /:id/roles/:roleId/members`), which is not step-up gated either — it
 * mints no secret and grants nothing the actor doesn't already hold.
 */
router.get('/:id/idp/group-mappings', requireAuth, requirePermission('roles:manage'), listOrgIdpGroupMappings);
router.post('/:id/idp/group-mappings', requireAuth, requirePermission('roles:manage'), audited('org.idp.mapping.upsert'), createOrgIdpGroupMapping);
router.put('/:id/idp/group-mappings/:mappingId', requireAuth, requirePermission('roles:manage'), audited('org.idp.mapping.upsert'), updateOrgIdpGroupMapping);
router.delete('/:id/idp/group-mappings/:mappingId', requireAuth, requirePermission('roles:manage'), audited('org.idp.mapping.delete'), deleteOrgIdpGroupMapping);

/*
 * Organization Members (admin can manage any org)
 */

/** GET /organization/:id/members - List organization members */
router.get('/:id/members', requireAuth, getOrganizationMembers);

/** GET /organization/:id/members/:userId/exists - Active-membership probe
 *  (service principal / org-admin). Used by the message service to reject a
 *  per-user DM addressed to a non-member. */
router.get('/:id/members/:userId/exists', requireAuth, checkOrganizationMembership);

/** POST /organization/:id/members - Add member to organization (admin only) */
router.post('/:id/members', requireAuth, requirePermission('members:manage'), audited('org.member.add'), addMemberToOrganization);

/** POST /organization/:id/members/bulk-add - Add one user to several teams in
 *  the org's subtree at once (admin/parent-admin only). */
router.post('/:id/members/bulk-add', requireAuth, requirePermission('members:manage'), audited('org.member.add'), bulkAddMemberToTeams);

/** GET /organization/:id/teams - Descendant team roster (no member context). */
router.get('/:id/teams', requireAuth, getOrganizationTeams);

/** GET /organization/:id/teams/deleted - Soft-deleted teams of :id still inside
 *  their retention window (restorable via POST /:teamId/restore).
 *  `org:settings` is the capability gate; `canAdministerOrg(:id)` the tenancy gate. */
router.get('/:id/teams/deleted', requireAuth, requirePermission('org:settings'), listDeletedTeams);

/** DELETE /organization/:id/teams/:teamId - A parent admin soft-deletes one of
 *  its own teams (same retention window + snapshot as sysadmin DELETE /:id).
 *  Step-up gated like every org delete. 404 unless :teamId's parent is :id. */
router.delete('/:id/teams/:teamId', requireAuth, requirePermission('org:settings'), requireStepUp, audited('org.team.delete'), deleteTeam);

/** GET /organization/:id/member/:memberId/teams - Descendant teams annotated
 *  with the member's membership (manage-teams view). */
router.get('/:id/member/:memberId/teams', requireAuth, getMemberTeams);

/** DELETE /organization/:id/members/:userId - Remove member from organization (admin only) */
router.delete('/:id/members/:userId', requireAuth, requirePermission('members:manage'), audited('org.member.remove'), removeMemberFromOrganization);

/** PATCH /organization/:id/members/:userId/deactivate - Deactivate member (admin only) */
router.patch('/:id/members/:userId/deactivate', requireAuth, requirePermission('members:manage'), audited('org.member.deactivate'), deactivateMember);

/** PATCH /organization/:id/members/:userId/activate - Reactivate member (admin only) */
router.patch('/:id/members/:userId/activate', requireAuth, requirePermission('members:manage'), audited('org.member.activate'), activateMember);

/*
 * Permission Roles (first-class RBAC). Membership drives the cached
 * UserOrganization.role; Admin → org-admin, Super Admin (system org
 * only) → platform admin.
 */

/** GET /organization/:id/roles - List roles + members */
router.get('/:id/roles', requireAuth, getOrganizationRoles);

/** POST /organization/:id/roles - Create a custom permission role (admin only) */
router.post('/:id/roles', requireAuth, requirePermission('roles:manage'), audited('org.role.create'), createOrganizationRole);

/** PUT /organization/:id/roles/:roleId - Update a custom role (admin only) */
router.put('/:id/roles/:roleId', requireAuth, requirePermission('roles:manage'), audited('org.role.update'), updateOrganizationRole);

/** DELETE /organization/:id/roles/:roleId - Delete a custom role (admin only) */
router.delete('/:id/roles/:roleId', requireAuth, requirePermission('roles:manage'), audited('org.role.delete'), deleteOrganizationRole);

/** POST /organization/:id/roles/:roleId/members - Add member to a role (admin only) */
router.post('/:id/roles/:roleId/members', requireAuth, requirePermission('roles:manage'), audited('org.role.member.add'), addRoleMember);

/** DELETE /organization/:id/roles/:roleId/members/:userId - Remove member from a role (admin only) */
router.delete('/:id/roles/:roleId/members/:userId', requireAuth, requirePermission('roles:manage'), audited('org.role.member.remove'), removeRoleMember);

/*
 * Service accounts (#2) — org-scoped non-human principals and their `pb_sa_…`
 * keys. EVERY route, read included, requires `service_accounts:manage`: the
 * listing is an inventory of the org's machine credentials (which exist, what
 * they can do, when they were last used), and nothing in the product needs a
 * plain member to see it. Writes add step-up — creating an account or issuing a
 * key mints a durable machine credential, the same class of action PAT creation
 * is step-up gated for — and a service-account key can never satisfy step-up
 * itself, so one key can't be used to mint another.
 */

/** GET /organization/:id/service-accounts - List accounts + their keys */
router.get('/:id/service-accounts', requireAuth, requirePermission('service_accounts:manage'), getOrganizationServiceAccounts);

/** GET /organization/:id/service-accounts/:accountId - One account + its keys */
router.get('/:id/service-accounts/:accountId', requireAuth, requirePermission('service_accounts:manage'), getOrganizationServiceAccount);

/** POST /organization/:id/service-accounts - Create a service account */
router.post(
  '/:id/service-accounts',
  requireAuth,
  requirePermission('service_accounts:manage'),
  requireStepUp,
  audited('org.service-account.create'),
  createOrganizationServiceAccount,
);

/** PATCH /organization/:id/service-accounts/:accountId - Update description/roles/budget/disabled */
router.patch(
  '/:id/service-accounts/:accountId',
  requireAuth,
  requirePermission('service_accounts:manage'),
  requireStepUp,
  audited('org.service-account.update'),
  updateOrganizationServiceAccount,
);

/** DELETE /organization/:id/service-accounts/:accountId - Delete the account + every key */
router.delete(
  '/:id/service-accounts/:accountId',
  requireAuth,
  requirePermission('service_accounts:manage'),
  requireStepUp,
  audited('org.service-account.delete'),
  deleteOrganizationServiceAccount,
);

/** POST /organization/:id/service-accounts/:accountId/keys - Issue a key (shown once) */
router.post(
  '/:id/service-accounts/:accountId/keys',
  requireAuth,
  requirePermission('service_accounts:manage'),
  requireStepUp,
  audited('org.service-account.key.create'),
  createOrganizationServiceAccountKey,
);

/** DELETE /organization/:id/service-accounts/:accountId/keys/:keyId - Revoke one key.
 *  NOT step-up gated: revocation is the safe direction (it only ever removes
 *  access), and a compromised-key response must never be blocked on a second
 *  factor — mirroring DELETE /user/keys/:id. */
router.delete(
  '/:id/service-accounts/:accountId/keys/:keyId',
  requireAuth,
  requirePermission('service_accounts:manage'),
  audited('org.service-account.key.revoke'),
  revokeOrganizationServiceAccountKey,
);

/*
 * Ownership Transfer
 */

/** PATCH /organization/:id/transfer-owner - Transfer organization ownership (admin only) */
router.patch('/:id/transfer-owner', requireAuth, requirePermission('org:settings'), requireStepUp, audited('org.ownership.transfer'), transferOrganizationOwnership);

export default router;

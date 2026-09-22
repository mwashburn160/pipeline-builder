// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission-union RBAC on the org-settings routes: the route's
 * `requirePermission(...)` is the capability gate and the controller adds only
 * the tenancy scope (`canManageOrgScope`). So a custom Role delegating
 * `org:settings` / `org:impersonation` works, and a member WITHOUT the
 * permission is refused — at the route, before any controller runs.
 *
 * The permission layer is api-core's REAL `requirePermission`; the other
 * middleware in each chain is a pass-through and the controllers are recorders.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const pass = (_req: unknown, _res: unknown, next: () => void) => next();
const reached: string[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireStepUp: Object.assign((...args: unknown[]) => (args.length === 3 ? (args[2] as () => void)() : pass), {}),
  requireAssurance: () => pass,
  requireOrgAdminAssurance: () => pass,
  audited: () => pass,
}));
jest.unstable_mockModule('../src/middleware/index.js', () => ({ requireAuth: pass, requireSystemAdmin: pass }));
jest.unstable_mockModule('../src/middleware/rate-limiter.js', () => ({ createLimiter: () => pass, userOrIpKey: () => 'k' }));
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({
  isBootstrapSetupRequest: () => false, resolveBootstrapSetupWindow: pass,
}));

/** A controller stand-in that records it was reached and answers 200. */
const recorder = (name: string) => (_req: unknown, res: any) => { reached.push(name); res.status(200).json({ ok: true }); };
const recorders = (names: string[]) => Object.fromEntries(names.map((n) => [n, recorder(n)]));
const ORG_HANDLERS = [
  'listAllUsers', 'getUserById', 'createUserByAdmin', 'updateUserById', 'deleteUserById', 'bulkDeleteUsers', 'updateUserFeatures',
  'changePassword', 'createAccessKey', 'deleteUser', 'generateToken', 'getPreferences', 'getUser', 'listAccessKeys', 'listTokenHistory',
  'listUserOrganizations', 'revokeAllTokens', 'revokeAccessKey', 'updatePreferences', 'updateUser',
  'listSessions', 'revokeSession', 'getOwnPasswordPolicy',
  'snoozeMfaPrompt', 'declineMfaPrompt', 'resetMfaPrompt',
  'getMyOrganization', 'createOrganization', 'getOrgAIConfig', 'updateOrgAIConfig', 'getOrganizationById',
  'getOrganizationDescendants', 'getOrganizationNames', 'getOrganizationParent', 'updateOrganization',
  'updateOrganizationIdentity', 'updateOrganizationTier',
  'updateOrganizationSeatLimit', 'getOrganizationSeatUsage', 'getOrganizationFeatureEntitlements',
  'getOrganizationMembers', 'checkOrganizationMembership', 'getOrganizationTeams', 'getMemberTeams',
  'addMemberToOrganization', 'bulkAddMemberToTeams', 'removeMemberFromOrganization', 'transferOrganizationOwnership',
  'deactivateMember', 'activateMember', 'deleteOrganization', 'restoreOrganization', 'exportOrganization',
  'listDeletedTeams', 'deleteTeam', 'moveOrganization',
  'getOrganizationRoles', 'createOrganizationRole', 'updateOrganizationRole', 'deleteOrganizationRole',
  'addRoleMember', 'removeRoleMember', 'listOrgDomains', 'addOrgDomain', 'verifyOrgDomain', 'setOrgDomainMode',
  'deleteOrgDomain', 'listOrgJoinRequests', 'decideOrgJoinRequest',
  'getOrganizationServiceAccounts', 'getOrganizationServiceAccount', 'createOrganizationServiceAccount',
  'updateOrganizationServiceAccount', 'deleteOrganizationServiceAccount',
  'createOrganizationServiceAccountKey', 'revokeOrganizationServiceAccountKey',
];

jest.unstable_mockModule('../src/controllers/index.js', () => recorders(ORG_HANDLERS));
jest.unstable_mockModule('../src/controllers/org-idp-self.js', () => recorders(['getOwnOrgIdpConfig', 'putOwnOrgIdpConfig', 'patchOwnOrgIdpConfig', 'deleteOwnOrgIdpConfig', 'getOwnOrgIdpSpInfo', 'importOwnOrgIdpMetadata']));
jest.unstable_mockModule('../src/controllers/sso-test.js', () => recorders(['startSsoTest', 'completeSsoTest']));
jest.unstable_mockModule('../src/controllers/org-idp-mappings.js', () => recorders([
  'listOrgIdpGroupMappings', 'createOrgIdpGroupMapping', 'updateOrgIdpGroupMapping', 'deleteOrgIdpGroupMapping',
]));
jest.unstable_mockModule('../src/controllers/org-impersonation-policy.js', () => recorders(['getImpersonationPolicy', 'updateImpersonationPolicy']));
jest.unstable_mockModule('../src/controllers/org-mfa-policy.js', () => recorders(['getMfaPolicy', 'updateMfaPolicy']));
jest.unstable_mockModule('../src/controllers/org-security-policy.js', () => recorders([
  'getPasswordPolicy', 'updatePasswordPolicy', 'getAuthenticatorPolicy', 'updateAuthenticatorPolicy',
]));
jest.unstable_mockModule('../src/controllers/mfa-reset.js', () => recorders(['listMfaResets', 'requestMfaReset', 'approveMfaReset', 'denyMfaReset']));

const router = (await import('../src/routes/organization.js')).default as any;

async function hit(method: string, path: string, user: Record<string, unknown>) {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  expect(layer).toBeDefined();
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  const req: any = { user, params: { id: 'org-1' }, headers: {}, body: {}, method: method.toUpperCase(), path };
  for (const s of layer.route.stack) {
    let advanced = false;
    await s.handle(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const ROUTES: Array<[string, string, string]> = [
  ['patch', '/:id/identity', 'org:settings'],
  ['get', '/:id/mfa-policy', 'org:settings'],
  ['patch', '/:id/mfa-policy', 'org:settings'],
  ['patch', '/:id/password-policy', 'org:settings'],
  ['patch', '/:id/authenticator-policy', 'org:settings'],
  ['post', '/:id/domains', 'org:settings'],
  ['post', '/:id/restore', 'org:settings'],
  ['get', '/:id/export', 'org:settings'],
  ['get', '/:id/teams/deleted', 'org:settings'],
  ['patch', '/:id/impersonation-policy', 'org:impersonation'],
];

describe('org-settings routes — permission union, not the coarse admin role', () => {
  it.each(ROUTES)('%s %s admits a non-admin member whose custom Role grants %s', async (method, path, permission) => {
    reached.length = 0;
    const res = await hit(method, path, { sub: 'u1', organizationId: 'org-1', role: 'member', permissions: [permission] });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(reached).toHaveLength(1);
  });

  it.each(ROUTES)('%s %s refuses a member without %s before the controller runs', async (method, path) => {
    reached.length = 0;
    const res = await hit(method, path, { sub: 'u1', organizationId: 'org-1', role: 'member', permissions: ['pipelines:read'] });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(reached).toHaveLength(0);
  });
});

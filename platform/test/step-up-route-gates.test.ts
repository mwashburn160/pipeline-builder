// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring test: credential- and capability-granting routes carry api-core's
 * `requireStepUp` AFTER authentication.
 *   - PUT  /users/:id/features   grants feature capabilities to another user;
 *   - PUT  /organization/:id     sysadmin org edit, like its step-up-gated siblings.
 */

import { jest, describe, it, expect } from '@jest/globals';

const tagged = (name: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { __mw: name });
const requireStepUp = tagged('requireStepUp');

jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  requireStepUp,
  requirePermission: () => tagged('requirePermission'),
}));
jest.unstable_mockModule('../src/middleware/index.js', () => ({ requireAuth: tagged('requireAuth'), requireSystemAdmin: tagged('requireSystemAdmin') }));
// The routers only need referenceable handlers.
const HANDLERS = [
  'listAllUsers', 'getUserById', 'createUserByAdmin', 'updateUserById', 'deleteUserById', 'bulkDeleteUsers', 'updateUserFeatures',
  'changePassword', 'createPat', 'deleteUser', 'generateToken', 'getPreferences', 'getUser', 'listPats', 'listTokenHistory',
  'listUserOrganizations', 'revokeAllTokens', 'revokePat', 'updatePreferences', 'updateUser',
  'getMyOrganization', 'createOrganization', 'getOrgAIConfig', 'updateOrgAIConfig', 'getOrganizationById',
  'getOrganizationDescendants', 'getOrganizationNames', 'getOrganizationParent', 'updateOrganization',
  'updateOrganizationIdentity', 'updateOrganizationTier', 'getOrganizationQuotas', 'updateOrganizationQuotas',
  'updateOrganizationSeatLimit', 'getOrganizationSeatUsage', 'getOrganizationFeatureEntitlements',
  'getOrganizationMembers', 'checkOrganizationMembership', 'getOrganizationTeams', 'getMemberTeams',
  'addMemberToOrganization', 'bulkAddMemberToTeams', 'removeMemberFromOrganization', 'transferOrganizationOwnership',
  'deactivateMember', 'activateMember', 'deleteOrganization', 'restoreOrganization', 'exportOrganization',
  'getOrganizationRoles', 'createOrganizationRole', 'updateOrganizationRole', 'deleteOrganizationRole',
  'addRoleMember', 'removeRoleMember', 'listOrgDomains', 'addOrgDomain', 'verifyOrgDomain', 'setOrgDomainMode',
  'deleteOrgDomain', 'listOrgJoinRequests', 'decideOrgJoinRequest',
];
const handlers = (names: string[]) => Object.fromEntries(names.map((h) => [h, tagged(h)]));
jest.unstable_mockModule('../src/controllers/index.js', () => handlers(HANDLERS));
jest.unstable_mockModule('../src/controllers/org-idp-self.js', () => handlers(['getOwnOrgIdpConfig', 'putOwnOrgIdpConfig', 'patchOwnOrgIdpConfig', 'deleteOwnOrgIdpConfig']));
jest.unstable_mockModule('../src/controllers/org-impersonation-policy.js', () => handlers(['getImpersonationPolicy', 'updateImpersonationPolicy']));
jest.unstable_mockModule('../src/middleware/rate-limiter.js', () => ({ createLimiter: () => tagged('limiter'), userOrIpKey: () => 'k' }));

const usersRouter = (await import('../src/routes/users.js')).default as any;
const userRouter = (await import('../src/routes/user.js')).default as any;
const organizationRouter = (await import('../src/routes/organization.js')).default as any;

function chain(router: any, method: string, path: string): string[] {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  expect(layer).toBeDefined();
  return layer.route.stack.map((s: any) => s.handle.__mw);
}

describe('step-up route gates', () => {
  it('PUT /users/:id/features requires step-up after auth', () => {
    const mw = chain(usersRouter, 'put', '/:id/features');
    expect(mw).toContain('requireStepUp');
    expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
  });

  it('PUT /organization/:id requires step-up after auth', () => {
    const mw = chain(organizationRouter, 'put', '/:id');
    expect(mw).toContain('requireStepUp');
    expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
  });

  it('POST /user/generate-token is NOT step-up gated (unattended token renewal)', () => {
    const mw = chain(userRouter, 'post', '/generate-token');
    expect(mw).not.toContain('requireStepUp');
  });
});

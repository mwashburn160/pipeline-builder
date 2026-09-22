// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring test: credential- and capability-granting routes carry api-core's
 * `requireStepUp` AFTER authentication.
 *   - PUT  /users/:id/features   grants feature capabilities to another user;
 *   - PUT  /organization/:id     sysadmin org edit, like its step-up-gated siblings.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { routeChain } from './helpers/route-chain.js';

const tagged = (name: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { __mw: name });
const requireStepUp = tagged('requireStepUp');

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // Both call shapes: the bare middleware, and the factor-restricted form
  // (`requireStepUp({ methods })`) the most dangerous routes use.
  requireStepUp: Object.assign((...args: unknown[]) => (
    args.length === 3 ? (requireStepUp as (...a: unknown[]) => unknown)(...args) : requireStepUp
  ), { __mw: 'requireStepUp' }),
  requirePermission: () => tagged('requirePermission'),
  requireAssurance: () => tagged('requireAssurance'),
  requireOrgAdminAssurance: () => tagged('requireOrgAdminAssurance'),
  tagRouteGate: <T>(fn: T) => fn,
  STRONG_STEP_UP_METHODS: ['webauthn', 'totp'],
  // Route-table audit declaration — a tagged pass-through, so it shows up in the
  // middleware chain this test inspects without affecting the step-up ordering.
  audited: (..._actions: string[]) => tagged('audited'),
}));
jest.unstable_mockModule('../src/middleware/index.js', () => ({ requireAuth: tagged('requireAuth'), requireSystemAdmin: tagged('requireSystemAdmin') }));
// The routers only need referenceable handlers.
const HANDLERS = [
  'listAllUsers', 'getUserById', 'createUserByAdmin', 'updateUserById', 'deleteUserById', 'bulkDeleteUsers', 'updateUserFeatures',
  'changePassword', 'createAccessKey', 'deleteUser', 'generateToken', 'getPreferences', 'getUser', 'listAccessKeys', 'listTokenHistory',
  'listUserOrganizations', 'revokeAllTokens', 'revokeAccessKey', 'updatePreferences', 'updateUser',
  'listSessions', 'revokeSession', 'getOwnPasswordPolicy',
  // The password-only prompt's own-account writes — none of them step-up gated,
  // which is the property the `/user` assertions below pin.
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
const handlers = (names: string[]) => Object.fromEntries(names.map((h) => [h, tagged(h)]));
jest.unstable_mockModule('../src/controllers/index.js', () => handlers(HANDLERS));
jest.unstable_mockModule('../src/controllers/org-idp-self.js', () => handlers(['getOwnOrgIdpConfig', 'putOwnOrgIdpConfig', 'patchOwnOrgIdpConfig', 'deleteOwnOrgIdpConfig', 'getOwnOrgIdpSpInfo', 'importOwnOrgIdpMetadata']));
jest.unstable_mockModule('../src/controllers/sso-test.js', () => handlers(['startSsoTest', 'completeSsoTest']));
jest.unstable_mockModule('../src/controllers/org-idp-mappings.js', () => handlers([
  'listOrgIdpGroupMappings', 'createOrgIdpGroupMapping', 'updateOrgIdpGroupMapping', 'deleteOrgIdpGroupMapping',
]));
jest.unstable_mockModule('../src/controllers/org-impersonation-policy.js', () => handlers(['getImpersonationPolicy', 'updateImpersonationPolicy']));
jest.unstable_mockModule('../src/controllers/org-mfa-policy.js', () => handlers(['getMfaPolicy', 'updateMfaPolicy']));
jest.unstable_mockModule('../src/controllers/org-security-policy.js', () => handlers([
  'getPasswordPolicy', 'updatePasswordPolicy', 'getAuthenticatorPolicy', 'updateAuthenticatorPolicy',
]));
jest.unstable_mockModule('../src/controllers/mfa-reset.js', () => handlers(['listMfaResets', 'requestMfaReset', 'approveMfaReset', 'denyMfaReset']));
jest.unstable_mockModule('../src/middleware/rate-limiter.js', () => ({ createLimiter: () => tagged('limiter'), userOrIpKey: () => 'k' }));

const usersRouter = (await import('../src/routes/users.js')).default as any;
const userRouter = (await import('../src/routes/user.js')).default as any;
const organizationRouter = (await import('../src/routes/organization.js')).default as any;


describe('step-up route gates', () => {
  it('PUT /users/:id/features requires step-up after auth', () => {
    const mw = routeChain(usersRouter, 'put', '/:id/features');
    expect(mw).toContain('requireStepUp');
    expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
  });

  it('service-account writes require step-up after auth (minting a machine credential)', () => {
    for (const [method, path] of [
      ['post', '/:id/service-accounts'],
      ['patch', '/:id/service-accounts/:accountId'],
      ['delete', '/:id/service-accounts/:accountId'],
      ['post', '/:id/service-accounts/:accountId/keys'],
    ] as const) {
      const mw = routeChain(organizationRouter, method, path);
      expect(mw).toContain('requireStepUp');
      expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
    }
  });

  it('service-account key REVOCATION is deliberately not step-up gated', () => {
    // Revocation only ever removes access — a compromised key must be killable
    // immediately, without a second factor.
    const mw = routeChain(organizationRouter, 'delete', '/:id/service-accounts/:accountId/keys/:keyId');
    expect(mw).toContain('requireAuth');
    expect(mw).not.toContain('requireStepUp');
  });

  it('PUT /organization/:id requires step-up after auth', () => {
    const mw = routeChain(organizationRouter, 'put', '/:id');
    expect(mw).toContain('requireStepUp');
    expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
  });

  it('team delete and org move require step-up after auth; the deleted-team list does not', () => {
    for (const [method, path] of [['delete', '/:id/teams/:teamId'], ['post', '/:id/move']] as const) {
      const mw = routeChain(organizationRouter, method, path);
      expect(mw).toContain('requireStepUp');
      expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
    }
    expect(routeChain(organizationRouter, 'get', '/:id/teams/deleted')).not.toContain('requireStepUp');
  });

  it('POST /user/generate-token is NOT step-up gated (unattended token renewal)', () => {
    const mw = routeChain(userRouter, 'post', '/generate-token');
    expect(mw).not.toContain('requireStepUp');
  });
});

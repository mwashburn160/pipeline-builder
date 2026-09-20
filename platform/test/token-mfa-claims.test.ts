// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The MFA-policy decisions made at the TOKEN chokepoint:
 *   - `org_admin_aal: 2` is stamped exactly when the org's (effective)
 *     "administrative actions require MFA" policy is on — on sessions and PATs
 *     alike, so each route decides what a machine meets;
 *   - an enforced "require MFA" refuses an `aal: 1` session, EXCEPT for a person
 *     inside an approved reset's per-user enrolment grace — and only while it
 *     runs.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    auth: {
      passwordMinLength: 8,
      jwt: { secret: 'test-jwt-secret', expiresIn: 7200, algorithm: 'HS256', tierExpiresIn: {} },
      refreshToken: { secret: 'test-refresh-secret', expiresIn: 2592000 },
    },
  },
}));

let policy: Record<string, unknown> = {};
jest.unstable_mockModule('../src/helpers/mfa-policy.js', () => ({ resolveEffectiveMfaPolicy: async () => policy }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));

const chain = <T>(value: T) => {
  const c: any = { lean: async () => value, select: () => c, session: () => c, sort: () => c };
  return c;
};
jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { updateOne: jest.fn(async () => ({})) },
  Organization: { findById: () => chain({ _id: 'org', name: 'Org', tier: 'team', parentOrgId: null }) },
  UserOrganization: {
    findOne: () => chain({ userId: 'u1', organizationId: 'org', role: 'admin', isActive: true }),
    find: () => chain([]),
  },
  RoleAssignment: { find: () => chain([]) },
  Role: { find: () => chain([]) },
}));

const { issueTokens, signApiKeyToken, signInAuth } = await import('../src/utils/token.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();

const user = (extra: Record<string, unknown> = {}) =>
  ({ _id: { toString: () => 'u1' }, username: 'u1', email: 'u1@x.com', isEmailVerified: true, tokenVersion: 1, ...extra }) as any;
const claims = (token: string) => jwt.decode(token) as Record<string, any>;
const pwd = { kind: 'interactive' as const, auth: signInAuth('pwd') };

beforeEach(() => { policy = {}; });

describe('org_admin_aal', () => {
  it('is absent while the policy is off', async () => {
    expect(claims((await issueTokens(user(), 'org', pwd)).accessToken).org_admin_aal).toBeUndefined();
  });

  it('is 2 on a session when the (effective) policy is on', async () => {
    policy = { adminActionsRequireMfa: true };
    expect(claims((await issueTokens(user(), 'org', pwd)).accessToken).org_admin_aal).toBe(2);
  });

  it('rides a PAT exchange too, so the route decides what a machine meets', async () => {
    policy = { adminActionsRequireMfa: true };
    const token = await signApiKeyToken(user(), { organizationId: 'org', role: 'admin', adminActionsRequireMfa: true }, 'key1', signInAuth('pwd'));
    expect(claims(token)).toMatchObject({ token_use: 'api_key', org_admin_aal: 2 });
  });
});

describe('the per-user MFA-reset enrolment grace', () => {
  beforeEach(() => { policy = { requireMfa: true, enforced: true }; });

  it('an enforced requirement refuses a single-factor session', async () => {
    await expect(issueTokens(user(), 'org', pwd)).rejects.toThrow('MFA_REQUIRED_FOR_ORG');
  });

  it('is honoured while it runs', async () => {
    const graced = user({ mfaResetGraceUntil: new Date(Date.now() + 3600_000) });
    await expect(issueTokens(graced, 'org', pwd)).resolves.toBeTruthy();
  });

  it('is not honoured once it has passed', async () => {
    const lapsed = user({ mfaResetGraceUntil: new Date(Date.now() - 1000) });
    await expect(issueTokens(lapsed, 'org', pwd)).rejects.toThrow('MFA_REQUIRED_FOR_ORG');
  });
});

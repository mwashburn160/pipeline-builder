// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ISSUANCE-TIME assurance (#8) — `signInAuth`, and the bootstrap-session
 * reach allowlist.
 *
 * `signInAuth` is the one place a sign-in is described, so it is the one place
 * that decides `aal`. Every combination is pinned here because the rules are a
 * security decision, not an implementation detail: getting "a passkey is
 * MFA-grade" or "plain SSO is not" wrong would either lock people out or hand
 * out a level that nothing behind it actually verified.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Pure logic under test: the assurance decision and the allowlist. The config,
// models and metrics graphs are stubbed so neither needs a database — the
// database-backed halves of #8 live in `mfa-bootstrap.integration.test.ts`.
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    auth: {
      jwt: { secret: 'test-secret', algorithm: 'HS256', expiresIn: 3600, tierExpiresIn: {} },
      refreshToken: { secret: 'test-refresh-secret', expiresIn: 86400 },
      passwordMinLength: 8,
    },
  },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  resolveUserFeatures: jest.fn(() => ({})),
  resolveUserPermissions: jest.fn(() => []),
  resolveOrgLineageWith: jest.fn(),
  isAncestorOrgWith: jest.fn(),
  expandOrgScopeWith: jest.fn(),
  toOrgIdString: (id: unknown) => String(id),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {},
  Organization: {},
  UserOrganization: {},
  Role: {},
  RoleAssignment: {},
  PersonalAccessToken: {},
  WebAuthnCredential: {},
  UserTotp: {},
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));

const { signInAuth, authFromClaims } = await import('../src/utils/token.js');
const { bootstrapSessionMayReach, isBootstrapSuperAdminEmail } = await import('../src/helpers/bootstrap-admin.js');

describe('signInAuth — assurance for every factor combination', () => {
  it('password alone is aal 1', () => {
    expect(signInAuth('pwd')).toMatchObject({ amr: ['pwd'], aal: 1 });
  });

  it('social sign-in is aal 1', () => {
    expect(signInAuth('oauth')).toMatchObject({ amr: ['oauth'], aal: 1 });
  });

  it('SSO through an UNMARKED IdP is aal 1 — providers do not report amr reliably', () => {
    expect(signInAuth('sso')).toMatchObject({ amr: ['sso'], aal: 1 });
  });

  it('SSO through an IdP the org marked as enforcing MFA is aal 2', () => {
    expect(signInAuth('sso', { idpMfa: true })).toMatchObject({ amr: ['sso'], aal: 2 });
  });

  it('a passkey is aal 2 on its own — user verification proves credential AND person', () => {
    expect(signInAuth('webauthn')).toMatchObject({ amr: ['webauthn'], aal: 2 });
  });

  it('password plus an authenticator code is aal 2, and says so in amr', () => {
    expect(signInAuth('pwd', { mfa: true })).toMatchObject({ amr: ['pwd', 'mfa'], aal: 2 });
  });

  it('stamps auth_time at the moment of the sign-in', () => {
    const before = Date.now();
    const auth = signInAuth('pwd');
    expect(auth.authTime.getTime()).toBeGreaterThanOrEqual(before);
    expect(auth.authTime.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('authFromClaims — a derived credential inherits, never raises', () => {
  it('carries an aal-2 session through unchanged', () => {
    const claims = { amr: ['webauthn' as const], aal: 2 as const, auth_time: 1_700_000_000 };
    expect(authFromClaims(claims)).toEqual({ amr: ['webauthn'], aal: 2, authTime: new Date(1_700_000_000_000) });
  });

  it('carries an aal-1 session through as aal 1 — nothing derived can promote it', () => {
    const claims = { amr: ['pwd' as const], aal: 1 as const, auth_time: 1_700_000_000 };
    expect(authFromClaims(claims).aal).toBe(1);
  });

  it('fails closed on a token with no assurance claims', () => {
    expect(() => authFromClaims({ amr: ['pwd'], auth_time: 1 } as never)).toThrow('SESSION_AUTH_MISSING');
    expect(() => authFromClaims(undefined)).toThrow('SESSION_AUTH_MISSING');
  });
});

describe('isBootstrapSuperAdminEmail', () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const previous = process.env.BOOTSTRAP_SUPERADMIN_EMAILS;
    if (value === undefined) delete process.env.BOOTSTRAP_SUPERADMIN_EMAILS;
    else process.env.BOOTSTRAP_SUPERADMIN_EMAILS = value;
    try { fn(); } finally {
      if (previous === undefined) delete process.env.BOOTSTRAP_SUPERADMIN_EMAILS;
      else process.env.BOOTSTRAP_SUPERADMIN_EMAILS = previous;
    }
  };

  it('matches case-insensitively and ignores whitespace', () => {
    withEnv(' Admin@Internal , ops@acme.com ', () => {
      expect(isBootstrapSuperAdminEmail('admin@internal')).toBe(true);
      expect(isBootstrapSuperAdminEmail('OPS@ACME.COM')).toBe(true);
      expect(isBootstrapSuperAdminEmail('someone@acme.com')).toBe(false);
    });
  });

  it('is false for every address when the env is unset — the SaaS case', () => {
    withEnv(undefined, () => {
      expect(isBootstrapSuperAdminEmail('admin@internal')).toBe(false);
    });
  });

  it('is false for an empty list, and for no email at all', () => {
    withEnv('', () => expect(isBootstrapSuperAdminEmail('admin@internal')).toBe(false));
    withEnv('admin@internal', () => expect(isBootstrapSuperAdminEmail(undefined)).toBe(false));
  });
});

describe('bootstrapSessionMayReach — what an enrolment session can touch', () => {
  const may = (method: string, path: string) => bootstrapSessionMayReach({ method, path, originalUrl: path } as never);

  it('allows enrolment: passkeys, authenticator app, step-up and the profile read', () => {
    expect(may('POST', '/auth/webauthn/register/options')).toBe(true);
    expect(may('POST', '/auth/webauthn/register/verify')).toBe(true);
    expect(may('POST', '/auth/totp/enrol')).toBe(true);
    expect(may('POST', '/auth/totp/activate')).toBe(true);
    expect(may('POST', '/auth/step-up')).toBe(true);
    expect(may('GET', '/user/profile')).toBe(true);
  });

  it('allows leaving: sign-out and the refresh that keeps enrolment alive', () => {
    expect(may('POST', '/auth/logout')).toBe(true);
    expect(may('POST', '/auth/refresh')).toBe(true);
  });

  it('allows exactly the setup calls init-platform.sh makes', () => {
    expect(may('GET', '/organization')).toBe(true);
    expect(may('GET', '/organization/000000000000000000000001/roles')).toBe(true);
    expect(may('POST', '/organization/000000000000000000000001/service-accounts')).toBe(true);
    expect(may('GET', '/organization/000000000000000000000001/service-accounts/abc')).toBe(true);
    expect(may('POST', '/organization/000000000000000000000001/service-accounts/abc/keys')).toBe(true);
    expect(may('DELETE', '/organization/000000000000000000000001/service-accounts/abc/keys/k1')).toBe(true);
  });

  it('refuses everything else — the platform-admin surface included', () => {
    expect(may('GET', '/admin/summary')).toBe(false);
    expect(may('POST', '/admin/impersonate/u1')).toBe(false);
    expect(may('GET', '/audit')).toBe(false);
    expect(may('PATCH', '/organization/000000000000000000000001/mfa-policy')).toBe(false);
    expect(may('GET', '/organization/000000000000000000000001/members')).toBe(false);
    expect(may('POST', '/organization')).toBe(false);
    expect(may('GET', '/users')).toBe(false);
  });

  it('matches on the path only, never on a query string an attacker controls', () => {
    expect(bootstrapSessionMayReach({ method: 'GET', path: '/admin/summary', originalUrl: '/admin/summary?x=/user/profile' } as never)).toBe(false);
    expect(bootstrapSessionMayReach({ method: 'GET', path: '/user/profile', originalUrl: '/user/profile?fresh=1' } as never)).toBe(true);
  });

  it('does not let a near-miss path through', () => {
    // `/organization` exactly, not a prefix — `/organizations` is a different
    // (fleet-wide) surface.
    expect(may('GET', '/organizations')).toBe(false);
    expect(may('GET', '/user/profile/extra')).toBe(false);
    expect(may('POST', '/auth/webauthn')).toBe(false);
  });
});

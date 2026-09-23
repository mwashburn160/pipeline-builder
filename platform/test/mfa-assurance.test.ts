// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ISSUANCE-TIME assurance — `signInAuth`, and the bootstrap-session
 * reach allowlist.
 *
 * `signInAuth` is the one place a sign-in is described, so it is the one place
 * that decides `aal`. Every combination is pinned here because the rules are a
 * security decision, not an implementation detail: getting "a passkey is
 * MFA-grade" or "plain SSO is not" wrong would either lock people out or hand
 * out a level that nothing behind it actually verified.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Pure logic under test: the assurance decision and the allowlist. The config,
// models and metrics graphs are stubbed so neither needs a database — the
// database-backed halves live in `mfa-bootstrap.integration.test.ts`.
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: {
    jwt: { secret: 'test-secret', algorithm: 'HS256', expiresIn: 3600, tierExpiresIn: {} },
    refreshToken: { secret: 'test-refresh-secret', expiresIn: 86400 },
    passwordMinLength: 8,
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

const { signInAuth, authFromClaims } = await import('../src/services/session/access-tokens.js');
const { bootstrapSessionMayReach, isBootstrapSetupRequest, isBootstrapSuperAdminEmail } = await import('../src/helpers/bootstrap-admin.js');

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

  it('SSO through an IdP the org marked as enforcing MFA is aal 2 — recorded as that org\'s assertion', () => {
    expect(signInAuth('sso', { idpMfaOrgId: 'org-1' })).toMatchObject({ amr: ['sso'], aal: 2, aalAssertedBy: 'org-1' });
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
    // Sign-out asks for the SSO Single-Logout redirect FIRST, so refusing it
    // made every bootstrap sign-out spend one of the IP-keyed auth limiter's
    // 20-per-15-minutes on a request that could never succeed — and the
    // frontend swallows the failure, so nothing showed it.
    expect(may('POST', '/auth/sso/logout')).toBe(true);
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

describe('isBootstrapSetupRequest — the one assurance exemption', () => {
  // A fresh install's only admin has no factor, so their session is `aal: 1` and
  // cannot satisfy the `minAssurance: 2` on the two service-account mints that
  // init-platform.sh must make. That is what this predicate names — and it must
  // name nothing else: all three parts (the LIVE window answer, the flag AND the
  // allowlist) are required, so an ordinary weak session gets no exemption and a
  // bootstrap session gets no extra reach.
  //
  // `bootstrapSetupInWindow` is what `resolveBootstrapSetupWindow` records after
  // re-reading the install age and the account. It is required here because the
  // `mfaEnrollmentPending` CLAIM outlives the thing it describes: enrolment clears
  // the flag from the refresh slots, but an access token already issued keeps it
  // for the rest of its ~15-minute life.
  const req = (over: Record<string, unknown>) => ({
    method: 'POST',
    path: '/organization/000000000000000000000001/service-accounts',
    originalUrl: '/organization/000000000000000000000001/service-accounts',
    bootstrapSetupInWindow: true,
    ...over,
  } as never);

  it('names the setup calls a bootstrap session has to make', () => {
    expect(isBootstrapSetupRequest(req({ user: { mfaEnrollmentPending: true } }))).toBe(true);
    expect(isBootstrapSetupRequest(req({
      user: { mfaEnrollmentPending: true },
      method: 'POST',
      path: '/organization/000000000000000000000001/service-accounts/a1/keys',
      originalUrl: '/organization/000000000000000000000001/service-accounts/a1/keys',
    }))).toBe(true);
  });

  it('refuses when the live window check has not answered, or answered no', () => {
    const pending = { user: { mfaEnrollmentPending: true } };
    // Middleware never ran (route forgot to mount it) — fails CLOSED, so the
    // route simply requires `aal: 2` from everybody, as it did before the
    // exemption existed.
    expect(isBootstrapSetupRequest(req({ ...pending, bootstrapSetupInWindow: undefined }))).toBe(false);
    // Install past its window, or the exception already closed by an enrolment:
    // reach to enrolment is untouched, but minting a durable key is not.
    expect(isBootstrapSetupRequest(req({ ...pending, bootstrapSetupInWindow: false }))).toBe(false);
  });

  it('exempts nobody whose session is not an enrolment session', () => {
    expect(isBootstrapSetupRequest(req({ user: { mfaEnrollmentPending: false } }))).toBe(false);
    expect(isBootstrapSetupRequest(req({ user: { aal: 1 } }))).toBe(false);
    expect(isBootstrapSetupRequest(req({}))).toBe(false);
  });

  it('does not widen the reach — a route off the allowlist is never exempt', () => {
    const pending = { user: { mfaEnrollmentPending: true } };
    expect(isBootstrapSetupRequest(req({
      ...pending,
      method: 'POST',
      path: '/organization/000000000000000000000001/mfa-resets',
      originalUrl: '/organization/000000000000000000000001/mfa-resets',
    }))).toBe(false);
    expect(isBootstrapSetupRequest(req({
      ...pending,
      method: 'PATCH',
      path: '/organization/000000000000000000000001/mfa-policy',
      originalUrl: '/organization/000000000000000000000001/mfa-policy',
    }))).toBe(false);
  });

  it('reads the path, not a query string the caller controls', () => {
    expect(isBootstrapSetupRequest(req({
      user: { mfaEnrollmentPending: true },
      method: 'PATCH',
      path: '/organization/000000000000000000000001/mfa-policy',
      originalUrl: '/organization/000000000000000000000001/mfa-policy?x=/service-accounts',
    }))).toBe(false);
  });
});

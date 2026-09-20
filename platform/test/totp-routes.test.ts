// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TOTP route wiring — the gates are the security property, so they are pinned
 * directly:
 *   - enrolling, disabling and re-keying recovery codes all require a STEP-UP
 *     token after auth AND an INTERACTIVE session (never an API key, a scoped
 *     machine token or an impersonated session — which is what "no enrolment or
 *     removal during read-only impersonation" actually means in code);
 *   - `activate` deliberately does NOT re-prompt for step-up: it confirms the
 *     pending secret the gated `/enrol` call minted, and the code in the body is
 *     the proof;
 *   - the TOTP step-up shares the ONE per-user step-up budget with the password,
 *     provider-re-auth and passkey paths;
 *   - the sign-in exchange is public, like `/auth/login`, with its own limiter.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const tagged = (name: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { __mw: name });

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireStepUp: tagged('requireStepUp'),
  requireAuth: tagged('requireAuth'),
  audited: (...actions: string[]) => tagged(`audited:${actions.join(',')}`),
  verifyServicePrincipal: () => false,
  sendError: jest.fn(),
  isServicePrincipal: () => false,
  isServiceAccountPrincipal: () => false,
  createLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
}));
jest.unstable_mockModule('../src/middleware/index.js', () => ({
  requireAuth: tagged('requireAuth'),
  requireInteractiveSession: tagged('requireInteractiveSession'),
  stepUpLimiter: tagged('stepUpLimiter'),
  isValidRefreshToken: tagged('isValidRefreshToken'),
  requireClientType: tagged('requireClientType'),
}));
jest.unstable_mockModule('../src/middleware/rate-limiter.js', () => ({
  createLimiter: (opts: { name: string }) => tagged(`limiter:${opts.name}`),
  userOrIpKey: () => 'k',
}));
jest.unstable_mockModule('../src/middleware/rate-limit-keys.js', () => ({ extractClientIp: () => 'ip' }));

const TOTP_CONTROLLERS = [
  'activateTotp', 'disableTotp', 'enrolTotp',
  'totpStatus', 'stepUpVerifyTotp', 'verifyMfaLogin',
];
jest.unstable_mockModule('../src/controllers/totp.js', () => Object.fromEntries(TOTP_CONTROLLERS.map((c) => [c, tagged(c)])));

// The rest of `routes/auth.ts`'s controller surface, stubbed so mounting it
// doesn't drag in the identity graph this suite says nothing about.
jest.unstable_mockModule('../src/controllers/index.js', () => Object.fromEntries([
  'login', 'logout', 'register', 'refresh', 'switchOrg', 'sendVerificationEmail', 'verifyEmail',
  'markEmailVerified', 'completeOnboarding', 'getDomainOrgs', 'joinDomainOrg',
].map((c) => [c, tagged(c)])));
jest.unstable_mockModule('../src/controllers/step-up-reauth.js', () => ({
  startStepUpReauth: tagged('startStepUpReauth'), completeStepUpReauth: tagged('completeStepUpReauth'),
}));
jest.unstable_mockModule('../src/controllers/step-up.js', () => ({ stepUpVerify: tagged('stepUpVerify') }));
// `routes/auth.ts` also mounts the account's recovery codes (/auth/recovery-codes).
jest.unstable_mockModule('../src/controllers/recovery-codes.js', () => ({
  recoveryCodeStatus: tagged('recoveryCodeStatus'), regenerateRecoveryCodes: tagged('regenerateRecoveryCodes'),
}));
// routes/auth.ts also mounts the forced-password-change leg and the
// per-account login throttle; stubbed so this suite loads neither graph.
jest.unstable_mockModule('../src/controllers/password-change-required.js', () => ({
  completeRequiredPasswordChange: tagged('completeRequiredPasswordChange'),
}));
jest.unstable_mockModule('../src/middleware/login-limiter.js', () => ({ loginAccountLimiter: tagged('limiter:login-account') }));
jest.unstable_mockModule('../src/controllers/token-exchange.js', () => ({
  exchangeToken: tagged('exchangeToken'),
  rotateKey: tagged('rotateKey'),
  revokeKey: tagged('revokeKey'),
}));
jest.unstable_mockModule('../src/controllers/webauthn.js', () => Object.fromEntries([
  'listPasskeys', 'loginOptions', 'loginVerify', 'registerOptions', 'registerVerify',
  'removePasskey', 'renamePasskey', 'stepUpOptions', 'stepUpVerifyWebAuthn',
].map((c) => [c, tagged(c)])));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const totpRouter = (await import('../src/routes/totp.js')).default as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const authRouter = (await import('../src/routes/auth.js')).default as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recoveryRouter = (await import('../src/routes/recovery-codes.js')).default as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chain(router: any, method: string, path: string): string[] {
  const layer = router.stack.find((l: { route?: { path: string; methods: Record<string, boolean> } }) =>
    l.route?.path === path && l.route.methods[method]);
  expect(layer).toBeDefined();
  return layer.route.stack.map((s: { handle: { __mw?: string } }) => s.handle.__mw);
}

describe('TOTP route gates', () => {
  it.each([
    ['post', '/enrol'],
    ['delete', '/'],
  ])('%s %s requires step-up and an interactive session, after auth', (method, path) => {
    const mw = chain(totpRouter, method, path);
    expect(mw).toContain('requireStepUp');
    expect(mw).toContain('requireInteractiveSession');
    expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
    expect(mw.indexOf('requireInteractiveSession')).toBeGreaterThan(mw.indexOf('requireAuth'));
  });

  it('activate confirms the already-gated enrolment instead of re-prompting', () => {
    const mw = chain(totpRouter, 'post', '/activate');
    expect(mw).toContain('requireAuth');
    expect(mw).toContain('requireInteractiveSession');
    expect(mw).not.toContain('requireStepUp');
  });

  it('status is a plain authenticated read of the caller\'s own account', () => {
    expect(chain(totpRouter, 'get', '/status')).toEqual(['requireAuth', 'totpStatus']);
  });

  it('audits both ends of the factor\'s life', () => {
    expect(chain(totpRouter, 'post', '/enrol')).toContain('audited:user.totp.enrol');
    expect(chain(totpRouter, 'post', '/activate')).toContain('audited:user.totp.enrol,user.login.failed');
    expect(chain(totpRouter, 'delete', '/')).toContain('audited:user.totp.disable');
  });

  it('no longer owns the recovery codes (they belong to the account)', () => {
    const layer = totpRouter.stack.find((l: { route?: { path: string } }) => l.route?.path === '/recovery-codes');
    expect(layer).toBeUndefined();
  });
});

describe('recovery-code routes (/auth/recovery-codes)', () => {

  it('regeneration requires step-up and an interactive session, and is audited', () => {
    const mw = chain(recoveryRouter, 'post', '/');
    expect(mw).toContain('requireStepUp');
    expect(mw).toContain('requireInteractiveSession');
    expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
    expect(mw).toContain('audited:user.mfa.recovery_regenerate');
  });

  it('status is a plain authenticated read', () => {
    expect(chain(recoveryRouter, 'get', '/')).toEqual(['requireAuth', 'recoveryCodeStatus']);
  });
});

describe('TOTP on the sign-in surface', () => {
  it('step-up by code shares the one per-user step-up budget', () => {
    const mw = chain(authRouter, 'post', '/step-up/totp');
    expect(mw).toContain('requireAuth');
    expect(mw).toContain('stepUpLimiter');
    expect(mw).toContain('audited:user.step-up,user.login.failed');
    // A budget that reset per factor would just be the loosest of them.
    expect(mw.filter((m) => m?.startsWith('limiter:'))).toEqual([]);
  });

  it('the sign-in exchange is public, limited per challenge, and audits both outcomes', () => {
    const mw = chain(authRouter, 'post', '/mfa/verify');
    // Pre-auth by construction: the caller holds a challenge handle, not a session.
    expect(mw).not.toContain('requireAuth');
    expect(mw).toContain('limiter:mfa-verify');
    expect(mw).toContain('audited:user.login,user.login.failed');
  });
});

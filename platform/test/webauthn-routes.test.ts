// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey route wiring — the gates are the security property here, so they are
 * pinned directly:
 *   - enrolling and revoking a passkey require a STEP-UP token after auth, and
 *     an INTERACTIVE session (never an API key, a scoped machine token or an
 *     impersonated session);
 *   - `register/verify` deliberately does NOT re-prompt for step-up: the
 *     ceremony it consumes was minted by the gated `/options` call, is bound to
 *     the user and is single-use;
 *   - passkey SIGN-IN is public, like `/auth/login`, and its options endpoint
 *     has its OWN limiter (browser autofill asks on every page load, which would
 *     exhaust the shared pre-auth bucket for a whole NAT);
 *   - passkey STEP-UP shares the one per-user step-up budget with the password
 *     and provider-re-auth paths.
 *
 * `requireInteractiveSession` itself is exercised against real payloads below.
 */

import { jest, describe, it, expect } from '@jest/globals';

const tagged = (name: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { __mw: name });

jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
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

const CONTROLLERS = [
  'listPasskeys', 'loginOptions', 'loginVerify', 'registerOptions', 'registerVerify',
  'removePasskey', 'renamePasskey', 'stepUpOptions', 'stepUpVerifyWebAuthn',
];
jest.unstable_mockModule('../src/controllers/webauthn.js', () => Object.fromEntries(CONTROLLERS.map((c) => [c, tagged(c)])));
const AUTH_CONTROLLERS = [
  'login', 'logout', 'register', 'refresh', 'switchOrg', 'sendVerificationEmail', 'verifyEmail',
  'markEmailVerified', 'completeOnboarding', 'getDomainOrgs', 'joinDomainOrg',
];
jest.unstable_mockModule('../src/controllers/index.js', () => Object.fromEntries(AUTH_CONTROLLERS.map((c) => [c, tagged(c)])));
jest.unstable_mockModule('../src/controllers/step-up-reauth.js', () => ({
  startStepUpReauth: tagged('startStepUpReauth'), completeStepUpReauth: tagged('completeStepUpReauth'),
}));
jest.unstable_mockModule('../src/controllers/step-up.js', () => ({ stepUpVerify: tagged('stepUpVerify') }));
// `routes/auth.ts` also mounts the TOTP surface; stubbing its controller keeps
// this suite from loading the enrolment service graph it says nothing about.
jest.unstable_mockModule('../src/controllers/totp.js', () => Object.fromEntries(
  ['activateTotp', 'disableTotp', 'enrolTotp', 'regenerateRecoveryCodes', 'totpStatus', 'stepUpVerifyTotp', 'verifyMfaLogin']
    .map((c) => [c, tagged(c)]),
));
jest.unstable_mockModule('../src/controllers/token-exchange.js', () => ({
  exchangeToken: tagged('exchangeToken'),
  rotateKey: tagged('rotateKey'),
  revokeKey: tagged('revokeKey'),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webauthnRouter = (await import('../src/routes/webauthn.js')).default as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const authRouter = (await import('../src/routes/auth.js')).default as any;
const { requireInteractiveSession } = await import('../src/middleware/require-interactive-session.js');
const { sendError } = await import('@pipeline-builder/api-core');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chain(router: any, method: string, path: string): string[] {
  const layer = router.stack.find((l: { route?: { path: string; methods: Record<string, boolean> } }) =>
    l.route?.path === path && l.route.methods[method]);
  expect(layer).toBeDefined();
  return layer.route.stack.map((s: { handle: { __mw?: string } }) => s.handle.__mw);
}

describe('passkey route gates', () => {
  it.each([
    ['post', '/register/options'],
    ['delete', '/credentials/:id'],
  ])('%s %s requires step-up and an interactive session, after auth', (method, path) => {
    const mw = chain(webauthnRouter, method, path);
    expect(mw).toContain('requireStepUp');
    expect(mw).toContain('requireInteractiveSession');
    expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireAuth'));
    expect(mw.indexOf('requireInteractiveSession')).toBeGreaterThan(mw.indexOf('requireAuth'));
  });

  it('register/verify consumes the already-gated ceremony instead of re-prompting', () => {
    const mw = chain(webauthnRouter, 'post', '/register/verify');
    expect(mw).toContain('requireAuth');
    expect(mw).toContain('requireInteractiveSession');
    expect(mw).not.toContain('requireStepUp');
  });

  it('renaming needs an interactive session but no step-up (a label is not a credential)', () => {
    const mw = chain(webauthnRouter, 'patch', '/credentials/:id');
    expect(mw).toContain('requireInteractiveSession');
    expect(mw).not.toContain('requireStepUp');
  });

  it('listing is a plain authenticated read of the caller\'s own credentials', () => {
    expect(chain(webauthnRouter, 'get', '/credentials')).toEqual(['requireAuth', 'listPasskeys']);
  });

  it('sign-in is public, and its challenge endpoint has its own limiter', () => {
    const options = chain(webauthnRouter, 'post', '/login/options');
    expect(options).not.toContain('requireAuth');
    expect(options).toContain('limiter:webauthn-login-options');

    const verify = chain(webauthnRouter, 'post', '/login/verify');
    expect(verify).not.toContain('requireAuth');
    // The credential presentation stays on the shared pre-auth budget.
    expect(verify.filter((m) => m?.startsWith('limiter:'))).toEqual([]);
    expect(verify).toContain('audited:user.login,user.login.failed');
  });

  it('audits both ends of a passkey\'s life', () => {
    expect(chain(webauthnRouter, 'post', '/register/verify')).toContain('audited:user.passkey.register');
    expect(chain(webauthnRouter, 'delete', '/credentials/:id')).toContain('audited:user.passkey.remove');
    expect(chain(webauthnRouter, 'patch', '/credentials/:id')).toContain('audited:user.passkey.rename');
  });

  it('passkey step-up shares the one per-user step-up budget', () => {
    for (const path of ['/step-up/webauthn/options', '/step-up/webauthn/verify']) {
      const mw = chain(authRouter, 'post', path);
      expect(mw).toContain('requireAuth');
      expect(mw).toContain('stepUpLimiter');
    }
    // The same instance the password path uses.
    expect(chain(authRouter, 'post', '/step-up')).toContain('stepUpLimiter');
  });
});

describe('requireInteractiveSession', () => {
  const run = (user: Record<string, unknown> | undefined) => {
    const next = jest.fn();
    requireInteractiveSession({ user } as never, {} as never, next);
    return next.mock.calls.length > 0;
  };

  const session = { sub: 'u1', sid: 'sess-1', principalType: 'user', token_use: 'access' };

  it('admits a person\'s own signed-in session', () => {
    expect(run(session)).toBe(true);
  });

  it.each([
    ['an access key (no session slot, api_key use)', { ...session, sid: undefined, token_use: 'api_key' }],
    ['a scoped machine credential', { ...session, scope: 'reporting:ingest' }],
    ['an impersonated session', { ...session, impersonatorId: 'admin-1' }],
    ['no credential at all', undefined],
  ])('refuses %s', (_label, user) => {
    (sendError as jest.Mock).mockClear();
    expect(run(user as Record<string, unknown> | undefined)).toBe(false);
    expect(sendError).toHaveBeenCalledWith(expect.anything(), 403, expect.any(String), 'INTERACTIVE_SESSION_REQUIRED');
  });
});

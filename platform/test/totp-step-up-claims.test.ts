// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The claims a step-up token and an MFA sign-in actually carry.
 *
 * These are what the assurance levels read, so they are pinned
 * now — including the part that DOESN'T change: `aal` stays 1 everywhere. A
 * token claiming aal 2 before any gate understands the claim would be an
 * assertion nothing verifies, and would quietly become load-bearing the moment
 * the assurance model trusts it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const signed: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('../src/services/token-signing/index.js', () => ({
  signUserJwt: async (payload: Record<string, unknown>) => { signed.push(payload); return 'jwt'; },
  // `utils/jwt-options` (pulled in by utils/token) links against these too.
  verifyUserJwtSync: jest.fn(),
  publishedJwks: jest.fn(async () => ({ keys: [] })),
  isRetiringKeyPublished: () => false,
  initTokenSigning: jest.fn(),
  _resetTokenSigningForTests: jest.fn(),
  _setTokenSigningKeysForTests: jest.fn(),
}));

const { issueStepUpToken, signInAuth } = await import('../src/services/session/access-tokens.js');

const USER = '651111111111111111111111';

beforeEach(() => { signed.length = 0; });

describe('issueStepUpToken', () => {
  it.each(['totp', 'webauthn'] as const)('adds `mfa` to amr for a %s step-up', async (method) => {
    // The two SECOND FACTORS — the ones `STRONG_STEP_UP_METHODS` admits on
    // the most dangerous routes. `mfa` in amr is what says so.
    await issueStepUpToken(USER, method);
    expect(signed[0]).toMatchObject({ type: 'step-up', sub: USER, method, amr: ['stepup', 'mfa'] });
    expect(typeof signed[0].jti).toBe('string');
  });

  it.each(['password', 'reauth'] as const)('leaves amr alone for a %s step-up', async (method) => {
    // Re-entering the password, or re-running the provider sign-in, proves the
    // SAME factor the session was opened with — not a second one.
    await issueStepUpToken(USER, method);
    expect(signed[0]).toMatchObject({ method, amr: ['stepup'] });
  });
});

describe('signInAuth', () => {
  it('records the second factor in amr AND raises assurance to 2', () => {
    expect(signInAuth('pwd', { mfa: true })).toMatchObject({ amr: ['pwd', 'mfa'], aal: 2 });
    expect(signInAuth('pwd')).toMatchObject({ amr: ['pwd'], aal: 1 });
    // A passkey is verified with user verification required, so one ceremony
    // proves both the credential and the person.
    expect(signInAuth('webauthn')).toMatchObject({ amr: ['webauthn'], aal: 2 });
  });

  it('stamps the sign-in time it is called at', () => {
    const before = Date.now();
    const auth = signInAuth('pwd', { mfa: true });
    expect(auth.authTime.getTime()).toBeGreaterThanOrEqual(before);
  });
});

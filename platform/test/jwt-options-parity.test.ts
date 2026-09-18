// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform mints the tokens every other service verifies with api-core. This
 * pins that the two agree, on BOTH chains:
 *
 * - USER tokens: platform signs ES256 with a `kid`; api-core resolves that `kid`
 *   through the JWKS and verifies with the published public key. Platform
 *   verifies the same token synchronously from its own key set — the two must
 *   reach the same answer, including on issuer/audience and a `kid` rotation.
 * - SERVICE tokens: ES256 signed by the CALLING service with its own key (#14),
 *   verified on both sides against the same per-service public bundle —
 *   including the rotation overlap (two published keys) and a token signed by
 *   the WRONG service.
 *
 * And the separation between them: a token on the wrong chain is refused by
 * both, which is the guarantee the whole change exists for.
 *
 * Deep import: the REAL api-core verifier, not a mock.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import jwt from 'jsonwebtoken';

const jwtConfig: Record<string, unknown> = {};
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { jwt: jwtConfig } } }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {}, Organization: {}, UserOrganization: {}, Role: {}, RoleAssignment: {},
}));

const apiCoreAuth = await import('@pipeline-builder/api-core/lib/middleware/auth.js');
const { verifyPlatformJwt } = await import('../src/utils/jwt-options.js');
const { signUserJwt, _setTokenSigningKeysForTests } = await import('../src/services/token-signing/index.js');
const { generateSigningKey } = await import('./helpers/signing.js');
const { installTestServiceKeys } = await import('@pipeline-builder/api-core/lib/testing/service-tokens.js');

const ENV = ['JWT_ISSUER', 'JWT_AUDIENCE'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const signing = generateSigningKey();
// Real per-service key files, as the deploy writes them: `billing` is the
// caller, `evil` stands in for any other service that holds a valid key of its
// own and tries to speak for billing.
const serviceKeys = installTestServiceKeys(['billing', 'billing-next', 'evil']);

function configure(c: { issuer?: string; audience?: string } = {}) {
  Object.assign(jwtConfig, { issuer: undefined, audience: undefined, ...c });
  if (c.issuer) process.env.JWT_ISSUER = c.issuer; else delete process.env.JWT_ISSUER;
  if (c.audience) process.env.JWT_AUDIENCE = c.audience; else delete process.env.JWT_AUDIENCE;
  serviceKeys.publish(['billing', 'evil']);
  serviceKeys.becomeService('billing');
  _setTokenSigningKeysForTests({ current: signing, retiring: [] });
}

beforeEach(() => configure());
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  serviceKeys.uninstall();
  _setTokenSigningKeysForTests(undefined);
});

/** The USER chain, as any other service runs it (JWKS-backed, async). */
const verifyUserWithApiCore = (t: string) => apiCoreAuth.verifyUserJwt(t);
/** The SERVICE chain, as any other service runs it (bundle-backed, synchronous). */
const verifyServiceWithApiCore = (t: string) => apiCoreAuth.verifyBearerToken(t);

const userClaims = (over: Record<string, unknown> = {}) => ({
  type: 'access',
  sub: 'u1',
  principalType: 'user',
  token_use: 'access',
  amr: ['pwd'],
  aal: 1,
  auth_time: Math.floor(Date.now() / 1000),
  role: 'member',
  ...over,
});

describe('platform USER tokens under api-core verification', () => {
  it('a token platform signs with issuer/audience configured verifies in api-core', async () => {
    configure({ issuer: 'pipeline-builder', audience: 'pb-api' });
    const token = await signUserJwt(userClaims(), { expiresIn: 60 });
    await expect(verifyUserWithApiCore(token)).resolves.toMatchObject({ sub: 'u1', iss: 'pipeline-builder', aud: 'pb-api' });
    expect(verifyPlatformJwt<{ sub: string }>(token).sub).toBe('u1');
  });

  it('platform REFUSES a token from another issuer signed by the same key, exactly like api-core', async () => {
    configure();
    const foreign = await signUserJwt(userClaims(), { expiresIn: 60 });
    // Re-pin the expected issuer AFTER minting, so the token carries none.
    configure({ issuer: 'pipeline-builder' });
    expect(() => verifyPlatformJwt(foreign)).toThrow();
    await expect(verifyUserWithApiCore(foreign)).rejects.toThrow();
  });

  it('both accept a token signed with a RETIRING key that is still published', async () => {
    const retiring = generateSigningKey();
    _setTokenSigningKeysForTests({ current: retiring, retiring: [] });
    const old = await signUserJwt(userClaims(), { expiresIn: 60 });

    // Rotation overlap: platform signs with the new key, publishes both.
    _setTokenSigningKeysForTests({ current: signing, retiring: [{ kid: retiring.kid, publicKey: retiring.publicKey }] });
    expect(verifyPlatformJwt<{ sub: string }>(old).sub).toBe('u1');
    await expect(verifyUserWithApiCore(old)).resolves.toMatchObject({ sub: 'u1' });

    // Rotation finished: neither side accepts it any more.
    _setTokenSigningKeysForTests({ current: signing, retiring: [] });
    expect(() => verifyPlatformJwt(old)).toThrow();
    await expect(verifyUserWithApiCore(old)).rejects.toThrow();
  });

  it('neither accepts an EXPIRED token', async () => {
    const expired = await signUserJwt(userClaims(), { expiresIn: -10 });
    expect(() => verifyPlatformJwt(expired)).toThrow(jwt.TokenExpiredError);
    await expect(verifyUserWithApiCore(expired)).rejects.toThrow(jwt.TokenExpiredError);
  });

  it('NEITHER accepts an HS256 token that claims to be a user', async () => {
    const forged = jwt.sign(userClaims(), 'any-shared-secret', { algorithm: 'HS256', expiresIn: 60 });
    expect(() => verifyPlatformJwt(forged)).toThrow();
    await expect(apiCoreAuth.verifyBearerToken(forged)).rejects.toThrow();
  });

  it('NEITHER accepts an ES256 token that claims to be a service principal', async () => {
    const forged = await signUserJwt(
      { type: 'access', sub: 'service:billing', principalType: 'service', token_use: 'access', role: 'member' },
      { expiresIn: 60 },
    );
    expect(() => verifyPlatformJwt(forged)).toThrow();
    await expect(apiCoreAuth.verifyBearerToken(forged)).rejects.toThrow();
  });
});

describe('platform SERVICE tokens under api-core verification', () => {
  it('both accept a token signed with a RETIRING service key that is still published', async () => {
    // `billing-next` stands in for billing's INCOMING key; publishing both under
    // the name `billing` is the overlap window.
    serviceKeys.publishKeys({
      billing: [serviceKeys.keys.get('billing')!, serviceKeys.keys.get('billing-next')!],
      evil: [serviceKeys.keys.get('evil')!],
    });
    const old = serviceKeys.sign('billing');
    expect(verifyPlatformJwt<{ sub: string }>(old).sub).toBe('service:billing');
    await expect(verifyServiceWithApiCore(old)).resolves.toMatchObject({ sub: 'service:billing' });
  });

  it('NEITHER accepts a token signed by a DIFFERENT service than its subject names', async () => {
    const forged = serviceKeys.signAs('evil', 'billing');
    expect(() => verifyPlatformJwt(forged)).toThrow();
    await expect(verifyServiceWithApiCore(forged)).rejects.toThrow();
  });

  it('NEITHER accepts an HS256 service token, whatever secret signed it', async () => {
    const forged = jwt.sign(
      { type: 'access', sub: 'service:billing', principalType: 'service', token_use: 'access', role: 'member' },
      'any-shared-secret',
      { algorithm: 'HS256', expiresIn: 60 },
    );
    expect(() => verifyPlatformJwt(forged)).toThrow();
    await expect(verifyServiceWithApiCore(forged)).rejects.toThrow();
  });

  it('neither accepts an EXPIRED service token', async () => {
    const expired = serviceKeys.sign('billing', {}, -10);
    expect(() => verifyPlatformJwt(expired)).toThrow(jwt.TokenExpiredError);
    await expect(verifyServiceWithApiCore(expired)).rejects.toThrow(jwt.TokenExpiredError);
  });
});

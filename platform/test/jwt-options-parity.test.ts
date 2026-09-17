// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform mints the tokens every other service verifies with api-core. This
 * pins that platform's sign/verify options (utils/jwt-options.ts) agree with the
 * REAL api-core verifier: issuer/audience pinned when configured, and rotation
 * through JWT_SECRET_PREVIOUS.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import jwt from 'jsonwebtoken';

const jwtConfig: Record<string, unknown> = {};
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { jwt: jwtConfig } } }));

// Deep import: the REAL api-core verifier, not a mock.
const apiCoreAuth = await import('@pipeline-builder/api-core/lib/middleware/auth.js');
const { jwtSignOptions, verifyPlatformJwt } = await import('../src/utils/jwt-options.js');

const ENV = ['JWT_SECRET', 'JWT_SECRET_PREVIOUS', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_ALGORITHM'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

function configure(c: { secret: string; secretPrevious?: string; issuer?: string; audience?: string }) {
  Object.assign(jwtConfig, { algorithm: 'HS256', secretPrevious: undefined, issuer: undefined, audience: undefined, ...c });
  process.env.JWT_SECRET = c.secret;
  if (c.secretPrevious) process.env.JWT_SECRET_PREVIOUS = c.secretPrevious; else delete process.env.JWT_SECRET_PREVIOUS;
  if (c.issuer) process.env.JWT_ISSUER = c.issuer; else delete process.env.JWT_ISSUER;
  if (c.audience) process.env.JWT_AUDIENCE = c.audience; else delete process.env.JWT_AUDIENCE;
  delete process.env.JWT_ALGORITHM;
  apiCoreAuth._resetJwtSecretCacheForTests();
}

beforeEach(() => configure({ secret: 's-current' }));
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  apiCoreAuth._resetJwtSecretCacheForTests();
});

const verifyWithApiCore = (t: string) => apiCoreAuth.verifyJwtWithRotation(t, apiCoreAuth.buildJwtVerifyOptions());

describe('platform tokens under api-core verification', () => {
  it('a token platform signs with issuer/audience configured verifies in api-core', () => {
    configure({ secret: 's-current', issuer: 'pipeline-builder', audience: 'pb-api' });
    const token = jwt.sign({ sub: 'u1', type: 'access' }, 's-current', jwtSignOptions(60));
    expect(verifyWithApiCore(token)).toMatchObject({ sub: 'u1', iss: 'pipeline-builder', aud: 'pb-api' });
  });

  it('platform REFUSES a token from another issuer sharing the secret, exactly like api-core', () => {
    configure({ secret: 's-current', issuer: 'pipeline-builder' });
    const foreign = jwt.sign({ sub: 'u1' }, 's-current', { algorithm: 'HS256', issuer: 'someone-else', expiresIn: 60 });
    expect(() => verifyPlatformJwt(foreign)).toThrow();
    expect(() => verifyWithApiCore(foreign)).toThrow();
  });

  it('both accept a token signed with the previous secret during a rotation', () => {
    configure({ secret: 's-new', secretPrevious: 's-old' });
    const old = jwt.sign({ sub: 'u1' }, 's-old', jwtSignOptions(60));
    expect(verifyPlatformJwt<{ sub: string }>(old).sub).toBe('u1');
    expect(verifyWithApiCore(old).sub).toBe('u1');
  });

  it('neither lets the previous secret revive an EXPIRED token', () => {
    configure({ secret: 's-new', secretPrevious: 's-old' });
    const expired = jwt.sign({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 10 }, 's-new', { algorithm: 'HS256' });
    expect(() => verifyPlatformJwt(expired)).toThrow(jwt.TokenExpiredError);
    expect(() => verifyWithApiCore(expired)).toThrow(jwt.TokenExpiredError);
  });
});

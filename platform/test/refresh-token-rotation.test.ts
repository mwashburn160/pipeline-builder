// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rotation drill for the refresh-token signing key (docs/runbooks/secret-rotation.md).
 *
 * Refresh tokens live for 30 days, so a rotation without an overlap window would
 * sign every signed-in device out. They are ES256 like every other user
 * token and have no secret of their own: the overlap is the RETIRING `kid` still
 * published in the JWKS, and the rotation ends when the operator drops it.
 * Verified against the same helper `utils/token.ts#verifyRefreshToken` calls.
 */

import { jest, describe, it, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ auth: { jwt: { algorithm: 'HS256', secret: 'service-secret' }, refreshToken: { expiresIn: 2592000 } } }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {}, Organization: {}, UserOrganization: {}, Role: {}, RoleAssignment: {},
}));

const { verifyRefreshJwt } = await import('../src/utils/jwt-options.js');
const { signUserJwt, _setTokenSigningKeysForTests } = await import('../src/services/token-signing/index.js');
const { generateSigningKey } = await import('./helpers/signing.js');

const incoming = generateSigningKey();
const retiring = generateSigningKey();

/** Publish `current` as the signing key, plus any verification-only keys. */
function configure(current: typeof incoming, ...published: Array<typeof incoming>) {
  _setTokenSigningKeysForTests({ current, retiring: published.map((k) => ({ kid: k.kid, publicKey: k.publicKey })) });
}

const sign = (payload: object = {}, expiresIn = 600) =>
  signUserJwt({ type: 'refresh', sub: 'u1', sid: 'sess-1', ...payload }, { expiresIn });

describe('refresh-token signing-key rotation', () => {
  it('old refresh token: accepted during the overlap, rejected once the retiring key is dropped', async () => {
    configure(retiring);
    const oldToken = await sign();
    expect(verifyRefreshJwt<{ sub: string }>(oldToken).sub).toBe('u1');

    // Overlap: platform signs with the incoming key and keeps publishing the old one.
    configure(incoming, retiring);
    const newToken = await sign({ sub: 'u2' });
    expect(verifyRefreshJwt<{ sub: string }>(oldToken).sub).toBe('u1');
    expect(verifyRefreshJwt<{ sub: string }>(newToken).sub).toBe('u2');

    // Finished: the retiring kid is no longer published.
    configure(incoming);
    expect(() => verifyRefreshJwt(oldToken)).toThrow(jwt.JsonWebTokenError);
    expect(verifyRefreshJwt<{ sub: string }>(newToken).sub).toBe('u2');
  });

  it('the retiring key does not revive an EXPIRED refresh token', async () => {
    configure(retiring);
    const expired = await sign({}, -5);
    configure(incoming, retiring);
    expect(() => verifyRefreshJwt(expired)).toThrow(jwt.TokenExpiredError);
  });

  it('keeps algorithm pinning — `alg: none` is refused', () => {
    configure(incoming, retiring);
    const noneAlg = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: incoming.kid })).toString('base64url')}.${Buffer.from(JSON.stringify({ type: 'refresh', sub: 'u1' })).toString('base64url')}.`;
    expect(() => verifyRefreshJwt(noneAlg)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects a token signed by a key that is not published', async () => {
    configure(generateSigningKey());
    const foreign = await sign();
    configure(incoming, retiring);
    expect(() => verifyRefreshJwt(foreign)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects an HS256 refresh token forged with the shared service secret', () => {
    configure(incoming, retiring);
    const forged = jwt.sign({ type: 'refresh', sub: 'u1', sid: 'sess-1' }, 'service-secret', { algorithm: 'HS256', expiresIn: 600 });
    expect(() => verifyRefreshJwt(forged)).toThrow(jwt.JsonWebTokenError);
  });
});

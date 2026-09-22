// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bearer-token verification: the user chain (ES256 against platform's JWKS) and
 * the identity-claim shape every gate reasons about.
 */

import jwt from 'jsonwebtoken';
import { platformJwksCache } from '../services/jwks-cache.js';
import { SERVICE_SUBJECT_PREFIX, isServiceKid, verifyServiceJwt } from '../services/service-keys.js';
import { AUTH_METHODS, PRINCIPAL_TYPES, TOKEN_USES, type JwtPayload } from '../types/common.js';
import { USER_TOKEN_ALGORITHM, decodeJwtHeader } from '../utils/jwk.js';
import { emitCounter } from '../utils/metric-emitter.js';
/** Issuer/audience pinning, when the deployment configures them. Shared by both chains. */
export function issuerAudienceOptions(): { issuer?: string; audience?: string } {
  return {
    ...(process.env.JWT_ISSUER ? { issuer: process.env.JWT_ISSUER } : {}),
    ...(process.env.JWT_AUDIENCE ? { audience: process.env.JWT_AUDIENCE } : {}),
  };
}

/**
 * Verify a token that speaks for a PERSON — access, step-up, and the token an
 * opaque access key is exchanged for — against platform's published signing
 * keys.
 *
 * ES256 and a `kid` are both mandatory: no `kid` means no way to pick the right
 * key across a rotation, and any other algorithm is refused outright, which is
 * what makes "no service accepts an HS256 user token" a property of the code
 * rather than a convention. Key lookup goes through the shared JWKS cache
 * (10-minute refresh, one refetch on an unknown `kid`, brief negative cache).
 *
 * @throws {UnknownKidError} the key set is current and has no such key → 401.
 * @throws {JwksUnavailableError} the key set could not be obtained → 503; an
 *         unverifiable token is never treated as valid.
 */
export async function verifyUserJwt<T = JwtPayload>(token: string): Promise<T> {
  const header = decodeJwtHeader(token);
  if (header?.alg !== USER_TOKEN_ALGORITHM || !header.kid) {
    throw new jwt.JsonWebTokenError(`User tokens must be signed with ${USER_TOKEN_ALGORITHM} and carry a kid`);
  }
  const key = await platformJwksCache().getKey(header.kid);
  return jwt.verify(token, key, { algorithms: [USER_TOKEN_ALGORITHM], ...issuerAudienceOptions() }) as T;
}

/**
 * Verify ANY bearer token and return its claims.
 *
 * Since #14 there is no shared secret left: BOTH chains are ES256 with a `kid`,
 * so the dispatch is by **who owns the `kid`** rather than by algorithm — and
 * because a `kid` is an RFC 7638 thumbprint, ownership is a fact about the key,
 * not a claim the token makes about itself:
 *
 * - a `kid` published in the per-service key bundle → an INTERNAL SERVICE token
 *   ({@link signServiceToken}), verified with that service's key; its `sub` must
 *   name the same service, so one service can never speak for another.
 * - anything else → a platform-signed USER token, verified against platform's
 *   published JWKS. A token claiming `principalType: 'service'` is refused
 *   here: an internal identity may not ride the user signing key.
 *
 * Anything that is not ES256 with a `kid` fails in both chains, which is what
 * makes "no HS256 token is accepted anywhere" a property of the code.
 */
export async function verifyBearerToken(token: string): Promise<JwtPayload> {
  const header = decodeJwtHeader(token);
  if (!header?.alg) throw new jwt.JsonWebTokenError('Malformed token header');

  if (header.kid && isServiceKid(header.kid)) {
    const claims = verifyServiceJwt<JwtPayload>(token, { kid: header.kid, ...issuerAudienceOptions() });
    if (claims.principalType !== 'service') {
      emitCounter('service_key_non_service_token_rejected_total', { alg: header.alg });
      throw new jwt.JsonWebTokenError('A service signing key may only mint a service principal');
    }
    return claims;
  }

  const claims = await verifyUserJwt(token);
  if (claims.principalType === 'service') {
    throw new jwt.JsonWebTokenError('Service principals may not be signed with the user signing key');
  }
  return claims;
}

/**
 * Whether a verified token carries a well-formed identity: a known
 * `principalType` and `token_use`, and the claims that kind of principal must
 * have. Fails closed — a token minted before these claims existed, or one with a
 * contradictory combination, is not an identity any gate should reason about.
 *
 * - `service`: `token_use: 'access'` and a `service:<name>` subject (the name
 *   feeds the denylist and audit attribution).
 * - `user` / `service_account`: `amr` (known methods), `aal` and `auth_time`.
 */
export function hasValidIdentityClaims(decoded: Partial<JwtPayload>): boolean {
  if (!decoded.principalType || !PRINCIPAL_TYPES.includes(decoded.principalType)) return false;
  if (!decoded.token_use || !TOKEN_USES.includes(decoded.token_use)) return false;
  if (decoded.principalType === 'service') {
    return decoded.token_use === 'access'
      && typeof decoded.sub === 'string'
      && decoded.sub.startsWith(SERVICE_SUBJECT_PREFIX)
      && decoded.sub.length > SERVICE_SUBJECT_PREFIX.length;
  }
  return Array.isArray(decoded.amr)
    && decoded.amr.every((m) => AUTH_METHODS.includes(m))
    && (decoded.aal === 1 || decoded.aal === 2)
    && typeof decoded.auth_time === 'number';
}


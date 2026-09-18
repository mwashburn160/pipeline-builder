// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * JWK primitives for the ASYMMETRIC user-token chain.
 *
 * Every token that speaks for a PERSON (access, refresh, step-up, and the
 * short-lived token an opaque access key is exchanged for) is signed by
 * **platform alone**, with ES256 and a `kid`, and verified by everyone else
 * against the public keys platform publishes at `/.well-known/jwks.json`. No
 * service holds a key that can mint a user token any more.
 *
 * Only Node's `crypto` is used — `createPublicKey`/`export` already speak JWK,
 * so nothing here needs a JOSE library.
 *
 * Internal SERVICE tokens (`principalType: 'service'`) are ES256 too, signed by
 * the CALLING service with its own key (#14, `services/service-keys.ts`). Both
 * chains therefore share these primitives, and a bearer token is routed by which
 * key set owns its `kid` rather than by its algorithm — see `middleware/auth.ts`.
 */

import crypto, { type KeyObject } from 'crypto';

/** The ONLY algorithm a user token may be signed with. */
export const USER_TOKEN_ALGORITHM = 'ES256';

/** The curve ES256 pins (`ECDSA_NIST_P256` / `prime256v1` / `ECC_NIST_P256` in KMS terms). */
export const USER_TOKEN_CURVE = 'P-256';

/** Path the public key set is served from (platform mounts it; nginx proxies it). */
export const JWKS_PATH = '/.well-known/jwks.json';

/** One published EC public key. */
export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  /** base64url X coordinate. */
  x: string;
  /** base64url Y coordinate. */
  y: string;
  /** RFC 7638 thumbprint — stable for the key, so rotation is a `kid` change. */
  kid: string;
  use: 'sig';
  alg: 'ES256';
}

/** The document served at {@link JWKS_PATH}. */
export interface JwksDocument {
  keys: PublicJwk[];
}

/** The header fields a verifier needs before it can pick a key. */
export interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

/**
 * Decode a JWT's header WITHOUT verifying anything. Returns `null` for anything
 * that is not a three-part token with a JSON object header — the caller then
 * rejects, so this never widens what is accepted.
 */
export function decodeJwtHeader(token: string): JwtHeader | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0]) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8')) as unknown;
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    return header as JwtHeader;
  } catch {
    return null;
  }
}

/**
 * The RFC 7638 thumbprint of an EC public key, base64url-encoded — used as the
 * `kid` everywhere.
 *
 * Deriving the id FROM the key (rather than naming keys by hand, or by their KMS
 * ARN) means the same key always publishes under the same `kid` whatever signer
 * holds it, a rotated-in key can never collide with the one it replaces, and no
 * AWS account id ever reaches a token or the public JWKS.
 *
 * The hashed form is the canonical JSON of exactly `crv`, `kty`, `x`, `y`, in
 * lexicographic order and with no whitespace — the spec's required members for
 * an EC key.
 */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

/**
 * Project an EC P-256 public key onto the published JWK shape, with its
 * thumbprint as `kid`. Throws when the key is not a P-256 EC key — a signer
 * configured with the wrong key type must fail at boot, not mint tokens nobody
 * can verify.
 */
export function publicJwkFrom(key: KeyObject): PublicJwk {
  const exported = key.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string };
  if (exported.kty !== 'EC' || exported.crv !== USER_TOKEN_CURVE || !exported.x || !exported.y) {
    throw new Error(`Token signing key must be an EC ${USER_TOKEN_CURVE} public key (got ${exported.kty ?? 'unknown'}/${exported.crv ?? 'unknown'})`);
  }
  const base = { kty: 'EC' as const, crv: USER_TOKEN_CURVE as 'P-256', x: exported.x, y: exported.y };
  return { ...base, kid: jwkThumbprint(base), use: 'sig', alg: 'ES256' };
}

/**
 * Turn a published JWK back into a verification key. Throws for anything that is
 * not an ES256-usable P-256 key, so a JWKS document with a surprise entry
 * (a future RSA key, a `use: 'enc'` key) can never be pressed into verifying a
 * user token.
 */
export function publicKeyFromJwk(jwk: PublicJwk): KeyObject {
  if (jwk.kty !== 'EC' || jwk.crv !== USER_TOKEN_CURVE) {
    throw new Error(`Unsupported JWKS entry: ${jwk.kty}/${jwk.crv}`);
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') throw new Error('JWKS entry is not a signing key');
  if (jwk.alg !== undefined && jwk.alg !== USER_TOKEN_ALGORITHM) throw new Error(`JWKS entry algorithm is not ${USER_TOKEN_ALGORITHM}`);
  return crypto.createPublicKey({ key: { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
}

/** True when `value` is shaped like the JWKS document (keys array of objects). */
export function isJwksDocument(value: unknown): value is JwksDocument {
  return !!value
    && typeof value === 'object'
    && Array.isArray((value as { keys?: unknown }).keys)
    && (value as { keys: unknown[] }).keys.every((k) => !!k && typeof k === 'object');
}

/**
 * Convert an ECDSA signature from ASN.1 DER (what AWS KMS returns) to the raw
 * fixed-width `r || s` JOSE form a JWT carries.
 *
 * DER is `SEQUENCE { INTEGER r, INTEGER s }` with both integers minimally
 * encoded and sign-padded; JOSE wants each coordinate left-zero-padded to
 * exactly the curve size (32 bytes for P-256). Getting this wrong produces
 * tokens that verify nowhere, so it is strict: any structural surprise throws.
 */
export function derToJoseSignature(der: Buffer, coordinateBytes = 32): Buffer {
  if (der[0] !== 0x30) throw new Error('Malformed DER signature: expected SEQUENCE');
  // Length byte(s): short form (<0x80) or long form (0x81 for a 1-byte length).
  let offset = 1;
  if (der[offset] === 0x81) offset += 2;
  else if (der[offset] < 0x80) offset += 1;
  else throw new Error('Malformed DER signature: unsupported length encoding');

  const readInt = (): Buffer => {
    if (der[offset] !== 0x02) throw new Error('Malformed DER signature: expected INTEGER');
    const len = der[offset + 1];
    const start = offset + 2;
    offset = start + len;
    let value = der.subarray(start, offset);
    // Strip the sign-padding byte DER adds when the high bit is set…
    while (value.length > coordinateBytes && value[0] === 0x00) value = value.subarray(1);
    if (value.length > coordinateBytes) throw new Error('Malformed DER signature: coordinate too large');
    // …then left-pad back out to the fixed curve width JOSE requires.
    return Buffer.concat([Buffer.alloc(coordinateBytes - value.length), value]);
  };

  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

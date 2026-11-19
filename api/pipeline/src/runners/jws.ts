// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal EdDSA (Ed25519) compact JWS over node:crypto — exactly what the run
 * request protocol needs and nothing more: sign with a PKCS#8 private key,
 * verify against a JWK set, publish public keys as OKP JWKs whose `kid` is the
 * RFC 7638 thumbprint (so a key always publishes under the same id and a
 * rotated-in key can never collide with the one it replaces).
 */

import { createHash, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';

/** A published Ed25519 public key. */
export interface Ed25519Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg: 'EdDSA';
}

export interface JwsHeader {
  alg: string;
  typ?: string;
  kid?: string;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

/** RFC 7638 thumbprint of an OKP key: sha256 over `{"crv","kty","x"}` (lexicographic, no whitespace). */
export function okpThumbprint(x: string): string {
  return b64url(createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest());
}

/** The public JWK of an Ed25519 key (private or public KeyObject). */
export function ed25519Jwk(key: KeyObject): Ed25519Jwk {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
  const { x } = pub.export({ format: 'jwk' }) as { x?: string };
  if (!x) throw new Error('Ed25519 key has no x coordinate');
  return { kty: 'OKP', crv: 'Ed25519', x, kid: okpThumbprint(x), use: 'sig', alg: 'EdDSA' };
}

/** Sign `payload` as a compact JWS with `alg: EdDSA`. */
export function signEdDsaJws(header: Omit<JwsHeader, 'alg'>, payload: object, privateKey: KeyObject): string {
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', ...header })));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const signature = edSign(null, Buffer.from(`${h}.${p}`), privateKey);
  return `${h}.${p}.${b64url(signature)}`;
}

/** Why a JWS did not verify (never carries the token or the signature). */
export class JwsVerifyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'JwsVerifyError';
  }
}

/**
 * Verify a compact EdDSA JWS against a key set: the header must name a `kid`
 * the set publishes and `alg: EdDSA`. Returns the decoded header + payload.
 * Claim checks (iss/aud/exp) are the verifier's business, not this helper's.
 */
export function verifyEdDsaJws(token: string, keys: readonly Ed25519Jwk[]): { header: JwsHeader; payload: Record<string, unknown> } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwsVerifyError('malformed');
  const [h, p, s] = parts as [string, string, string];
  let header: JwsHeader;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64url(h).toString('utf8')) as JwsHeader;
    payload = JSON.parse(fromB64url(p).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new JwsVerifyError('malformed');
  }
  if (header.alg !== 'EdDSA') throw new JwsVerifyError('alg');
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new JwsVerifyError('unknown kid');
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  if (!edVerify(null, Buffer.from(`${h}.${p}`), pub, fromB64url(s))) throw new JwsVerifyError('signature');
  return { header, payload };
}

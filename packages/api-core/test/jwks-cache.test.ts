// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The JWKS primitives and the cache contract every verifier depends on.
 *
 * `jwt-rotation.test.ts` exercises this THROUGH `requireAuth`; here the cache is
 * driven directly so the timing rules (10-minute refresh, one refetch per
 * unknown `kid`, brief negative cache, fail-closed when nothing is in hand) are
 * pinned without a middleware in the way. Also covers the DER → JOSE signature
 * conversion, which only the KMS signer exercises in production — a bug there
 * would produce tokens nothing in the fleet can verify.
 */

import crypto from 'crypto';
import { describe, it, expect } from '@jest/globals';
import {
  JwksCache, JwksUnavailableError, UnknownKidError,
} from '../src/services/jwks-cache.js';
import { generateTestSigningKey } from '../src/testing/user-tokens.js';
import {
  USER_TOKEN_ALGORITHM, decodeJwtHeader, derToJoseSignature, isJwksDocument, jwkThumbprint,
  publicJwkFrom, publicKeyFromJwk, type JwksDocument,
} from '../src/utils/jwk.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('publicJwkFrom / publicKeyFromJwk', () => {
  it('round-trips an EC P-256 public key through the published JWK shape', () => {
    const key = generateTestSigningKey();
    const jwk = publicJwkFrom(key.publicKey);
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: USER_TOKEN_ALGORITHM });
    expect(jwk.kid).toBe(key.kid);

    const restored = publicKeyFromJwk(jwk);
    expect(restored.export({ format: 'jwk' })).toEqual(key.publicKey.export({ format: 'jwk' }));
  });

  it('derives a STABLE kid from the key material (RFC 7638), not from a name', () => {
    const key = generateTestSigningKey();
    // Same key, exported and re-imported elsewhere → same kid. That is what lets
    // a KMS key and a file copy of it publish under one identity.
    const elsewhere = crypto.createPublicKey(key.publicKey.export({ format: 'pem', type: 'spki' }) as string);
    expect(publicJwkFrom(elsewhere).kid).toBe(key.kid);
    expect(publicJwkFrom(generateTestSigningKey().publicKey).kid).not.toBe(key.kid);
  });

  it('rejects a key that is not EC P-256 — a wrong curve must fail at boot', () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => publicJwkFrom(publicKey)).toThrow(/EC P-256/);
  });

  it('refuses a JWKS entry that is not an ES256 signing key', () => {
    const jwk = publicJwkFrom(generateTestSigningKey().publicKey);
    expect(() => publicKeyFromJwk({ ...jwk, use: 'enc' as 'sig' })).toThrow(/not a signing key/);
    expect(() => publicKeyFromJwk({ ...jwk, alg: 'ES384' as 'ES256' })).toThrow(/algorithm is not ES256/);
    expect(() => publicKeyFromJwk({ ...jwk, crv: 'P-384' as 'P-256' })).toThrow(/Unsupported/);
  });

  it('computes the thumbprint over exactly crv/kty/x/y, in order', () => {
    const jwk = { kty: 'EC', crv: 'P-256', x: 'eHh4', y: 'eXl5' };
    const expected = crypto.createHash('sha256')
      .update('{"crv":"P-256","kty":"EC","x":"eHh4","y":"eXl5"}')
      .digest('base64url');
    // Property order in the input must not matter; canonical order must.
    expect(jwkThumbprint({ y: 'eXl5', x: 'eHh4', kty: 'EC', crv: 'P-256' })).toBe(expected);
    expect(jwkThumbprint(jwk)).toBe(expected);
  });
});

describe('derToJoseSignature', () => {
  it('converts what KMS returns into a signature the verifier accepts', () => {
    // KMS only speaks DER; a JWS carries fixed-width `r || s`. Sign the same
    // input both ways and require the converted DER to match Node's raw output.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const input = Buffer.from('header.payload', 'utf-8');
    for (let i = 0; i < 25; i += 1) {
      const der = crypto.sign('sha256', input, { key: privateKey, dsaEncoding: 'der' });
      const jose = derToJoseSignature(der);
      expect(jose).toHaveLength(64);
      expect(crypto.verify('sha256', input, { key: publicKey, dsaEncoding: 'ieee-p1363' }, jose)).toBe(true);
    }
  });

  it('rejects a malformed DER signature rather than emitting garbage bytes', () => {
    expect(() => derToJoseSignature(Buffer.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]))).toThrow(/SEQUENCE/);
    expect(() => derToJoseSignature(Buffer.from([0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01]))).toThrow(/INTEGER/);
  });
});

describe('decodeJwtHeader / isJwksDocument', () => {
  it('returns null for anything that is not a three-part token with a JSON object header', () => {
    expect(decodeJwtHeader('not-a-token')).toBeNull();
    expect(decodeJwtHeader('a.b')).toBeNull();
    expect(decodeJwtHeader(`${Buffer.from('[]').toString('base64url')}.b.c`)).toBeNull();
    expect(decodeJwtHeader(`${Buffer.from('nonsense').toString('base64url')}.b.c`)).toBeNull();
  });

  it('reads alg and kid', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1' })).toString('base64url');
    expect(decodeJwtHeader(`${header}.b.c`)).toMatchObject({ alg: 'ES256', kid: 'k1' });
  });

  it('recognizes only a key-set-shaped document', () => {
    expect(isJwksDocument({ keys: [] })).toBe(true);
    expect(isJwksDocument({ keys: [{ kid: 'a' }] })).toBe(true);
    expect(isJwksDocument({ keys: 'nope' })).toBe(false);
    expect(isJwksDocument({ keys: ['nope'] })).toBe(false);
    expect(isJwksDocument(null)).toBe(false);
  });
});

describe('JwksCache', () => {
  function cacheOver(document: () => JwksDocument, options: Partial<{ refreshIntervalMs: number; negativeTtlMs: number; unknownKidCooldownMs: number }> = {}) {
    let fetches = 0;
    let fail = 0;
    const cache = new JwksCache({
      source: 'test',
      fetch: async () => {
        fetches += 1;
        if (fail > 0) { fail -= 1; throw new Error('fetch failed'); }
        return document();
      },
      ...options,
    });
    return {
      cache,
      fetches: () => fetches,
      failNext: (n: number) => { fail = n; },
    };
  }

  it('fetches once and serves every later lookup from cache', async () => {
    const key = generateTestSigningKey();
    const h = cacheOver(() => ({ keys: [key.jwk] }));
    await h.cache.getKey(key.kid);
    await h.cache.getKey(key.kid);
    expect(h.fetches()).toBe(1);
  });

  it('refetches once the refresh interval has passed', async () => {
    const key = generateTestSigningKey();
    const h = cacheOver(() => ({ keys: [key.jwk] }), { refreshIntervalMs: 20 });
    await h.cache.getKey(key.kid);
    await sleep(30);
    await h.cache.getKey(key.kid);
    expect(h.fetches()).toBe(2);
  });

  it('throws UnknownKidError for a kid the published set does not contain', async () => {
    const key = generateTestSigningKey();
    const other = generateTestSigningKey();
    const h = cacheOver(() => ({ keys: [key.jwk] }));
    await expect(h.cache.getKey(other.kid)).rejects.toBeInstanceOf(UnknownKidError);
  });

  it('refetches at most once per cooldown for an unknown kid', async () => {
    const key = generateTestSigningKey();
    const other = generateTestSigningKey();
    const h = cacheOver(() => ({ keys: [key.jwk] }), { unknownKidCooldownMs: 10_000 });
    await h.cache.getKey(key.kid);
    await expect(h.cache.getKey(other.kid)).rejects.toThrow();
    await expect(h.cache.getKey(other.kid)).rejects.toThrow();
    expect(h.fetches()).toBe(2);
  });

  it('FAILS CLOSED with JwksUnavailableError when nothing has ever been fetched', async () => {
    const key = generateTestSigningKey();
    const h = cacheOver(() => ({ keys: [key.jwk] }), { negativeTtlMs: 10_000 });
    h.failNext(5);
    await expect(h.cache.getKey(key.kid)).rejects.toBeInstanceOf(JwksUnavailableError);
    // Negative cache: the next lookup must not hammer the source again.
    await expect(h.cache.getKey(key.kid)).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(h.fetches()).toBe(1);
  });

  it('keeps serving a cached set while refreshes fail, then picks up the recovery', async () => {
    const key = generateTestSigningKey();
    const rotated = generateTestSigningKey();
    let published = [key.jwk];
    const h = cacheOver(() => ({ keys: published }), { refreshIntervalMs: 10, negativeTtlMs: 20 });
    await h.cache.getKey(key.kid);

    h.failNext(1);
    await sleep(15);
    await expect(h.cache.getKey(key.kid)).resolves.toBeDefined();

    published = [rotated.jwk];
    await sleep(30);
    await expect(h.cache.getKey(rotated.kid)).resolves.toBeDefined();
  });

  it('treats a document with no usable keys as a failure, not an empty key set', async () => {
    const h = cacheOver(() => ({ keys: [] }));
    await expect(h.cache.getKey('whatever')).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('skips an unusable entry but keeps the rest of the set', async () => {
    const key = generateTestSigningKey();
    const h = cacheOver(() => ({ keys: [{ ...key.jwk, kid: 'broken', x: '!!!' }, key.jwk] } as JwksDocument));
    await expect(h.cache.getKey(key.kid)).resolves.toBeDefined();
    expect(h.cache.knownKids()).toEqual([key.kid]);
  });
});

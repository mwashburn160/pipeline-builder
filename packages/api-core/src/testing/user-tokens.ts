// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test helpers for the ES256 user-token chain.
 *
 * Before #5 every suite that needed an authenticated request just signed a JWT
 * with a literal `JWT_SECRET` — one line, and seventeen independent copies of
 * it. User tokens are asymmetric now, which needs a keypair, a `kid` and a JWKS
 * the verifier can fetch, so that per-suite copy-paste would be ~15 lines each.
 * Hence one shared seam, in api-core next to the route-coverage helper, imported
 * by the suites of every package:
 *
 * ```ts
 * import { installTestJwks, signTestUserToken } from '@pipeline-builder/api-core/lib/testing/user-tokens.js';
 *
 * const jwks = installTestJwks();
 * const token = signTestUserToken({ sub: 'u1', role: 'member', ... });
 * ```
 *
 * `installTestJwks` replaces the process-wide JWKS cache with one backed by the
 * generated keys — no HTTP, and it counts fetches so a test can assert the
 * refresh / unknown-`kid` / negative-cache behaviour.
 */

import crypto, { type KeyObject } from 'crypto';
import { JwksCache, setPlatformJwksCache } from '../services/jwks-cache.js';
import { USER_TOKEN_ALGORITHM, publicJwkFrom, type JwksDocument, type PublicJwk } from '../utils/jwk.js';

/** A generated signing key, in every form the tests need. */
export interface TestSigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: PublicJwk;
}

/** Generate one EC P-256 signing key, `kid` = its RFC 7638 thumbprint. */
export function generateTestSigningKey(): TestSigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicJwkFrom(publicKey);
  return { kid: jwk.kid, privateKey, publicKey, jwk };
}

/**
 * Sign `payload` as an ES256 JWT with `key`. `expiresIn` seconds (default 300).
 * Synchronous — `crypto.sign` is, and platform's async signer only exists
 * because KMS is a network call — so a suite can mint a token inline wherever it
 * used to call `jwt.sign`.
 */
export function signTestUserToken(
  payload: Record<string, unknown>,
  options: { key: TestSigningKey; expiresIn?: number; issuer?: string; audience?: string; kid?: string; notBefore?: number } = {
    key: defaultKey(),
  },
): string {
  const key = options.key ?? defaultKey();
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    ...payload,
    iat: payload.iat ?? now,
    exp: payload.exp ?? now + (options.expiresIn ?? 300),
    ...(options.notBefore !== undefined ? { nbf: now + options.notBefore } : {}),
    ...(options.issuer ? { iss: options.issuer } : {}),
    ...(options.audience ? { aud: options.audience } : {}),
  };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
  const signingInput = `${b64({ alg: USER_TOKEN_ALGORITHM, typ: 'JWT', kid: options.kid ?? key.kid })}.${b64(body)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf-8'), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** The claim block a USER principal must carry to satisfy `hasValidIdentityClaims`. */
export function testUserIdentityClaims(): Record<string, unknown> {
  return {
    type: 'access',
    principalType: 'user',
    token_use: 'access',
    amr: ['pwd'],
    aal: 1,
    auth_time: Math.floor(Date.now() / 1000),
  };
}

/** Handle over the installed test JWKS — lets a test rotate keys and count fetches. */
export interface TestJwksHandle {
  /** Keys currently published. */
  keys: TestSigningKey[];
  /** The first published key — what `signTestUserToken` uses by default. */
  primary: TestSigningKey;
  /** How many times the verifier has fetched the document. */
  fetchCount(): number;
  /** Make the next fetch(es) fail, to exercise the negative cache / fail-closed paths. */
  failNextFetches(count: number): void;
  /** Replace the published set (a rotation), leaving the cache to notice. */
  publish(keys: TestSigningKey[]): void;
  /** The document as the verifier sees it. */
  document(): JwksDocument;
}

let installed: TestJwksHandle | undefined;

function defaultKey(): TestSigningKey {
  if (!installed) throw new Error('installTestJwks() must be called before signing a test user token');
  return installed.primary;
}

/**
 * Install a JWKS cache backed by freshly generated keys (or `keys` when given)
 * as the process-wide one, and return a handle over it. Call in `beforeEach`;
 * `uninstallTestJwks()` restores the real HTTP-backed cache.
 */
export function installTestJwks(
  keys: TestSigningKey[] = [generateTestSigningKey()],
  cacheOptions: { refreshIntervalMs?: number; negativeTtlMs?: number; unknownKidCooldownMs?: number } = {},
): TestJwksHandle {
  let published = keys;
  let fetches = 0;
  let failures = 0;

  const handle: TestJwksHandle = {
    get keys() { return published; },
    get primary() { return published[0]; },
    fetchCount: () => fetches,
    failNextFetches: (count: number) => { failures = count; },
    publish: (next: TestSigningKey[]) => { published = next; },
    document: () => ({ keys: published.map((k) => k.jwk) }),
  };

  const cache = new JwksCache({
    source: 'test',
    fetch: async () => {
      fetches += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error('test JWKS fetch failure');
      }
      return handle.document();
    },
    ...cacheOptions,
  });
  setPlatformJwksCache(cache);
  installed = handle;
  return handle;
}

/** Restore the real (HTTP-backed) JWKS cache. */
export function uninstallTestJwks(): void {
  setPlatformJwksCache(undefined);
  installed = undefined;
}

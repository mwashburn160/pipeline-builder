// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform's user-token signing service — the ONLY place in the fleet where a
 * token that speaks for a person is minted.
 *
 * Access, refresh, step-up and exchanged access-key tokens are all ES256, all
 * carry a `kid`, and are all verified by everyone else against
 * `/.well-known/jwks.json`. No service holds a key that can mint one, which is
 * the whole point: before this, all ten services shared one HS256 secret, so any
 * one of them could forge a platform-admin token.
 *
 * Rotation is by `kid`: the JWKS publishes the CURRENT key plus any RETIRING
 * keys, verifiers refetch on an unknown `kid`, and an operator finishes the
 * rotation by dropping the retiring key from config. See
 * docs/runbooks/secret-rotation.md.
 */

import {
  JwksCache, USER_TOKEN_ALGORITHM, createLogger, decodeJwtHeader, publicJwkFrom, setPlatformJwksCache,
  type JwksDocument, type PublicJwk,
} from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import { loadKmsSigningKey } from './kms-signer.js';
import { loadLocalSigningKey } from './local-signer.js';
import type { SigningKey, SigningKeySet } from './signer.js';
import { config } from '../../config/index.js';

const logger = createLogger('token-signing');

let keySet: SigningKeySet | undefined;
let initPromise: Promise<SigningKeySet> | undefined;

/** base64url of a JSON value, the JWS way (no padding, URL alphabet). */
function b64uJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

/** Build the configured key set. Throws — a platform that cannot sign must not serve. */
async function buildKeySet(): Promise<SigningKeySet> {
  const { mode, keyFile, previousKeyFile, kmsKeyId, kmsPreviousKeyId } = config.auth.jwt.signing;

  if (mode === 'kms') {
    if (!kmsKeyId) throw new Error('TOKEN_SIGNING_KMS_KEY_ID is required when TOKEN_SIGNING_MODE=kms');
    const current = await loadKmsSigningKey(kmsKeyId, { canSign: true });
    const retiring = kmsPreviousKeyId ? [await loadKmsSigningKey(kmsPreviousKeyId, { canSign: false })] : [];
    return { current, retiring };
  }

  if (!keyFile) throw new Error('TOKEN_SIGNING_KEY_FILE is required when TOKEN_SIGNING_MODE=local');
  const current = await loadLocalSigningKey(keyFile, { canSign: true });
  const retiring = previousKeyFile ? [await loadLocalSigningKey(previousKeyFile, { canSign: false })] : [];
  return { current, retiring };
}

/**
 * Load the signing keys. Called once from `startServer` BEFORE the port opens,
 * so a misconfigured key is a startup failure rather than a 500 on the first
 * sign-in. Idempotent, and concurrent callers share the one load (tests and the
 * lazy fallback below rely on that).
 */
export async function initTokenSigning(): Promise<SigningKeySet> {
  initPromise ??= buildKeySet().then((loaded) => {
    keySet = loaded;
    // api-core primitives that platform ALSO uses (`requireStepUp`, which
    // verifies through `verifyUserJwt`) read the process-wide JWKS cache. Point
    // it at the in-memory key set so platform never HTTP-fetches its own
    // published keys — a self-call that would make step-up depend on the
    // gateway route to platform being up.
    setPlatformJwksCache(new JwksCache({ fetch: publishedJwks, source: 'platform-local' }));
    logger.info('Token signing initialized', {
      mode: config.auth.jwt.signing.mode,
      kid: loaded.current.kid,
      retiringKids: loaded.retiring.map((k) => k.kid),
    });
    return loaded;
  }).catch((error) => {
    // Don't cache the failure: a transient KMS blip at boot shouldn't poison
    // every later attempt.
    initPromise = undefined;
    throw error;
  });
  return initPromise;
}

/** Test seam: forget the loaded keys so the next call re-reads config. */
export function _resetTokenSigningForTests(): void {
  keySet = undefined;
  initPromise = undefined;
  setPlatformJwksCache(undefined);
}

/**
 * Test seam: install a key set directly, bypassing config (no PEM on disk, no
 * KMS). `test/helpers/signing.ts` generates the keys; this only installs them,
 * so key generation stays out of production code. Pass `undefined` to clear.
 */
export function _setTokenSigningKeysForTests(set: SigningKeySet | undefined): void {
  keySet = set;
  initPromise = set ? Promise.resolve(set) : undefined;
  setPlatformJwksCache(set ? new JwksCache({ fetch: publishedJwks, source: 'platform-local' }) : undefined);
}

/** The loaded key set, loading it on demand for callers that run before boot finishes. */
async function keys(): Promise<SigningKeySet> {
  return keySet ?? initTokenSigning();
}

/** Every key platform publishes: the signing key first, then any retiring ones. */
function allKeys(set: SigningKeySet): SigningKey[] {
  return [set.current, ...set.retiring];
}

/** What every platform-signed token carries beyond the caller's claims. */
export interface SignOptions {
  /** Lifetime in seconds. `iat`/`exp` are stamped from it. */
  expiresIn: number;
}

/**
 * Sign `payload` as an ES256 JWT with the current key's `kid`.
 *
 * Hand-rolled rather than `jwt.sign` because KMS signing is asynchronous and
 * `jsonwebtoken` has no async signer hook — so the header/payload encoding lives
 * here and the two signer implementations only ever produce raw signature bytes.
 * `iat`, `exp` and the optional `iss`/`aud` are stamped here for every token
 * class, so there is exactly one place that decides what a platform token says.
 */
export async function signUserJwt(payload: Record<string, unknown>, options: SignOptions): Promise<string> {
  const { current } = await keys();
  if (!current.sign) throw new Error('The current token signing key cannot sign');

  const { issuer, audience } = config.auth.jwt;
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + options.expiresIn,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
  };
  const signingInput = `${b64uJson({ alg: USER_TOKEN_ALGORITHM, typ: 'JWT', kid: current.kid })}.${b64uJson(body)}`;
  const signature = await current.sign(Buffer.from(signingInput, 'utf-8'));
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Verify a platform-signed user token, SYNCHRONOUSLY.
 *
 * Platform holds the public half of every key it publishes, so it never needs
 * the JWKS round-trip the other services make — which matters because the rate
 * limiter's bucket selection and the refresh path both verify inline. Callers
 * must ensure {@link initTokenSigning} has completed (it has, for anything
 * served after boot).
 *
 * Throws `JsonWebTokenError` for an unknown `kid`, a non-ES256 token, or a bad
 * signature — so a token signed with the retired shared secret, or by any
 * service, fails exactly like a forgery.
 */
export function verifyUserJwtSync<T>(token: string): T {
  const set = keySet;
  if (!set) throw new jwt.JsonWebTokenError('Token signing keys are not loaded');

  const header = decodeJwtHeader(token);
  if (header?.alg !== USER_TOKEN_ALGORITHM || !header.kid) {
    throw new jwt.JsonWebTokenError(`User tokens must be signed with ${USER_TOKEN_ALGORITHM} and carry a kid`);
  }
  const key = allKeys(set).find((k) => k.kid === header.kid);
  if (!key) throw new jwt.JsonWebTokenError(`Unknown signing key ${header.kid}`);

  const { issuer, audience } = config.auth.jwt;
  return jwt.verify(token, key.publicKey, {
    algorithms: [USER_TOKEN_ALGORITHM],
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  }) as T;
}

/** The document served at `/.well-known/jwks.json`: current + retiring public keys. */
export async function publishedJwks(): Promise<JwksDocument> {
  const set = await keys();
  const seen = new Set<string>();
  const publicKeys: PublicJwk[] = [];
  for (const key of allKeys(set)) {
    // A retiring key configured identically to the current one would otherwise
    // publish twice; `kid` is the thumbprint, so identity is exact.
    if (seen.has(key.kid)) continue;
    seen.add(key.kid);
    publicKeys.push(publicJwkFrom(key.publicKey));
  }
  return { keys: publicKeys };
}

/** The `kid` new tokens are being signed with (diagnostics, metrics, tests). */
export async function currentSigningKid(): Promise<string> {
  return (await keys()).current.kid;
}

/** True while a retiring key is still published — the rotation-overlap gauge. */
export function isRetiringKeyPublished(): boolean {
  return (keySet?.retiring.length ?? 0) > 0;
}

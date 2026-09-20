// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Opaque access-key format, shared by everything that mints, presents or
 * recognizes one.
 *
 * A key is a high-entropy random string with a human-readable prefix:
 *
 *     pb_pat_<43 base64url chars>     personal access key (a person's credential)
 *     pb_sa_<43 base64url chars>      service-account key (reserved; not minted yet)
 *
 * The key itself is NEVER stored — platform keeps only `sha256(key)` plus the
 * prefix and last four characters, which is all the UI needs to name one. It is
 * therefore shown exactly once, at creation.
 *
 * Keys are opaque: they carry no claims and no signature, so a service cannot
 * verify one locally. A caller trades the key at platform's
 * `POST /auth/token/exchange` for a short-lived JWT (see `api-key-exchange.ts`),
 * which every service verifies the usual way. That is what makes revocation
 * effective fleet-wide within one token lifetime.
 */

import { createHash, randomBytes } from 'crypto';

/** Prefixes that name what kind of principal a key speaks for. */
export const API_KEY_PREFIXES = ['pb_pat', 'pb_sa'] as const;

/** One of {@link API_KEY_PREFIXES}. `pb_sa` is reserved for service accounts. */
export type ApiKeyPrefix = (typeof API_KEY_PREFIXES)[number];

/** Random bytes behind each key — 256 bits, base64url-encoded to 43 chars. */
const API_KEY_SECRET_BYTES = 32;

/**
 * Lifetime of the JWT an exchange returns. Short by design: it is the window in
 * which a revoked key still works, and the reason services never need to read a
 * key hash.
 */
export const API_KEY_TOKEN_TTL_SECONDS = 300;

/**
 * A well-formed key. Anchored and length-bounded so a hostile Authorization
 * header can't be routed down the exchange path on a loose prefix match.
 */
const KEY_PATTERN = new RegExp(`^(${API_KEY_PREFIXES.join('|')})_([A-Za-z0-9_-]{32,64})$`);

/**
 * Whether `credential` is an opaque access key (rather than a JWT). Used at the
 * one place each service decides how to resolve an Authorization credential.
 */
export function isOpaqueApiKey(credential: string | undefined): boolean {
  return typeof credential === 'string' && KEY_PATTERN.test(credential);
}

/** The prefix of a well-formed key, else `undefined`. */
export function apiKeyPrefixOf(credential: string | undefined): ApiKeyPrefix | undefined {
  if (typeof credential !== 'string') return undefined;
  const match = KEY_PATTERN.exec(credential);
  return match ? (match[1] as ApiKeyPrefix) : undefined;
}

/**
 * The stored form of a key: SHA-256, hex. A plain hash (not a password KDF) is
 * correct here — the key is 256 bits of CSPRNG output, so there is nothing to
 * brute-force and the lookup happens on every exchange.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Mint a new key. The caller stores only {@link hashApiKey} of the result. */
export function generateApiKey(prefix: ApiKeyPrefix): string {
  return `${prefix}_${randomBytes(API_KEY_SECRET_BYTES).toString('base64url')}`;
}


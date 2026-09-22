// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reporting-API authentication. The stored credential is an OPAQUE
 * service-account key (`pb_sa_…`), traded at platform for a short-lived JWT.
 * Nothing is verified here: an opaque key has no claims and no signature, and
 * the exchange re-reads the account, its org and the key's own state every time,
 * which is what makes a revocation take effect within one token lifetime.
 *
 * Contract: cache the token in the warm container, refresh EARLY (before
 * expiry) so a batch never presents a token that dies mid-flight, and fail the
 * batch on an exchange failure rather than shipping events unauthenticated.
 */

import { createPlatformCredential } from '@pipeline-builder/pipeline-core/lib/handlers/platform-credential.js';
import { log } from './util.js';

/** Refresh at this fraction of the token's life — never at the last moment. */
const TOKEN_REFRESH_FRACTION = 0.8;
/** Floor on the cached lifetime, so a surprisingly short TTL can't cause a
 *  refresh storm (one exchange per batch at worst). */
const MIN_TOKEN_CACHE_MS = 30_000;
/** Per-request timeout for the exchange call. */
const EXCHANGE_TIMEOUT_MS = 5000;

/**
 * The service-account key: `PLATFORM_ACCESS_KEY` if set, otherwise the
 * `password` field of the Secrets Manager secret named by `PLATFORM_SECRET_NAME`.
 * A stored JWT is refused loudly, naming the fix, instead of failing later as an
 * opaque 401 from the reporting API.
 */
const credential = createPlatformCredential({
  secretName: () => process.env.PLATFORM_SECRET_NAME,
  envKeyVar: 'PLATFORM_ACCESS_KEY',
});

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

/**
 * Trade the stored key for a short-lived platform token, cached per warm
 * container until it is 80% through its life. Throws on any failure, which fails
 * the batch so SQS retries it — an unauthenticated ship is never an option.
 */
export async function getAuthToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const baseUrl = (process.env.PLATFORM_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('PLATFORM_BASE_URL environment variable is required');
  const key = await credential.getKey();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/auth/token/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ key }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // A rejected key is the one failure an operator has to act on, and platform
    // deliberately answers every refusal the same way — so say what to check
    // rather than echoing an undifferentiated 401.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Access-key exchange refused (${res.status}) — the stored key is unknown, revoked, expired, `
        + 'its service account is disabled, or this address is outside the key’s IP allowlist',
      );
    }
    throw new Error(`Access-key exchange failed: ${res.status}`);
  }

  const body = await res.json().catch(() => ({})) as { data?: { accessToken?: string; expiresIn?: number } };
  const accessToken = body.data?.accessToken;
  if (!accessToken) throw new Error('Access-key exchange returned no access token');

  const ttlMs = (typeof body.data?.expiresIn === 'number' && body.data.expiresIn > 0 ? body.data.expiresIn : 300) * 1000;
  cachedToken = accessToken;
  cachedTokenExpiresAt = Date.now() + Math.max(MIN_TOKEN_CACHE_MS, ttlMs * TOKEN_REFRESH_FRACTION);
  log.info('Exchanged the stored service-account key for a platform token');
  return accessToken;
}

/**
 * Drop everything the container holds about its credential after a 401/403 from
 * the API: the token, and the KEY — the token-renew Lambda rotates the secret
 * underneath us, so a warm container that only re-exchanged would keep
 * presenting the retired key forever. An env-provided key cannot change without
 * a new container, so it is kept.
 */
export function invalidateCredential(): void {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
  credential.invalidate();
}

/** @internal Test-only: forget every cached credential. */
export function _resetAuthForTests(): void {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
  credential.reset();
}

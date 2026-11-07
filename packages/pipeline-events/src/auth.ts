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
import { fetchWithTimeout, log } from './util.js';

/** Refresh at this fraction of the token's life — never at the last moment. */
const TOKEN_REFRESH_FRACTION = 0.8;
/**
 * No FLOOR on the cached lifetime, deliberately.
 *
 * There was one — 30s, "so a surprisingly short TTL can't cause a refresh
 * storm" — and it broke this module's own contract. The cache held
 * `max(30s, ttl * 0.8)`, so for any `expiresIn` under ~37s the floor WON and the
 * container kept serving a token that had already died: at `expiresIn=10` the
 * token expires at 10s and the cache held it for 30s. The batch then presents a
 * dead token and takes a 401, which is precisely what "refresh EARLY (before
 * expiry) so a batch never presents a token that dies mid-flight" exists to
 * prevent.
 *
 * It was never reachable in practice — `API_KEY_TOKEN_TTL_SECONDS` is a
 * hard-coded 300, which caches 240s — so this is a latent contradiction being
 * removed before someone makes that TTL configurable and it becomes a live 401
 * loop that looks like a credential problem.
 *
 * Dropping it costs nothing the floor actually bought: the worst case it named
 * is "one exchange per batch", which is the SQS batch rate and is already the
 * bound, floor or no floor. `cachedTokenExpiresAt` is now always strictly
 * inside the token's life, which is the invariant the suite asserts.
 */
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

  // Same deadline as before, through the package's one bounded-fetch helper: a manual
  // controller plus a timer it has to remember to clear is a leak waiting for an early
  // `return`, and two spellings of "time this out" is how one of them ends up missing.
  const res = await fetchWithTimeout(`${baseUrl}/api/auth/token/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ key }),
  }, EXCHANGE_TIMEOUT_MS);

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
  cachedTokenExpiresAt = Date.now() + ttlMs * TOKEN_REFRESH_FRACTION;
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

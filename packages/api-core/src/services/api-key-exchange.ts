// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Trade an opaque access key for a short-lived JWT, once, and cache it.
 *
 * Only platform, billing and quota have MongoDB, so the stateless services
 * cannot look up a key hash — and asking platform to validate EVERY request
 * would put it on the hot path of the whole fleet. Instead this module does the
 * exchange once per key (`POST /auth/token/exchange`) and caches the returned
 * JWT in-process until it expires, so `requireAuth` only ever verifies a JWT.
 *
 * Properties that matter:
 *
 * - **Revocation latency is bounded by the token TTL** (5 minutes). A revoked
 *   key can no longer be exchanged, and the cached token it already produced
 *   dies on its own.
 * - **Early, jittered refresh.** The cached token is re-exchanged in the
 *   background at ~75% of its life (±20% jitter) so no request ever blocks on
 *   the exchange, and a fleet of pods holding the same key doesn't stampede
 *   platform at the same instant.
 * - **One in-flight exchange per key.** Concurrent requests share a promise.
 * - **Short negative cache.** A key platform rejected is remembered for 30s, so
 *   a misconfigured client (or a scanner) can't turn every request into a
 *   platform round-trip.
 * - **Platform down is a 503, never a 200.** The caller maps
 *   {@link ApiKeyExchangeUnavailableError} to "try again", with a metric — it is
 *   deliberately NOT fail-open: an unverifiable credential is not an identity.
 *
 * The exchange request itself carries this service's own signed service token,
 * which is what exempts it from platform's IP-keyed `/auth` rate limiter (every
 * pod's exchanges would otherwise share one bucket) and names the caller in
 * platform's audit trail.
 */

import { getServiceAuthHeader } from '../middleware/service-tokens.js';
import { SYSTEM_ORG_ID } from '../middleware/system-org.js';
import { InternalHttpClient } from '../services/http-client.js';
import { hashApiKey } from '../utils/api-key.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';
import { envInt } from '../utils/env.js';
import { serviceEndpoint } from '../utils/service-registry.js';

const logger = createLogger('api-key-exchange');

/** Most distinct keys held in the process-wide cache before the oldest are dropped. */
const MAX_CACHED_KEYS = 1000;

/** How long a platform REJECTION is remembered (ms). */
const NEGATIVE_TTL_MS = 30_000;

/** Fraction of a token's life after which a background re-exchange is started. */
const REFRESH_AT_FRACTION = 0.75;

/** ± jitter applied to the refresh point, as a fraction of the token's life.
 *  Wide enough to de-synchronize a fleet, narrow enough to leave a clear tail of
 *  still-valid token after the latest possible refresh. */
const REFRESH_JITTER_FRACTION = 0.1;

/** The key was presented to platform and refused (unknown, revoked, expired). */
export class ApiKeyRejectedError extends Error {
  constructor(message = 'Access key is invalid, revoked or expired') {
    super(message);
    this.name = 'ApiKeyRejectedError';
  }
}

/** Platform could not be reached (or answered 5xx) — the key's validity is unknown. */
export class ApiKeyExchangeUnavailableError extends Error {
  constructor(message = 'Access-key verification is temporarily unavailable') {
    super(message);
    this.name = 'ApiKeyExchangeUnavailableError';
  }
}

interface CacheEntry {
  /** The exchanged JWT. */
  token: string;
  /** Epoch ms at which the JWT stops being usable. */
  expiresAt: number;
  /** Epoch ms after which a background re-exchange should be started. */
  refreshAt: number;
}

/** Cache of successful exchanges, keyed by `sha256(key)` — never by the key itself. */
const tokenCache = new Map<string, CacheEntry>();
/** Cache of rejections, keyed the same way; value is the epoch ms it expires. */
const rejectionCache = new Map<string, number>();
/** In-flight exchanges, so concurrent requests for one key share a round-trip. */
const inFlight = new Map<string, Promise<CacheEntry>>();

/** The service name minted into the exchange call's own service token. */
let serviceName = process.env.SERVICE_NAME || 'unknown';

/**
 * Name this process in the exchange call's service token. Called from
 * `wireServiceSecurity` at boot (and by the plugin service, which wires its
 * boot security by hand).
 */
export function setApiKeyExchangeServiceName(name: string): void {
  serviceName = name;
}

/** Platform's in-cluster address — the same env pair every other caller uses. */
function platformClient(): InternalHttpClient {
  return new InternalHttpClient({
    ...serviceEndpoint('platform'),
    timeout: envInt('API_KEY_EXCHANGE_TIMEOUT_MS', 3000, { min: 1 }),
  });
}

/** The epoch ms at which a token with `ttlSeconds` of life should be refreshed early. */
function jitteredRefreshAt(issuedAt: number, ttlSeconds: number): number {
  const lifeMs = ttlSeconds * 1000;
  const jitter = (Math.random() * 2 - 1) * REFRESH_JITTER_FRACTION;
  // Clamp into (0, 1) so the refresh point is always before expiry and never in
  // the past, whatever TTL platform returns.
  const fraction = Math.min(0.95, Math.max(0.1, REFRESH_AT_FRACTION + jitter));
  return issuedAt + lifeMs * fraction;
}

/** Drop the oldest entries once the cache is over its cap (keys are long-lived, tokens are not). */
function evictIfFull(): void {
  if (tokenCache.size <= MAX_CACHED_KEYS) return;
  const now = Date.now();
  for (const [hash, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(hash);
  }
  // Map preserves insertion order — drop from the front until back under the cap.
  while (tokenCache.size > MAX_CACHED_KEYS) {
    const oldest = tokenCache.keys().next();
    if (oldest.done) break;
    tokenCache.delete(oldest.value);
  }
}

interface ExchangeResponse {
  success?: boolean;
  data?: { accessToken?: string; expiresIn?: number };
}

/** One real round-trip to platform. Throws the two typed errors above. */
async function performExchange(key: string, hash: string): Promise<CacheEntry> {
  const client = platformClient();
  let status: number;
  let body: ExchangeResponse;
  try {
    const res = await client.post<ExchangeResponse>('/auth/token/exchange', { key }, {
      headers: {
        Authorization: getServiceAuthHeader({ serviceName, role: 'member', orgId: SYSTEM_ORG_ID }),
      },
      // The exchange is a pure read of the key record plus a token mint — safe to
      // retry, and a lost retry only costs one extra mint.
      idempotent: true,
    });
    status = res.statusCode;
    body = res.body;
  } catch (err) {
    emitCounter('api_key_exchange_total', { result: 'unavailable' });
    emitCounter('api_key_exchange_failures_total', { reason: 'unavailable' });
    logger.warn('Access-key exchange failed to reach platform', {
      error: errorMessage(err),
    });
    throw new ApiKeyExchangeUnavailableError();
  }

  if (status === 401 || status === 403 || status === 400 || status === 404) {
    rejectionCache.set(hash, Date.now() + NEGATIVE_TTL_MS);
    emitCounter('api_key_exchange_total', { result: 'rejected' });
    emitCounter('api_key_exchange_failures_total', { reason: 'rejected' });
    throw new ApiKeyRejectedError();
  }

  const accessToken = body?.data?.accessToken;
  if (status >= 400 || typeof accessToken !== 'string' || accessToken.length === 0) {
    // 429 and 5xx land here: platform is up but can't answer right now, which is
    // "unknown", not "invalid" — never cache it as a rejection.
    emitCounter('api_key_exchange_total', { result: 'unavailable' });
    emitCounter('api_key_exchange_failures_total', { reason: status === 429 ? 'throttled' : 'server_error' });
    throw new ApiKeyExchangeUnavailableError();
  }

  const ttlSeconds = typeof body?.data?.expiresIn === 'number' && body.data.expiresIn > 0
    ? body.data.expiresIn
    : 60;
  const now = Date.now();
  const entry: CacheEntry = {
    token: accessToken,
    expiresAt: now + ttlSeconds * 1000,
    refreshAt: jitteredRefreshAt(now, ttlSeconds),
  };
  tokenCache.set(hash, entry);
  rejectionCache.delete(hash);
  evictIfFull();
  emitCounter('api_key_exchange_total', { result: 'success' });
  return entry;
}

/** Exchange, sharing a single in-flight round-trip per key. */
function exchangeOnce(key: string, hash: string): Promise<CacheEntry> {
  const pending = inFlight.get(hash);
  if (pending) return pending;
  const promise = performExchange(key, hash).finally(() => inFlight.delete(hash));
  inFlight.set(hash, promise);
  return promise;
}

/**
 * The JWT for `key`, from cache when possible. Throws {@link ApiKeyRejectedError}
 * when platform refused the key and {@link ApiKeyExchangeUnavailableError} when
 * it could not be asked.
 */
export async function exchangeApiKey(key: string): Promise<string> {
  const hash = hashApiKey(key);
  const now = Date.now();

  const rejectedUntil = rejectionCache.get(hash);
  if (rejectedUntil !== undefined) {
    if (rejectedUntil > now) {
      emitCounter('api_key_exchange_cache_total', { result: 'rejected' });
      throw new ApiKeyRejectedError();
    }
    rejectionCache.delete(hash);
  }

  const cached = tokenCache.get(hash);
  if (cached && cached.expiresAt > now) {
    if (cached.refreshAt <= now && !inFlight.has(hash)) {
      // Early refresh: warm the cache WITHOUT making this request wait. A failed
      // background refresh is not this request's problem — the cached token is
      // still valid, and the next request past expiry exchanges inline.
      emitCounter('api_key_exchange_cache_total', { result: 'refresh' });
      void exchangeOnce(key, hash).catch(() => { /* logged + counted in performExchange */ });
    } else {
      emitCounter('api_key_exchange_cache_total', { result: 'hit' });
    }
    return cached.token;
  }

  emitCounter('api_key_exchange_cache_total', { result: 'miss' });
  return (await exchangeOnce(key, hash)).token;
}

/**
 * Drop every cached exchange. For tests and for a process that wants to force
 * re-validation; production relies on the TTLs above.
 */
export function resetApiKeyExchangeCache(): void {
  tokenCache.clear();
  rejectionCache.clear();
  inFlight.clear();
}

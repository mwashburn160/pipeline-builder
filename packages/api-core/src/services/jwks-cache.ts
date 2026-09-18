// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The JWKS cache every verifier in the fleet shares.
 *
 * Platform signs user tokens with ES256 and publishes the public halves at
 * `/.well-known/jwks.json`. Verifiers must not fetch that per request (platform
 * would land on the hot path of the whole fleet) nor cache it forever (a rotated
 * key would never be picked up), so the contract is fixed here and reused by
 * api-core's `requireAuth`, image-registry's auth resolver and the CLI:
 *
 * - **Refresh every 10 minutes.** A key rotated in at platform is trusted fleet-
 *   wide within that window without anyone restarting.
 * - **Refetch once on an unknown `kid`.** A brand-new signing key is picked up
 *   immediately instead of 401-ing every request until the next refresh. Rate-
 *   limited ({@link UNKNOWN_KID_REFETCH_COOLDOWN_MS}) so a flood of forged `kid`s
 *   can't turn into a fetch storm against platform.
 * - **Negative-cache failures briefly.** A platform outage doesn't become a
 *   fetch-per-request amplifier.
 * - **Fail closed.** An unverifiable token is not an identity: when the key set
 *   cannot be obtained the verifier throws {@link JwksUnavailableError} and the
 *   caller answers 401/503 — it NEVER falls through to "allow".
 *   A key set already in hand is still used while a refresh is failing (the keys
 *   are public and don't expire; refusing every request because platform blipped
 *   would be a self-inflicted outage), which is why the negative cache exists.
 */

import type { KeyObject } from 'crypto';
import {
  JWKS_PATH,
  isJwksDocument,
  publicKeyFromJwk,
  type JwksDocument,
  type PublicJwk,
} from '../utils/jwk.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('jwks-cache');

/** How long a fetched key set is served before a refresh is due. */
export const JWKS_REFRESH_INTERVAL_MS = 600_000; // 10 minutes

/** How long a fetch FAILURE suppresses further attempts. */
export const JWKS_NEGATIVE_TTL_MS = 10_000;

/** Minimum gap between unknown-`kid` refetches, so forged kids can't stampede platform. */
export const UNKNOWN_KID_REFETCH_COOLDOWN_MS = 30_000;

/** The key set could not be obtained — the token's validity is UNKNOWN (503-shaped). */
export class JwksUnavailableError extends Error {
  constructor(message = 'Token signing keys are temporarily unavailable') {
    super(message);
    this.name = 'JwksUnavailableError';
  }
}

/** The key set was obtained and does NOT contain the token's `kid` (401-shaped). */
export class UnknownKidError extends Error {
  constructor(kid: string) {
    super(`No published signing key for kid ${kid}`);
    this.name = 'UnknownKidError';
  }
}

/** Fetches the raw JWKS document. Rejects on any transport/shape failure. */
export type JwksFetcher = () => Promise<JwksDocument>;

export interface JwksCacheOptions {
  fetch: JwksFetcher;
  /** For metrics/logging (e.g. `'platform'`). */
  source?: string;
  refreshIntervalMs?: number;
  negativeTtlMs?: number;
  unknownKidCooldownMs?: number;
}

/**
 * A key set with the freshness bookkeeping the contract above needs. Deliberately
 * transport-agnostic: the CLI and the Lambda hand it their own fetcher.
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private failedUntil = 0;
  private lastUnknownKidFetchAt = 0;
  private inFlight: Promise<void> | undefined;

  private readonly refreshIntervalMs: number;
  private readonly negativeTtlMs: number;
  private readonly unknownKidCooldownMs: number;
  private readonly source: string;

  constructor(private readonly options: JwksCacheOptions) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? JWKS_REFRESH_INTERVAL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? JWKS_NEGATIVE_TTL_MS;
    this.unknownKidCooldownMs = options.unknownKidCooldownMs ?? UNKNOWN_KID_REFETCH_COOLDOWN_MS;
    this.source = options.source ?? 'platform';
  }

  /**
   * The verification key for `kid`.
   *
   * @throws {JwksUnavailableError} the key set could not be obtained at all.
   * @throws {UnknownKidError} the key set is in hand but has no such key.
   */
  async getKey(kid: string): Promise<KeyObject> {
    await this.ensureFresh();
    const key = this.keys.get(kid);
    if (key) return key;

    // Unknown kid: platform may have JUST rotated. Refetch once (rate-limited),
    // then decide. A cached-but-stale set that still lacks the kid after the
    // refetch is a real rejection, not a freshness problem.
    const now = Date.now();
    if (now - this.lastUnknownKidFetchAt >= this.unknownKidCooldownMs) {
      this.lastUnknownKidFetchAt = now;
      emitCounter('jwks_unknown_kid_refetch_total', { source: this.source });
      await this.refresh({ force: true }).catch(() => { /* handled below by the miss */ });
      const refreshed = this.keys.get(kid);
      if (refreshed) return refreshed;
    }
    if (this.keys.size === 0) throw new JwksUnavailableError();
    throw new UnknownKidError(kid);
  }

  /** Every currently-trusted `kid`. Exposed for diagnostics and tests. */
  knownKids(): string[] {
    return [...this.keys.keys()];
  }

  /** Drop everything, so the next lookup refetches. */
  reset(): void {
    this.keys.clear();
    this.fetchedAt = 0;
    this.failedUntil = 0;
    this.lastUnknownKidFetchAt = 0;
    this.inFlight = undefined;
  }

  /** Refetch when the set is missing or past its refresh interval. */
  private async ensureFresh(): Promise<void> {
    const now = Date.now();
    const stale = now - this.fetchedAt >= this.refreshIntervalMs;
    if (this.keys.size > 0 && !stale) return;

    if (now < this.failedUntil) {
      // Inside the negative-cache window. Serve a key set we already hold
      // (public keys don't expire); with nothing in hand, fail closed.
      if (this.keys.size > 0) return;
      throw new JwksUnavailableError();
    }

    try {
      await this.refresh({ force: false });
    } catch (error) {
      if (this.keys.size > 0) {
        logger.warn('JWKS refresh failed; continuing on the cached key set', {
          source: this.source,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw new JwksUnavailableError();
    }
  }

  /** One real fetch, shared by every concurrent caller. */
  private refresh(opts: { force: boolean }): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!opts.force && Date.now() < this.failedUntil) return Promise.reject(new JwksUnavailableError());
    const promise = this.performFetch().finally(() => { this.inFlight = undefined; });
    this.inFlight = promise;
    return promise;
  }

  private async performFetch(): Promise<void> {
    let document: JwksDocument;
    try {
      document = await this.options.fetch();
    } catch (error) {
      this.failedUntil = Date.now() + this.negativeTtlMs;
      emitCounter('jwks_fetch_total', { source: this.source, result: 'error' });
      logger.warn('JWKS fetch failed', {
        source: this.source,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof Error ? error : new Error(String(error));
    }

    const keys = new Map<string, KeyObject>();
    for (const jwk of document.keys as PublicJwk[]) {
      if (!jwk?.kid) continue;
      try {
        keys.set(jwk.kid, publicKeyFromJwk(jwk));
      } catch (error) {
        // One unusable entry must not discard the rest of the set.
        logger.warn('Skipping unusable JWKS entry', { kid: jwk.kid, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (keys.size === 0) {
      this.failedUntil = Date.now() + this.negativeTtlMs;
      emitCounter('jwks_fetch_total', { source: this.source, result: 'empty' });
      throw new Error('JWKS document contained no usable keys');
    }

    this.keys = keys;
    this.fetchedAt = Date.now();
    this.failedUntil = 0;
    emitCounter('jwks_fetch_total', { source: this.source, result: 'success' });
  }
}

/**
 * Fetch platform's JWKS over the in-cluster address every other caller uses
 * (`PLATFORM_SERVICE_HOST` / `PLATFORM_SERVICE_PORT`), or the absolute
 * `PLATFORM_JWKS_URL` when one is configured (the CLI and the events Lambda run
 * outside the cluster).
 *
 * Unauthenticated by design: the key set is public, and requiring a credential
 * to fetch the keys that verify credentials is a bootstrap cycle.
 */
export async function fetchPlatformJwks(): Promise<JwksDocument> {
  const absolute = process.env.PLATFORM_JWKS_URL;
  const timeout = parseInt(process.env.JWKS_FETCH_TIMEOUT_MS || '3000', 10);
  if (absolute) return fetchJwksFromUrl(absolute, timeout);

  // Loaded LAZILY, on the first fetch. A static import would put the HTTP client
  // (and platform's address) into the import graph of every module that merely
  // uses `requireAuth` — the same reason `api-key-exchange` is lazy, and what
  // keeps partial `http-client.js` mocks in the service suites working.
  const { InternalHttpClient } = await import('./http-client.js');
  const client = new InternalHttpClient({
    host: process.env.PLATFORM_SERVICE_HOST || 'platform',
    port: parseInt(process.env.PLATFORM_SERVICE_PORT || '3000', 10),
    timeout,
  });
  const res = await client.get<unknown>(JWKS_PATH, { idempotent: true });
  if (res.statusCode !== 200 || !isJwksDocument(res.body)) {
    throw new Error(`Unexpected JWKS response (status ${res.statusCode})`);
  }
  return res.body;
}

/** Fetch a JWKS document from an absolute URL (outside-the-cluster verifiers). */
export async function fetchJwksFromUrl(url: string, timeoutMs = 3000): Promise<JwksDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS fetch returned ${res.status}`);
    const body: unknown = await res.json();
    if (!isJwksDocument(body)) throw new Error('JWKS response was not a key set');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

let platformJwks: JwksCache | undefined;

/** The process-wide cache of platform's published signing keys. */
export function platformJwksCache(): JwksCache {
  platformJwks ??= new JwksCache({ fetch: fetchPlatformJwks, source: 'platform' });
  return platformJwks;
}

/**
 * Replace the process-wide cache — used by tests, and by any host that must
 * supply its own fetcher. Pass `undefined` to drop back to the default.
 */
export function setPlatformJwksCache(cache: JwksCache | undefined): void {
  platformJwks = cache;
}

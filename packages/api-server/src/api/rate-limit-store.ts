// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createEnvRedisClient, createLogger, errorMessage, safeCreateRequire } from '@pipeline-builder/api-core';
import type { Store } from 'express-rate-limit';

const logger = createLogger('rate-limit-store');

type CommandClient = { call: (...args: string[]) => Promise<unknown> };

/** The options express-rate-limit hands to `Store.init`. */
type StoreInitOptions = Parameters<NonNullable<Store['init']>>[0];

/** One Redis connection for every rate limiter in the process.
 *  undefined = not built yet; null = Redis not configured. */
let client: CommandClient | null | undefined;

/**
 * Run the wrapped store's `init` on FIRST USE rather than at route setup, and
 * run it again if it fails.
 *
 * `rate-limit-redis` loads its two Lua scripts in `init` and keeps the in-flight
 * `SCRIPT LOAD` promises on the instance (`incrementScriptSha`, `getScriptSha`),
 * which every later `increment` awaits. express-rate-limit calls `init` exactly
 * once, at route setup, does not await it, and never calls it again — its own
 * contract says so. So ONE rejection there is memoized for the life of the
 * process: every subsequent request re-awaits that same rejected promise and the
 * limiter is silently off. The store's internal retry doesn't help, because it
 * only re-loads on a `NOSCRIPT` reply.
 *
 * At boot that rejection is a live race, not a hypothetical. The env Redis
 * client has no offline queue, and its readiness gate waits only
 * `REQUEST_PATH_REDIS_READY_TIMEOUT_MS` before letting the command run against a
 * socket that is still connecting — so on a slow start the `SCRIPT LOAD` is
 * rejected with "Stream isn't writeable", and rate limiting never comes back.
 *
 * Both halves of the fix matter, and neither touches the connection's semantics
 * (no offline queue, still fail-fast — a request must never hang behind a Redis
 * outage). Deferring `init` to the first actual request removes the race, since
 * a request arrives long after the connection settles. Re-running it on failure
 * means no limiter can be left permanently off by one bad moment. A failure
 * still propagates to express-rate-limit, which — paired with
 * `passOnStoreError: true` — lets that one request through and logs it.
 */
function withRetryingInit(store: Store, namespace: string): Store {
  let initOptions: StoreInitOptions | undefined;
  let inflight: Promise<void> | null = null;
  let failed = false;

  const initialized = (): Promise<void> => {
    // express-rate-limit always calls `init` before any other method; if some
    // caller doesn't, pass straight through rather than inventing options.
    if (initOptions === undefined) return Promise.resolve();
    if (!inflight) {
      inflight = Promise.resolve(store.init?.(initOptions))
        .then(() => {
          // Worth a line: the failure below is loud, and an operator who saw it
          // needs to know rate limiting is actually enforcing again.
          if (failed) logger.info('Rate-limit store recovered — scripts loaded', { namespace });
          failed = false;
        })
        .catch((error: unknown) => {
          // Forget the failure so the NEXT request builds fresh script promises
          // instead of re-awaiting this rejected one forever.
          inflight = null;
          failed = true;
          logger.warn('Rate-limit store init failed — requests pass unlimited until it succeeds', {
            namespace, error: errorMessage(error),
          });
          throw error;
        });
    }
    return inflight;
  };

  return {
    // Captured, not forwarded — the real init runs from `initialized()`.
    init: (options) => { initOptions = options; },
    increment: async (key) => { await initialized(); return store.increment(key); },
    decrement: async (key) => { await initialized(); return store.decrement(key); },
    resetKey: async (key) => { await initialized(); return store.resetKey(key); },
    // Only expose what the wrapped store actually implements: express-rate-limit
    // treats the PRESENCE of these as "the store supports it".
    ...(store.get ? { get: async (key: string) => { await initialized(); return store.get!(key); } } : {}),
    ...(store.resetAll ? { resetAll: async () => { await initialized(); return store.resetAll!(); } } : {}),
    ...(store.shutdown ? { shutdown: () => store.shutdown!() } : {}),
    ...(store.localKeys === undefined ? {} : { localKeys: store.localKeys }),
    ...(store.prefix === undefined ? {} : { prefix: store.prefix }),
  };
}

/**
 * A cross-replica rate-limit store under `rl:<namespace>:`, or `undefined` when
 * Redis isn't configured (express-rate-limit then uses its per-process memory
 * store, which is right for a single replica).
 *
 * Without a shared store every limit is really `max × replicas`, and weakest
 * exactly when an HPA has scaled out under load. Use a namespace unique to the
 * service AND limiter, so separate limiters never share a counter. Pair it with
 * `passOnStoreError: true`: a Redis outage then lets requests through instead of
 * failing them. Script loading is deferred to the first request and retried on
 * failure — see {@link withRetryingInit}.
 */
export function createSharedRateLimitStore(namespace: string): Store | undefined {
  if (client === undefined) client = createEnvRedisClient<CommandClient>('rate-limit');
  if (!client) return undefined;
  const redis = client;
  const require = safeCreateRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RedisStore } = require('rate-limit-redis') as { RedisStore: new (o: unknown) => Store };
  logger.debug('Shared rate-limit store created', { namespace });
  return withRetryingInit(new RedisStore({
    prefix: `rl:${namespace}:`,
    sendCommand: (...args: string[]) => redis.call(...args),
  }), namespace);
}

/** Test-only: forget the memoized client. */
export function __resetSharedRateLimitStoreForTests(): void {
  client = undefined;
}

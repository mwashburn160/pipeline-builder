// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createEnvRedisClient, createLogger, safeCreateRequire } from '@pipeline-builder/api-core';
import type { Store } from 'express-rate-limit';

const logger = createLogger('rate-limit-store');

type CommandClient = { call: (...args: string[]) => Promise<unknown> };

/** One Redis connection for every rate limiter in the process.
 *  undefined = not built yet; null = Redis not configured. */
let client: CommandClient | null | undefined;

/**
 * A cross-replica rate-limit store under `rl:<namespace>:`, or `undefined` when
 * Redis isn't configured (express-rate-limit then uses its per-process memory
 * store, which is right for a single replica).
 *
 * Without a shared store every limit is really `max × replicas`, and weakest
 * exactly when an HPA has scaled out under load. Use a namespace unique to the
 * service AND limiter, so separate limiters never share a counter. Pair it with
 * `passOnStoreError: true`: a Redis outage then lets requests through instead of
 * failing them. A store whose scripts can't load at startup (Redis not yet
 * connected) is tolerated by express-rate-limit and reloads on first use.
 */
export function createSharedRateLimitStore(namespace: string): Store | undefined {
  if (client === undefined) client = createEnvRedisClient<CommandClient>('rate-limit');
  if (!client) return undefined;
  const redis = client;
  const require = safeCreateRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RedisStore } = require('rate-limit-redis') as { RedisStore: new (o: unknown) => Store };
  logger.debug('Shared rate-limit store created', { namespace });
  return new RedisStore({
    prefix: `rl:${namespace}:`,
    sendCommand: (...args: string[]) => redis.call(...args),
  });
}

/** Test-only: forget the memoized client. */
export function __resetSharedRateLimitStoreForTests(): void {
  client = undefined;
}

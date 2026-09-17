// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'module';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('env-redis');

/**
 * The ONE place Redis connection settings are read from the environment.
 *
 * Two shapes, exactly one of which may be set:
 *
 * - **Standalone** — `REDIS_URL` (`redis://host:6379[/db]`, or `rediss://` for
 *   TLS). Credentials may sit in the URL or in `REDIS_PASSWORD`.
 * - **HA (Sentinel)** — `REDIS_SENTINELS` (comma-separated `host:port`) plus
 *   `REDIS_SENTINEL_MASTER` (default `mymaster`) and optional
 *   `REDIS_SENTINEL_PASSWORD`. `REDIS_PASSWORD` authenticates to the data nodes.
 *   ioredis follows the master across a failover.
 *
 * Neither set → Redis is off, and each caller degrades to its documented
 * no-Redis behavior.
 *
 * `REDIS_HOST` / `REDIS_PORT` are not read. `REDIS_HOST` is refused outright so a
 * stale config fails at startup instead of silently running without Redis.
 * `REDIS_PORT` can't be refused: Kubernetes injects `REDIS_PORT=tcp://<ip>:6379`
 * into every pod in a namespace with a Service named `redis`, which is exactly
 * why a host/port pair was unsafe to parse.
 *
 * Misconfiguration throws {@link RedisConfigError}. Writers and readers of the
 * same keys (revocation, step-up, leader locks) must resolve Redis identically;
 * a config that quietly resolved to "no Redis" on one side is how revocation
 * once did nothing at all.
 */

/** Thrown for a Redis environment that can't be used as written. */
export class RedisConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisConfigError';
  }
}

/** Resolved connection, independent of any client library. */
export type RedisConnection =
  | {
    mode: 'sentinel';
    sentinels: Array<{ host: string; port: number }>;
    masterName: string;
    password?: string;
    sentinelPassword?: string;
  }
  | {
    mode: 'url';
    url: string;
    password?: string;
  };

/**
 * Parse `REDIS_SENTINELS` into `{ host, port }[]`. Blank entries are skipped and
 * a missing port means the Sentinel default 26379; a port that isn't a valid
 * TCP port is a configuration error.
 */
export function parseSentinels(raw: string | undefined): Array<{ host: string; port: number }> {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const idx = entry.lastIndexOf(':');
    const host = idx === -1 ? entry : entry.slice(0, idx);
    const portText = idx === -1 ? '' : entry.slice(idx + 1);
    const port = portText === '' ? 26379 : Number(portText);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RedisConfigError(`REDIS_SENTINELS entry "${entry}" is not host:port`);
    }
    return { host, port };
  });
}

/**
 * Resolve the Redis connection from `env`, or `null` when Redis isn't
 * configured. Throws {@link RedisConfigError} for an unusable configuration.
 */
export function resolveRedisConnection(env: NodeJS.ProcessEnv = process.env): RedisConnection | null {
  if (env.REDIS_HOST) {
    throw new RedisConfigError(
      'REDIS_HOST is not supported. Set REDIS_URL=redis://<host>:<port> (or REDIS_SENTINELS for HA) and remove REDIS_HOST/REDIS_PORT.',
    );
  }

  const sentinels = parseSentinels(env.REDIS_SENTINELS);
  const url = env.REDIS_URL?.trim();
  const password = env.REDIS_PASSWORD || undefined;

  if (sentinels.length > 0 && url) {
    throw new RedisConfigError('Set REDIS_URL or REDIS_SENTINELS, not both.');
  }

  if (sentinels.length > 0) {
    return {
      mode: 'sentinel',
      sentinels,
      masterName: env.REDIS_SENTINEL_MASTER || 'mymaster',
      password,
      sentinelPassword: env.REDIS_SENTINEL_PASSWORD || undefined,
    };
  }

  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new RedisConfigError('REDIS_URL is not a valid URL (expected redis://<host>:<port>).');
    }
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new RedisConfigError(`REDIS_URL must use redis:// or rediss://, got ${parsed.protocol}//`);
    }
    if (!parsed.hostname) throw new RedisConfigError('REDIS_URL has no host.');
    return { mode: 'url', url, password };
  }

  return null;
}

/** A log-safe description of a connection (never includes credentials). */
export function describeRedisConnection(conn: RedisConnection): Record<string, unknown> {
  if (conn.mode === 'sentinel') {
    return { mode: 'sentinel', master: conn.masterName, sentinels: conn.sentinels.length };
  }
  const u = new URL(conn.url);
  return { mode: 'url', host: u.hostname, port: u.port || '6379', tls: u.protocol === 'rediss:' };
}

type RedisCtor<T> = new (...args: unknown[]) => T;

function loadIoredis<T>(): RedisCtor<T> {
  const req = createRequire(import.meta.url);
  const mod = req('ioredis') as { Redis?: RedisCtor<T>; default?: RedisCtor<T> };
  return (mod.Redis ?? mod.default ?? mod) as RedisCtor<T>;
}

/**
 * Construct an ioredis client for a resolved connection. `options` are merged
 * into the client options (e.g. `{ db, maxRetriesPerRequest: null }` for BullMQ).
 * An `error` listener is always attached so a dropped connection is logged
 * rather than surfacing as an unhandled `'error'` event that crashes Node.
 */
export function createRedisClient<T = unknown>(
  conn: RedisConnection,
  label: string,
  options: Record<string, unknown> = {},
): T {
  const Ctor = loadIoredis<T>();
  const auth = conn.password ? { password: conn.password } : {};
  const inst = conn.mode === 'sentinel'
    ? new Ctor({
      sentinels: conn.sentinels,
      name: conn.masterName,
      ...(conn.sentinelPassword ? { sentinelPassword: conn.sentinelPassword } : {}),
      ...auth,
      ...options,
    })
    : new Ctor(conn.url, { ...auth, ...options });
  (inst as unknown as { on: (evt: string, cb: (e: unknown) => void) => void })
    .on('error', (e) => logger.warn(`Redis ${label} client error`, { error: e instanceof Error ? e.message : String(e) }));
  return inst;
}

/**
 * The shared application Redis client: `null` when Redis isn't configured, so
 * the caller degrades to its no-Redis behavior.
 *
 * Commands fail fast (`maxRetriesPerRequest: 1`, no offline queue) because the
 * request-path callers are best-effort or fail closed on their own terms — a
 * request must not hang behind a Redis outage. That includes the moments before
 * the first connection completes: a background caller that runs at startup must
 * either tolerate a rejected command or wait with {@link whenRedisReady}.
 *
 * Throws {@link RedisConfigError} for a bad configuration, and if Redis is
 * configured but `ioredis` can't be loaded — both are deployment errors that
 * must not quietly turn Redis-backed guarantees off.
 */
export function createEnvRedisClient<T = unknown>(label: string): T | null {
  const conn = resolveRedisConnection();
  if (!conn) return null;
  const inst = createRedisClient<T>(conn, label, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  logger.info(`Redis ${label} client created`, describeRedisConnection(conn));
  return inst;
}

/** The subset of ioredis needed to wait for a connection. */
export interface ReadyAwareRedis {
  status?: string;
  once?(event: string, cb: (...args: unknown[]) => void): unknown;
  off?(event: string, cb: (...args: unknown[]) => void): unknown;
}

/**
 * Resolve once `client` is connected and ready for commands, or reject after
 * `timeoutMs`. For startup work (creating a consumer group, subscribing) that
 * otherwise races the first connection. A client without ioredis' `status`
 * (e.g. a test double) counts as ready.
 */
export function whenRedisReady(client: ReadyAwareRedis, timeoutMs = 30_000): Promise<void> {
  if (client.status === undefined || client.status === 'ready' || !client.once) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      client.off?.('ready', onReady);
      reject(new Error(`Redis not ready after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    client.once!('ready', onReady);
  });
}

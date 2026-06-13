// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getConnection } from '@pipeline-builder/pipeline-core';

type HealthStatus = 'connected' | 'disconnected' | 'unknown';
type HealthResult = Record<string, HealthStatus>;

/**
 * Reject if `promise` hasn't settled within `ms`. A health/readiness probe
 * must never hang the `/ready` response — a down datastore (or a BullMQ
 * ioredis client with `maxRetriesPerRequest: null` + an offline queue) can
 * leave a `ping()`/query pending indefinitely, so every probe is time-boxed.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Postgres health probe: returns `{ postgres: 'connected' }` when the pool's
 * connection test succeeds, `{ postgres: 'disconnected' }` on any error or
 * timeout (so `/ready` correctly reports 503). Use as (part of) the
 * `checkDependencies` option of `createApp()` for any service backed by the
 * shared pipeline-data Drizzle connection.
 */
export async function postgresHealthCheck(timeoutMs = 3000): Promise<HealthResult> {
  try {
    await withTimeout(getConnection().testConnection(), timeoutMs, 'postgres testConnection');
    return { postgres: 'connected' };
  } catch {
    return { postgres: 'disconnected' };
  }
}

/** Minimal shape of an ioredis client needed for a health PING. */
interface RedisLike {
  ping(): Promise<string>;
}

/**
 * Source of a redis client: either the client itself, or a (sync/async) getter.
 * The getter form supports BullMQ's `queue.client` (a `Promise<RedisClient>`)
 * so a service can probe the exact connection its queue uses without opening
 * a second one.
 */
type RedisClientSource = RedisLike | (() => RedisLike | Promise<RedisLike>);

/**
 * Redis health probe factory: pass the service's EXISTING ioredis connection
 * (or a getter for it — e.g. `() => queue.client`) and get back a
 * `checkDependencies` callback that `PING`s it. Mirrors `mongoHealthCheck` —
 * it probes the real connection rather than opening a throwaway one per call.
 * The PING is time-boxed so a down redis (whose offline queue would otherwise
 * buffer the command) reports `disconnected` quickly instead of hanging.
 */
export function redisHealthCheck(source: RedisClientSource, timeoutMs = 2000): () => Promise<HealthResult> {
  return async () => {
    try {
      const client = typeof source === 'function' ? await source() : source;
      await withTimeout(client.ping(), timeoutMs, 'redis ping');
      return { redis: 'connected' };
    } catch {
      return { redis: 'disconnected' };
    }
  };
}

/**
 * Combine several dependency probes into one `checkDependencies` callback that
 * runs them IN PARALLEL and merges their results. A slow/failed probe can't
 * delay the others or time out the whole `/ready` response.
 *
 * CONTRACT: each probe must CATCH internally and RETURN its `{ name: status }`
 * (as the built-in postgres/redis/mongo probes do). A probe that THROWS is
 * merged as `{}` — its dependency then vanishes from the map and `/ready`
 * reports 200 with the dep simply absent (a silent false-healthy), rather than
 * surfacing it as `disconnected`. The `.catch(() => ({}))` below only exists so
 * one misbehaving probe can't take down the others, NOT as a substitute for a
 * probe returning its own disconnected status.
 */
export function combineHealthChecks(
  ...checks: Array<() => Promise<HealthResult>>
): () => Promise<HealthResult> {
  return async () => {
    const results = await Promise.all(checks.map((check) => check().catch(() => ({} as HealthResult))));
    return Object.assign({}, ...results) as HealthResult;
  };
}

/**
 * Minimal shape expected of a mongoose connection for the health probe.
 * Accepts `mongoose.connection` directly without requiring mongoose as a
 * dependency of api-server.
 */
interface MongooseConnectionLike {
  readyState: number;
}

/**
 * MongoDB health probe factory: pass `mongoose.connection` and get back a
 * `checkDependencies` callback that reports based on mongoose's readyState.
 *
 * Mapping (per mongoose docs): 1=connected, 2=connecting, 3=disconnecting,
 * any other value (0=disconnected, 99=uninitialized) is treated as
 * 'disconnected' so `/health` returns 503.
 */
export function mongoHealthCheck(connection: MongooseConnectionLike): () => Promise<HealthResult> {
  return async () => ({
    mongodb: connection.readyState === 1 ? 'connected'
      : connection.readyState === 2 ? 'unknown' // connecting; treat as transient
        : 'disconnected',
  });
}

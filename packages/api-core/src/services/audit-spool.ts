// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'module';

import type { RemoteAuditEvent } from './remote-audit-client.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('audit-spool');

/** A buffered emission: the event plus which service must re-deliver it. */
export interface AuditSpoolEntry {
  event: RemoteAuditEvent;
  serviceName: string;
}

/**
 * Durable buffer for audit events that failed LIVE delivery to the platform
 * (retries exhausted during a sustained outage). Without this, the audit trail —
 * a security log — is silently lost the moment the platform is down for longer
 * than the client's small retry budget.
 *
 * Contract:
 * - BOUNDED. A security log must degrade to "dropped the oldest, loudly" (a
 *   metric) rather than grow without limit and OOM the emitter.
 * - FAIL-SAFE. Every method swallows its own errors — a broken/unreachable spool
 *   must never break or block the audit emission path (which is itself
 *   fire-and-forget). A spool problem degrades to the pre-spool behavior.
 * - Ordering is best-effort. Re-delivered events chain at re-delivery time
 *   (that's when the platform inserts them), so each event also carries an
 *   `occurredAt` stamped at emission for reviewers — see RemoteAuditEvent.
 */
export interface AuditSpool {
  /** Buffer an event that failed live delivery. */
  enqueue(entry: AuditSpoolEntry): Promise<void>;
  /** Remove and return up to `max` buffered entries for re-delivery attempts. */
  take(max: number): Promise<AuditSpoolEntry[]>;
  /** Return entries whose re-delivery failed to the buffer (best-effort). */
  requeue(entries: AuditSpoolEntry[]): Promise<void>;
  /** Approximate current depth (for metrics / drain decisions). */
  depth(): Promise<number>;
}

/** Minimal Redis LIST surface the spool needs (a subset of ioredis). */
interface RedisListClient {
  rpush(key: string, ...values: string[]): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lpop(key: string, count: number): Promise<string[] | null>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  llen(key: string): Promise<number>;
}

const DEFAULT_SPOOL_KEY = 'audit:spool';
const DEFAULT_MAX_DEPTH = 10_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeParse(raw: string): AuditSpoolEntry | null {
  try {
    const parsed = JSON.parse(raw) as AuditSpoolEntry;
    return parsed && parsed.event && parsed.serviceName ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Redis-LIST-backed spool. Durable across process restarts (unlike an in-memory
 * or per-pod-disk buffer), shared by all replicas of a service, and bounded via
 * a trim-to-tail on overflow (drops the OLDEST, emitting `audit_spool_dropped_total`).
 */
export function createRedisAuditSpool(
  redis: RedisListClient,
  opts: { maxDepth?: number; key?: string } = {},
): AuditSpool {
  const key = opts.key ?? DEFAULT_SPOOL_KEY;
  const maxDepth = Math.max(1, opts.maxDepth ?? DEFAULT_MAX_DEPTH);

  return {
    async enqueue(entry) {
      try {
        const len = await redis.rpush(key, JSON.stringify(entry));
        emitCounter('audit_spool_enqueued_total', { service: entry.serviceName });
        if (len > maxDepth) {
          // Keep only the newest `maxDepth`; drop the overflow at the head.
          const dropped = len - maxDepth;
          await redis.ltrim(key, dropped, -1);
          emitCounter('audit_spool_dropped_total', { service: entry.serviceName }, dropped);
          logger.warn('Audit spool overflow — dropped oldest buffered events', { dropped, maxDepth });
        }
      } catch (err) {
        logger.warn('Audit spool enqueue failed (event lost)', { error: errMsg(err) });
      }
    },

    async take(max) {
      try {
        const raw = await redis.lpop(key, Math.max(1, max));
        if (!raw || raw.length === 0) return [];
        return raw.map(safeParse).filter((e): e is AuditSpoolEntry => e !== null);
      } catch (err) {
        logger.warn('Audit spool take failed', { error: errMsg(err) });
        return [];
      }
    },

    async requeue(entries) {
      if (entries.length === 0) return;
      try {
        // Put failed re-deliveries back at the HEAD so they're retried first and
        // rough emission order is preserved across the outage.
        await redis.lpush(key, ...entries.map((e) => JSON.stringify(e)));
      } catch (err) {
        logger.warn('Audit spool requeue failed (events lost)', { error: errMsg(err) });
      }
    },

    async depth() {
      try {
        return await redis.llen(key);
      } catch {
        return 0;
      }
    },
  };
}

/**
 * Build a Redis-backed audit spool from the ambient `REDIS_URL` / `REDIS_HOST`
 * env (mirrors `createEnvRedisTokenRevocationStore`). Returns `null` when Redis
 * is not configured or the client can't be constructed — the caller then runs
 * without a spool (pre-spool best-effort behavior), never crashing. ioredis is a
 * runtime-only optional dep loaded via `createRequire`, so this stays importable
 * where Redis isn't present.
 */
export function createEnvRedisAuditSpool(opts: { maxDepth?: number; key?: string } = {}): AuditSpool | null {
  try {
    const url = process.env.REDIS_URL;
    const host = process.env.REDIS_HOST;
    if (!url && !host) return null;
    const req = createRequire(import.meta.url);
    const mod = req('ioredis') as {
      Redis?: new (...args: unknown[]) => unknown;
      default?: new (...args: unknown[]) => unknown;
    };
    const RedisCtor = (mod.Redis ?? mod.default ?? mod) as new (...args: unknown[]) => RedisListClient;
    const redisOpts = { maxRetriesPerRequest: 1, enableOfflineQueue: false };
    const inst = url
      ? new RedisCtor(url, redisOpts)
      : new RedisCtor({ host, port: parseInt(process.env.REDIS_PORT ?? '6379', 10), ...redisOpts });
    (inst as unknown as { on: (evt: string, cb: (e: unknown) => void) => void })
      .on('error', (e) => logger.warn('Redis audit-spool client error', { error: errMsg(e) }));
    logger.info('Redis audit spool initialized');
    return createRedisAuditSpool(inst, opts);
  } catch (err) {
    logger.warn('Redis unavailable for audit spool; audit delivery is best-effort only', { error: errMsg(err) });
    return null;
  }
}

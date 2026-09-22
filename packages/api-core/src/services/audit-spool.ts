// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { createEnvRedisClient, createRedisReadyGate, type ReadyAwareRedis } from './env-redis.js';
import type { RemoteAuditEvent } from './remote-audit-client.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';

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
  /**
   * Atomically MOVE up to `max` buffered entries onto an in-progress list and
   * return them. Because the entries are moved (not popped-and-dropped), a crash
   * mid-drain leaves them recoverable on the in-progress list — see `recover`.
   * Each taken entry MUST be resolved with exactly one of `ack` (delivered) or
   * `requeue` (still failing), or it lingers on the in-progress list until the
   * next `recover`.
   */
  take(max: number): Promise<AuditSpoolEntry[]>;
  /** Acknowledge successfully re-delivered entries — removes them from the
   *  in-progress list so they are not recovered again. */
  ack(entries: AuditSpoolEntry[]): Promise<void>;
  /** Return entries whose re-delivery failed to the HEAD of the buffer (retried
   *  first) and clear them from the in-progress list. Best-effort. */
  requeue(entries: AuditSpoolEntry[]): Promise<void>;
  /**
   * Reclaim entries stranded on ABANDONED in-progress lists — those of owners
   * (spool instances, i.e. pods) whose heartbeat is older than the stale
   * threshold — moving them back to the head of the main buffer. A LIVE owner's
   * in-flight batch is never touched, so a peer's recover can't duplicate work
   * that owner is still delivering. Safe to call periodically; returns the
   * number reclaimed.
   */
  recover(): Promise<number>;
  /** Mark this owner alive (so no peer reclaims its in-flight batch). */
  heartbeat(): Promise<void>;
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
  /** Atomically pop from one list end and push to another (Redis ≥ 6.2). */
  lmove(source: string, destination: string, from: 'LEFT' | 'RIGHT', to: 'LEFT' | 'RIGHT'): Promise<string | null>;
  /** Remove `count` occurrences of `value` from a list. */
  lrem(key: string, count: number, value: string): Promise<number>;
  /** Owner heartbeats: a sorted set of owner id → last-seen epoch ms. */
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, member: string): Promise<number>;
}

/**
 * The spool key for one service's buffered audit events. Per SERVICE on
 * purpose: re-delivery mints a service token as `entry.serviceName`, which only
 * that service's pods can sign (per-service keys). A shared key let a pod of
 * one service take another's entries, fail to sign for them, and requeue them
 * forever — while that service's own pods never saw them.
 */
export function auditSpoolKey(serviceName: string): string {
  return `audit:spool:${serviceName}`;
}

const DEFAULT_MAX_DEPTH = 10_000;
/** An owner whose heartbeat is older than this is presumed dead (its pod crashed). */
const DEFAULT_STALE_OWNER_MS = 10 * 60_000;
/** Guard so a pathological in-progress list can't spin `recover`/`take` forever. */
const MAX_MOVE_ITERATIONS = 100_000;

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
export interface RedisAuditSpoolOptions {
  /** The buffer's Redis key — one per service ({@link auditSpoolKey}). */
  key: string;
  maxDepth?: number;
  /** This instance's owner id (default: random per instance). */
  ownerId?: string;
  /** Heartbeat age after which an owner's in-flight batch is reclaimable. */
  staleOwnerMs?: number;
  /** Awaited before each command — e.g. a readiness gate for a lazily connecting client. */
  ready?: () => Promise<void>;
}

export function createRedisAuditSpool(redis: RedisListClient, opts: RedisAuditSpoolOptions): AuditSpool {
  const key = opts.key;
  const ownerId = opts.ownerId ?? randomUUID();
  const staleOwnerMs = Math.max(1, opts.staleOwnerMs ?? DEFAULT_STALE_OWNER_MS);
  const ready = opts.ready ?? (() => Promise.resolve());
  // PER-OWNER in-progress list — a taken batch lives here until it is acked
  // (delivered) or requeued (still failing). It is a security log's durability
  // net: a crash between take and ack/requeue leaves the batch here, and a peer's
  // (or this pod's successor's) `recover` reclaims it once the owner's heartbeat
  // goes stale. One shared in-flight list let any replica's startup recover
  // steal batches its live siblings were mid-way through delivering.
  const inflightKeyOf = (owner: string) => `${key}:inflight:${owner}`;
  const inProgressKey = inflightKeyOf(ownerId);
  const ownersKey = `${key}:owners`;
  const maxDepth = Math.max(1, opts.maxDepth ?? DEFAULT_MAX_DEPTH);

  const beat = async (): Promise<void> => {
    await redis.zadd(ownersKey, Date.now(), ownerId);
  };

  // The EXACT serialized string each returned entry was parsed from, so `ack` /
  // `requeue` can LREM the precise value off the in-progress list. Keyed by the
  // returned object identity (the drain consumer passes the SAME objects back),
  // so it needs no stable re-serialization. WeakMap → entries GC naturally.
  const rawByEntry = new WeakMap<AuditSpoolEntry, string>();
  const rawOf = (entry: AuditSpoolEntry): string => rawByEntry.get(entry) ?? JSON.stringify(entry);

  return {
    async enqueue(entry) {
      try {
        await ready();
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
        logger.warn('Audit spool enqueue failed (event lost)', { error: errorMessage(err) });
      }
    },

    async take(max) {
      try {
        await ready();
        await beat();
        const out: AuditSpoolEntry[] = [];
        const limit = Math.max(1, max);
        for (let i = 0; i < limit; i++) {
          // Atomically MOVE head→in-progress-tail so the entry is never in limbo:
          // it is on exactly one list at all times, recoverable after a crash.
          const raw = await redis.lmove(key, inProgressKey, 'LEFT', 'RIGHT');
          if (raw === null || raw === undefined) break;
          const parsed = safeParse(raw);
          if (parsed) {
            rawByEntry.set(parsed, raw);
            out.push(parsed);
          } else {
            // Corrupt payload — drop it off the in-progress list so it can't wedge
            // the drain, and account for it.
            await redis.lrem(inProgressKey, 1, raw);
            emitCounter('audit_spool_dropped_total', { service: 'unknown' });
          }
        }
        return out;
      } catch (err) {
        logger.warn('Audit spool take failed', { error: errorMessage(err) });
        return [];
      }
    },

    async ack(entries) {
      if (entries.length === 0) return;
      try {
        await ready();
        for (const entry of entries) {
          await redis.lrem(inProgressKey, 1, rawOf(entry));
          rawByEntry.delete(entry);
        }
      } catch (err) {
        logger.warn('Audit spool ack failed (may re-deliver on recover)', { error: errorMessage(err) });
      }
    },

    async requeue(entries) {
      if (entries.length === 0) return;
      try {
        // Put failed re-deliveries back at the HEAD so they're retried first and
        // rough emission order is preserved across the outage — and clear them
        // from the in-progress list so `recover` doesn't double them. Iterate in
        // reverse so lpush restores the batch's original order at the head.
        //
        // ORDERING INVARIANT (at-least-once): lpush to the main list FIRST, THEN
        // lrem from in-progress. A crash between the two leaves the entry on BOTH
        // lists → harmless double-delivery (deduped downstream by idempotency
        // reuse), never a LOSS. The reverse order (lrem then lpush) would drop the
        // event outright on a crash in the gap, which a security log must not do.
        await ready();
        for (let i = entries.length - 1; i >= 0; i--) {
          const raw = rawOf(entries[i]);
          await redis.lpush(key, raw);
          await redis.lrem(inProgressKey, 1, raw);
          rawByEntry.delete(entries[i]);
        }
      } catch (err) {
        logger.warn('Audit spool requeue failed (events lost)', { error: errorMessage(err) });
      }
    },

    async recover() {
      try {
        await ready();
        await beat();
        let reclaimed = 0;
        const stale = await redis.zrangebyscore(ownersKey, '-inf', Date.now() - staleOwnerMs);
        for (const owner of stale) {
          if (owner === ownerId) continue;
          const source = inflightKeyOf(owner);
          for (let i = 0; i < MAX_MOVE_ITERATIONS; i++) {
            // Move in-progress-tail → main-head: an older stranded entry (nearer
            // the in-progress head) ends up ahead of a newer one, preserving order.
            const raw = await redis.lmove(source, key, 'RIGHT', 'LEFT');
            if (raw === null || raw === undefined) break;
            reclaimed++;
          }
          // Only forget the owner once its list is empty.
          await redis.zrem(ownersKey, owner);
        }
        if (reclaimed > 0) {
          emitCounter('audit_spool_recovered_total', {}, reclaimed);
          logger.warn('Audit spool recovered events stranded by a dead owner', { reclaimed });
        }
        return reclaimed;
      } catch (err) {
        logger.warn('Audit spool recover failed', { error: errorMessage(err) });
        return 0;
      }
    },

    async heartbeat() {
      try {
        await ready();
        await beat();
      } catch (err) {
        logger.debug('Audit spool heartbeat failed', { error: errorMessage(err) });
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
 * Build a Redis-backed audit spool from the ambient `REDIS_URL` / `REDIS_SENTINELS`
 * env via the shared `createEnvRedisClient`. Returns `null` when Redis is not
 * configured — the caller then runs without a spool (best-effort behavior). The shared helper loads
 * ioredis via `createRequire`, so this stays importable where Redis isn't present.
 */
export function createEnvRedisAuditSpool(opts: Omit<RedisAuditSpoolOptions, 'ready'>): AuditSpool | null {
  const inst = createEnvRedisClient<RedisListClient & ReadyAwareRedis>('audit-spool');
  if (!inst) return null;
  logger.info('Redis audit spool initialized', { key: opts.key });
  // The env client has no offline queue: a boot-time recover() run before the
  // connection is up would fail and strand batches until the next restart, so
  // every command waits (bounded) for readiness.
  return createRedisAuditSpool(inst, { ...opts, ready: createRedisReadyGate(inst, 10_000) });
}

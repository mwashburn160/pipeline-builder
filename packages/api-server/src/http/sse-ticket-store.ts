// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createEnvRedisClient } from '@pipeline-builder/api-core';

const logger = createLogger('sse-ticket-store');

/** A minted ticket's bound identity: owning org + normalized stream subject. */
export interface SSETicketRecord {
  orgId: string;
  /** Normalized (dashes stripped, lowercased) stream subject id. */
  requestId: string;
}

/**
 * Pluggable backend for SSE log-stream tickets AND stream-ownership.
 *
 * Two concerns share one store because both must be consistent across pods:
 * - **Tickets** — short-lived, single-use, bound to (org, subject). The default
 *   in-memory store is correct only single-replica; the Redis store makes the
 *   mint (one pod) / redeem (another pod) exchange work behind a load balancer.
 * - **Stream ownership** — which org OWNS a given stream subject. The stream
 *   producer (platform, a different service) records this so ticket minting can
 *   assert the caller's org owns the subject, closing the cross-tenant attach
 *   gap where any org could mint a ticket for a guessed requestId.
 *
 * All methods are async (Redis is async) and best-effort on the failure side per
 * their doc — a store outage must degrade gracefully, never crash the stream.
 */
export interface SSETicketStore {
  /** Persist a single-use ticket bound to `record`, expiring after `ttlMs`. */
  put(ticketId: string, record: SSETicketRecord, ttlMs: number): Promise<void>;
  /** Atomically fetch-and-delete a ticket (single-use). Null if absent/expired. */
  consume(ticketId: string): Promise<SSETicketRecord | null>;
  /** Count of live (unexpired) tickets held for an org (per-org cap). */
  countForOrg(orgId: string): Promise<number>;
  /** Count of all live tickets across the store (capacity cap). */
  total(): Promise<number>;
  /** Record the org that OWNS a stream subject (producer-side), TTL `ttlMs`. */
  bindStreamOwner(requestId: string, orgId: string, ttlMs: number): Promise<void>;
  /** The owning org of a stream subject, or null when none is bound. */
  getStreamOwner(requestId: string): Promise<string | null>;
  /** Optional hygiene sweep of expired entries (Redis TTL makes this a no-op). */
  sweep?(): Promise<void>;
}

interface StoredTicket extends SSETicketRecord {
  expiresAt: number;
}

interface StoredOwner {
  orgId: string;
  expiresAt: number;
}

/**
 * In-memory ticket store — the default. Correct for a single replica only;
 * mirrors the behavior the SSEManager previously implemented inline.
 */
export function createMemoryTicketStore(): SSETicketStore {
  const tickets = new Map<string, StoredTicket>();
  const owners = new Map<string, StoredOwner>();

  return {
    async put(ticketId, record, ttlMs) {
      tickets.set(ticketId, { ...record, expiresAt: Date.now() + ttlMs });
    },
    async consume(ticketId) {
      const t = tickets.get(ticketId);
      tickets.delete(ticketId); // single-use — remove whether or not valid
      if (!t || Date.now() > t.expiresAt) return null;
      return { orgId: t.orgId, requestId: t.requestId };
    },
    async countForOrg(orgId) {
      const now = Date.now();
      let n = 0;
      for (const t of tickets.values()) if (t.orgId === orgId && t.expiresAt > now) n++;
      return n;
    },
    async total() {
      const now = Date.now();
      let n = 0;
      for (const t of tickets.values()) if (t.expiresAt > now) n++;
      return n;
    },
    async bindStreamOwner(requestId, orgId, ttlMs) {
      owners.set(requestId, { orgId, expiresAt: Date.now() + ttlMs });
    },
    async getStreamOwner(requestId) {
      const o = owners.get(requestId);
      if (!o) return null;
      if (Date.now() > o.expiresAt) { owners.delete(requestId); return null; }
      return o.orgId;
    },
    async sweep() {
      const now = Date.now();
      for (const [id, t] of tickets) if (now > t.expiresAt) tickets.delete(id);
      for (const [id, o] of owners) if (now > o.expiresAt) owners.delete(id);
    },
  };
}

/**
 * Minimal ioredis surface the Redis ticket store needs. `set` takes the variadic
 * option tail (`EX <s>`); `zadd`/`zremrangebyscore`/`zcard` back the cap counters.
 */
export interface RedisTicketClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

const TICKET_PREFIX = 'sse:tkt:';
const ORG_ZSET_PREFIX = 'sse:tkt:org:';
const ALL_ZSET = 'sse:tkt:all';
const OWNER_PREFIX = 'sse:owner:';

/**
 * Redis-backed ticket store — required for multi-pod correctness. Tickets are
 * per-key with native TTL; cap counters are ZSETs scored by expiry (pruned on
 * read). Stream ownership is a per-subject key with its own TTL. All reads are
 * fail-safe (null / 0) so a Redis blip never wedges the stream.
 */
export function createRedisTicketStore(redis: RedisTicketClient): SSETicketStore {
  const tkey = (id: string): string => `${TICKET_PREFIX}${id}`;
  const orgKey = (orgId: string): string => `${ORG_ZSET_PREFIX}${orgId}`;
  const ownerKey = (requestId: string): string => `${OWNER_PREFIX}${requestId}`;
  const ttlSec = (ttlMs: number): number => Math.max(1, Math.ceil(ttlMs / 1000));

  return {
    async put(ticketId, record, ttlMs) {
      const expiresAt = Date.now() + ttlMs;
      const sec = ttlSec(ttlMs);
      try {
        await redis.set(tkey(ticketId), JSON.stringify(record), 'EX', sec);
        // Track for the caps. Score = expiry so pruning is a range delete.
        await redis.zadd(orgKey(record.orgId), expiresAt, ticketId);
        await redis.zadd(ALL_ZSET, expiresAt, ticketId);
        // Bound the per-org ZSET's own lifetime so an idle org's key can't leak.
        await redis.expire(orgKey(record.orgId), sec);
      } catch (err) {
        logger.warn('SSE ticket put failed', { error: err instanceof Error ? err.message : String(err) });
      }
    },
    async consume(ticketId) {
      try {
        const raw = await redis.get(tkey(ticketId));
        // Single-use: delete regardless. A concurrent double-redeem: at most one
        // saw a non-null value before the delete; the ZREM cleans the counters.
        await redis.del(tkey(ticketId));
        if (!raw) return null;
        const rec = JSON.parse(raw) as SSETicketRecord;
        await redis.zrem(orgKey(rec.orgId), ticketId);
        await redis.zrem(ALL_ZSET, ticketId);
        return rec;
      } catch (err) {
        logger.warn('SSE ticket consume failed', { error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
    async countForOrg(orgId) {
      try {
        await redis.zremrangebyscore(orgKey(orgId), 0, Date.now());
        return await redis.zcard(orgKey(orgId));
      } catch { return 0; }
    },
    async total() {
      try {
        await redis.zremrangebyscore(ALL_ZSET, 0, Date.now());
        return await redis.zcard(ALL_ZSET);
      } catch { return 0; }
    },
    async bindStreamOwner(requestId, orgId, ttlMs) {
      try {
        await redis.set(ownerKey(requestId), orgId, 'EX', ttlSec(ttlMs));
      } catch (err) {
        logger.warn('SSE stream-owner bind failed', { error: err instanceof Error ? err.message : String(err) });
      }
    },
    async getStreamOwner(requestId) {
      try {
        return await redis.get(ownerKey(requestId));
      } catch { return null; }
    },
  };
}

/**
 * Build a Redis-backed ticket store from the shared env Redis (same wiring as
 * the rate-limiter / audit-spool). Returns null when Redis isn't configured so
 * the caller keeps the in-memory default. Never throws.
 */
export function createEnvRedisTicketStore(): SSETicketStore | null {
  const client = createEnvRedisClient<RedisTicketClient>('sse-ticket');
  if (!client) return null;
  logger.info('Redis SSE ticket store initialized');
  return createRedisTicketStore(client);
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';

import { createEnvRedisClient } from './env-redis.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('sse-ticket-store');

/** Redis key namespaces. Ticket → orgId; windowed issue counters bound abuse. */
const TICKET_KEY_PREFIX = 'sse:tk:';
const ORG_COUNT_PREFIX = 'sse:tkc:';
const TOTAL_COUNT_KEY = 'sse:tkc:__all__';

/** Result of {@link SseTicketStore.issue}. */
export type SseTicketIssueResult =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'total' | 'org' };

/**
 * Store for short-lived, single-use SSE auth tickets. A client exchanges its JWT
 * for a ticket (so the token never lands in an EventSource query string / access
 * log), then redeems it on the SSE `GET`.
 *
 * The store is the multi-replica correctness boundary: a ticket minted on pod A
 * MUST be redeemable on pod B. The Redis backend makes that true; the in-memory
 * backend is a single-process fallback for dev / single-replica installs.
 */
export interface SseTicketStore {
  /** Mint a ticket for `orgId`, or reject when a rate window is saturated. */
  issue(orgId: string): Promise<SseTicketIssueResult>;
  /** Atomically redeem a ticket exactly once; returns its org or null if invalid/expired/spent. */
  consume(ticketId: string): Promise<{ orgId: string } | null>;
  /** Release timers/resources. In-memory clears its sweep interval; Redis is a no-op. */
  stop(): void;
}

/** Caps + TTL for the ticket store. */
export interface SseTicketStoreConfig {
  /** Ticket lifetime — long enough for the client to open the EventSource. */
  ttlMs: number;
  /** Hard cap on tickets minted per TTL window across all orgs (abuse bound). */
  maxTotal: number;
  /** Per-org cap on tickets minted per TTL window (single-tenant abuse bound). */
  maxPerOrg: number;
}

/** Minimal ioredis surface this store needs (GETDEL requires Redis ≥ 6.2). */
interface SseRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

function newTicketId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * In-memory backend — the original single-process behaviour. Counts LIVE
 * (unexpired) tickets per org and evicts expired entries on a timer. Correct
 * only within one process, so it is the fallback used when Redis isn't configured.
 */
function createInMemorySseTicketStore(config: SseTicketStoreConfig): SseTicketStore {
  interface Entry { orgId: string; expiresAt: number }
  const store = new Map<string, Entry>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, t] of store) if (now > t.expiresAt) store.delete(id);
  }, config.ttlMs);
  cleanup.unref();

  function countLiveForOrg(orgId: string, now: number): number {
    let count = 0;
    for (const t of store.values()) if (t.orgId === orgId && t.expiresAt > now) count++;
    return count;
  }

  return {
    async issue(orgId: string): Promise<SseTicketIssueResult> {
      const now = Date.now();
      if (store.size >= config.maxTotal) return { ok: false, reason: 'total' };
      if (countLiveForOrg(orgId, now) >= config.maxPerOrg) return { ok: false, reason: 'org' };
      const ticket = newTicketId();
      store.set(ticket, { orgId, expiresAt: now + config.ttlMs });
      return { ok: true, ticket };
    },
    async consume(ticketId: string): Promise<{ orgId: string } | null> {
      const t = store.get(ticketId);
      store.delete(ticketId); // single-use — consume immediately
      if (!t || Date.now() > t.expiresAt) return null;
      return { orgId: t.orgId };
    },
    stop(): void { clearInterval(cleanup); },
  };
}

/**
 * Redis backend — multi-replica safe. Tickets live under a TTL'd key so any pod
 * can redeem one; {@link SseTicketStore.consume} uses GETDEL so redemption is
 * atomic (two pods can't both spend the same ticket). The per-org / global caps
 * become windowed rate limits (max mints per TTL window) via INCR + first-hit
 * EXPIRE — equivalent abuse bounding to the in-memory live-count, and it also
 * caps churn.
 *
 * Fail-CLOSED by design (unlike the fail-open token-revocation reader): if Redis
 * errors, `issue` returns a cap rejection and `consume` returns null, so a Redis
 * outage degrades to "no live notifications" rather than handing out or
 * accepting unvalidated tickets. SSE notifications are non-critical, so failing
 * closed here costs only real-time delivery, never correctness.
 */
function createRedisSseTicketStore(redis: SseRedis, config: SseTicketStoreConfig): SseTicketStore {
  const ttlSec = Math.max(1, Math.ceil(config.ttlMs / 1000));

  // Windowed counter: INCR, and on the first hit of a window set the TTL so it
  // auto-resets. Returns true while still within `limit` for this window.
  async function withinWindow(key: string, limit: number): Promise<boolean> {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttlSec);
    return n <= limit;
  }

  return {
    async issue(orgId: string): Promise<SseTicketIssueResult> {
      try {
        if (!(await withinWindow(TOTAL_COUNT_KEY, config.maxTotal))) return { ok: false, reason: 'total' };
        if (!(await withinWindow(`${ORG_COUNT_PREFIX}${orgId}`, config.maxPerOrg))) return { ok: false, reason: 'org' };
        const ticket = newTicketId();
        await redis.set(`${TICKET_KEY_PREFIX}${ticket}`, orgId, 'EX', ttlSec);
        return { ok: true, ticket };
      } catch (err) {
        logger.warn('SSE ticket issue failed (fail-closed)', { error: err instanceof Error ? err.message : String(err) });
        return { ok: false, reason: 'total' };
      }
    },
    async consume(ticketId: string): Promise<{ orgId: string } | null> {
      try {
        const orgId = await redis.getdel(`${TICKET_KEY_PREFIX}${ticketId}`);
        return orgId ? { orgId } : null;
      } catch (err) {
        logger.warn('SSE ticket consume failed (fail-closed)', { error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
    stop(): void { /* Redis keys expire on their own TTL — nothing to release. */ },
  };
}

/**
 * Build an {@link SseTicketStore} from the standard Redis env (`REDIS_URL` or
 * `REDIS_HOST`/`REDIS_PORT`). Uses the Redis backend when configured
 * (multi-replica safe), otherwise falls back to the in-memory single-process
 * backend. A service opts in with one boot line:
 *   `const tickets = createEnvSseTicketStore({ ttlMs, maxTotal, maxPerOrg });`
 */
export function createEnvSseTicketStore(config: SseTicketStoreConfig): SseTicketStore {
  const redis = createEnvRedisClient<SseRedis>('sse-ticket');
  if (redis) {
    logger.info('SSE ticket store: Redis backend (multi-replica)');
    return createRedisSseTicketStore(redis, config);
  }
  logger.info('SSE ticket store: in-memory backend (single-process fallback)');
  return createInMemorySseTicketStore(config);
}

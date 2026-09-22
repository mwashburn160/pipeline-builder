// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';

import { createEnvRedisClient, createRedisReadyGate, type ReadyAwareRedis } from './env-redis.js';
import { envInt } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from '../utils/response.js';

const logger = createLogger('sse-ticket-store');

/** What a ticket authorizes: the owning org and, for subject-bound channels, the stream subject. */
export interface SseTicketRecord {
  orgId: string;
  /** Stream subject the ticket is bound to (e.g. a build-log requestId). Absent for org-keyed channels. */
  subject?: string;
}

/** Result of {@link SseTicketStore.issue}. */
export type SseTicketIssueResult =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'total' | 'org' };

/**
 * The ONE store for short-lived, single-use SSE auth tickets, plus the
 * stream-ownership bindings subject-bound channels need.
 *
 * A client exchanges its JWT for a ticket (so the token never lands in an
 * EventSource query string / access log), then redeems it on the SSE `GET`.
 *
 * - **Tickets** are single-use across pods: the Redis backend redeems with
 *   `GETDEL`, so two pods can never both spend one ticket.
 * - **Caps count LIVE tickets** (issued, not yet redeemed, not expired) — per org
 *   and in total. A redeemed or expired ticket frees its slot immediately.
 * - **Ownership** records which org owns a stream subject, so a subject-bound
 *   channel can refuse to mint a ticket for another org's stream.
 *
 * Both backends share these semantics; the in-memory one is correct for a
 * single process only.
 */
export interface SseTicketStore {
  /** Mint a ticket for `orgId` (optionally bound to `subject`), or reject when a live-ticket cap is reached. */
  issue(orgId: string, subject?: string): Promise<SseTicketIssueResult>;
  /** Redeem a ticket exactly once; null when unknown, expired or already spent. */
  consume(ticketId: string): Promise<SseTicketRecord | null>;
  /** Record the org that owns `subject` for `ttlMs`. */
  bindOwner(subject: string, orgId: string, ttlMs: number): Promise<void>;
  /** The org that owns `subject`, or null when none is bound. Throws when the backend can't answer. */
  getOwner(subject: string): Promise<string | null>;
  /** Release timers/resources. In-memory clears its sweep interval; Redis is a no-op. */
  stop(): void;
}

/** Caps + TTL for the ticket store. */
export interface SseTicketStoreConfig {
  /** Ticket lifetime — long enough for the client to open the EventSource. */
  ttlMs: number;
  /** Cap on LIVE tickets across all orgs (abuse / memory bound). */
  maxTotal: number;
  /** Cap on LIVE tickets per org (single-tenant fairness bound). */
  maxPerOrg: number;
  /**
   * Key namespace so independent channels (message notifications, reporting
   * execution-status, a service's build-log stream) never share tickets, caps
   * or ownership bindings — a ticket minted for one channel must not be
   * redeemable on another. Omit for the default namespace.
   */
  keyPrefix?: string;
}

function newTicketId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** In-memory backend — single-process fallback when Redis isn't configured. */
export function createMemorySseTicketStore(config: SseTicketStoreConfig): SseTicketStore {
  interface Entry extends SseTicketRecord { expiresAt: number }
  const tickets = new Map<string, Entry>();
  const owners = new Map<string, { orgId: string; expiresAt: number }>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [id, t] of tickets) if (now >= t.expiresAt) tickets.delete(id);
    for (const [id, o] of owners) if (now >= o.expiresAt) owners.delete(id);
  };
  const timer = setInterval(sweep, Math.max(1_000, config.ttlMs));
  timer.unref();

  return {
    async issue(orgId, subject) {
      sweep();
      if (tickets.size >= config.maxTotal) return { ok: false, reason: 'total' };
      let forOrg = 0;
      for (const t of tickets.values()) if (t.orgId === orgId) forOrg++;
      if (forOrg >= config.maxPerOrg) return { ok: false, reason: 'org' };
      const ticket = newTicketId();
      tickets.set(ticket, { orgId, ...(subject !== undefined && { subject }), expiresAt: Date.now() + config.ttlMs });
      return { ok: true, ticket };
    },
    async consume(ticketId) {
      const t = tickets.get(ticketId);
      tickets.delete(ticketId); // single-use — gone whether or not it was valid
      if (!t || Date.now() >= t.expiresAt) return null;
      return { orgId: t.orgId, ...(t.subject !== undefined && { subject: t.subject }) };
    },
    async bindOwner(subject, orgId, ttlMs) {
      owners.set(subject, { orgId, expiresAt: Date.now() + ttlMs });
    },
    async getOwner(subject) {
      const o = owners.get(subject);
      if (!o) return null;
      if (Date.now() >= o.expiresAt) { owners.delete(subject); return null; }
      return o.orgId;
    },
    stop() { clearInterval(timer); },
  };
}

/** Minimal ioredis surface the Redis backend needs (GETDEL requires Redis ≥ 6.2). */
export interface SseTicketRedis extends ReadyAwareRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  zrem(key: string, ...members: string[]): Promise<number>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/**
 * Atomic live-count issue. Prunes expired members from both cap sets, checks the
 * total then the per-org cap, and only then stores the ticket and records it in
 * both sets — so concurrent mints can't overshoot a cap and a cap can never
 * stick (every member carries its own expiry score and every key a TTL).
 *
 * KEYS: total zset, org zset, ticket key.
 * ARGV: ttlMs, maxTotal, maxPerOrg, ticketId, record JSON.
 * Uses the server clock so every pod agrees on "expired".
 */
const ISSUE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 'total' end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 'org' end
redis.call('SET', KEYS[3], ARGV[5], 'PX', ttl)
redis.call('ZADD', KEYS[1], now + ttl, ARGV[4])
redis.call('ZADD', KEYS[2], now + ttl, ARGV[4])
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
return 'ok'`;

/**
 * Redis backend — multi-replica safe.
 *
 * Fail-CLOSED: a Redis error makes `issue` reject (`total`), `consume` return
 * null and `getOwner` throw, so an outage degrades to "no live stream" rather
 * than handing out or accepting unvalidated tickets. `bindOwner` is best-effort.
 */
export function createRedisSseTicketStore(redis: SseTicketRedis, config: SseTicketStoreConfig): SseTicketStore {
  const ns = config.keyPrefix ? `${config.keyPrefix}:` : '';
  const ticketKey = (t: string) => `${ns}sse:tk:${t}`;
  const orgSetKey = (o: string) => `${ns}sse:tkz:org:${o}`;
  const totalSetKey = `${ns}sse:tkz:all`;
  const ownerKey = (s: string) => `${ns}sse:owner:${s}`;
  const ttlMs = Math.max(1, Math.ceil(config.ttlMs));
  // The env client has no offline queue: wait (bounded) for the first connection
  // so the first mint/redeem after boot isn't rejected outright.
  const ready = createRedisReadyGate(redis);

  return {
    async issue(orgId, subject) {
      try {
        await ready();
        const ticket = newTicketId();
        const record: SseTicketRecord = { orgId, ...(subject !== undefined && { subject }) };
        const outcome = await redis.eval(
          ISSUE_SCRIPT, 3, totalSetKey, orgSetKey(orgId), ticketKey(ticket),
          ttlMs, config.maxTotal, config.maxPerOrg, ticket, JSON.stringify(record),
        );
        if (outcome === 'ok') return { ok: true, ticket };
        return { ok: false, reason: outcome === 'org' ? 'org' : 'total' };
      } catch (err) {
        logger.warn('SSE ticket issue failed (fail-closed)', { error: errorMessage(err) });
        return { ok: false, reason: 'total' };
      }
    },
    async consume(ticketId) {
      try {
        await ready();
        const raw = await redis.getdel(ticketKey(ticketId));
        if (!raw) return null;
        const rec = JSON.parse(raw) as SseTicketRecord;
        if (typeof rec?.orgId !== 'string') return null;
        // Free the live-count slots now rather than at expiry. Best-effort: a
        // failure here only delays the slot until the member's expiry score.
        await Promise.all([redis.zrem(orgSetKey(rec.orgId), ticketId), redis.zrem(totalSetKey, ticketId)])
          .catch((err: unknown) => logger.debug('SSE ticket slot release failed', { error: errorMessage(err) }));
        return rec;
      } catch (err) {
        logger.warn('SSE ticket consume failed (fail-closed)', { error: errorMessage(err) });
        return null;
      }
    },
    async bindOwner(subject, orgId, ownerTtlMs) {
      try {
        await ready();
        await redis.set(ownerKey(subject), orgId, 'PX', Math.max(1, Math.ceil(ownerTtlMs)));
      } catch (err) {
        logger.warn('SSE stream-owner bind failed', { error: errorMessage(err) });
      }
    },
    async getOwner(subject) {
      await ready();
      return redis.get(ownerKey(subject));
    },
    stop() { /* keys expire on their own TTL */ },
  };
}

/**
 * The deploy-wide ticket caps: `SSE_MAX_TOTAL_TICKETS` (default 1000) and
 * `SSE_MAX_TICKETS_PER_ORG` (default 10). One reader so every channel parses
 * them the same way.
 */
export function envSseTicketCaps(): Pick<SseTicketStoreConfig, 'maxTotal' | 'maxPerOrg'> {
  return {
    maxTotal: envInt('SSE_MAX_TOTAL_TICKETS', 1000, { min: 1 }),
    maxPerOrg: envInt('SSE_MAX_TICKETS_PER_ORG', 10, { min: 1 }),
  };
}

/** {@link createEnvSseTicketStore} config: the caps default to {@link envSseTicketCaps}. */
export type EnvSseTicketStoreConfig = Omit<SseTicketStoreConfig, 'maxTotal' | 'maxPerOrg'>
  & Partial<Pick<SseTicketStoreConfig, 'maxTotal' | 'maxPerOrg'>>;

/**
 * Build an {@link SseTicketStore} from the standard Redis env (`REDIS_URL` or
 * `REDIS_SENTINELS`): the Redis backend when configured (multi-replica safe),
 * otherwise the in-memory single-process backend.
 */
export function createEnvSseTicketStore(options: EnvSseTicketStoreConfig): SseTicketStore {
  const caps = envSseTicketCaps();
  const config: SseTicketStoreConfig = {
    ...options,
    maxTotal: options.maxTotal ?? caps.maxTotal,
    maxPerOrg: options.maxPerOrg ?? caps.maxPerOrg,
  };
  const redis = createEnvRedisClient<SseTicketRedis>('sse-ticket');
  if (redis) {
    logger.info('SSE ticket store: Redis backend (multi-replica)', { keyPrefix: config.keyPrefix });
    return createRedisSseTicketStore(redis, config);
  }
  logger.info('SSE ticket store: in-memory backend (single-process fallback)', { keyPrefix: config.keyPrefix });
  return createMemorySseTicketStore(config);
}

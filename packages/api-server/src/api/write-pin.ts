// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-request write pin — read-after-write for a user's NEXT request.
 *
 * THE PROBLEM THIS SOLVES, which is the common case and not an edge case:
 * `POST /pipelines` returns, the page reloads, `GET /pipelines` runs. That GET
 * is a different request with no memory of the POST, so without something
 * carried between them it routes to a replica that may not have replayed the
 * commit, and the pipeline the user just created is simply missing. No error,
 * no retry, and not reproducible on demand.
 *
 * `tenancy.ts` already solves the WITHIN-a-request half: `withTenantTx` sets
 * `mayHaveWritten` on the request's tenant context, and the read helper keeps
 * that request on the primary afterwards. This module extends the same flag
 * ACROSS requests by remembering, in Redis, that an org wrote recently — and it
 * sets the very same `mayHaveWritten` flag, so there is one mechanism and one
 * code path, not two.
 *
 * WHY REDIS AND NOT AN LSN. The alternative is exact: capture
 * `pg_current_wal_lsn()` at commit, carry it with the client, and have the read
 * path wait for the standby to replay at least that far. It was rejected for
 * reasons that are about this system rather than about elegance:
 *
 *   1. Shared state is mandatory anyway — the app tier is 2 replicas wide on
 *      eks, so an in-process map misses every request that lands on the other
 *      pod. LSN tracking avoids shared state only by carrying the value on the
 *      CLIENT, and this product's own pitch is five ways in (dashboard, CLI,
 *      REST, CDK, AI). A CLI or CDK caller will not echo an LSN back, so that
 *      approach degrades to "primary for every non-browser client" or needs
 *      server-side storage — which is this, with extra steps.
 *   2. A client-supplied LSN is attacker-controlled input, and an unbounded
 *      wait on a replica that never catches up turns a bogus value into a hang.
 *      That is a denial of service wearing a correctness costume, and bounding
 *      it correctly is a second security surface to get right.
 *
 * The pin is COARSE and that is the accepted trade: it is keyed per ORG, not
 * per user, because a user may read through a different session than the one
 * that wrote. So one member's write briefly sends the whole org's reads to the
 * primary. That can only remove a benefit, never introduce a regression —
 * reading from the primary is exactly what happens today.
 *
 * FAIL CLOSED. No Redis configured, an unreachable Redis, or a failed read all
 * resolve to "assume this org wrote", which routes reads to the primary. That
 * is the same fail-closed-without-Redis posture the leader lock takes, and it
 * is the only safe direction: guessing "no recent write" when the answer is
 * unknown is how a user loses sight of their own data.
 *
 * COSTS NOTHING UNTIL READ-SPLITTING IS ON. Every entry point short-circuits
 * when no read replica is configured, so a deploy with `DB_READ_HOST` unset —
 * which is how all four targets ship — never touches Redis on the request path.
 */

import { createEnvRedisClient, createLogger, createRedisReadyGate, envInt, isReadReplicaConfigured } from '@pipeline-builder/api-core';
// TYPE-ONLY, and that is deliberate: a type import is erased at compile time, so
// it never touches pipeline-data's `stubModule` at runtime. A VALUE import here
// turned all 91 suites that stub that package into a 500.
import type { TenantContext } from '@pipeline-builder/pipeline-data';

const logger = createLogger('write-pin');

/**
 * How long a write keeps its org on the primary.
 *
 * Should sit comfortably above observed p99 replication lag. Ten seconds is
 * deliberately generous for a default: too short silently reintroduces the
 * missing-row bug, while too long only costs offload. The asymmetry says which
 * way to err.
 */
const ttlSeconds = () => envInt('DB_READ_WRITE_PIN_TTL_SECONDS', 10);

const key = (orgId: string) => `rw-pin:${orgId}`;

/**
 * The two ioredis calls this needs, plus the three members
 * `createRedisReadyGate` reads.
 *
 * Declared structurally rather than by extending api-core's `ReadyAwareRedis`,
 * which is internal to that package and not part of its public surface. The
 * readiness gate is not optional: the env client has no offline queue, so a
 * command issued before the first connection completes is rejected outright —
 * which would make the FIRST read of every pod fail closed to the primary.
 */
interface PinRedis {
  exists(key: string): Promise<number>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  status?: string;
  once?(event: string, cb: (...args: unknown[]) => void): unknown;
  off?(event: string, cb: (...args: unknown[]) => void): unknown;
}

export interface WritePinStore {
  /**
   * Has this org written recently? Returns TRUE when the answer is unknown
   * (no Redis, unreachable, read failed) — see FAIL CLOSED above.
   */
  isPinned(orgId: string | undefined): Promise<boolean>;
  /** Record that this org just wrote. Never throws. */
  pin(orgId: string | undefined): Promise<void>;
}

/** A store that reports nothing pinned — for tests and for single-process use. */
export const NO_WRITE_PIN: WritePinStore = {
  isPinned: () => Promise.resolve(false),
  pin: () => Promise.resolve(),
};

let store: WritePinStore | undefined;

/** Replace the store. For tests, and for a service that owns its own client. */
export function setWritePinStore(next: WritePinStore | undefined): void {
  store = next;
}

/**
 * The process-wide store, built on first use from `REDIS_URL` /
 * `REDIS_SENTINELS` exactly like the other env-Redis consumers here.
 */
export function getWritePinStore(): WritePinStore {
  if (!store) store = createEnvRedisWritePinStore();
  return store;
}

export function createEnvRedisWritePinStore(): WritePinStore {
  // undefined = not yet attempted; null = attempted and unavailable.
  let cached: PinRedis | null | undefined;
  let ready: (() => Promise<void>) | undefined;
  let warned = false;

  async function client(): Promise<PinRedis | null> {
    if (cached === undefined) {
      cached = createEnvRedisClient<PinRedis>('write-pin');
      if (cached) {
        logger.info('Redis write-pin store initialized', { ttlSeconds: ttlSeconds() });
        ready = createRedisReadyGate(cached);
      } else if (!warned) {
        warned = true;
        // Only worth saying when a replica actually exists: without one every
        // read goes to the primary regardless and the pin is irrelevant.
        logger.warn('No Redis configured for the read-after-write pin; every read will use the primary');
      }
    }
    if (ready) await ready();
    return cached;
  }

  return {
    async isPinned(orgId: string): Promise<boolean> {
      if (!orgId) return true; // no org to key on -> assume written
      try {
        const redis = await client();
        if (!redis) return true; // fail closed
        return (await redis.exists(key(orgId))) === 1;
      } catch (err) {
        logger.warn('Write-pin lookup failed; routing reads to the primary', {
          error: err instanceof Error ? err.message : String(err),
        });
        return true; // fail closed
      }
    },

    async pin(orgId: string | undefined): Promise<void> {
      // Nothing to key on, so nothing to pin. The read side fails closed for
      // the same scope anyway.
      if (!orgId) return;
      try {
        const redis = await client();
        if (!redis) return;
        await redis.set(key(orgId), '1', 'EX', ttlSeconds());
      } catch (err) {
        // A failed pin is the dangerous direction — the NEXT request may read a
        // stale replica — but there is nothing useful to do about it here, and
        // throwing would fail a request whose write already committed. Log it
        // loudly; `postgres_write_pin_errors_total` is the thing to alert on.
        logger.warn('Failed to set the read-after-write pin; a subsequent read may hit a stale replica', {
          orgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * Is the pin in play at all?
 *
 * False whenever no read replica is configured — which is how all four targets
 * ship. The middleware uses this as a hard gate so that with no replica it does
 * not register a response listener, does not touch Redis, and calls `next()`
 * SYNCHRONOUSLY, exactly as it did before any of this existed. Making the
 * request path asynchronous for a feature nobody has enabled would be a
 * behaviour change paid by every route on every target.
 */
export function writePinActive(): boolean {
  return isReadReplicaConfigured();
}

/**
 * Before the request runs: if this org wrote recently, pre-set the same
 * `mayHaveWritten` flag `withTenantTx` would have set, so the read helper keeps
 * the request on the primary.
 *
 * No-ops entirely when no replica is configured — which keeps Redis off the
 * request path for every deploy that has not enabled read-splitting.
 */
export async function applyWritePin(scope: TenantContext): Promise<void> {
  if (!isReadReplicaConfigured()) return;
  if (scope.mayHaveWritten) return; // already known to have written
  if (await getWritePinStore().isPinned(scope.orgId)) scope.mayHaveWritten = true;
}

/**
 * After the response: if anything in this request opened a primary transaction,
 * pin the org so its next request reads from the primary too.
 *
 * Reads `mayHaveWritten` rather than the HTTP method on purpose. A POST that
 * only validates has nothing to pin for, and — more importantly — a GET that
 * writes (a lazy backfill, a last-seen stamp) absolutely does. The flag follows
 * what actually touched the primary, which the method cannot tell you.
 */
export function recordWriteForPin(scope: TenantContext): void {
  if (!isReadReplicaConfigured()) return;
  if (!scope.mayHaveWritten) return;
  void getWritePinStore().pin(scope.orgId);
}

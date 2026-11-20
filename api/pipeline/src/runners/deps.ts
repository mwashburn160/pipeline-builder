// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Everything the runner subsystem touches outside its own logic — the runner
 * and key stores, the per-org signer cache, secret encryption, the clock,
 * outbound delivery (`safeFetch`), Redis (lock + rate limit + key-cache
 * invalidation), the dispatch queue, the org-hierarchy client and the
 * notification path — behind one injectable bundle. Production wiring is lazy (nothing connects at
 * import); tests replace any part with {@link setRunnerDepsForTesting} and
 * never touch the network.
 */

import { randomUUID } from 'node:crypto';
import {
  createEnvRedisClient,
  createLogger,
  errorMessage,
  fetchOrgDescendants,
  fetchOrgNames,
  fetchParentOrgId,
  incrWindow,
  MAX_ORG_DEPTH,
  recordAudit,
  safeFetch,
  sendSystemNotification,
  type RemoteAuditEvent,
  type SafeFetchResponse,
  type SystemNotification,
} from '@pipeline-builder/api-core';
import { RUNNER_KEY_CACHE_MS, RUNNER_KEY_METRICS, type RunnerKeyInvalidation, type RunnersUnavailableReason } from '@pipeline-builder/api-core/pipeline-runners';
import { incCounter, resetGauge, setGauge } from '@pipeline-builder/api-server';
import { encryptionReady, evictOrgKms, keySecrets, type KeySecrets } from './key-crypto.js';
import { keyInvalidationBus, type KeyInvalidationInput } from './key-invalidation.js';
import type { RunnerKeyStore } from './key-store.js';
import { createOrgSignerCache, type OrgSignerCache, type RunRequestSigner } from './signing.js';
import type { RunnerStore } from './store.js';

const logger = createLogger('pipeline-runners');

/** The push queue: one job per request, jobId = requestId. */
export interface DispatchQueue {
  enqueue(requestId: string, delayMs?: number): Promise<void>;
}

/** Per-pipeline delivery serialization (one delivery in flight per pipeline). */
export interface PipelineLock {
  acquire(pipelineId: string, ttlMs: number): Promise<string | null>;
  release(pipelineId: string, token: string): Promise<void>;
}

/** Fixed-window limiter: true when the hit is within `max` per `windowMs`. */
export interface RateLimiter {
  hit(key: string, max: number, windowMs: number): Promise<boolean>;
}

/** Org ancestry + names for team inheritance. */
export interface HierarchyClient {
  /** Ancestors of `orgId`, NEAREST first (the direct parent, then its parent, …). */
  ancestors(orgId: string, knownParent?: string): Promise<string[]>;
  /** Every descendant of `orgId` (all levels, without `orgId`); [] when it has none or the lookup fails. */
  descendants(orgId: string): Promise<string[]>;
  names(orgIds: string[]): Promise<Record<string, string>>;
}

/** Whether runners can be used at all right now, and why not. */
export interface RunnersAvailability {
  available: boolean;
  reason?: RunnersUnavailableReason;
}

/** The per-replica key caches (dropped on a pub/sub invalidation; see {@link applyKeyInvalidation}). */
export interface RunnerKeyCaches {
  signers: OrgSignerCache;
  /** Per-runner JWKS bodies: runnerId → owner org, keys and when they were read. */
  jwks: Map<string, { ownerOrgId: string; body: unknown; at: number }>;
  /** The pause toggle as last read (null = never read). */
  pause: { paused: boolean; at: number } | null;
  /** Orgs whose key failed to decrypt at the last attempt on this replica (the alert gauge). */
  unreadable: Set<string>;
}

export type SafeFetchFn = (url: string, opts: NonNullable<Parameters<typeof safeFetch>[1]>) => Promise<SafeFetchResponse>;

export interface RunnerDeps {
  /**
   * The signer for runners owned by `orgId` (the runner row's `org_id`): the
   * effective key org's active key. Throws RunnerRouteError RUNNER_KEY_MISSING
   * or RUNNER_KEY_UNREADABLE (that org only).
   */
  signerFor: (orgId: string) => Promise<RunRequestSigner>;
  /** Secret encryption set up, runner + key tables present, deliveries not paused. */
  runnersAvailable: () => Promise<RunnersAvailability>;
  /** The system-org pause toggle (cached; refreshed every 60 s or on a pub/sub message). */
  deliveriesPaused: () => Promise<boolean>;
  keyStore: RunnerKeyStore;
  secrets: KeySecrets;
  keyCaches: RunnerKeyCaches;
  /** Tell every replica (this one included) to drop cache entries, after a change COMMITS. */
  publishKeyInvalidation: (msg: KeyInvalidationInput) => void;
  store: RunnerStore;
  fetch: SafeFetchFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  queue: DispatchQueue;
  lock: PipelineLock;
  limiter: RateLimiter;
  hierarchy: HierarchyClient;
  notify: (n: SystemNotification) => Promise<boolean>;
  audit: (event: RemoteAuditEvent) => void;
  metrics: { inc(name: string, labels: Record<string, string>, value?: number): void; gauge(name: string, labels: Record<string, string>, value: number): void; resetGauge(name: string): void };
  newId: () => string;
}

// -- Redis-backed lock + limiter (fail-open to in-process) --------------------

interface LockRedisClient {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get?(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const RELEASE_IF_OWNER = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** A lock over Redis `SET NX PX`, or in-process when there is no Redis. */
export function createPipelineLock(redis: LockRedisClient | null, now: () => number = Date.now): PipelineLock {
  const local = new Map<string, { token: string; until: number }>();
  return {
    async acquire(pipelineId, ttlMs) {
      const token = randomUUID();
      if (redis) {
        try {
          return (await redis.set(`runner-dispatch:lock:${pipelineId}`, token, 'PX', ttlMs, 'NX')) === 'OK' ? token : null;
        } catch (err) {
          logger.warn('Runner dispatch lock unavailable; using the in-process lock', { error: errorMessage(err) });
        }
      }
      const held = local.get(pipelineId);
      if (held && held.until > now()) return null;
      local.set(pipelineId, { token, until: now() + ttlMs });
      return token;
    },
    async release(pipelineId, token) {
      if (redis) {
        try { await redis.eval(RELEASE_IF_OWNER, 1, `runner-dispatch:lock:${pipelineId}`, token); } catch { /* TTL is the backstop */ }
      }
      if (local.get(pipelineId)?.token === token) local.delete(pipelineId);
    },
  };
}

/** A limiter over api-core's atomic `incrWindow`; in-process without Redis; fails OPEN on a Redis error. */
export function createRateLimiter(redis: LockRedisClient | null, now: () => number = Date.now): RateLimiter {
  const local = new Map<string, { count: number; until: number }>();
  return {
    async hit(key, max, windowMs) {
      if (redis) {
        try {
          return (await incrWindow(redis, `runner-rate:${key}`, windowMs)) <= max;
        } catch (err) {
          logger.warn('Runner rate limit store unavailable; allowing', { error: errorMessage(err) });
          return true;
        }
      }
      const t = now();
      const w = local.get(key);
      if (!w || w.until <= t) {
        local.set(key, { count: 1, until: t + windowMs });
        return 1 <= max;
      }
      w.count += 1;
      return w.count <= max;
    },
  };
}

// -- Org hierarchy ---------------------------------------------------------------

/** Ancestry via platform's `/organization/:id/parent`, walked up (cycle- and depth-guarded). */
export function createHierarchyClient(): HierarchyClient {
  return {
    async ancestors(orgId, knownParent) {
      const out: string[] = [];
      const seen = new Set([orgId.toLowerCase()]);
      let next: string | undefined = knownParent;
      try {
        if (next === undefined) next = await fetchParentOrgId(orgId);
        while (next && !seen.has(next.toLowerCase()) && out.length < MAX_ORG_DEPTH) {
          out.push(next);
          seen.add(next.toLowerCase());
          next = await fetchParentOrgId(next);
        }
      } catch (err) {
        // Inheritance is additive: a failed lookup means fewer runners, never more.
        logger.warn('Org ancestry lookup failed; using what was resolved', { error: errorMessage(err) });
      }
      return out;
    },
    async descendants(orgId) {
      try {
        const ids = await fetchOrgDescendants(orgId);
        return (ids ?? []).filter((id) => id.toLowerCase() !== orgId.toLowerCase());
      } catch (err) {
        logger.warn('Org descendants lookup failed', { error: errorMessage(err) });
        return [];
      }
    },
    async names(orgIds) {
      try {
        return await fetchOrgNames(orgIds);
      } catch {
        return {};
      }
    },
  };
}

// -- The bundle ------------------------------------------------------------------

let redisClient: LockRedisClient | null | undefined;
const redis = (): LockRedisClient | null => {
  if (redisClient === undefined) redisClient = createEnvRedisClient<LockRedisClient>('runner-dispatch');
  return redisClient;
};

let queueImpl: DispatchQueue | undefined;
/** Install the push queue (the BullMQ adapter, at boot). Until then enqueue is a logged no-op. */
export function setDispatchQueue(queue: DispatchQueue): void { queueImpl = queue; }

/**
 * The Drizzle store, loaded on first USE: importing the runner modules (as the
 * execution and registry routes do) must not touch pipeline-data's runner
 * tables before the first runner request.
 */
function lazyDrizzleStore(): RunnerStore {
  let real: Promise<RunnerStore> | undefined;
  const load = () => (real ??= import('./store.js').then((m) => m.createDrizzleRunnerStore()));
  return new Proxy({} as RunnerStore, {
    get: (_t, prop: string) => async (...args: unknown[]) => {
      const store = await load();
      return (store[prop as keyof RunnerStore] as (...a: unknown[]) => unknown)(...args);
    },
  });
}

/** The key store, loaded on first use (like the runner store). */
function lazyKeyStore(): RunnerKeyStore {
  let real: Promise<RunnerKeyStore> | undefined;
  const load = () => (real ??= import('./key-store.js').then((m) => m.createDrizzleKeyStore()));
  return new Proxy({} as RunnerKeyStore, {
    get: (_t, prop: string) => async (...args: unknown[]) => {
      const store = await load();
      return (store[prop as keyof RunnerKeyStore] as (...a: unknown[]) => unknown)(...args);
    },
  });
}

/**
 * The key parts of a bundle over `get` (the bundle they end up in): the signer
 * cache, availability and the pause cache. Shared by production and tests.
 */
export function createKeyDeps(get: () => RunnerDeps, opts: { encryptionReady?: () => boolean } = {}): Pick<RunnerDeps, 'signerFor' | 'runnersAvailable' | 'deliveriesPaused' | 'keyCaches'> {
  const ready = opts.encryptionReady ?? encryptionReady;
  const keyCaches: RunnerKeyCaches = {
    signers: createOrgSignerCache({
      resolve: async (orgId) => (await import('./keys.js')).buildOrgSigner(get(), orgId),
      version: (orgIds) => get().keyStore.version(orgIds),
      now: () => get().now(),
      onInvalidate: (source) => get().metrics.inc(RUNNER_KEY_METRICS.invalidations, { source }),
    }),
    jwks: new Map(),
    pause: null,
    unreadable: new Set(),
  };
  const deliveriesPaused = async (): Promise<boolean> => {
    const d = get();
    const cached = keyCaches.pause;
    if (cached && d.now() - cached.at < RUNNER_KEY_CACHE_MS) return cached.paused;
    try {
      const row = await d.keyStore.getPause();
      keyCaches.pause = { paused: !!row?.deliveriesPaused, at: d.now() };
    } catch (err) {
      // Keep the last answer; with none, fail closed (paused) until the row can be read.
      logger.warn('Runner pause toggle unreadable', { error: errorMessage(err) });
      return cached?.paused ?? true;
    }
    return keyCaches.pause.paused;
  };
  return {
    keyCaches,
    signerFor: (orgId) => keyCaches.signers.signerFor(orgId),
    deliveriesPaused,
    async runnersAvailable() {
      const d = get();
      if (!ready()) return { available: false, reason: 'encryption_not_configured' };
      if (!(await runnerTablesPresent(d))) return { available: false, reason: 'tables_missing' };
      if (await deliveriesPaused()) return { available: false, reason: 'paused' };
      return { available: true };
    },
  };
}

/**
 * Apply one invalidation message to a bundle's caches: `keys` drops the signer
 * and JWKS entries of the named runner-owning orgs (and any cached per-org KMS
 * master); `pause` forgets the pause toggle so the next read re-reads it.
 */
export function applyKeyInvalidation(deps: Pick<RunnerDeps, 'keyCaches'>, msg: RunnerKeyInvalidation): void {
  if (msg.kind === 'pause') {
    deps.keyCaches.pause = null;
    return;
  }
  const orgs = new Set(msg.orgIds.map((o) => o.toLowerCase()));
  deps.keyCaches.signers.invalidate([...orgs], 'pubsub');
  for (const [runnerId, entry] of deps.keyCaches.jwks) if (orgs.has(entry.ownerOrgId)) deps.keyCaches.jwks.delete(runnerId);
  for (const o of orgs) evictOrgKms(o);
}

/** A (re)subscribe: messages may have been missed, so drop everything. */
export function resyncKeyCaches(deps: Pick<RunnerDeps, 'keyCaches'>): void {
  deps.keyCaches.signers.clear();
  deps.keyCaches.jwks.clear();
  deps.keyCaches.pause = null;
}

/** Subscribe this process's bundle to the invalidation channel (once, at startup). */
export function startKeyInvalidation(): void {
  keyInvalidationBus().subscribe((m) => applyKeyInvalidation(runnerDeps(), m), () => resyncKeyCaches(runnerDeps()));
}

function defaultDeps(): RunnerDeps {
  const now = Date.now;
  const keyParts = createKeyDeps(() => runnerDeps());
  return {
    ...keyParts,
    keyStore: lazyKeyStore(),
    secrets: keySecrets(),
    publishKeyInvalidation: (msg) => keyInvalidationBus().publish(msg),
    store: lazyDrizzleStore(),
    fetch: safeFetch,
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    queue: {
      async enqueue(requestId, delayMs) {
        if (queueImpl) return queueImpl.enqueue(requestId, delayMs);
        logger.warn('Runner dispatch queue not started; request stays queued until the sweep', { requestId });
      },
    },
    lock: createPipelineLock(redis(), now),
    limiter: createRateLimiter(redis(), now),
    hierarchy: createHierarchyClient(),
    notify: (n) => sendSystemNotification(n),
    audit: (e) => recordAudit(e),
    metrics: { inc: (n, l, v) => incCounter(n, l, v), gauge: (n, l, v) => setGauge(n, l, v), resetGauge: (n) => resetGauge(n) },
    newId: () => randomUUID(),
  };
}

let current: RunnerDeps | undefined;

/** The process's runner dependencies (built on first use). */
export function runnerDeps(): RunnerDeps {
  if (!current) current = defaultDeps();
  return current;
}

/** Replace parts of the bundle (tests). `null` resets to production wiring. */
export function setRunnerDepsForTesting(overrides: Partial<RunnerDeps> | null): RunnerDeps | undefined {
  if (overrides === null) {
    current = undefined;
    return undefined;
  }
  current = { ...(current ?? defaultDeps()), ...overrides };
  return current;
}

let tablesWarned = false;

/**
 * Whether this database has the runner tables. One created before runners
 * (postgres-init.sql runs on new installs only) does not: runners are then
 * unavailable — said once in the log, never a 500.
 */
export async function runnerTablesPresent(deps: RunnerDeps): Promise<boolean> {
  const present = (await deps.store.tablesPresent().catch(() => false)) && (await deps.keyStore.tablesPresent().catch(() => false));
  if (!present && !tablesWarned) {
    tablesWarned = true;
    logger.warn('The runner tables (pipeline_runners, pipeline_run_requests, pipeline_runner_signing_keys, pipeline_runner_key_settings, pipeline_runner_platform_settings) are missing; pipeline runners are unavailable until the operator creates them');
  }
  return present;
}

/** Runners usable right now (encryption set up, tables present, not paused). */
export async function runnersReady(deps?: RunnerDeps): Promise<boolean> {
  return (await (deps ?? runnerDeps()).runnersAvailable()).available;
}

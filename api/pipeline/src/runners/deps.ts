// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Everything the runner subsystem touches outside its own logic — the store,
 * the signer, the clock, outbound delivery (`safeFetch`), Redis (lock + rate
 * limit), the dispatch queue, the org-hierarchy client and the notification
 * path —
 * behind one injectable bundle. Production wiring is lazy (nothing connects at
 * import); tests replace any part with {@link setRunnerDepsForTesting} and
 * never touch the network.
 */

import { randomUUID } from 'node:crypto';
import {
  createEnvRedisClient,
  createLogger,
  errorMessage,
  fetchOrgFeatures,
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
import { RUNNER_FEATURE } from '@pipeline-builder/api-core/pipeline-runners';
import { incCounter, setGauge } from '@pipeline-builder/api-server';
import { loadRunnerSigner, runnerSigningKeyConfigured, type RunRequestSigner } from './signing.js';
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
  names(orgIds: string[]): Promise<Record<string, string>>;
}

export type SafeFetchFn = (url: string, opts: NonNullable<Parameters<typeof safeFetch>[1]>) => Promise<SafeFetchResponse>;

export interface RunnerDeps {
  /**
   * Whether `orgId` still holds the `cross_account_runners` feature, as last
   * seen on one of its own authenticated requests (`noteOrgFeature`). Unknown
   * → true: every request was created by a principal that held it.
   */
  orgEnabled: (orgId: string) => Promise<boolean>;
  noteOrgFeature: (orgId: string, has: boolean) => Promise<void>;
  signer: () => RunRequestSigner | null;
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
  metrics: { inc(name: string, labels: Record<string, string>): void; gauge(name: string, labels: Record<string, string>, value: number): void };
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

let signerCache: { value: RunRequestSigner | null } | undefined;
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
 * tables at all while the feature is off.
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

function defaultDeps(): RunnerDeps {
  const now = Date.now;
  return {
    ...orgFeatureCache(redis(), undefined, async (orgId) => (await fetchOrgFeatures(orgId)).includes(RUNNER_FEATURE)),
    signer: () => {
      if (!signerCache) signerCache = { value: loadRunnerSigner() };
      return signerCache.value;
    },
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
    metrics: { inc: (n, l) => incCounter(n, l), gauge: (n, l, v) => setGauge(n, l, v) },
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
    signerCache = undefined;
    return undefined;
  }
  current = { ...(current ?? defaultDeps()), ...overrides };
  return current;
}

/**
 * The DEPLOYMENT can use runners: a signing key loaded. (Per org: the
 * `cross_account_runners` feature — see {@link principalHasRunnerFeature}.)
 */
export function runnersAvailable(deps?: RunnerDeps): boolean {
  // No key configured and nothing injected: answer without building any
  // wiring, so a deployment without runners touches nothing new.
  if (!deps && !current && !runnerSigningKeyConfigured()) return false;
  const d = deps ?? runnerDeps();
  return d.signer() !== null;
}

/** The same value is re-written to Redis at most this often (per org, per replica). */
const FEATURE_REWRITE_MS = 60_000;

/**
 * The per-org feature state, shared across replicas through Redis (in-process
 * without it). Recorded from the org's own authenticated requests; read by the
 * dispatcher and the sweep, which run outside any request. A MISS (never seen,
 * or the Redis entry expired) asks `resolve` — the org's real entitlement — and
 * caches the answer; only a failed lookup (or no resolver) reads as enabled.
 * A repeated note of an unchanged value skips the Redis write for a minute.
 */
export function orgFeatureCache(
  store: { set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>; get?(key: string): Promise<string | null> } | null,
  ttlSeconds = 24 * 3600,
  resolve?: (orgId: string) => Promise<boolean>,
  now: () => number = Date.now,
) {
  const local = new Map<string, boolean>();
  const written = new Map<string, { value: boolean; at: number }>();
  const key = (orgId: string) => `runner-org-feature:${orgId.toLowerCase()}`;
  const noteOrgFeature = async (orgId: string, has: boolean): Promise<void> => {
    const k = orgId.toLowerCase();
    local.set(k, has);
    if (!store) return;
    const last = written.get(k);
    if (last && last.value === has && now() - last.at < FEATURE_REWRITE_MS) return;
    try {
      await store.set(key(orgId), has ? '1' : '0', 'EX', ttlSeconds);
      written.set(k, { value: has, at: now() });
    } catch { /* best effort */ }
  };
  return {
    async orgEnabled(orgId: string): Promise<boolean> {
      if (store?.get) {
        try {
          const v = await store.get(key(orgId));
          if (v === '0') return false;
          if (v === '1') return true;
        } catch { /* fall through to the local view */ }
      }
      const seen = local.get(orgId.toLowerCase());
      if (seen !== undefined) return seen;
      if (!resolve) return true;
      try {
        const has = await resolve(orgId);
        await noteOrgFeature(orgId, has);
        return has;
      } catch (err) {
        logger.warn('Org feature lookup failed; treating the org as enabled', { orgId, error: errorMessage(err) });
        return true;
      }
    },
    noteOrgFeature,
  };
}

let tablesWarned = false;

/**
 * Whether this database has the runner tables. One created before runners
 * (postgres-init.sql runs on new installs only) does not: runners are then
 * unavailable — said once in the log, never a 500.
 */
export async function runnerTablesPresent(deps: RunnerDeps): Promise<boolean> {
  const present = await deps.store.tablesPresent().catch(() => false);
  if (!present && !tablesWarned) {
    tablesWarned = true;
    logger.warn('Runner signing key configured but the runner tables (pipeline_runners, pipeline_run_requests) are missing; cross-account runners are unavailable until the operator creates them');
  }
  return present;
}

/** Runners usable right now: a signing key loaded AND the runner tables present. */
export async function runnersReady(deps?: RunnerDeps): Promise<boolean> {
  if (!runnersAvailable(deps)) return false;
  return runnerTablesPresent(deps ?? runnerDeps());
}

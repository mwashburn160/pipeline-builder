// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org registry storage, measured in the BACKGROUND and read from a snapshot.
 *
 * Why: measuring one org on demand walked the whole registry catalog (an
 * object-store listing — minutes on RustFS/S3), then every tag, manifest and
 * blob, one call at a time. It could not finish inside a request deadline, so
 * the quota service's reads timed out (tripping its S2S breaker) and a capped
 * org's push gate could never prove the org was under budget.
 *
 * Now ONE leader-locked job walks the catalog once per interval, measures every
 * org with the same scan the gate always used ({@link scanRepositories}: the
 * org's `org-<id>/*` namespace plus the `public/*` repositories billed to it,
 * blobs deduplicated), and stores each org's total. Reads are a key lookup.
 *
 * Fail-closed is preserved:
 *   - No snapshot yet, or the last COMPLETED run is older than
 *     {@link maxSnapshotAgeMs} → the reading is `incomplete` (unknown), which the
 *     push gate refuses on and the usage route answers 503 for. There is no
 *     fallback to an on-demand scan: that is the path that cannot finish.
 *   - The run marker (`meta`) is written LAST, so a run that dies part-way never
 *     makes its partial results look current.
 *   - An org whose own scan was incomplete is stored as incomplete.
 *
 * One walk per interval fleet-wide: the lock stops overlapping runs, and a
 * cycle that finds a run started within {@link RECENT_RUN_FRACTION} of the
 * interval skips ({@link runStorageSnapshotCycle}). Orgs are scanned several at
 * a time with at most `REGISTRY_STORAGE_SCAN_CONCURRENCY` registry calls in
 * flight for the whole run, so run time (and with it the freshness window)
 * does not grow with the sum of every call's latency.
 *
 * Freshness: a new push is counted at the next run (the interval). A delete or
 * prune re-measures that org's known repositories straight away
 * ({@link refreshOrgSnapshot}), so freed bytes show without waiting.
 */

import {
  createEnvRedisClient,
  createEnvRedisLock,
  createLogger,
  createScheduler,
  DEFAULT_LEADER_LOCK_TTL_MS,
  envInt,
  errorMessage,
  leaderLockKey,
  type Scheduler,
} from '@pipeline-builder/api-core';
import { incCounter, observe, setGauge } from '@pipeline-builder/api-server';
import { createLimiter, mapWithConcurrency } from './concurrency.js';
import { readPublicationOwners } from './public-publications.js';
import { listRepositoriesUnderPrefix } from './registry-client.js';
import {
  newScanTimings,
  onOrgStorageInvalidated,
  scanRepositories,
  storageScanConcurrency,
  type StorageUsage,
} from './storage-usage.js';

const logger = createLogger('storage-snapshot');

const KEY_PREFIX = 'image-registry:storage-snapshot:';
const META_KEY = `${KEY_PREFIX}meta`;
const orgKey = (orgId: string): string => `${KEY_PREFIX}org:${orgId}`;
/** Records outlive any freshness window by far; the expiry only drops departed orgs. */
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;

const LOCK_KEY = leaderLockKey('image-registry', 'storage-snapshot');

/** Histogram: seconds a snapshot run spent per phase (`phase=total` is the whole run). */
export const SNAPSHOT_PHASE_HISTOGRAM = 'registry_storage_snapshot_phase_seconds';
/**
 * Counter: snapshot reads by outcome (`fresh`, `stale`, `missing`), plus the
 * scheduled cycles that found a recent run and skipped (`skipped_recent`).
 */
export const SNAPSHOT_READS_COUNTER = 'registry_storage_snapshot_reads_total';
/**
 * Gauge: epoch seconds the last COMPLETED run (on any pod) finished. Every pod
 * republishes it from the stored marker — the leader as it writes, the others
 * each cycle — so `max()` over the fleet reads the true age wherever it is
 * scraped. Alerted by `RegistryStorageSnapshotStale`.
 */
export const SNAPSHOT_LAST_SUCCESS_GAUGE = 'registry_storage_snapshot_last_success_timestamp_seconds';
/** Gauge: the interval (seconds) the last completed run was scheduled at; the stale alert's yardstick. */
export const SNAPSHOT_INTERVAL_GAUGE = 'registry_storage_snapshot_interval_seconds';

/**
 * A scheduled cycle skips when the stored marker shows a run started within
 * this fraction of the interval. The lock only stops two runs OVERLAPPING; it
 * is released after each run, so without this every pod's timer could start
 * another full walk inside the same interval. Under 1 so ordinary timer jitter
 * never skips a run that is due.
 */
export const RECENT_RUN_FRACTION = 0.9;

/** The marker of the last COMPLETED run. */
export interface SnapshotMeta {
  /** When the run started (epoch ms). Org records carry the run that wrote them. */
  runId: number;
  completedAt: number;
  durationMs: number;
  /** The leader's configured interval, so readers judge age against what actually runs. */
  intervalMs: number;
  orgs: number;
}

/** One org's measurement. */
interface OrgRecord {
  /** The run (or refresh) start time that produced it; see {@link readOrgStorageUsage}. */
  runId: number;
  bytes: number;
  blobs: number;
  /** The repositories measured — what a targeted refresh re-scans. */
  repos: string[];
  computedAt: number;
  incomplete: boolean;
  /** False when publication records were unreadable during the run (scope may be short). */
  recordsComplete: boolean;
}

/** Key/value store the snapshot lives in: Redis when configured, else this process. */
export interface SnapshotStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

interface RedisKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

function createStore(): SnapshotStore {
  const redis = createEnvRedisClient<RedisKv>('storage-snapshot');
  if (redis) {
    return {
      get: (key) => redis.get(key),
      set: async (key, value, ttlSeconds) => { await redis.set(key, value, 'EX', ttlSeconds); },
    };
  }
  // No Redis: each pod runs the (then unlocked) job and keeps its own copy.
  logger.info('Redis not configured — storage snapshot kept in process memory');
  const mem = new Map<string, { value: string; expires: number }>();
  return {
    get: async (key) => {
      const hit = mem.get(key);
      if (!hit || hit.expires < Date.now()) return null;
      return hit.value;
    },
    set: async (key, value, ttlSeconds) => { mem.set(key, { value, expires: Date.now() + ttlSeconds * 1000 }); },
  };
}

let store: SnapshotStore | null = null;
const getStore = (): SnapshotStore => (store ??= createStore());

/** Tests: swap the backing store (null → recreate from env on next use). */
export function setSnapshotStoreForTests(next: SnapshotStore | null): void {
  store = next;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Publish the fleet's liveness gauges from a run marker. */
function publishSnapshotGauges(meta: SnapshotMeta): void {
  setGauge(SNAPSHOT_LAST_SUCCESS_GAUGE, {}, meta.completedAt / 1000);
  setGauge(SNAPSHOT_INTERVAL_GAUGE, {}, meta.intervalMs / 1000);
}

/**
 * Republish the stored marker's gauges on a pod that did not run this cycle,
 * so dashboards and the stale alert read the fleet's last success from any
 * replica. No marker yet → nothing to publish. Never throws.
 */
export async function republishSnapshotGauges(): Promise<void> {
  try {
    const meta = parse<SnapshotMeta>(await getStore().get(META_KEY));
    if (meta) publishSnapshotGauges(meta);
  } catch (err) {
    logger.warn('Storage snapshot marker unreadable — gauges not republished', { error: errorMessage(err) });
  }
}

/**
 * How old the last completed run may be before readings are unknown: two
 * intervals plus that run's own duration — one missed run is tolerated, a
 * second is not. Derived from measured run time rather than fixed, so a
 * registry that grows (and scans slower) does not start failing reads.
 */
export function maxSnapshotAgeMs(meta: Pick<SnapshotMeta, 'intervalMs' | 'durationMs'>): number {
  return 2 * meta.intervalMs + meta.durationMs;
}

/**
 * One org's storage from the snapshot. Same shape the on-demand rollup had;
 * `incomplete: true` means "unknown" — no snapshot, a stale one, or an org
 * whose own measurement was incomplete. Throws when the store is unreachable
 * (callers already treat a throw as unknown).
 */
export async function readOrgStorageUsage(orgId: string): Promise<StorageUsage> {
  const id = orgId.toLowerCase();
  const prefix = `org-${id}/`;
  const s = getStore();
  const [metaRaw, recordRaw] = await Promise.all([s.get(META_KEY), s.get(orgKey(id))]);
  const meta = parse<SnapshotMeta>(metaRaw);
  if (!meta) {
    incCounter(SNAPSHOT_READS_COUNTER, { outcome: 'missing' });
    return { prefix, bytes: 0, repos: 0, blobs: 0, computedAt: 0, incomplete: true };
  }
  if (Date.now() - meta.completedAt > maxSnapshotAgeMs(meta)) {
    incCounter(SNAPSHOT_READS_COUNTER, { outcome: 'stale' });
    logger.warn('Storage snapshot is stale — reading as unknown', {
      orgId: id, completedAt: new Date(meta.completedAt).toISOString(), maxAgeMs: maxSnapshotAgeMs(meta),
    });
    return { prefix, bytes: 0, repos: 0, blobs: 0, computedAt: meta.completedAt, incomplete: true };
  }
  incCounter(SNAPSHOT_READS_COUNTER, { outcome: 'fresh' });
  const record = parse<OrgRecord>(recordRaw);
  // Every org the last completed run found was written BEFORE its marker, so a
  // record older than that run (or none) means the run found nothing for it.
  if (!record || record.runId < meta.runId) {
    return { prefix, bytes: 0, repos: 0, blobs: 0, computedAt: meta.completedAt, incomplete: false };
  }
  return {
    prefix,
    bytes: record.bytes,
    repos: record.repos.length,
    blobs: record.blobs,
    computedAt: record.computedAt,
    incomplete: record.incomplete,
  };
}

/**
 * One full snapshot run. Walks the catalog ONCE, reads the publication records
 * from that same listing, measures every org, writes each org's record, then
 * the run marker. Returns the marker, or null when `signal` aborted the run
 * (lock lost / shutdown) — nothing is marked current in that case.
 *
 * Throws when the catalog cannot be listed, so the scheduler records no
 * success and SchedulerJobStale can fire.
 */
export async function runStorageSnapshot(opts: { intervalMs: number; signal?: AbortSignal }): Promise<SnapshotMeta | null> {
  const { intervalMs, signal } = opts;
  const runId = Date.now();
  const timings = newScanTimings();

  let t = Date.now();
  const catalog = await listRepositoriesUnderPrefix('');
  const catalogMs = Date.now() - t;

  t = Date.now();
  let owners = new Map<string, string | null>();
  let recordsComplete = true;
  try {
    const read = await readPublicationOwners({ force: true, catalog });
    owners = read.owners;
    recordsComplete = read.complete;
  } catch (err) {
    recordsComplete = false;
    logger.warn('Publication records unreadable during storage snapshot', { error: errorMessage(err) });
  }
  const recordsMs = Date.now() - t;

  // Scope per org — identical to the on-demand rollup it replaces: its own
  // `org-<id>/*` repos, then the `public/*` repos billed to it. `quarantine/*`
  // and every other namespace belong to no org and are never added.
  const orgRepos = new Map<string, string[]>();
  const add = (orgId: string, repo: string): void => {
    const list = orgRepos.get(orgId);
    if (list) list.push(repo);
    else orgRepos.set(orgId, [repo]);
  };
  for (const repo of catalog) {
    const m = /^org-([^/]+)\//.exec(repo);
    if (m) add(m[1]!.toLowerCase(), repo);
  }
  for (const [publicRepo, owner] of owners) {
    if (owner) add(owner.toLowerCase(), publicRepo);
  }

  const s = getStore();
  const perOrgMs: Array<{ orgId: string; ms: number; repos: number }> = [];
  let incompleteOrgs = 0;
  // Several orgs at once, and ONE cap on registry calls for the whole run: each
  // org's scan is itself concurrent, so without the shared limiter the run
  // would keep orgs × per-scan calls in flight.
  const concurrency = storageScanConcurrency();
  const limiter = createLimiter(concurrency);
  await mapWithConcurrency([...orgRepos], concurrency, async ([orgId, repos]) => {
    if (signal?.aborted) return;
    const orgStart = Date.now();
    const scan = await scanRepositories(repos, { timings, limiter });
    if (signal?.aborted) return;
    const incomplete = scan.incomplete || !recordsComplete;
    if (incomplete) incompleteOrgs++;
    const record: OrgRecord = {
      runId, bytes: scan.bytes, blobs: scan.blobs, repos, computedAt: Date.now(), incomplete, recordsComplete,
    };
    await s.set(orgKey(orgId), JSON.stringify(record), RECORD_TTL_SECONDS);
    perOrgMs.push({ orgId, ms: Date.now() - orgStart, repos: repos.length });
  });
  if (signal?.aborted) {
    logger.info('Storage snapshot run aborted — not marking it current', { reason: String(signal.reason ?? '') });
    return null;
  }

  const completedAt = Date.now();
  const meta: SnapshotMeta = { runId, completedAt, durationMs: completedAt - runId, intervalMs, orgs: orgRepos.size };
  await s.set(META_KEY, JSON.stringify(meta), RECORD_TTL_SECONDS);
  publishSnapshotGauges(meta);

  const phases: Record<string, number> = {
    catalog: catalogMs,
    publication_records: recordsMs,
    tags: timings.tagsMs,
    manifests: timings.manifestsMs,
    blob_heads: timings.blobHeadsMs,
    total: meta.durationMs,
  };
  for (const [phase, ms] of Object.entries(phases)) observe(SNAPSHOT_PHASE_HISTOGRAM, { phase }, ms / 1000);
  logger.info('Storage snapshot complete', {
    orgs: meta.orgs,
    incompleteOrgs,
    catalogRepos: catalog.length,
    recordsComplete,
    phaseMs: phases,
    slowestOrgs: perOrgMs.sort((a, b) => b.ms - a.ms).slice(0, 5),
  });
  return meta;
}

/** What one scheduled cycle did. */
export type SnapshotCycleOutcome = 'ran' | 'skipped_recent' | 'aborted';

/**
 * One scheduled cycle: skip when the stored marker shows a run (by any pod)
 * started within {@link RECENT_RUN_FRACTION} of `intervalMs` — republishing
 * its gauges so this pod's dashboards stay populated — else run a full
 * snapshot. Throws whatever {@link runStorageSnapshot} throws.
 */
export async function runStorageSnapshotCycle(opts: { intervalMs: number; signal?: AbortSignal }): Promise<SnapshotCycleOutcome> {
  const meta = parse<SnapshotMeta>(await getStore().get(META_KEY));
  // `runId` is the run's start, so this also covers a run that completed
  // recently; judging by completion instead would push every run out by the
  // previous run's duration.
  if (meta && Date.now() - meta.runId < RECENT_RUN_FRACTION * opts.intervalMs) {
    incCounter(SNAPSHOT_READS_COUNTER, { outcome: 'skipped_recent' });
    publishSnapshotGauges(meta);
    logger.debug('Storage snapshot cycle skipped — a run started recently', {
      runId: new Date(meta.runId).toISOString(), intervalMs: opts.intervalMs,
    });
    return 'skipped_recent';
  }
  return (await runStorageSnapshot(opts)) ? 'ran' : 'aborted';
}

/** In-flight targeted refreshes, one per org; `again` coalesces a burst into one re-run. */
const refreshing = new Map<string, { promise: Promise<void>; again: boolean }>();

async function refreshOnce(orgId: string): Promise<void> {
  const s = getStore();
  const record = parse<OrgRecord>(await s.get(orgKey(orgId)));
  // Nothing measured for it yet — the next full run will.
  if (!record) return;
  const startedAt = Date.now();
  const scan = await scanRepositories(record.repos);
  // A full run that started after this refresh has newer figures: keep them.
  const current = parse<OrgRecord>(await s.get(orgKey(orgId)));
  if (current && current.runId > startedAt) return;
  const next: OrgRecord = {
    ...record,
    // The refresh measured the org at or after `startedAt`, so it is at least as
    // current as any run that started before it.
    runId: startedAt,
    bytes: scan.bytes,
    blobs: scan.blobs,
    computedAt: Date.now(),
    incomplete: scan.incomplete || !record.recordsComplete,
  };
  await s.set(orgKey(orgId), JSON.stringify(next), RECORD_TTL_SECONDS);
  logger.info('Storage snapshot refreshed for org', { orgId, bytes: next.bytes, incomplete: next.incomplete, ms: Date.now() - startedAt });
}

/**
 * Re-measure one org's known repositories now (after a delete / prune), so
 * freed bytes show before the next full run. Repositories new since the last
 * run are not known here; the next full run picks them up. Never throws.
 */
export function refreshOrgSnapshot(orgId: string): Promise<void> {
  const id = orgId.toLowerCase();
  const inflight = refreshing.get(id);
  if (inflight) {
    inflight.again = true;
    return inflight.promise;
  }
  const entry = { promise: Promise.resolve(), again: false };
  entry.promise = (async () => {
    do {
      entry.again = false;
      try {
        await refreshOnce(id);
      } catch (err) {
        logger.warn('Storage snapshot refresh failed', { orgId: id, error: errorMessage(err) });
      }
    } while (entry.again);
  })().finally(() => refreshing.delete(id));
  refreshing.set(id, entry);
  return entry.promise;
}

onOrgStorageInvalidated((orgId) => { void refreshOrgSnapshot(orgId); });

interface SnapshotConfig {
  intervalMs: number;
  startupDelayMs: number;
  lockTtlMs: number;
}

/**
 *   REGISTRY_STORAGE_SNAPSHOT_INTERVAL_MS       (default 600000 — 10 min)
 *   REGISTRY_STORAGE_SNAPSHOT_STARTUP_DELAY_MS  (default 30000)
 *   REGISTRY_STORAGE_SNAPSHOT_LOCK_TTL_MS       (default api-core DEFAULT_LEADER_LOCK_TTL_MS;
 *                                                heartbeated while a run is in progress)
 */
function readConfig(): SnapshotConfig {
  return {
    intervalMs: envInt('REGISTRY_STORAGE_SNAPSHOT_INTERVAL_MS', 600_000, { min: 60_000 }),
    startupDelayMs: envInt('REGISTRY_STORAGE_SNAPSHOT_STARTUP_DELAY_MS', 30_000, { min: 0 }),
    lockTtlMs: envInt('REGISTRY_STORAGE_SNAPSHOT_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1 }),
  };
}

let scheduler: Scheduler | null = null;

/**
 * Start the always-on snapshot job (one pod per window via the leader lock;
 * every pod when Redis is absent). Idempotent; stopped by runServer's onShutdown.
 */
export function startStorageSnapshotScheduler(): void {
  if (scheduler) return;
  const cfg = readConfig();
  const lockClient = createEnvRedisLock();
  logger.info('Storage snapshot scheduler starting', {
    intervalMs: cfg.intervalMs, startupDelayMs: cfg.startupDelayMs, locked: !!lockClient,
  });
  scheduler = createScheduler({
    name: 'storage-snapshot',
    intervalMs: cfg.intervalMs,
    startupDelayMs: cfg.startupDelayMs,
    // Not caught: a throw keeps the scheduler from stamping a success.
    run: async ({ signal }) => { await runStorageSnapshotCycle({ intervalMs: cfg.intervalMs, signal }); },
    // Another pod holds the lock: still report the fleet's last success.
    onSkipped: () => republishSnapshotGauges(),
    ...(lockClient ? { lock: { redis: () => lockClient, key: LOCK_KEY, ttlMs: cfg.lockTtlMs } } : {}),
  });
  scheduler.start();
}

/** Stop the snapshot job. Exported for tests / clean shutdown. */
export function stopStorageSnapshotScheduler(): void {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
}

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
 * ({@link refreshOrgSnapshot}), so freed bytes show without waiting. Each org
 * record keeps a per-repository breakdown stamped with the store's measurement
 * sequence when its scan started ({@link SnapshotStore.nextSeq}: one counter
 * for the whole fleet, never a pod's wall clock, so clock skew cannot let an
 * older figure win), and both writers MERGE into the stored record rather than replace it
 * ({@link mergeOrgRecord}): a full run keeps a refresh's newer figures for the
 * repositories it re-measured, and a refresh keeps repositories a newer run
 * found. One org's record failing to store does not lose the run: the org is
 * named in the marker and reads as unknown until it is measured again.
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
  type RepoUsage,
  type StorageUsage,
} from './storage-usage.js';

const logger = createLogger('storage-snapshot');

const KEY_PREFIX = 'image-registry:storage-snapshot:';
const META_KEY = `${KEY_PREFIX}meta`;
const SEQ_KEY = `${KEY_PREFIX}seq`;
const orgKey = (orgId: string): string => `${KEY_PREFIX}org:${orgId}`;
/** Records outlive any freshness window by far; the expiry only drops departed orgs. */
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;

const LOCK_KEY = leaderLockKey('image-registry', 'storage-snapshot');

/** Histogram: seconds a snapshot run spent per phase (`phase=total` is the whole run). */
export const SNAPSHOT_PHASE_HISTOGRAM = 'registry_storage_snapshot_phase_seconds';
/** Counter: snapshot reads by outcome (`fresh`, `stale`, `missing`) — one per read. */
export const SNAPSHOT_READS_COUNTER = 'registry_storage_snapshot_reads_total';
/**
 * Counter: scheduled snapshot cycles by outcome — `ran` (a full walk completed),
 * `aborted` (lock lost / shutdown mid-run, nothing marked current) or
 * `skipped_recent` (another run started within {@link RECENT_RUN_FRACTION} of
 * the interval). A cycle that throws records nothing here; the scheduler's own
 * failure signal and `RegistryStorageSnapshotStale` cover it.
 */
export const SNAPSHOT_RUNS_COUNTER = 'registry_storage_snapshot_runs_total';
/**
 * Gauge: epoch seconds the last COMPLETED run (on any pod) finished. Every pod
 * republishes it from the stored marker — the leader as it writes, the others
 * each cycle — so `max()` over the fleet reads the true age wherever it is
 * scraped. Alerted by `RegistryStorageSnapshotStale`.
 */
export const SNAPSHOT_LAST_SUCCESS_GAUGE = 'registry_storage_snapshot_last_success_timestamp_seconds';
/**
 * Counter: org records a snapshot run measured but could not store. The run
 * carries on and the marker names the org, which reads as unknown (the push
 * gate refuses) until a later write lands.
 */
export const SNAPSHOT_ORG_WRITE_FAILURES_COUNTER = 'registry_storage_snapshot_org_write_failures_total';
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
  /** The run's measurement sequence ({@link SnapshotStore.nextSeq}), taken at its
   *  start. Org records carry the run (or refresh) that wrote them. */
  runId: number;
  /** When the run started (epoch ms, the running pod's clock): age only. */
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** The leader's configured interval, so readers judge age against what actually runs. */
  intervalMs: number;
  orgs: number;
  /** Orgs this run measured but could not store: they read as unknown (not as
   *  "the run found nothing") until a later record lands. */
  incompleteOrgIds?: string[];
}

/** One repository's figures inside an org record. */
interface RepoFigure {
  bytes: number;
  blobs: number;
  /** The measurement sequence taken when the scan that produced these figures
   *  started ({@link SnapshotStore.nextSeq}): the state it read is at least as
   *  recent as every figure with a lower one. */
  seq: number;
  incomplete: boolean;
}

/** One org's measurement. */
interface OrgRecord {
  /** The measurement sequence of the run (or refresh) that produced it; see {@link readOrgStorageUsage}. */
  runId: number;
  bytes: number;
  blobs: number;
  /** The repositories measured — what a targeted refresh re-scans. */
  repos: string[];
  computedAt: number;
  incomplete: boolean;
  /** False when publication records were unreadable during the run (scope may be short). */
  recordsComplete: boolean;
  /** Per-repository breakdown; `bytes`/`blobs` are its sums. */
  perRepo: Record<string, RepoFigure>;
}

/** Stamp a scan's per-repo usage with the sequence taken when it started. */
function figuresFrom(perRepo: ReadonlyMap<string, RepoUsage> | undefined, seq: number): Map<string, RepoFigure> {
  const out = new Map<string, RepoFigure>();
  for (const [repo, u] of perRepo ?? []) out.set(repo, { ...u, seq });
  return out;
}

/**
 * Merge a scan's per-repo figures into the stored record for the org. For each
 * repository in `repos`, the more recently measured figure (higher `seq`) wins —
 * the stored one when another writer (a refresh during a run, a run during a
 * refresh) started measuring it after this scan did. A repository neither side measured
 * leaves the org incomplete. The record's `runId` never goes backwards, so a
 * record that already counted as current for the latest marker still does.
 */
export function mergeOrgRecord(opts: {
  measured: ReadonlyMap<string, RepoFigure>;
  repos: readonly string[];
  stored: OrgRecord | null;
  runId: number;
  recordsComplete: boolean;
}): OrgRecord {
  const { measured, repos, stored, runId, recordsComplete } = opts;
  const perRepo: Record<string, RepoFigure> = {};
  let bytes = 0;
  let blobs = 0;
  let incomplete = !recordsComplete;
  for (const repo of repos) {
    const mine = measured.get(repo);
    const theirs = stored?.perRepo[repo];
    const pick = theirs && (!mine || theirs.seq > mine.seq) ? theirs : mine;
    if (!pick) {
      incomplete = true;
      continue;
    }
    perRepo[repo] = pick;
    bytes += pick.bytes;
    blobs += pick.blobs;
    if (pick.incomplete) incomplete = true;
  }
  return {
    runId: Math.max(runId, stored?.runId ?? 0),
    bytes,
    blobs,
    repos: [...repos],
    computedAt: Date.now(),
    incomplete,
    recordsComplete,
    perRepo,
  };
}

/** Key/value store the snapshot lives in: Redis when configured, else this process. */
export interface SnapshotStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * Write `value` only if the key still holds `expected` (null: still absent),
   * atomically. False when another writer got there first. The org records'
   * read-merge-write goes through this, so a run and a refresh racing on one
   * org never drop each other's merge.
   */
  setIfUnchanged(key: string, expected: string | null, value: string, ttlSeconds: number): Promise<boolean>;
  /**
   * The next measurement sequence: strictly increasing across every writer
   * sharing the store (Redis `INCR`), so it orders scans by when they started
   * whatever each pod's clock says.
   */
  nextSeq(): Promise<number>;
}

interface RedisKv {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Compare-and-set. KEYS: the key. ARGV: '1' when a value is expected ('0':
 * expect it absent), the expected value, the new value, its TTL in seconds.
 */
const SET_IF_UNCHANGED_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if cur ~= ARGV[2] then return 0 end
elseif cur then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1`;

function createStore(): SnapshotStore {
  const redis = createEnvRedisClient<RedisKv>('storage-snapshot');
  if (redis) {
    return {
      get: (key) => redis.get(key),
      set: async (key, value, ttlSeconds) => { await redis.set(key, value, 'EX', ttlSeconds); },
      setIfUnchanged: async (key, expected, value, ttlSeconds) =>
        Number(await redis.eval(SET_IF_UNCHANGED_SCRIPT, 1, key, expected === null ? '0' : '1', expected ?? '', value, ttlSeconds)) === 1,
      nextSeq: async () => Number(await redis.incr(SEQ_KEY)),
    };
  }
  // No Redis: each pod runs the (then unlocked) job and keeps its own copy.
  logger.info('Redis not configured — storage snapshot kept in process memory');
  const mem = new Map<string, { value: string; expires: number }>();
  let seq = 0;
  const read = (key: string): string | null => {
    const hit = mem.get(key);
    if (!hit || hit.expires < Date.now()) return null;
    return hit.value;
  };
  const write = (key: string, value: string, ttlSeconds: number): void => {
    mem.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  };
  return {
    get: async (key) => read(key),
    set: async (key, value, ttlSeconds) => write(key, value, ttlSeconds),
    setIfUnchanged: async (key, expected, value, ttlSeconds) => {
      if (read(key) !== expected) return false;
      write(key, value, ttlSeconds);
      return true;
    },
    nextSeq: async () => ++seq,
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

/** Read-merge-write attempts before an org record write gives up (contention is rare: two writers at most). */
const MERGE_ATTEMPTS = 5;

/**
 * Store one org's record as `build(stored)`, against what is stored at the
 * moment of the write: re-read and re-merge whenever another writer changed the
 * record in between. Throws when the record stays contended (or the store
 * fails); the caller treats the org as not stored.
 */
async function storeMergedOrgRecord(s: SnapshotStore, orgId: string, build: (stored: OrgRecord | null) => OrgRecord): Promise<OrgRecord> {
  const key = orgKey(orgId);
  for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
    const raw = await s.get(key);
    const record = build(parse<OrgRecord>(raw));
    if (await s.setIfUnchanged(key, raw, JSON.stringify(record), RECORD_TTL_SECONDS)) return record;
  }
  throw new Error(`org record still contended after ${MERGE_ATTEMPTS} attempts`);
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
  // The last run measured this org but could not store the result: whatever is
  // stored predates it, so the org is unknown until something newer than the
  // run (a targeted refresh, the next run) lands.
  if (meta.incompleteOrgIds?.includes(id) && (!record || record.runId <= meta.runId)) {
    return { prefix, bytes: 0, repos: 0, blobs: 0, computedAt: meta.completedAt, incomplete: true };
  }
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
  const s = getStore();
  const startedAt = Date.now();
  const runId = await s.nextSeq();
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
  // A canonical order, so a shared blob is billed to the same repository by
  // every scan of the org (the per-repo figures of a run and a refresh merge).
  for (const repos of orgRepos.values()) repos.sort();

  const perOrgMs: Array<{ orgId: string; ms: number; repos: number }> = [];
  let incompleteOrgs = 0;
  const unstoredOrgs: string[] = [];
  // Several orgs at once, and ONE cap on registry calls for the whole run: each
  // org's scan is itself concurrent, so without the shared limiter the run
  // would keep orgs × per-scan calls in flight.
  const concurrency = storageScanConcurrency();
  const limiter = createLimiter(concurrency);
  await mapWithConcurrency([...orgRepos], concurrency, async ([orgId, repos]) => {
    if (signal?.aborted) return;
    const orgStart = Date.now();
    const seq = await s.nextSeq();
    const scan = await scanRepositories(repos, { timings, limiter, perRepo: true });
    if (signal?.aborted) return;
    try {
      // Read-merge-write: a targeted refresh may have stored newer figures for
      // some of these repositories since this scan started (or store them while
      // this write is in flight — the write is conditional on what it merged).
      const measured = figuresFrom(scan.perRepo, seq);
      const record = await storeMergedOrgRecord(s, orgId, (stored) => mergeOrgRecord({
        measured, repos, stored, runId, recordsComplete,
      }));
      if (record.incomplete) incompleteOrgs++;
    } catch (err) {
      // One org's record not landing must not lose every other org's: the
      // marker names it, so it reads as unknown rather than as 0 bytes.
      incompleteOrgs++;
      unstoredOrgs.push(orgId);
      incCounter(SNAPSHOT_ORG_WRITE_FAILURES_COUNTER, {});
      logger.warn('Storage snapshot could not store an org record — it reads as unknown', { orgId, error: errorMessage(err) });
    }
    perOrgMs.push({ orgId, ms: Date.now() - orgStart, repos: repos.length });
  });
  if (signal?.aborted) {
    logger.info('Storage snapshot run aborted — not marking it current', { reason: String(signal.reason ?? '') });
    return null;
  }

  const completedAt = Date.now();
  const meta: SnapshotMeta = {
    runId,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    intervalMs,
    orgs: orgRepos.size,
    ...(unstoredOrgs.length > 0 ? { incompleteOrgIds: unstoredOrgs.sort() } : {}),
  };
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
    unstoredOrgs: unstoredOrgs.length,
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
  // Judged by the run's start, so this also covers a run that completed
  // recently; judging by completion instead would push every run out by the
  // previous run's duration.
  if (meta && Date.now() - meta.startedAt < RECENT_RUN_FRACTION * opts.intervalMs) {
    incCounter(SNAPSHOT_RUNS_COUNTER, { outcome: 'skipped_recent' });
    publishSnapshotGauges(meta);
    logger.debug('Storage snapshot cycle skipped — a run started recently', {
      startedAt: new Date(meta.startedAt).toISOString(), intervalMs: opts.intervalMs,
    });
    return 'skipped_recent';
  }
  const outcome: SnapshotCycleOutcome = (await runStorageSnapshot(opts)) ? 'ran' : 'aborted';
  incCounter(SNAPSHOT_RUNS_COUNTER, { outcome });
  return outcome;
}

/** In-flight targeted refreshes, one per org; `again` coalesces a burst into one re-run. */
const refreshing = new Map<string, { promise: Promise<void>; again: boolean }>();

async function refreshOnce(orgId: string): Promise<void> {
  const s = getStore();
  const record = parse<OrgRecord>(await s.get(orgKey(orgId)));
  // Nothing measured for it yet — the next full run will.
  if (!record) return;
  const startedAt = Date.now();
  const seq = await s.nextSeq();
  const repos = [...record.repos].sort();
  const scan = await scanRepositories(repos, { perRepo: true });
  // Merge into what is stored AT THE WRITE: a full run may have written since
  // this refresh read the record (or write while this one is in flight — the
  // write is conditional on what it merged). The run's repositories (including
  // any this refresh never knew) are kept, its figures win wherever it started
  // measuring after this refresh did (a higher `seq`), and its `runId` is kept,
  // so the record still counts as current for that run's marker.
  const measured = figuresFrom(scan.perRepo, seq);
  const next = await storeMergedOrgRecord(s, orgId, (stored) => {
    const current = stored ?? record;
    return mergeOrgRecord({
      measured,
      repos: current.repos,
      stored: current,
      // The refresh measured the org after taking `seq`, so it is at least as
      // current as any run that took a lower one.
      runId: seq,
      recordsComplete: current.recordsComplete,
    });
  });
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

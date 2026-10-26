// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The read-replica lag circuit.
 *
 * A standby that has fallen behind does not fail reads — it answers them with
 * old data, confidently and quickly. That is the whole hazard of read-splitting
 * and the reason this module gates the feature: `DB_READ_HOST` must not be
 * configured on any target until this exists.
 *
 * SHAPE: a cached sample, not a per-query check. Asking the standby how far
 * behind it is costs a round-trip, so doing it per read would spend most of the
 * benefit on the measurement. Instead a sample is refreshed at most every
 * `DB_READ_LAG_SAMPLE_MS` in the background, and the routing decision reads the
 * cache synchronously.
 *
 * FAIL CLOSED, THREE WAYS. An unknown lag is treated as unacceptable, so:
 *   - before the first sample completes, reads go to the primary;
 *   - if the sample query errors, reads go to the primary;
 *   - if the cached sample has gone STALE — the sampler stopped running, the
 *     pool is wedged — reads go to the primary.
 * The last one matters most: a cache that merely stops updating would otherwise
 * freeze the circuit in whatever state it was last in, which for a healthy
 * reading means "keep using a replica nobody is checking any more".
 *
 * WHY NOT A TIMER: pipeline-data has no scheduler and no leader lock, and a
 * `setInterval` in a library keeps the event loop alive and leaks across tests.
 * Sampling is kicked off opportunistically from the read path instead
 * (fire-and-forget, debounced), so a process that never reads never samples —
 * which is correct, and costs nothing.
 */

import { createLogger, emitGauge, envInt } from '@pipeline-builder/api-core';
import type { Pool } from 'pg';

const logger = createLogger('database-read-lag');

/**
 * How far behind a standby may be and still serve reads.
 *
 * Five seconds is a deliberately loose default: this circuit exists to catch a
 * standby that is BROKEN or badly behind, not to provide read-your-writes.
 * Read-after-write is handled separately and exactly, by the write watermark in
 * `tenancy.ts` — a lag threshold cannot do that job at any value, because a
 * replica 200ms behind still has not replayed a commit from 100ms ago.
 * Confusing the two is how a lag threshold ends up tuned to a number that
 * neither protects correctness nor permits any offload.
 */
const maxLagSeconds = () => envInt('DB_READ_MAX_LAG_SECONDS', 5);
const sampleIntervalMs = () => envInt('DB_READ_LAG_SAMPLE_MS', 5000);
/**
 * How long one sample may take before it is abandoned.
 *
 * THIS IS NOT A PERFORMANCE KNOB, it is what makes the sampler recoverable.
 * Nothing else bounds a running query on this pool — `connectionTimeoutMillis`
 * bounds ACQUIRING a connection and `idleTimeoutMillis` evicts idle ones;
 * neither touches a query already executing. So a wedged connection left
 * `inFlight` true forever, the `finally` never ran, every later call returned
 * at the guard, and no further sample was taken FOR THE LIFE OF THE PROCESS.
 * The cached reading then went stale, the verdict became `unknown`, and every
 * read fell back to the primary permanently — safe, but unrecoverable without
 * a restart, and visible only as PostgresReadCircuitOpen 30 minutes later.
 */
const sampleTimeoutMs = () => envInt('DB_READ_LAG_SAMPLE_TIMEOUT_MS', 5000);

/**
 * Race a query against a timer so the caller always regains control.
 *
 * The abandoned query is left to the pool — Postgres keeps running it, and the
 * pool's own idle handling reclaims the connection. That is deliberate: the
 * alternative is cancelling server-side, which needs a second connection and a
 * PID, and this is a 1-row read whose cost is bounded anyway. What matters is
 * that `inFlight` is released, so the next read retries.
 *
 * `clearTimeout` in `finally` is not tidiness: an un-cleared timer keeps the
 * Node event loop alive, which hangs a test run and, in a short-lived process,
 * delays exit.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A sample older than this many intervals is treated as no sample at all. */
const STALE_INTERVALS = 3;

interface Sample {
  lagSeconds: number;
  atMs: number;
}

let sample: Sample | null = null;
let inFlight = false;
let consecutiveFailures = 0;

export type LagVerdict =
  /** No sample yet, or the last one is stale/failed. Reads use the primary. */
  | 'unknown'
  /** Replay lag is within the threshold. */
  | 'ok'
  /** Replay lag is beyond the threshold. Reads use the primary. */
  | 'lagging';

/**
 * The circuit's current state, read synchronously by the routing decision.
 *
 * Returns `unknown` rather than throwing or guessing when there is nothing
 * trustworthy to report, and every caller treats `unknown` as "use the
 * primary".
 */
export function lagVerdict(now = Date.now()): LagVerdict {
  if (!sample) return 'unknown';
  if (now - sample.atMs > sampleIntervalMs() * STALE_INTERVALS) return 'unknown';
  return sample.lagSeconds > maxLagSeconds() ? 'lagging' : 'ok';
}

/**
 * The lag query, and the one subtlety in this whole module.
 *
 * `now() - pg_last_xact_replay_timestamp()` is the usual lag expression and it
 * is WRONG ON ITS OWN: that timestamp is the commit time of the last replayed
 * transaction, so on an idle primary it simply gets older and older. A standby
 * that is perfectly caught up on a quiet system would report minutes of "lag"
 * and this circuit would send every read back to the primary — permanently,
 * and most visibly at night when nothing is happening.
 *
 * The guard is the LSN comparison first: when everything received has been
 * replayed, the standby is current by definition, whatever the clock says.
 * Only when there is unreplayed WAL does the timestamp mean anything.
 */
const LAG_SQL = `
  SELECT CASE
    WHEN NOT pg_is_in_recovery() THEN 0
    WHEN pg_last_wal_receive_lsn() IS NULL THEN NULL
    WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())))
  END AS lag_seconds
`;

/**
 * Refresh the sample if it is due. Fire-and-forget: never throws, never
 * returns a rejected promise, and resolves as soon as a sample is not needed.
 *
 * `pg_is_in_recovery() = false` means this pool is pointed at a PRIMARY, which
 * is a misconfiguration worth surfacing rather than a lag of zero — but it is
 * reported as lag 0 anyway, because the alternative is refusing to serve reads
 * from a server that is, in fact, able to serve them correctly. The warning is
 * logged once per transition instead.
 */
export async function maybeSampleLag(pool: Pool): Promise<void> {
  const now = Date.now();
  if (inFlight) return;
  if (sample && now - sample.atMs < sampleIntervalMs()) return;
  inFlight = true;
  try {
    const res = await withTimeout(
      pool.query<{ lag_seconds: string | number | null }>(LAG_SQL),
      sampleTimeoutMs(),
      'read-replica lag sample',
    );
    const raw = res.rows[0]?.lag_seconds;
    if (raw === null || raw === undefined) {
      // A standby that has never received WAL. Not an error, but not a usable
      // reading either — it must not be recorded as "caught up".
      recordFailure('no WAL received yet');
      return;
    }
    const lagSeconds = Number(raw);
    if (!Number.isFinite(lagSeconds)) {
      recordFailure(`non-numeric lag value: ${String(raw)}`);
      return;
    }
    if (consecutiveFailures > 0) {
      logger.info('Read-replica lag sampling recovered', { afterFailures: consecutiveFailures, lagSeconds });
      consecutiveFailures = 0;
    }
    sample = { lagSeconds, atMs: Date.now() };
    emitGauge('postgres_replica_lag_seconds', {}, lagSeconds);
    emitGauge('postgres_read_circuit_open', {}, lagVerdict() === 'ok' ? 0 : 1);
  } catch (err) {
    recordFailure(err instanceof Error ? err.message : String(err));
  } finally {
    inFlight = false;
  }
}

function recordFailure(reason: string): void {
  consecutiveFailures += 1;
  // Discard the previous sample rather than keeping a stale "ok": a sampler
  // that cannot reach the standby is exactly when reads must not go there.
  sample = null;
  emitGauge('postgres_read_circuit_open', {}, 1);
  // Log the first failure and then back off, so an unreachable standby does not
  // produce a line per read.
  if (consecutiveFailures === 1 || consecutiveFailures % 100 === 0) {
    logger.warn('Read-replica lag sample failed; reads fall back to the primary', {
      reason,
      consecutiveFailures,
    });
  }
}

/** Test seam: forget the cached sample and failure state. */
export function resetLagStateForTests(): void {
  sample = null;
  inFlight = false;
  consecutiveFailures = 0;
}

/** Test seam: install a sample directly, without a database. */
export function setLagSampleForTests(lagSeconds: number, atMs = Date.now()): void {
  sample = { lagSeconds, atMs };
}

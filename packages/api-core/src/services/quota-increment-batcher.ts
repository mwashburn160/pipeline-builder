// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-pod aggregation of METERING increments (apiCalls / automationCalls).
 *
 * Metering used to be one POST to the quota service per successful request,
 * and each POST was a conditional `findOneAndUpdate` on the org's hot document,
 * a team counter update, a ledger insert and a threshold check. At the request
 * rates the meter exists for, the quota service was doing more work than the
 * request it was counting.
 *
 * Increments are now summed in memory per (org, quota type) and, inside that,
 * per attribution group (principal, key, route pattern, pipeline), then sent
 * every `QUOTA_INCREMENT_FLUSH_MS` (default 1000) as ONE metered increment per
 * (org, type) carrying its groups. The quota service applies the sum atomically
 * against the (pooled) cap with partial admission: the counter moves by as much
 * as fits and never past the limit, and the rest is recorded as `overshoot` in
 * the ledger (api/quota `incrementMetered`).
 *
 * Guarantees, and their limits:
 *  - the counter may LAG real usage by up to one flush interval (plus the HTTP
 *    hop); enforcement is unaffected beyond that lag, because the counter
 *    still never exceeds the cap;
 *  - the buffer is bounded (`QUOTA_INCREMENT_BUFFER_MAX` attribution groups).
 *    Reaching it flushes immediately; only while a flush is already in flight
 *    is a NEW group dropped, counted on `quota_increment_dropped_total`;
 *  - a flush that fails is counted on `quota_increment_failures_total` (the
 *    QuotaIncrementFailures alert) and NOT retried: the POST may have landed,
 *    and a retry would double-count;
 *  - graceful shutdown flushes: `runServer` awaits {@link flushQuotaIncrements}
 *    after the HTTP server has drained, and a SIGTERM flush covers processes
 *    with their own shutdown path.
 *
 * Reservations (aiCalls, pipelines, plugins …) never come through here — they
 * need the synchronous answer and keep `reserveQuota`.
 */

import type { QuotaService, QuotaUsageAttribution } from './quota.js';
import type { QuotaType } from '../types/common.js';
import { runConcurrent } from '../utils/concurrency.js';
import { envInt } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('quota-increment-batcher');

/** Flush interval (ms). `0` disables batching: every increment is sent on its own. */
export const QUOTA_INCREMENT_FLUSH_MS = envInt('QUOTA_INCREMENT_FLUSH_MS', 1000, { min: 0, max: 60_000 });

/** Most attribution groups held between flushes, across every org. */
export const QUOTA_INCREMENT_BUFFER_MAX = envInt('QUOTA_INCREMENT_BUFFER_MAX', 10_000, { min: 1 });

/** Most groups one metered increment carries (the quota service enforces the same bound). */
export const MAX_GROUPS_PER_INCREMENT = 500;

/** Concurrent POSTs per flush. */
const FLUSH_CONCURRENCY = 8;

/** One attribution group of a metered increment: who spent `amount` units. */
export interface MeteredIncrementGroup {
  amount: number;
  attribution?: Omit<QuotaUsageAttribution, 'requestId'>;
}

/** Sends one (org, type)'s groups. Resolves when the quota service answered (or not). */
export type MeteredIncrementSender = (orgId: string, quotaType: QuotaType, groups: MeteredIncrementGroup[]) => Promise<void>;

interface PendingSeries {
  orgId: string;
  quotaType: QuotaType;
  groups: Map<string, MeteredIncrementGroup>;
}

/** The attribution a group aggregates on — everything but the per-request id. */
function groupAttribution(a: QuotaUsageAttribution | undefined): MeteredIncrementGroup['attribution'] {
  if (!a) return undefined;
  const { requestId: _requestId, ...rest } = a;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function groupKey(a: MeteredIncrementGroup['attribution']): string {
  return a ? JSON.stringify([a.principalType, a.principalId, a.keyId, a.route, a.pipelineId]) : '';
}

/** A per-pod increment aggregator over one sender. Exported for tests. */
export class QuotaIncrementBatcher {
  private buffer = new Map<string, PendingSeries>();
  private groupCount = 0;
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly send: MeteredIncrementSender,
    private readonly opts: { flushMs: number; maxGroups: number } = { flushMs: QUOTA_INCREMENT_FLUSH_MS, maxGroups: QUOTA_INCREMENT_BUFFER_MAX },
  ) {}

  /** Units waiting for the next flush (tests, metrics). */
  pendingUnits(): number {
    let n = 0;
    for (const s of this.buffer.values()) for (const g of s.groups.values()) n += g.amount;
    return n;
  }

  /** Count `amount` units for (org, type). Never throws, never awaits. */
  add(orgId: string, quotaType: QuotaType, attribution?: QuotaUsageAttribution, amount: number = 1): void {
    const attr = groupAttribution(attribution);
    if (this.opts.flushMs === 0) {
      this.dispatch(orgId, quotaType, [{ amount, ...(attr && { attribution: attr }) }]);
      return;
    }
    const seriesKey = `${orgId}\u0000${quotaType}`;
    const key = groupKey(attr);
    const existing = this.buffer.get(seriesKey)?.groups.get(key);
    if (existing) {
      existing.amount += amount;
      return;
    }
    if (this.groupCount >= this.opts.maxGroups) {
      if (this.inFlight) {
        emitCounter('quota_increment_dropped_total', { quotaType }, amount);
        return;
      }
      void this.flush();
    }
    let series = this.buffer.get(seriesKey);
    if (!series) {
      series = { orgId, quotaType, groups: new Map() };
      this.buffer.set(seriesKey, series);
    }
    series.groups.set(key, { amount, ...(attr && { attribution: attr }) });
    this.groupCount += 1;
    this.arm();
  }

  /** Send everything buffered now. Resolves once every POST has settled. */
  async flush(): Promise<void> {
    if (this.buffer.size === 0) return this.inFlight ?? undefined;
    const batch = [...this.buffer.values()];
    this.buffer = new Map();
    this.groupCount = 0;
    const previous = this.inFlight;
    const run = (async () => {
      await runConcurrent(batch, FLUSH_CONCURRENCY, async (series) => {
        const groups = [...series.groups.values()];
        for (let i = 0; i < groups.length; i += MAX_GROUPS_PER_INCREMENT) {
          await this.sendSafely(series.orgId, series.quotaType, groups.slice(i, i + MAX_GROUPS_PER_INCREMENT));
        }
      });
      if (previous) await previous;
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  /** Stop the timer (tests; process teardown). Buffered units stay until {@link flush}. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.opts.flushMs);
    this.timer.unref?.();
    armShutdownFlush();
  }

  private dispatch(orgId: string, quotaType: QuotaType, groups: MeteredIncrementGroup[]): void {
    void this.sendSafely(orgId, quotaType, groups);
  }

  private async sendSafely(orgId: string, quotaType: QuotaType, groups: MeteredIncrementGroup[]): Promise<void> {
    try {
      await this.send(orgId, quotaType, groups);
    } catch (err) {
      logger.warn('Metered quota increment failed', { orgId, quotaType, error: String(err) });
      emitCounter('quota_increment_failures_total', { reason: 'exception', quotaType });
    }
  }
}

/** One batcher per quota client, so a test's fake client never shares a buffer. */
const batchers = new WeakMap<QuotaService, QuotaIncrementBatcher>();

/** The live batchers, for the shutdown flush (a WeakMap cannot be iterated). */
const live = new Set<QuotaIncrementBatcher>();

/** The batcher feeding `quotaService.incrementMetered`. */
export function batcherFor(quotaService: QuotaService, sender: MeteredIncrementSender): QuotaIncrementBatcher {
  let b = batchers.get(quotaService);
  if (!b) {
    b = new QuotaIncrementBatcher(sender);
    batchers.set(quotaService, b);
    live.add(b);
  }
  return b;
}

/**
 * Flush every pod-local batcher. Called by `runServer` once the HTTP server has
 * stopped accepting and in-flight requests have finished (their `finish`
 * meters are then all buffered). Never rejects.
 */
export async function flushQuotaIncrements(): Promise<void> {
  await Promise.all([...live].map((b) => b.flush().catch(() => undefined)));
}

let shutdownArmed = false;

/**
 * SIGTERM flush for processes that don't shut down through `runServer`.
 *
 * Armed only when the process ALREADY handles SIGTERM (every service registers
 * its shutdown at startup, before the first request is metered): adding the
 * first listener would switch off Node's default exit-on-SIGTERM for a process
 * that relied on it (a CLI, a test worker).
 */
function armShutdownFlush(): void {
  if (shutdownArmed || process.listenerCount('SIGTERM') === 0) return;
  shutdownArmed = true;
  process.once('SIGTERM', () => { void flushQuotaIncrements(); });
}

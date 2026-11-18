// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The durable CASCADE OUTBOX — how an org purge or a GDPR user erasure reaches
 * every OTHER service that holds the subject's data.
 *
 * Two halves:
 *
 *  - {@link enqueueCascade} writes one `cascade_outbox` row per downstream leg
 *    (services/cascade-legs.ts) INSIDE the caller's Mongo transaction — the
 *    org's hard delete, the user's deletion. The state change and the promise
 *    to propagate it commit or roll back together: there is no window in which
 *    the org is gone and nothing remembers that pipeline, plugin, compliance,
 *    message, reporting, quota, billing and the registry still hold its data.
 *    The row is an UPSERT on `(kind, subjectId, service)`, so a transaction
 *    retry (which re-runs its body) or a re-run purge is one leg, not two.
 *
 *  - {@link dispatchCascadeOutbox} — a leader-locked background sweep — leases
 *    each due leg, delivers it to the owning service's idempotent endpoint, and
 *    on a 2xx marks it `done`. A failure is retried with exponential backoff
 *    ({@link cascadeBackoffMs}); at `maxAttempts` the leg goes `dead`, which
 *    increments `platform_cascade_dead_total{service,kind}` (paged by the
 *    `PlatformCascadeLegDead` rule), logs the subject, and records an
 *    `org.cascade.dead` audit row — the operator-readable trail of an erasure
 *    that did not finish. {@link cascadeStatus} reads a subject's legs back.
 *
 * A crash between the commit and the first delivery loses nothing: the rows
 * are pending in Mongo and the next tick (on whichever pod holds the lock)
 * delivers them. A crash between a 2xx and the `done` write redelivers once,
 * which the idempotent handlers answer 2xx again.
 */

import { createLogger, errorMessage, leaderLockKey, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { ClientSession } from 'mongoose';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { findLeg, legsFor, type CascadeDelivery } from './cascade-legs.js';
import { config } from '../config/index.js';
import { recordAuditEvent } from '../helpers/audit.js';
import CascadeOutbox, { type CascadeKind, type CascadeOutboxData } from '../models/cascade-outbox.js';
import { incCounter } from '../observability/metrics.js';

const logger = createLogger('cascade-outbox');

const LOCK_KEY = leaderLockKey('platform', 'cascade-outbox');

/**
 * Count, never throw: `incCounter` raises when the metrics registry is not
 * wired, and a dispatcher whose bookkeeping can fail would strand the pass.
 */
function count(name: string, labels: Record<string, string>): void {
  try {
    incCounter(name, labels);
  } catch {
    // The log line next to every call still carries the event.
  }
}

/** `lastError` is a diagnostic, not a log: bound it. */
const LAST_ERROR_MAX = 500;

/** Tunables (defaults: `config.organization.cascadeOutbox`). */
export interface CascadeOutboxOptions {
  batchSize: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  leaseMs: number;
}

function options(over: Partial<CascadeOutboxOptions> = {}): CascadeOutboxOptions {
  const c = config.organization.cascadeOutbox;
  return {
    batchSize: c.batchSize,
    maxAttempts: c.maxAttempts,
    backoffBaseMs: c.backoffBaseMs,
    backoffMaxMs: c.backoffMaxMs,
    leaseMs: c.leaseMs,
    ...over,
  };
}

/**
 * Delay before the retry that follows failed attempt number `attempt` (1-based):
 * `base · 2^(attempt-1)`, capped at `max`. Deterministic — one leader-locked
 * dispatcher means there is no herd for jitter to spread.
 */
export function cascadeBackoffMs(attempt: number, base: number, max: number): number {
  const exp = Math.max(0, attempt - 1);
  // 2^31 already dwarfs any sane cap; stop before the float goes to Infinity.
  return Math.min(max, base * 2 ** Math.min(exp, 31));
}

/**
 * Record every downstream leg of a `kind` cascade for `subjectId`, inside
 * `session`'s transaction. Returns the legs' names (for the caller's audit row).
 * Idempotent: a leg already present (any status) is left exactly as it is.
 */
export async function enqueueCascade(
  kind: CascadeKind,
  subjectId: string,
  session: ClientSession,
  now: Date = new Date(),
): Promise<string[]> {
  const legs = legsFor(kind);
  if (legs.length === 0) return [];
  await CascadeOutbox.bulkWrite(
    legs.map((leg) => ({
      updateOne: {
        filter: { kind, subjectId, service: leg.service },
        update: {
          $setOnInsert: {
            kind,
            subjectId,
            service: leg.service,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            lastError: null,
            lastStatusCode: null,
            completedAt: null,
          },
        },
        upsert: true,
      },
    })),
    { session, ordered: true },
  );
  return legs.map((l) => l.service);
}

/** Outcome of one {@link dispatchCascadeOutbox} pass. */
export interface CascadeDispatchResult {
  /** Due legs found by the scan. */
  scanned: number;
  delivered: number;
  /** Failed and rescheduled. */
  retried: number;
  /** Failed for the last time. */
  dead: number;
  /** Due when scanned but leased by someone else (or no longer due) by the claim. */
  skipped: number;
}

/**
 * One delivery pass over the due legs. Never throws for a leg (a delivery that
 * throws is a failed attempt); a scan failure propagates so the scheduler
 * records a failing cycle. Stops between legs when `run.signal` aborts.
 */
export async function dispatchCascadeOutbox(
  run?: { signal: AbortSignal },
  over: Partial<CascadeOutboxOptions> & { now?: () => Date } = {},
): Promise<CascadeDispatchResult> {
  const opts = options(over);
  const clock = over.now ?? (() => new Date());
  const result: CascadeDispatchResult = { scanned: 0, delivered: 0, retried: 0, dead: 0, skipped: 0 };

  const due = await CascadeOutbox.find({ status: 'pending', nextAttemptAt: { $lte: clock() } })
    .sort({ nextAttemptAt: 1, _id: 1 })
    .limit(opts.batchSize)
    .select('_id')
    .lean();
  result.scanned = due.length;

  for (const { _id } of due) {
    if (run?.signal.aborted) break;
    const now = clock();
    // LEASE before delivering: push `nextAttemptAt` past the slowest leg, so a
    // second dispatcher — or this one after a crash — leaves it alone until the
    // lease lapses. Atomic, so of two claimants exactly one wins.
    const leg = await CascadeOutbox.findOneAndUpdate(
      { _id, status: 'pending', nextAttemptAt: { $lte: now } },
      { $set: { nextAttemptAt: new Date(now.getTime() + opts.leaseMs) } },
      { new: true },
    ).lean<CascadeOutboxData & { _id: unknown }>();
    if (!leg) {
      result.skipped += 1;
      continue;
    }

    const delivery = await deliver(leg);
    const attempts = leg.attempts + 1;
    const doneAt = clock();

    if (delivery.ok) {
      await CascadeOutbox.updateOne(
        { _id },
        { $set: { status: 'done', attempts, completedAt: doneAt, lastError: null, lastStatusCode: delivery.statusCode ?? null } },
      );
      result.delivered += 1;
      count('platform_cascade_delivery_total', { service: leg.service, kind: leg.kind, result: 'delivered' });
      logger.info('Cascade leg delivered', { kind: leg.kind, subjectId: leg.subjectId, service: leg.service, attempts });
      continue;
    }

    const lastError = (delivery.error ?? 'failed').slice(0, LAST_ERROR_MAX);
    if (attempts >= opts.maxAttempts) {
      await CascadeOutbox.updateOne(
        { _id },
        { $set: { status: 'dead', attempts, completedAt: doneAt, lastError, lastStatusCode: delivery.statusCode ?? null } },
      );
      result.dead += 1;
      deadLetter(leg, attempts, lastError, delivery.statusCode);
      continue;
    }

    const nextAttemptAt = new Date(doneAt.getTime() + cascadeBackoffMs(attempts, opts.backoffBaseMs, opts.backoffMaxMs));
    await CascadeOutbox.updateOne(
      { _id },
      { $set: { attempts, nextAttemptAt, lastError, lastStatusCode: delivery.statusCode ?? null } },
    );
    result.retried += 1;
    count('platform_cascade_delivery_total', { service: leg.service, kind: leg.kind, result: 'retried' });
    logger.warn('Cascade leg failed; retrying with backoff', {
      kind: leg.kind, subjectId: leg.subjectId, service: leg.service, attempts, nextAttemptAt, error: lastError,
    });
  }

  if (result.scanned > 0) logger.info('Cascade outbox pass', { ...result });
  return result;
}

/** Deliver one leg; an unregistered leg or a throwing `deliver` is a failure. */
async function deliver(leg: Pick<CascadeOutboxData, 'kind' | 'service' | 'subjectId'>): Promise<CascadeDelivery> {
  const def = findLeg(leg.kind, leg.service);
  if (!def) return { ok: false, error: `no cascade leg registered for ${leg.kind}/${leg.service}` };
  try {
    return await def.deliver(leg.subjectId);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * A leg ran out of attempts: the subject's data is still sitting in that
 * service. Meter it (the alert), log the subject id (the runbook's key), and
 * audit it (the admin-readable trail). The reporting must not throw — the leg
 * is already marked `dead`, and a throwing handler would fail the pass.
 */
function deadLetter(leg: Pick<CascadeOutboxData, 'kind' | 'service' | 'subjectId'>, attempts: number, lastError: string, statusCode?: number): void {
  count('platform_cascade_dead_total', { service: leg.service, kind: leg.kind });
  // The pre-outbox erasure signal, kept so its alert and panel still read a
  // user erasure that did not finish — now only after every retry failed.
  if (leg.kind === 'user.erased') count('user_erasure_incomplete_total', { store: 'postgres' });
  logger.error('Cascade leg DEAD — retries exhausted; the subject\'s data remains in the owning service', {
    kind: leg.kind, subjectId: leg.subjectId, service: leg.service, attempts, lastError, statusCode,
  });
  try {
    const isOrg = leg.kind === 'org.deleted';
    recordAuditEvent({
      action: 'org.cascade.dead',
      actorId: 'cascade-outbox',
      orgId: SYSTEM_ORG_ID,
      ...(isOrg ? { affectedOrgId: leg.subjectId } : {}),
      targetType: isOrg ? 'organization' : 'user',
      targetId: leg.subjectId,
      outcome: 'failure',
      // No error text: it can carry a downstream's response fragments.
      details: { kind: leg.kind, service: leg.service, attempts, ...(statusCode ? { statusCode } : {}) },
    });
  } catch (err) {
    logger.error('Failed to record org.cascade.dead audit event', { subjectId: leg.subjectId, error: errorMessage(err) });
  }
}

/** One leg as {@link cascadeStatus} reports it. */
export interface CascadeLegStatusView {
  service: string;
  status: CascadeOutboxData['status'];
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  lastStatusCode: number | null;
  completedAt: Date | null;
  createdAt: Date;
}

/**
 * Every leg of `subjectId`'s cascade(s) — the admin-readable status of an org
 * purge or user erasure once platform's own record of the subject is gone.
 */
export async function cascadeStatus(subjectId: string, kind?: CascadeKind): Promise<CascadeLegStatusView[]> {
  const rows = await CascadeOutbox.find({ subjectId, ...(kind ? { kind } : {}) }).sort({ service: 1 }).lean();
  return rows.map((r) => ({
    service: r.service,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    lastError: r.lastError ?? null,
    lastStatusCode: r.lastStatusCode ?? null,
    completedAt: r.completedAt ?? null,
    createdAt: r.createdAt,
  }));
}

/**
 * The dispatcher as a background sweep (services/background-sweeps.ts), under
 * the cross-pod leader lock. `concurrencySafe`: every leg is leased atomically
 * and every handler is idempotent, so two dispatchers would only duplicate an
 * ack — which licenses running without Redis rather than not at all (the
 * erasure obligation does not pause because the lock store is down).
 */
export function cascadeOutboxSweep(intervalMs: number = config.organization.cascadeOutbox.intervalMs): IntervalSweepDefinition {
  return {
    name: 'cascade-outbox',
    lockKey: LOCK_KEY,
    concurrencySafe: true,
    intervalMs,
    run: async (run) => { await dispatchCascadeOutbox(run); },
  };
}

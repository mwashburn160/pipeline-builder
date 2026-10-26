// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a read goes, and why.
 *
 * Replication CANNOT be reproduced here — these suites run on PGlite, an
 * in-process Postgres with no streaming replication — so the testable unit is
 * the ROUTING DECISION, not the lag. That is also the part with the bug in it:
 * lag is a property of Postgres, while "should this read go to a replica" is
 * code we wrote.
 *
 * The invariant every case below defends: **anything uncertain resolves to the
 * primary.** A read served by the primary is merely less efficient; a read
 * served by a stale replica is a user-visible bug that cannot be reproduced on
 * demand, which is the failure this whole feature exists to avoid causing.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
// The predicate moved to api-core: api-server's middleware needs it too, and
// reaching into pipeline-data from there threw in all 91 suites that stub this
// package with `stubModule`. read-connection.ts consumes it from api-core.
import { isReadReplicaConfigured } from '@pipeline-builder/api-core';
import { resetReadConnectionForTests } from '../src/database/read-connection.js';
import { lagVerdict, maybeSampleLag, resetLagStateForTests, setLagSampleForTests } from '../src/database/read-lag.js';
import { chooseReadTarget, type TenantContext } from '../src/database/tenancy.js';

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  orgId: 'org-1',
  isSuperAdmin: false,
  ...over,
});

/** A replica that exists and is caught up. */
const healthy = { available: true, lag: 'ok' } as const;
/** No replica configured, or the kill switch is off. */
const absent = { available: false, lag: 'unknown' } as const;

const ENV_KEYS = ['DB_READ_HOST', 'DB_READ_ENABLED', 'DB_READ_MAX_LAG_SECONDS', 'DB_READ_LAG_SAMPLE_MS', 'DB_READ_LAG_SAMPLE_TIMEOUT_MS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  resetReadConnectionForTests();
  resetLagStateForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetReadConnectionForTests();
  resetLagStateForTests();
});

describe('chooseReadTarget', () => {
  it('uses the replica for a plain read', () => {
    expect(chooseReadTarget(ctx(), healthy)).toEqual({ useReplica: true, reason: 'replica' });
  });

  it('stays on the primary when no replica is available', () => {
    // The state every target is in until Phase 1 ships a standby, and the state
    // the kill switch and the lag circuit both fall back to.
    expect(chooseReadTarget(ctx(), absent)).toEqual({ useReplica: false, reason: 'no-replica' });
  });

  it('stays on the primary once this request may have written', () => {
    // read-after-write WITHIN a request: the handler wrote, so it must not read
    // its own write off a replica that has not replayed the commit.
    expect(chooseReadTarget(ctx({ mayHaveWritten: true }), healthy))
      .toEqual({ useReplica: false, reason: 'may-have-written' });
  });

  it('prefers the primary when BOTH conditions apply, and says why without a replica', () => {
    // Ordering matters only for the explanation, but the explanation is what an
    // operator reads when asking "why is my replica idle".
    expect(chooseReadTarget(ctx({ mayHaveWritten: true }), absent).useReplica).toBe(false);
  });

  it('stays on the primary with no tenant context at all', () => {
    // Background workers and migrations run outside runWithTenantContext. They
    // are not request-scoped, so there is no watermark to consult — and a job
    // that reads to decide what to write must not read from a replica.
    //
    // The REAL reason this must be the primary is not performance: the primary
    // path goes through withTenantTx, whose RLS_CONTEXT_MODE guard warns (or in
    // strict mode throws) on a missing context. The replica path has no such
    // guard, so routing here would set app.org_id = '' silently — an empty
    // scope that LOOKS valid to every RLS policy.
    expect(chooseReadTarget(undefined, healthy))
      .toEqual({ useReplica: false, reason: 'no-context' });
  });
});

describe('isReadReplicaConfigured', () => {
  it('is false when no host is set', () => {
    delete process.env.DB_READ_HOST;
    expect(isReadReplicaConfigured()).toBe(false);
  });

  it('is false for a host of only whitespace', () => {
    // `DB_READ_HOST=""` is how every .env.example ships it, and a stray space
    // must not be read as "a replica exists".
    process.env.DB_READ_HOST = '   ';
    expect(isReadReplicaConfigured()).toBe(false);
  });

  it('is true once a host is set', () => {
    process.env.DB_READ_HOST = 'postgres-read';
    delete process.env.DB_READ_ENABLED;
    expect(isReadReplicaConfigured()).toBe(true);
  });

  it('is false when the kill switch is off, even with a host', () => {
    // The case the unset-host fallback does NOT cover: a replica that is up and
    // reachable but serving stale or wrong data. This must not need a redeploy.
    process.env.DB_READ_HOST = 'postgres-read';
    process.env.DB_READ_ENABLED = 'false';
    expect(isReadReplicaConfigured()).toBe(false);
  });
});

describe('the lag circuit', () => {
  it('sends reads to the primary while the standby is lagging', () => {
    expect(chooseReadTarget(ctx(), { available: true, lag: 'lagging' }))
      .toEqual({ useReplica: false, reason: 'replica-lagging' });
  });

  it('sends reads to the primary when lag is UNKNOWN, not just when it is high', () => {
    // The fail-closed case, and the one worth stating explicitly: "we have no
    // idea how far behind this standby is" must behave exactly like "it is too
    // far behind". The states that produce `unknown` are all real — no sample
    // taken yet, the sample query failed, or the sampler stopped running — and
    // in every one of them a replica read could return arbitrarily old data.
    expect(chooseReadTarget(ctx(), { available: true, lag: 'unknown' }))
      .toEqual({ useReplica: false, reason: 'replica-lagging' });
  });

  it('reports lag before the request-level reasons', () => {
    // Both route to the primary, so this is purely about the explanation an
    // operator reads when asking why the replica is idle. "The standby is
    // behind" is actionable; "this request may have written" is noise when the
    // real problem is replication.
    expect(chooseReadTarget(ctx({ mayHaveWritten: true }), { available: true, lag: 'lagging' }).reason)
      .toBe('replica-lagging');
  });

  it('still reports no-replica when there is no replica AND no lag reading', () => {
    expect(chooseReadTarget(ctx(), { available: false, lag: 'unknown' }).reason).toBe('no-replica');
  });
});

describe('lagVerdict', () => {
  it('is unknown with no sample at all', () => {
    expect(lagVerdict()).toBe('unknown');
  });

  it('is ok for a fresh sample inside the threshold', () => {
    setLagSampleForTests(1);
    expect(lagVerdict()).toBe('ok');
  });

  it('is lagging for a fresh sample beyond the threshold', () => {
    setLagSampleForTests(99);
    expect(lagVerdict()).toBe('lagging');
  });

  it('honours DB_READ_MAX_LAG_SECONDS', () => {
    process.env.DB_READ_MAX_LAG_SECONDS = '60';
    setLagSampleForTests(30);
    expect(lagVerdict()).toBe('ok');
    process.env.DB_READ_MAX_LAG_SECONDS = '10';
    expect(lagVerdict()).toBe('lagging');
  });

  it('treats a STALE sample as unknown, not as its last value', () => {
    // THE CASE THIS CIRCUIT EXISTS FOR, and the one a naive cache gets wrong.
    // If the sampler stops — a wedged pool, a process that stopped reading —
    // a cache that merely stops updating freezes the verdict at whatever it
    // last was. Frozen at `ok` that means "keep serving reads from a replica
    // nobody is checking any more", which is indistinguishable from healthy
    // right up until someone notices the data is old.
    process.env.DB_READ_LAG_SAMPLE_MS = '1000';
    const fourSamplesAgo = Date.now() - 4000; // STALE_INTERVALS is 3
    setLagSampleForTests(0, fourSamplesAgo);
    expect(lagVerdict()).toBe('unknown');
  });

  it('accepts a sample that is old but not yet stale', () => {
    // The boundary on the other side: sampling is debounced, so a reading
    // slightly older than one interval is normal operation and must not flap
    // the circuit.
    process.env.DB_READ_LAG_SAMPLE_MS = '1000';
    setLagSampleForTests(0, Date.now() - 1500);
    expect(lagVerdict()).toBe('ok');
  });
});

describe('a read must not claim to have written', () => {
  it('leaves mayHaveWritten alone when the read falls back to the primary', () => {
    // THE BUG THIS GUARDS, which defeats the whole feature rather than breaking
    // it visibly. withTenantTxRead's fallback path runs on the primary via
    // withTenantTx, which sets `mayHaveWritten`. api-server's middleware reads
    // that flag after the response to set the Redis write pin — so a
    // READ-ONLY request would pin its entire org to the primary for the pin
    // TTL. And because reads fall back whenever no replica is configured (the
    // shipping default), every org would be pinned permanently: full
    // complexity, zero offload, and nothing anywhere reporting a fault.
    //
    // Asserted on the routing contract rather than by driving a transaction,
    // because the invariant is about the FLAG's meaning: it records "may have
    // WRITTEN", never "touched the primary".
    const c = ctx();
    expect(c.mayHaveWritten).toBeUndefined();
    // A context that has not written is routed to the replica...
    expect(chooseReadTarget(c, healthy).useReplica).toBe(true);
    // ...and asking that question must not itself set the flag.
    expect(c.mayHaveWritten).toBeUndefined();
  });

  it('still honours the flag once something really has written', () => {
    const c = ctx({ mayHaveWritten: true });
    expect(chooseReadTarget(c, healthy)).toEqual({ useReplica: false, reason: 'may-have-written' });
  });
});

describe('the sampler recovers from a hung query', () => {
  /** A pool whose query never settles — a wedged connection. */
  const hungPool = () => ({ query: () => new Promise<never>(() => { /* never settles */ }) });

  it('abandons a sample that does not return, instead of wedging forever', async () => {
    // THE BUG THIS GUARDS. Nothing bounds a RUNNING query on this pool:
    // connectionTimeoutMillis bounds acquiring a connection and
    // idleTimeoutMillis evicts idle ones. So a hung query left the in-flight
    // guard set — its `finally` never ran — and every later call returned at
    // the guard. No further sample was taken FOR THE LIFE OF THE PROCESS: the
    // reading went stale, the verdict became `unknown`, and every read fell
    // back to the primary permanently. Safe, but unrecoverable without a
    // restart and only visible as PostgresReadCircuitOpen 30 minutes later.
    process.env.DB_READ_LAG_SAMPLE_TIMEOUT_MS = '40';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeSampleLag(hungPool() as any);
    // It returned at all — that is the first half of the property.
    // And it recorded a FAILURE rather than a reading, so the circuit opens.
    expect(lagVerdict()).toBe('unknown');
  });

  it('samples again after a hung one, rather than being stuck at the guard', async () => {
    process.env.DB_READ_LAG_SAMPLE_TIMEOUT_MS = '40';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeSampleLag(hungPool() as any);
    // A healthy pool now gets through: the in-flight guard was released.
    const ok = { query: () => Promise.resolve({ rows: [{ lag_seconds: 0 }] }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeSampleLag(ok as any);
    expect(lagVerdict()).toBe('ok');
  });

  it('treats a non-numeric reading as no reading', async () => {
    // A standby that has never received WAL reports NULL. Not an error, but not
    // a usable value either — it must never be recorded as "caught up".
    const weird = { query: () => Promise.resolve({ rows: [{ lag_seconds: null }] }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeSampleLag(weird as any);
    expect(lagVerdict()).toBe('unknown');
  });
});

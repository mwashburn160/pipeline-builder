// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The read path's structural guarantees, asserted against the SOURCE.
 *
 * These are properties a behavioural test cannot defend, because the failure
 * they describe is a later refactor that keeps every test passing while
 * removing the point of the feature: a read connection quietly pointed back at
 * the primary leaves all of the complexity and none of the offload, and nothing
 * anywhere reports a fault. The plan asked for exactly this
 * ("a contract test asserting the read connection is configured read-only, so a
 * later refactor cannot quietly point it at the primary").
 *
 * Source-level rather than runtime because the invariants are about WIRING —
 * which module may reach which pool — and that is not observable from inside a
 * single call.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';

const SRC = join(import.meta.dirname, '..', 'src', 'database');
const read = (f: string) => readFileSync(join(SRC, f), 'utf-8');

const readConnection = read('read-connection.ts');
const tenancy = read('tenancy.ts');

describe('the read connection cannot become the primary', () => {
  it('never imports the primary drizzle instance', () => {
    // `db` is the primary. If this module could reach it, the fallback path and
    // the replica path would differ by a variable rather than by a pool, and
    // the kill switch would stop meaning anything.
    const imports = readConnection.split('\n').filter((l) => /^import /.test(l)).join('\n');
    expect(imports).not.toMatch(/\bdb\b/);
    // getSslConfig is the one thing it legitimately shares with the primary
    // module — TLS settings, not a connection.
    expect(imports).toContain('getSslConfig');
  });

  it('names its own host AND its own database, never the primary\'s', () => {
    expect(readConnection).toContain("envStr('DB_READ_HOST'");
    // The DATABASE name is what routes to the standby — DB_READ_HOST is the
    // same pooler the write path uses. Defaulting this to `DATABASE` would send
    // every "read" back to the primary's pool through a second connection pool:
    // all of the cost, none of the benefit, and no error anywhere.
    expect(readConnection).toContain("envStr('DB_READ_DATABASE'");
    expect(readConnection).not.toMatch(/database:\s*envStr\('DATABASE'/);
  });

  it('keeps a smaller pool than the primary, so reads cannot starve writes', () => {
    // The primary's default is a VARIABLE (`isLambda ? 2 : 20`), not a literal,
    // so this compares against the long-running branch — the only one a read
    // replica is ever reached from, since Lambda invocations are short-lived and
    // do not open a second pool.
    expect(readConnection).toContain("envInt('DB_READ_MAX_POOL_SIZE'");
    const readDflt = Number(/envInt\('DB_READ_MAX_POOL_SIZE',\s*(\d+)\)/.exec(readConnection)?.[1]);
    const primary = read('postgres-connection.ts');
    expect(primary).toContain("envInt('DRIZZLE_MAX_POOL_SIZE', defaultPoolSize)");
    const longRunning = Number(/defaultPoolSize = isLambda \? \d+ : (\d+)/.exec(primary)?.[1]);
    expect({ readDflt: Number.isFinite(readDflt), longRunning: Number.isFinite(longRunning) })
      .toEqual({ readDflt: true, longRunning: true });
    expect(readDflt).toBeLessThan(longRunning);
  });

  it('returns null rather than a primary pool when no replica is configured', () => {
    // The fallback must be ABSENCE, not substitution. A getReadPool() that
    // handed back the primary would make every caller "work" while the routing
    // decision became a lie, and chooseReadTarget would report 'replica'.
    expect(readConnection).toMatch(/if \(!isReadReplicaConfigured\(\)\) return null;/);
  });

  it('takes the configured-predicate from api-core, not a local copy', () => {
    // It lives in api-core because api-server's tenant-context middleware needs
    // it too, and that middleware runs in EVERY service — 91 suites stub
    // pipeline-data with `stubModule`, which throws on a non-overridden export,
    // so a value import from there turned all of them into a 500. api-core's
    // mocks spread requireActual, so a symbol there costs no stub edits.
    //
    // Asserted as ABSENCE of a second definition: two copies of "is a replica
    // configured" would drift, and the drift would read as a working kill
    // switch that only half the code honours.
    expect(readConnection).toContain('isReadReplicaConfigured');
    expect(readConnection).not.toMatch(/export function isReadReplicaConfigured/);
    expect(readConnection).not.toMatch(/envBool\('DB_READ_ENABLED'/);
  });

  it('never lets a replica-pool error take the process down', () => {
    // Every read can be served by the primary, so an idle-client error on the
    // standby must not be fatal — but a `pool.on('error')` that rethrew, or no
    // handler at all, crashes node on an unhandled 'error' event.
    // Matched to the first `});` after the registration rather than to a fixed
    // indentation, so reformatting the file does not silently empty this.
    const at = readConnection.indexOf("pool.on('error'");
    expect(at).toBeGreaterThan(-1);
    const handler = readConnection.slice(at, readConnection.indexOf('});', at) + 3);
    expect(handler).toContain('logger.error');
    // COMMENTS STRIPPED before looking for `throw`. The handler's own comment
    // says "Never throw from here", so matching the raw text finds the word in
    // the prose explaining why it is absent — which is how a guard ends up
    // asserting the opposite of what it means.
    const code = handler.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bthrow\b/);
  });
});

describe('the read helper is read-only on EVERY path', () => {
  it('declares the transaction read-only on the replica AND the primary fallback', () => {
    // Two occurrences, deliberately. Phase 0a found four call sites that look
    // like reads and are not (`SELECT … FOR UPDATE`, `pg_advisory_xact_lock`).
    // Declaring it on the fallback path too makes such a call fail HERE, with a
    // clear message, on every target — including the ones that will never have
    // a replica, where it would otherwise succeed and quietly take a lock.
    const occurrences = tenancy.match(/SET TRANSACTION READ ONLY/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('routes through chooseReadTarget rather than deciding inline', () => {
    // The decision has to be inspectable and testable without a replica, which
    // is the only way it CAN be tested here: the substrate is PGlite, which has
    // no replication at all.
    expect(tenancy).toContain('chooseReadTarget(ctx, {');
    expect(tenancy).toContain('lag: lagVerdict()');
  });

  it('emits the routing reason, so an idle replica is explainable', () => {
    // Without this the question "why is my replica idle" has no answer short of
    // reading code — and the four reasons have four different fixes.
    expect(tenancy).toMatch(/emitCounter\('postgres_read_routed_total'/);
  });

  it('treats an unknown lag exactly like an excessive one', () => {
    // Fail closed. The states that produce `unknown` are all real (no sample
    // yet, the sample failed, the sampler stopped), and in every one of them a
    // replica read could return arbitrarily old data.
    expect(tenancy).toMatch(/health\.lag !== 'ok'/);
  });

  it('does not mark a read as a write', () => {
    // withTenantTxRead's fallback runs on the primary via withTenantTx, which
    // sets `mayHaveWritten` — and api-server's middleware turns that flag into
    // a Redis write pin. Without the opt-out, a READ-ONLY request would pin its
    // whole org to the primary, permanently, since reads fall back whenever no
    // replica is configured.
    expect(tenancy).toMatch(/markWritten/);
    expect(tenancy).toMatch(/\/\* markWritten \*\/ false/);
  });
});

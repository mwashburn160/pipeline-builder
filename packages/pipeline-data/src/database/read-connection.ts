// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The read-replica connection — a second pool pointed at a streaming standby.
 *
 * Shaped after {@link ./public-reader.ts}: a separate, smaller pool that
 * connects like every other client (through pgbouncer), rather than a second
 * target bolted onto the primary pool. As with the public reader, what selects
 * the backend is the pgbouncer DATABASE name — `pipeline_builder_read`, whose
 * `[databases]` entry points at the `postgres-read` Service — not the host.
 * `DB_READ_HOST` is pgbouncer on every target, exactly like `DB_HOST`. It carries the SAME application role and
 * the SAME RLS policies — a physical standby replicates `pg_authid` and every
 * policy — so `withTenantTxRead` sets the identical GUCs here that
 * `withTenantTx` sets on the primary.
 *
 * NOT CONFIGURED IS THE NORMAL STATE UNTIL A REPLICA EXISTS. With `DB_READ_HOST`
 * unset, {@link getReadPool} returns null and every caller falls back to the
 * primary. That is what lets this module ship before any infrastructure does,
 * and it is also the degraded path the kill switch and (later) the lag circuit
 * fall back to — so it has to keep working and be tested deliberately, not only
 * exercised by accident on a laptop.
 *
 * WHY A SEPARATE MODULE rather than a flag on `Connection`: a global whose
 * target can change is how a write reaches a standby. `Connection` stays the
 * primary, unconditionally, and callers that want a replica have to ask for one
 * by name.
 */

import { createLogger, envInt, envStr, isReadReplicaConfigured } from '@pipeline-builder/api-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import { schema } from './drizzle-schema.js';
import { getSslConfig } from './postgres-connection.js';

const logger = createLogger('database-read');

let pool: Pool | null = null;
let readDb: ReturnType<typeof drizzle> | null = null;
/** Set once so a misconfigured deploy does not log on every query. */
let warned = false;

/**
 * The replica pool, or null when no replica is configured.
 *
 * Lazily created so importing this module costs nothing on a deploy that has no
 * replica — which, until Phase 1 lands, is all of them.
 */
export function getReadPool(): Pool | null {
  if (!isReadReplicaConfigured()) return null;
  if (pool) return pool;

  const host = envStr('DB_READ_HOST', '');
  const config: PoolConfig = {
    host,
    port: envInt('DB_READ_PORT', envInt('DB_PORT', 5432)),
    // A DIFFERENT pgbouncer database than the write path, and that is the whole
    // point: reads go to `pipeline_builder_read`, whose `[databases]` entry
    // names `host=postgres-read` — the Service in front of the standbys. The
    // primary's pool (`pipeline_builder`) names `host=postgres`.
    //
    // So the thing that decides whether a read reaches a replica is the
    // DATABASE NAME, not the host: DB_READ_HOST is pgbouncer on every target,
    // the same pooler the write path uses. Defaulting this to `DATABASE` would
    // send every "read" straight back to the primary's pool through a second
    // connection pool — all of the complexity, none of the offload, and no
    // error anywhere to say so.
    database: envStr('DB_READ_DATABASE', 'pipeline_builder_read'),
    // The SAME application role as the primary. A standby replicates the role
    // catalog, so a second credential would be a second thing to rotate for no
    // benefit — and a role that existed only on the replica would vanish the
    // moment the standby was re-seeded from a base backup.
    user: envStr('DB_USER', 'postgres'),
    password: process.env.DB_PASSWORD ?? '',
    // Deliberately smaller than the primary's. Read traffic must not be able to
    // exhaust connections the write path needs, and the replica has its own
    // max_connections budget which is NOT the primary's.
    max: envInt('DB_READ_MAX_POOL_SIZE', 10),
    idleTimeoutMillis: envInt('DRIZZLE_IDLE_TIMEOUT_MILLIS', 30_000),
    connectionTimeoutMillis: envInt('DRIZZLE_CONNECTION_TIMEOUT_MILLIS', 5000),
    ssl: getSslConfig(),
    allowExitOnIdle: true,
  };

  pool = new Pool(config);
  pool.on('error', (err) => {
    // Never throw from here: an idle-client error on the REPLICA must not take
    // the process down, because every read can be served by the primary.
    logger.error('Read-replica pool error (reads fall back to the primary)', err);
  });
  readDb = drizzle(pool, { schema });

  logger.info('Read-replica connection initialized', { host, max: config.max });
  return pool;
}

/** The replica's drizzle instance, or null when no replica is configured. */
export function getReadDb(): ReturnType<typeof drizzle> | null {
  if (!getReadPool()) {
    if (!warned && envStr('DB_READ_HOST', '').trim().length > 0) {
      warned = true;
      logger.info('Read replica is configured but disabled (DB_READ_ENABLED=false); reads use the primary');
    }
    return null;
  }
  return readDb;
}

/**
 * Close the replica pool. Called from `closeConnection()` so a shutdown closes
 * BOTH pools — a half-closed process holds server connections open on the
 * standby and keeps its replication slot busy.
 */
export async function closeReadConnection(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  readDb = null;
  warned = false;
  await p.end();
  logger.info('Read-replica connection closed');
}

/** Test seam: forget the memoized pool without closing it. */
export function resetReadConnectionForTests(): void {
  pool = null;
  readDb = null;
  warned = false;
}

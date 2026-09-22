// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The anonymous public plugin directory's database connection.
 *
 * A second, SMALL pool that logs in as `ecosystem_public_reader` — a role that
 * can SELECT the `public_*` views and nothing else (postgres-init.sql). It
 * connects like every other client, THROUGH pgbouncer (`DB_HOST` / `DB_PORT`),
 * to the dedicated `pipeline_builder_public` pool, which pgbouncer caps at 5
 * server connections for this user across all pools. It is never the
 * application role and never carries a tenant context: the views filter to
 * public rows themselves, so there is nothing to scope.
 *
 * Not configured (no `ECOSYSTEM_PUBLIC_READER_PASSWORD`) → the public directory
 * is off; callers check {@link isPublicReaderConfigured} and answer 404.
 */

import { envInt } from '@pipeline-builder/api-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './drizzle-schema.js';
import { getSslConfig } from './postgres-connection.js';

/** The reader role's fixed name (postgres-init.sql creates exactly this role). */
export const PUBLIC_READER_ROLE = 'ecosystem_public_reader';

let pool: Pool | null = null;
let readerDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** Whether the public reader login is configured (the directory can serve). */
export function isPublicReaderConfigured(): boolean {
  return (process.env.ECOSYSTEM_PUBLIC_READER_PASSWORD ?? '') !== '';
}

/**
 * The reader's Drizzle instance, created on first use.
 *
 * @throws when the reader isn't configured — check {@link isPublicReaderConfigured} first.
 */
export function getPublicReaderDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (readerDb) return readerDb;
  if (!isPublicReaderConfigured()) {
    throw new Error('ECOSYSTEM_PUBLIC_READER_PASSWORD is not set: the public plugin directory is disabled');
  }
  pool = new Pool({
    host: process.env.DB_HOST || 'pgbouncer',
    port: envInt('DB_PORT', 6432, { min: 1 }),
    database: process.env.PUBLIC_DIRECTORY_DB_NAME || 'pipeline_builder_public',
    user: PUBLIC_READER_ROLE,
    password: process.env.ECOSYSTEM_PUBLIC_READER_PASSWORD,
    // Below pgbouncer's per-user cap (5), so a replica never queues inside pgbouncer.
    max: envInt('PUBLIC_DIRECTORY_POOL_SIZE', 4, { min: 1 }),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: envInt('DRIZZLE_CONNECTION_TIMEOUT_MILLIS', 5000, { min: 1 }),
    // Client-side bound on one directory query. pgbouncer (transaction mode)
    // refuses a `statement_timeout` startup parameter, so it can't be set there.
    query_timeout: envInt('PUBLIC_DIRECTORY_QUERY_TIMEOUT_MS', 5000, { min: 1 }),
    ssl: getSslConfig(),
    allowExitOnIdle: true,
  });
  readerDb = drizzle(pool, { schema });
  return readerDb;
}

/** Close the reader pool (graceful shutdown; tests). */
export async function closePublicReader(): Promise<void> {
  const p = pool;
  pool = null;
  readerDb = null;
  if (p) await p.end();
}

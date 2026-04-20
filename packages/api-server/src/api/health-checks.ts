// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getConnection } from '@pipeline-builder/pipeline-core';

type HealthStatus = 'connected' | 'disconnected' | 'unknown';
type HealthResult = Record<string, HealthStatus>;

/**
 * Postgres health probe: returns `{ postgres: 'connected' }` when the pool's
 * connection test succeeds, `{ postgres: 'unknown' }` otherwise. Use as the
 * `checkDependencies` option of `createApp()` for any service backed by the
 * shared pipeline-data Drizzle connection.
 */
export async function postgresHealthCheck(): Promise<HealthResult> {
  try {
    await getConnection().testConnection();
    return { postgres: 'connected' };
  } catch {
    return { postgres: 'unknown' };
  }
}

/**
 * Minimal shape expected of a mongoose connection for the health probe.
 * Accepts `mongoose.connection` directly without requiring mongoose as a
 * dependency of api-server.
 */
interface MongooseConnectionLike {
  readyState: number;
}

/**
 * MongoDB health probe factory: pass `mongoose.connection` and get back a
 * `checkDependencies` callback that reports `{ mongodb: 'connected' |
 * 'disconnected' | 'unknown' }` based on mongoose's readyState. Use for
 * services backed by mongoose.
 */
export function mongoHealthCheck(connection: MongooseConnectionLike): () => Promise<HealthResult> {
  return async () => ({
    mongodb: connection.readyState === 1 ? 'connected'
      : connection.readyState === 0 ? 'unknown' // starting up
        : 'disconnected',
  });
}

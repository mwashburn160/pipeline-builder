// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drizzle migration runner.
 *
 * Idempotent: safe to call on every service start. drizzle tracks applied
 * migrations in the `__drizzle_migrations` table and skips ones already run.
 *
 * The migration files live at `packages/pipeline-data/drizzle/` and are
 * generated from the `drizzle-schema.ts` source via `pnpm db:generate`
 * (which invokes `drizzle-kit generate`).
 *
 * For brand-new deploys, `postgres-init.sql` still creates the baseline
 * tables — the migration runner will skip its initial baseline migration
 * because the tables already exist (drizzle uses CREATE TABLE IF NOT EXISTS
 * by default for the snapshot-based generator). Future schema changes ship
 * as additive migrations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@pipeline-builder/api-core';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getConnection } from './postgres-connection';

const logger = createLogger('migrator');

export interface MigrateOptions {
  /** Absolute path to the migrations folder. Defaults to `<package>/drizzle`. */
  migrationsFolder?: string;
  /** Schema-qualified migrations table name. Defaults to `__drizzle_migrations`. */
  migrationsTable?: string;
  /** Skip the runner entirely (for tests or when a deploy uses an external migration tool). */
  skip?: boolean;
}

/** Resolve the default migrations folder relative to this package. */
function defaultMigrationsFolder(): string {
  // src/database/migrator.ts → up two levels → package root, then ./drizzle
  return path.resolve(__dirname, '..', '..', 'drizzle');
}

/**
 * Run any pending Drizzle migrations against the configured Postgres.
 *
 * No-ops gracefully when:
 *   - `options.skip` is true
 *   - `RUN_DB_MIGRATIONS` env var is set to a falsy value (`0`/`false`)
 *   - the migrations folder doesn't exist (fresh repo, nothing generated yet)
 *
 * Throws on any actual migration failure so the service refuses to start
 * with a half-applied schema.
 */
export async function runMigrations(options: MigrateOptions = {}): Promise<void> {
  if (options.skip) {
    logger.info('Migration runner skipped via options.skip');
    return;
  }

  const envFlag = process.env.RUN_DB_MIGRATIONS;
  if (envFlag !== undefined && (envFlag === '0' || envFlag.toLowerCase() === 'false')) {
    logger.info('Migration runner skipped via RUN_DB_MIGRATIONS env');
    return;
  }

  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder();
  if (!fs.existsSync(migrationsFolder)) {
    logger.info('No migrations folder found, nothing to run', { migrationsFolder });
    return;
  }

  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    logger.info('No drizzle journal found, nothing to run', { journalPath });
    return;
  }

  const conn = getConnection();
  const migrationsTable = options.migrationsTable ?? '__drizzle_migrations';

  logger.info('Running pending Drizzle migrations', { migrationsFolder, migrationsTable });
  try {
    await migrate(conn.db, { migrationsFolder, migrationsTable });
    logger.info('Drizzle migrations complete');
  } catch (err) {
    logger.error('Drizzle migration failed — refusing to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

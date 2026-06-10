// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the migration runner.
 * Verifies the no-op short-circuits (skip flag, env disable, missing folder)
 * — actual `migrate()` invocation is exercised in integration tests against
 * a real Postgres.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const migrateFn = jest.fn();

jest.unstable_mockModule('drizzle-orm/node-postgres/migrator', () => ({
  migrate: (...args: unknown[]) => migrateFn(...args),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const getConnection = jest.fn<() => { db: { __mock: boolean } }>().mockReturnValue({ db: { __mock: true } });
jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({
  getConnection: () => getConnection(),
}));

const { runMigrations } = await import('../src/database/migrator.js');

describe('runMigrations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RUN_DB_MIGRATIONS;
  });

  it('no-ops when options.skip is true', async () => {
    await runMigrations({ skip: true });
    expect(migrateFn).not.toHaveBeenCalled();
  });

  it('no-ops when RUN_DB_MIGRATIONS=0', async () => {
    process.env.RUN_DB_MIGRATIONS = '0';
    await runMigrations();
    expect(migrateFn).not.toHaveBeenCalled();
  });

  it('no-ops when RUN_DB_MIGRATIONS=false (case-insensitive)', async () => {
    process.env.RUN_DB_MIGRATIONS = 'FALSE';
    await runMigrations();
    expect(migrateFn).not.toHaveBeenCalled();
  });

  it('no-ops when migrations folder does not exist', async () => {
    await runMigrations({ migrationsFolder: '/nonexistent-folder-for-tests' });
    expect(migrateFn).not.toHaveBeenCalled();
  });

  it('runs migrate() when folder + journal both exist', async () => {
    const tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    fs.mkdirSync(path.join(tmpFolder, 'meta'), { recursive: true });
    fs.writeFileSync(path.join(tmpFolder, 'meta', '_journal.json'), '{}');

    migrateFn.mockResolvedValue(undefined);
    await runMigrations({ migrationsFolder: tmpFolder });

    expect(migrateFn).toHaveBeenCalledTimes(1);
    expect(migrateFn).toHaveBeenCalledWith(
      { __mock: true },
      expect.objectContaining({ migrationsFolder: tmpFolder, migrationsTable: '__drizzle_migrations' }),
    );
  });

  it('rethrows when migrate() fails so the service refuses to start', async () => {
    const tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    fs.mkdirSync(path.join(tmpFolder, 'meta'), { recursive: true });
    fs.writeFileSync(path.join(tmpFolder, 'meta', '_journal.json'), '{}');

    migrateFn.mockRejectedValue(new Error('boom'));
    await expect(runMigrations({ migrationsFolder: tmpFolder })).rejects.toThrow('boom');
  });

  it('respects a custom migrationsTable option', async () => {
    const tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    fs.mkdirSync(path.join(tmpFolder, 'meta'), { recursive: true });
    fs.writeFileSync(path.join(tmpFolder, 'meta', '_journal.json'), '{}');

    migrateFn.mockResolvedValue(undefined);
    await runMigrations({ migrationsFolder: tmpFolder, migrationsTable: 'my_migrations' });
    expect(migrateFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ migrationsTable: 'my_migrations' }),
    );
  });
});

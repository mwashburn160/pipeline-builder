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

const migrateFn = jest.fn();

jest.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: (...args: unknown[]) => migrateFn(...args),
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }),
}));

const getConnection = jest.fn().mockReturnValue({ db: { __mock: true } });
jest.mock('../src/database/postgres-connection', () => ({
  getConnection: () => getConnection(),
}));

import { runMigrations } from '../src/database/migrator';

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

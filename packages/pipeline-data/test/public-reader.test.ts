// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for database/public-reader — the anonymous directory's view-only
 * connection. `pg` is stubbed; these pin that it logs in as the reader role
 * THROUGH pgbouncer to the dedicated public pool, stays under pgbouncer's
 * per-user cap, and is off (throws) without a password.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const poolConfigs: Array<Record<string, unknown>> = [];
const ended: number[] = [];
jest.unstable_mockModule('pg', () => ({
  Pool: class {
    constructor(cfg: Record<string, unknown>) { poolConfigs.push(cfg); }
    async end() { ended.push(1); }
  },
}));
jest.unstable_mockModule('drizzle-orm/node-postgres', () => ({ drizzle: jest.fn(() => ({ __db: true })) }));
jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ getSslConfig: () => undefined }));
jest.unstable_mockModule('../src/database/drizzle-schema.js', () => ({}));

const reader = await import('../src/database/public-reader.js');

const ENV_KEYS = ['ECOSYSTEM_PUBLIC_READER_PASSWORD', 'DB_HOST', 'DB_PORT', 'PUBLIC_DIRECTORY_DB_NAME', 'PUBLIC_DIRECTORY_POOL_SIZE', 'PUBLIC_DIRECTORY_QUERY_TIMEOUT_MS'];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  poolConfigs.length = 0;
  ended.length = 0;
  await reader.closePublicReader();
  ended.length = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('public reader connection', () => {
  it('is off without a password', () => {
    expect(reader.isPublicReaderConfigured()).toBe(false);
    expect(() => reader.getPublicReaderDb()).toThrow(/ECOSYSTEM_PUBLIC_READER_PASSWORD/);
    expect(poolConfigs).toHaveLength(0);
  });

  it('logs in as the reader role through pgbouncer to the public pool, by default', () => {
    process.env.ECOSYSTEM_PUBLIC_READER_PASSWORD = 's3cret';
    expect(reader.isPublicReaderConfigured()).toBe(true);
    reader.getPublicReaderDb();
    expect(poolConfigs[0]).toMatchObject({
      host: 'pgbouncer',
      port: 6432,
      database: 'pipeline_builder_public',
      user: reader.PUBLIC_READER_ROLE,
      password: 's3cret',
      max: 4,
      query_timeout: 5000,
    });
    expect(reader.PUBLIC_READER_ROLE).toBe('ecosystem_public_reader');
  });

  it('honours the env overrides and ignores invalid numbers', () => {
    Object.assign(process.env, {
      ECOSYSTEM_PUBLIC_READER_PASSWORD: 'x',
      DB_HOST: 'pooler',
      DB_PORT: '7000',
      PUBLIC_DIRECTORY_DB_NAME: 'pub',
      PUBLIC_DIRECTORY_POOL_SIZE: 'lots',
      PUBLIC_DIRECTORY_QUERY_TIMEOUT_MS: '1500',
    });
    reader.getPublicReaderDb();
    expect(poolConfigs[0]).toMatchObject({ host: 'pooler', port: 7000, database: 'pub', max: 4, query_timeout: 1500 });
  });

  it('creates one pool, and a fresh one after close', async () => {
    process.env.ECOSYSTEM_PUBLIC_READER_PASSWORD = 'x';
    const a = reader.getPublicReaderDb();
    expect(reader.getPublicReaderDb()).toBe(a);
    expect(poolConfigs).toHaveLength(1);
    await reader.closePublicReader();
    expect(ended).toHaveLength(1);
    reader.getPublicReaderDb();
    expect(poolConfigs).toHaveLength(2);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two pools' wiring and lifecycle decisions, over a stub `pg.Pool`:
 *
 * - the primary `Connection`: env → pool config, the singleton, the health
 *   probe (which must release its client even when the probe throws), the
 *   graceful close (with its timeout), the lazy `db` proxy, and the
 *   production refusal of an empty DB_PASSWORD;
 * - the read replica: OFF (null, callers fall back to the primary) unless
 *   configured, the `pipeline_builder_read` pgbouncer database by default (the
 *   name is what routes to the standby), memoized, closed together with the
 *   primary, and an idle-client error that never throws.
 *
 * SSL precedence is ssl-config.test.ts; the read path's source-level guarantees
 * are read-connection-contract.test.ts.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

interface FakeClient { query: jest.Mock<AnyFn>; release: jest.Mock<AnyFn> }
const pools: FakePool[] = [];
class FakePool {
  readonly handlers: Record<string, (arg?: unknown) => void> = {};
  totalCount = 3;
  idleCount = 2;
  waitingCount = 1;
  client: FakeClient = { query: jest.fn<AnyFn>(async () => ({ rows: [{ '?column?': 1 }] })), release: jest.fn<AnyFn>() };
  connect = jest.fn<AnyFn>(async () => this.client);
  end = jest.fn<AnyFn>(async () => undefined);
  constructor(readonly config: Record<string, unknown>) { pools.push(this); }
  on(event: string, fn: (arg?: unknown) => void) { this.handlers[event] = fn; return this; }
}
jest.unstable_mockModule('pg', () => ({ Pool: FakePool, default: { Pool: FakePool } }));
jest.unstable_mockModule('drizzle-orm/node-postgres', () => ({
  drizzle: (pool: FakePool) => ({ pool, select: function select(this: { pool: FakePool }) { return this.pool; } }),
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { Connection, db, closeConnection, testConnection, getConnection } = await import('../src/database/postgres-connection.js');
const read = await import('../src/database/read-connection.js');

const ENV_KEYS = ['DB_HOST', 'DB_PORT', 'DATABASE', 'DB_USER', 'DB_PASSWORD', 'NODE_ENV', 'DRIZZLE_MAX_POOL_SIZE',
  'DB_READ_HOST', 'DB_READ_ENABLED', 'DB_READ_DATABASE', 'DB_READ_PORT', 'DB_READ_MAX_POOL_SIZE', 'DB_SSL', 'PGSSLMODE'];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.NODE_ENV = 'test';
  pools.length = 0;
  await Connection.reset(false);
  read.resetReadConnectionForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('primary Connection', () => {
  it('builds the pool from the environment', () => {
    Object.assign(process.env, { DB_HOST: 'pgbouncer', DB_PORT: '6432', DATABASE: 'pb', DB_USER: 'app', DB_PASSWORD: 's3cret', DRIZZLE_MAX_POOL_SIZE: '7' });
    Connection.getInstance({ enableLogging: false });
    expect(pools[0]!.config).toMatchObject({ host: 'pgbouncer', port: 6432, database: 'pb', user: 'app', password: 's3cret', max: 7, ssl: false, allowExitOnIdle: true });
  });

  it('is a singleton until reset', async () => {
    const a = Connection.getInstance({ enableLogging: false });
    expect(Connection.getInstance()).toBe(a);
    expect(getConnection()).toBe(a);
    expect(pools).toHaveLength(1);
    await Connection.reset(true);
    expect(pools[0]!.end).toHaveBeenCalled();
    expect(Connection.getInstance({ enableLogging: false })).not.toBe(a);
  });

  it('refuses an empty DB_PASSWORD in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => Connection.getInstance({ enableLogging: false })).toThrow('Database initialization failed');
  });

  it('testConnection: true on a row, false on a failure — and releases the client even when the probe throws', async () => {
    const c = Connection.getInstance({ enableLogging: false });
    await expect(c.testConnection()).resolves.toBe(true);
    const pool = pools[0]!;
    pool.client.query.mockRejectedValueOnce(new Error('server closed the connection'));
    await expect(testConnection()).resolves.toBe(false);
    expect(pool.client.release).toHaveBeenCalledTimes(2);
    pool.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(c.testConnection()).resolves.toBe(false);
  });

  it('reports pool statistics', () => {
    expect(Connection.getInstance({ enableLogging: false }).getStats()).toEqual({ totalCount: 3, idleCount: 2, waitingCount: 1 });
  });

  it('close: ends the pool; a close that hangs past the timeout rejects; isClosing is reset either way', async () => {
    const c = Connection.getInstance({ enableLogging: false });
    await c.close(50);
    expect(pools[0]!.end).toHaveBeenCalledTimes(1);
    pools[0]!.end.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(c.close(10)).rejects.toThrow('Connection close timeout');
    expect(c.isClosing()).toBe(false);
  });

  it('close: a prompt close clears its timeout timer (does not hold the event loop open)', async () => {
    const c = Connection.getInstance({ enableLogging: false });
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    try {
      await c.close(60_000);
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('close while already closing is a no-op', async () => {
    const c = Connection.getInstance({ enableLogging: false });
    let finish: () => void = () => undefined;
    pools[0]!.end.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
    const first = c.close(1000);
    expect(c.isClosing()).toBe(true);
    await c.close(1000);
    expect(pools[0]!.end).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it('the db proxy creates the connection lazily and binds methods to it', () => {
    expect(pools).toHaveLength(0);
    const select = (db as unknown as { select: () => unknown }).select;
    expect(pools).toHaveLength(1);
    expect(select()).toBe(pools[0]);
  });

  it('an idle-client error is logged, never thrown', () => {
    Connection.getInstance({ enableLogging: false, enableAutoRetry: false });
    expect(() => pools[0]!.handlers.error!(new Error('idle client terminated'))).not.toThrow();
  });
});

describe('read replica', () => {
  it('is OFF (null) when DB_READ_HOST is unset — callers fall back to the primary', () => {
    expect(read.getReadPool()).toBeNull();
    expect(read.getReadDb()).toBeNull();
    expect(pools).toHaveLength(0);
  });

  it('is OFF when the kill switch is thrown, even with a host', () => {
    Object.assign(process.env, { DB_READ_HOST: 'pgbouncer', DB_READ_ENABLED: 'false' });
    expect(read.getReadDb()).toBeNull();
    expect(read.getReadDb()).toBeNull();
    expect(pools).toHaveLength(0);
  });

  it('connects to the pipeline_builder_read database by default (the NAME routes to the standby), with its own smaller pool', () => {
    Object.assign(process.env, { DB_READ_HOST: 'pgbouncer', DB_PORT: '6432', DB_USER: 'app', DB_PASSWORD: 'pw' });
    const pool = read.getReadPool() as unknown as FakePool;
    expect(pool.config).toMatchObject({ host: 'pgbouncer', port: 6432, database: 'pipeline_builder_read', user: 'app', password: 'pw', max: 10 });
    // Memoized: one pool however many callers ask.
    expect(read.getReadPool()).toBe(pool);
    expect(read.getReadDb()).toEqual(expect.objectContaining({ pool }));
    expect(pools).toHaveLength(1);
  });

  it('DB_READ_DATABASE / DB_READ_PORT / DB_READ_MAX_POOL_SIZE override the defaults', () => {
    Object.assign(process.env, { DB_READ_HOST: 'h', DB_READ_DATABASE: 'replica_db', DB_READ_PORT: '7000', DB_READ_MAX_POOL_SIZE: '3' });
    expect((read.getReadPool() as unknown as FakePool).config).toMatchObject({ database: 'replica_db', port: 7000, max: 3 });
  });

  it('a replica idle-client error never throws (reads can always use the primary)', () => {
    process.env.DB_READ_HOST = 'h';
    const pool = read.getReadPool() as unknown as FakePool;
    expect(() => pool.handlers.error!(new Error('standby restarted'))).not.toThrow();
  });

  it('closeConnection closes BOTH pools; closing an unopened replica is a no-op', async () => {
    await read.closeReadConnection();
    process.env.DB_READ_HOST = 'h';
    Connection.getInstance({ enableLogging: false });
    const replica = read.getReadPool() as unknown as FakePool;
    await closeConnection();
    expect(pools[0]!.end).toHaveBeenCalled();
    expect(replica.end).toHaveBeenCalled();
    // Forgotten after close: the next ask builds a fresh pool.
    expect(read.getReadPool()).not.toBe(replica);
  });
});

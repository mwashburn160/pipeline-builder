// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Redis environment resolution (services/env-redis.ts) — the one place Redis
 * connection settings are read.
 *
 *   - `REDIS_URL` (standalone) or `REDIS_SENTINELS` (HA), never both;
 *   - `REDIS_HOST` is refused, so a stale config fails at startup instead of
 *     quietly running without Redis;
 *   - the Kubernetes-injected `REDIS_PORT=tcp://…` is ignored;
 *   - nothing configured → `null` (callers degrade).
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  RedisConfigError,
  createEnvRedisClient,
  describeRedisConnection,
  parseSentinels,
  resolveRedisConnection,
  whenRedisReady,
} from '../src/services/env-redis.js';

describe('parseSentinels', () => {
  it('parses a comma-separated host:port list', () => {
    expect(parseSentinels('s1:26379,s2:26380')).toEqual([
      { host: 's1', port: 26379 },
      { host: 's2', port: 26380 },
    ]);
  });

  it('defaults a missing port to 26379 and trims whitespace', () => {
    expect(parseSentinels(' a , b:12345 ')).toEqual([
      { host: 'a', port: 26379 },
      { host: 'b', port: 12345 },
    ]);
  });

  it('returns [] for unset / empty / all-blank input', () => {
    expect(parseSentinels(undefined)).toEqual([]);
    expect(parseSentinels('')).toEqual([]);
    expect(parseSentinels(' , , ')).toEqual([]);
  });

  it('REFUSES a port that is not a TCP port, instead of guessing', () => {
    expect(() => parseSentinels('h:notaport')).toThrow(RedisConfigError);
    expect(() => parseSentinels('h:70000')).toThrow(RedisConfigError);
  });
});

describe('resolveRedisConnection', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveRedisConnection({})).toBeNull();
  });

  it('resolves REDIS_URL, with REDIS_PASSWORD kept out of the URL', () => {
    expect(resolveRedisConnection({ REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'pw' }))
      .toEqual({ mode: 'url', url: 'redis://redis:6379', password: 'pw' });
  });

  it('resolves Sentinel with master name and both passwords', () => {
    expect(resolveRedisConnection({
      REDIS_SENTINELS: 's1:26379,s2:26379',
      REDIS_SENTINEL_MASTER: 'primary',
      REDIS_PASSWORD: 'data',
      REDIS_SENTINEL_PASSWORD: 'sent',
    })).toEqual({
      mode: 'sentinel',
      sentinels: [{ host: 's1', port: 26379 }, { host: 's2', port: 26379 }],
      masterName: 'primary',
      password: 'data',
      sentinelPassword: 'sent',
    });
  });

  it('defaults the Sentinel master name to mymaster', () => {
    const conn = resolveRedisConnection({ REDIS_SENTINELS: 's1' });
    expect(conn).toMatchObject({ mode: 'sentinel', masterName: 'mymaster' });
  });

  it('REFUSES REDIS_HOST — a stale config must not silently mean "no Redis"', () => {
    expect(() => resolveRedisConnection({ REDIS_HOST: 'redis', REDIS_PORT: '6379' })).toThrow(/REDIS_HOST is not supported/);
  });

  it('ignores the Kubernetes service-link REDIS_PORT=tcp://…', () => {
    expect(resolveRedisConnection({ REDIS_PORT: 'tcp://10.98.51.96:6379', REDIS_URL: 'redis://redis:6379' }))
      .toMatchObject({ mode: 'url' });
    expect(resolveRedisConnection({ REDIS_PORT: 'tcp://10.98.51.96:6379' })).toBeNull();
  });

  it('REFUSES both REDIS_URL and REDIS_SENTINELS', () => {
    expect(() => resolveRedisConnection({ REDIS_URL: 'redis://r:6379', REDIS_SENTINELS: 's1:26379' }))
      .toThrow(/not both/);
  });

  it('REFUSES a REDIS_URL that is not redis:// or rediss://', () => {
    expect(() => resolveRedisConnection({ REDIS_URL: 'redis' })).toThrow(RedisConfigError);
    expect(() => resolveRedisConnection({ REDIS_URL: 'http://redis:6379' })).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  it('accepts rediss:// (TLS)', () => {
    expect(resolveRedisConnection({ REDIS_URL: 'rediss://cache.example.com:6380' })).toMatchObject({ mode: 'url' });
  });
});

describe('describeRedisConnection', () => {
  it('never includes credentials', () => {
    const d = describeRedisConnection({ mode: 'url', url: 'rediss://user:secret@cache:6380', password: 'pw' });
    expect(d).toEqual({ mode: 'url', host: 'cache', port: '6380', tls: true });
    expect(JSON.stringify(d)).not.toMatch(/secret|pw/);
  });
});

describe('createEnvRedisClient', () => {
  it('returns null when nothing is configured', () => {
    const saved = { url: process.env.REDIS_URL, sentinels: process.env.REDIS_SENTINELS, host: process.env.REDIS_HOST };
    delete process.env.REDIS_URL; delete process.env.REDIS_SENTINELS; delete process.env.REDIS_HOST;
    try {
      expect(createEnvRedisClient('test')).toBeNull();
    } finally {
      if (saved.url !== undefined) process.env.REDIS_URL = saved.url;
      if (saved.sentinels !== undefined) process.env.REDIS_SENTINELS = saved.sentinels;
      if (saved.host !== undefined) process.env.REDIS_HOST = saved.host;
    }
  });
});

describe('whenRedisReady', () => {
  it('resolves at once for a ready client', async () => {
    await expect(whenRedisReady({ status: 'ready', once: jest.fn() })).resolves.toBeUndefined();
  });

  it('waits for the ready event', async () => {
    let fire: (() => void) | undefined;
    const client = { status: 'connecting', once: (_e: string, cb: () => void) => { fire = cb; }, off: jest.fn() };
    const p = whenRedisReady(client, 1000);
    fire!();
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects after the timeout', async () => {
    const client = { status: 'connecting', once: jest.fn(), off: jest.fn() };
    await expect(whenRedisReady(client, 10)).rejects.toThrow(/not ready/);
  });
});

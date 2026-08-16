// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Redis Sentinel env parsing + the no-Redis-configured gate.
 * `createEnvRedisClient` itself loads ioredis via a guarded require and returns
 * null when it (or the env) is absent — verified here for the unconfigured case;
 * the sentinel-vs-url-vs-host construction is exercised via `parseSentinels`.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { parseSentinels, createEnvRedisClient } from '../src/services/env-redis.js';

const ENV_KEYS = ['REDIS_SENTINELS', 'REDIS_SENTINEL_MASTER', 'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD'];
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe('parseSentinels', () => {
  it('parses a comma-separated host:port list', () => {
    expect(parseSentinels('s1:26379,s2:26379,s3:26379')).toEqual([
      { host: 's1', port: 26379 },
      { host: 's2', port: 26379 },
      { host: 's3', port: 26379 },
    ]);
  });

  it('defaults a missing port to the Sentinel default 26379 + trims whitespace', () => {
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

  it('falls back to 26379 on a non-numeric port', () => {
    expect(parseSentinels('h:notaport')).toEqual([{ host: 'h', port: 26379 }]);
  });
});

describe('createEnvRedisClient gate', () => {
  it('returns null when NOTHING is configured (no sentinels/url/host)', () => {
    expect(createEnvRedisClient('test')).toBeNull();
  });
});

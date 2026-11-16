// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator unlock (`scripts/rate-limit-unlock.ts`) deletes store keys by
 * NAME, so a key it computes differently from the limiter that wrote it clears
 * nothing and reports success. These pin its names to the real key generators.
 */

import { describe, it, expect } from '@jest/globals';
import type express from 'express';

process.env.JWT_SECRET ||= 'rate-limit-unlock-test-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const { unlockTargets, IP_KEYED_AUTH_BUCKETS } = await import('../src/helpers/rate-limit-unlock.js');
const { extractClientIp, rateLimitKey } = await import('../src/middleware/rate-limit-keys.js');
const { loginAccountKey } = await import('../src/middleware/login-limiter.js');

const asReq = (fields: Record<string, unknown>) => ({ headers: {}, ...fields }) as unknown as express.Request;

describe('unlockTargets', () => {
  it('names the per-IP sign-in buckets with the key extractClientIp writes', () => {
    const ip = '203.0.113.7';
    const key = extractClientIp(asReq({ ip }));
    const targets = unlockTargets({ ip });
    for (const bucket of IP_KEYED_AUTH_BUCKETS) {
      expect(targets).toContainEqual({ bucket, key: `rl:platform:${bucket}:${key}` });
    }
  });

  it('names the anonymous general bucket with the key rateLimitKey writes', () => {
    const ip = '203.0.113.7';
    expect(unlockTargets({ ip })).toContainEqual({ bucket: 'general', key: `rl:platform:general:${rateLimitKey(asReq({ ip }))}` });
  });

  it('normalizes an IPv6 address to the /64 the limiter buckets on', () => {
    const a = unlockTargets({ ip: '2001:db8:1:2::1' });
    const b = unlockTargets({ ip: '2001:db8:1:2:ffff::9' });
    expect(a).toEqual(b);
    expect(a[0]!.key).toBe(`rl:platform:auth:${extractClientIp(asReq({ ip: '2001:db8:1:2::1' }))}`);
  });

  it('names the per-account bucket with the key loginAccountKey writes, however the identifier was typed', () => {
    const key = loginAccountKey(asReq({ body: { identifier: 'admin@internal' } }));
    for (const typed of ['admin@internal', ' Admin@Internal ']) {
      expect(unlockTargets({ identifier: typed })).toEqual([{ bucket: 'login-account', key: `rl:platform:login-account:${key}` }]);
    }
  });

  it('names nothing when given nothing', () => {
    expect(unlockTargets({})).toEqual([]);
    expect(unlockTargets({ ip: '  ', identifier: '' })).toEqual([]);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The refresh-rotation grace (helpers/refresh-grace.ts) is BEST-EFFORT on write:
 * the rotation already committed, so a shared-store refusal (production, Redis
 * down) must not fail the refresh and cost the caller the pair it was issued.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';

let redis: { set: jest.Mock; get?: jest.Mock } | null = null;
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({ getRedisClient: async () => redis }));

const { rememberRotation, graceTokensFor } = await import('../src/helpers/refresh-grace.js');

const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 900 } as never;
const prevEnv = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = prevEnv; redis = null; });

describe('rememberRotation', () => {
  it('swallows a production store refusal — the refresh still succeeds', async () => {
    process.env.NODE_ENV = 'production';
    redis = { set: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('down')) } as never;
    await expect(rememberRotation('h1', { userId: 'u1', sessionId: 's1', tokens })).resolves.toBeUndefined();
  });

  it('answers a racing loser from the grace entry for the same user and slot only', async () => {
    process.env.NODE_ENV = 'test';
    await rememberRotation('h2', { userId: 'u1', sessionId: 's1', tokens });
    await expect(graceTokensFor('h2', 'u1', 's1')).resolves.toBe(tokens);
    await expect(graceTokensFor('h2', 'u1', 'other')).resolves.toBeNull();
  });
});

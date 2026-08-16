// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for rateLimitByOrg — the per-organization limiter. Drives the real
 * express-rate-limit middleware with its in-memory store (no Redis) and asserts:
 * per-org bucketing, independent buckets across orgs, a 429 over the cap, and
 * that verified service principals are skipped.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendError = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: mockSendError,
  // In-memory store path (no Redis configured).
  createEnvRedisClient: () => null,
  // A request is a service principal iff we tagged it so.
  verifyServicePrincipal: (req: { serviceToken?: boolean }) => req?.serviceToken === true,
}));

const { rateLimitByOrg } = await import('../src/api/rate-limit-by-org.js');

interface MockReq { ip: string; user?: { organizationId: string }; serviceToken?: boolean }

/** Invoke the middleware once and resolve after its async store settles. */
function run(mw: (req: unknown, res: unknown, next: () => void) => void, req: MockReq): Promise<{ nexted: boolean }> {
  const res = { setHeader: jest.fn(), getHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return new Promise((resolve) => setImmediate(() => resolve({ nexted })));
}

describe('rateLimitByOrg', () => {
  beforeEach(() => { mockSendError.mockReset(); });

  it('allows up to the cap then 429s the same org', async () => {
    const mw = rateLimitByOrg({ name: 'test-a', max: 2, windowMs: 60_000 });
    const req: MockReq = { ip: '10.0.0.1', user: { organizationId: 'org-1' } };

    expect((await run(mw, req)).nexted).toBe(true);
    expect((await run(mw, req)).nexted).toBe(true);
    // Third within the window is rejected.
    const third = await run(mw, req);
    expect(third.nexted).toBe(false);
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 429, expect.any(String), expect.anything());
  });

  it('buckets orgs independently (a different org is unaffected)', async () => {
    const mw = rateLimitByOrg({ name: 'test-b', max: 1, windowMs: 60_000 });

    expect((await run(mw, { ip: '10.0.0.1', user: { organizationId: 'org-1' } })).nexted).toBe(true);
    // org-1 is now at cap…
    expect((await run(mw, { ip: '10.0.0.1', user: { organizationId: 'org-1' } })).nexted).toBe(false);
    // …but org-2 has its own fresh bucket.
    expect((await run(mw, { ip: '10.0.0.1', user: { organizationId: 'org-2' } })).nexted).toBe(true);
  });

  it('skips verified service principals (never limited)', async () => {
    const mw = rateLimitByOrg({ name: 'test-c', max: 1, windowMs: 60_000 });
    const svc: MockReq = { ip: '10.0.0.9', user: { organizationId: 'org-1' }, serviceToken: true };

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      expect((await run(mw, svc)).nexted).toBe(true);
    }
    expect(mockSendError).not.toHaveBeenCalled();
  });

  it('falls back to a client-IP bucket when unauthenticated', async () => {
    const mw = rateLimitByOrg({ name: 'test-d', max: 1, windowMs: 60_000 });

    expect((await run(mw, { ip: '10.0.0.5' })).nexted).toBe(true);
    // Same IP, no org → same bucket → limited.
    expect((await run(mw, { ip: '10.0.0.5' })).nexted).toBe(false);
    // A different IP is its own bucket.
    expect((await run(mw, { ip: '10.0.0.6' })).nexted).toBe(true);
  });
});

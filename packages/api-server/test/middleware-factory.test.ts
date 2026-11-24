// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireAuth: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

jest.unstable_mockModule('../src/api/check-quota.js', () => ({
  checkQuota: jest.fn(() => 'CHECK_QUOTA_MIDDLEWARE'),
}));

jest.unstable_mockModule('../src/api/require-org-id.js', () => ({
  requireOrgId: jest.fn(() => 'REQUIRE_ORG_ID_MIDDLEWARE'),
}));

jest.unstable_mockModule('../src/api/tenant-context.js', () => ({
  withTenantContext: jest.fn(() => 'TENANT_CONTEXT_MIDDLEWARE'),
}));

const { checkQuota } = await import('../src/api/check-quota.js');
const {
  createProtectedRoute,
  createAuthenticatedWithOrgRoute,
  extendRequestTimeout,
} = await import('../src/api/middleware-factory.js');
const { default: express } = await import('express');
const { requireOrgId } = await import('../src/api/require-org-id.js');
const { withTenantContext } = await import('../src/api/tenant-context.js');

describe('createProtectedRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an array of five middleware (auth, orgId, idempotency, tenantContext, quota)', () => {
    const fakeQuotaService = {} as any;
    const result = createProtectedRoute(fakeQuotaService, 'apiCalls' as any);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(5);
  });

  it('invokes requireOrgId(), withTenantContext() and checkQuota() factories', () => {
    const fakeQuotaService = {} as any;
    createProtectedRoute(fakeQuotaService, 'pipelines' as any);
    expect(requireOrgId).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(checkQuota).toHaveBeenCalledWith(fakeQuotaService, 'pipelines');
  });

  it('places middleware in order: auth, orgId, idempotency, tenantContext, quota', () => {
    const fakeQuotaService = {} as any;
    const result = createProtectedRoute(fakeQuotaService, 'plugins' as any);
    expect(result[1]).toBe('REQUIRE_ORG_ID_MIDDLEWARE');
    // [2] is the idempotency middleware (a real closure, not a labeled mock) —
    // mounted post-orgId so the verified org can namespace its replay cache.
    expect(typeof result[2]).toBe('function');
    expect(result[3]).toBe('TENANT_CONTEXT_MIDDLEWARE');
    expect(result[4]).toBe('CHECK_QUOTA_MIDDLEWARE');
  });
});

describe('createAuthenticatedWithOrgRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an array of four middleware (auth, orgId, idempotency, tenantContext)', () => {
    const result = createAuthenticatedWithOrgRoute();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
  });

  it('invokes requireOrgId() factory', () => {
    createAuthenticatedWithOrgRoute();
    expect(requireOrgId).toHaveBeenCalledTimes(1);
  });

  it('does not invoke checkQuota', () => {
    createAuthenticatedWithOrgRoute();
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it('places auth first, orgId second, idempotency third, tenantContext fourth', () => {
    const result = createAuthenticatedWithOrgRoute();
    expect(result[1]).toBe('REQUIRE_ORG_ID_MIDDLEWARE');
    expect(typeof result[2]).toBe('function'); // idempotency middleware (real closure)
    expect(result[3]).toBe('TENANT_CONTEXT_MIDDLEWARE');
  });
});

describe('extendRequestTimeout', () => {
  /**
   * A server with app-factory's shape: every request gets a SHORT deadline that
   * answers 503, and `/slow` answers 200 after `handlerMs`. `extend` puts
   * extendRequestTimeout in front of it.
   */
  async function slowRequest(opts: { deadlineMs: number; handlerMs: number; extend?: number }): Promise<number> {
    const app = express();
    app.use((_req, res, next) => {
      res.setTimeout(opts.deadlineMs, () => {
        if (!res.headersSent) res.status(503).end();
      });
      next();
    });
    const handler = (_req: unknown, res: { headersSent: boolean; status: (c: number) => { end: () => void } }) => {
      setTimeout(() => { if (!res.headersSent) res.status(200).end(); }, opts.handlerMs);
    };
    if (opts.extend !== undefined) app.get('/slow', extendRequestTimeout(opts.extend), handler as never);
    else app.get('/slow', handler as never);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const { port } = server.address() as { port: number };
      return (await fetch(`http://127.0.0.1:${port}/slow`)).status;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('without it, a handler slower than the default deadline is answered 503', async () => {
    expect(await slowRequest({ deadlineMs: 50, handlerMs: 200 })).toBe(503);
  });

  it('moves the deadline, so the slow handler answers', async () => {
    expect(await slowRequest({ deadlineMs: 50, handlerMs: 200, extend: 1_000 })).toBe(200);
  });

  it('keeps the 503 answer once the new deadline passes', async () => {
    expect(await slowRequest({ deadlineMs: 50, handlerMs: 400, extend: 150 })).toBe(503);
  });
});

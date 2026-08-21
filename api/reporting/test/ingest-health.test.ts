// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /reports/ingest-health — the machine (events-Lambda) upsert of
 * per-org forwarded/dropped/last-seen ingestion health.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendError = jest.fn((_res: any, code: number, msg: string) => ({ error: msg, code }));
const mockSendBadRequest = jest.fn((_res: any, msg: string, _code?: string) => msg);
const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockRecordHealth = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  // requireOrgId:false — the org is taken from the token identity; the mock
  // mirrors withRoute by reading it from req.__orgId (default '' = absent).
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: req.__orgId ?? '', userId: 'svc' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: opts?.requireOrgId === false ? (req.__orgId ?? '') : 'acme', userId: 'svc' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  sendError: mockSendError,
  hasScope: (req: any, scope: string) => req?.user?.scope === scope,
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: { recordIngestHealth: (...a: unknown[]) => mockRecordHealth(...a) },
}));

const { createIngestHealthRoutes } = await import('../src/routes/ingest-health.js');

describe('POST /reports/ingest-health', () => {
  let router: any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const getHandler = () => router.stack.find((l: any) => l.route?.path === '/')?.route?.stack[0]?.handle;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createIngestHealthRoutes();
  });

  it('upserts health for an org-scoped ingest token', async () => {
    await getHandler()({
      __orgId: 'acme', user: { scope: 'reporting:ingest' },
      body: { forwarded: 100, dropped: 2, lastEventAt: '2026-07-05T00:00:00Z' },
    }, res());

    expect(mockRecordHealth).toHaveBeenCalledWith('acme', { forwarded: 100, dropped: 2, lastEventAt: '2026-07-05T00:00:00Z' });
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });
  });

  it('attributes to the body orgId for a multi-tenant forwarder (not the token org)', async () => {
    await getHandler()({
      __orgId: 'forwarder-sys', user: { scope: 'reporting:ingest' },
      body: { orgId: 'tenant-b', forwarded: 7, dropped: 0, lastEventAt: '2026-07-05T00:00:00Z' },
    }, res());

    // Body orgId wins; it must NOT leak into the health payload passed downstream.
    expect(mockRecordHealth).toHaveBeenCalledWith('tenant-b', { forwarded: 7, dropped: 0, lastEventAt: '2026-07-05T00:00:00Z' });
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });
  });

  it('accepts a body orgId even when the token carries no org identity', async () => {
    await getHandler()({ user: { scope: 'reporting:ingest' }, body: { orgId: 'tenant-c', forwarded: 3 } }, res());
    expect(mockRecordHealth).toHaveBeenCalledWith('tenant-c', { forwarded: 3 });
  });

  it('403s a token without the reporting:ingest scope', async () => {
    await getHandler()({ __orgId: 'acme', user: { scope: 'other' }, body: {} }, res());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 403, expect.stringContaining('reporting:ingest'), expect.anything());
    expect(mockRecordHealth).not.toHaveBeenCalled();
  });

  it('400s an ingest token with no org identity', async () => {
    await getHandler()({ user: { scope: 'reporting:ingest' }, body: {} }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('org-scoped'), 'VALIDATION_ERROR');
    expect(mockRecordHealth).not.toHaveBeenCalled();
  });

  it('400s an invalid lastEventAt and does not write', async () => {
    await getHandler()({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, body: { lastEventAt: 'not-a-date' } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockRecordHealth).not.toHaveBeenCalled();
  });
});

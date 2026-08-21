// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the inbound billing → reporting retention-sync route (Phase 8):
 * `PUT /reports/retention-sync/:orgId`. Mirrors the platform seat-limit sync
 * auth (service principal or system-admin); clamps/validates the two retention
 * windows and upserts them into `dora_settings`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSetReportingSettings = jest.fn<(...a: unknown[]) => Promise<void>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn(),
  sendError: jest.fn(),
  sendBadRequest: jest.fn(),
  getParam: jest.fn((params: any, key: string) => params?.[key]),
  // Same principal checks the platform seat-limit route uses.
  isServicePrincipal: jest.fn((req: any) =>
    typeof req?.user?.sub === 'string' && req.user.sub.startsWith('service:')),
  isSystemAdmin: jest.fn((req: any) => req?.user?.isSuperAdmin === true),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  // Pass `req` straight through so the handler reads its own params/body; orgId
  // in the context is irrelevant here (the route reads the :orgId path param).
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: {}, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: '', userId: '' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: { setReportingSettings: mockSetReportingSettings },
}));

const { sendSuccess, sendError, sendBadRequest } = await import('@pipeline-builder/api-core');
const { createRetentionSyncRoutes } = await import('../src/routes/retention-sync.js');

// The billing service token identity (getServiceAuthHeader({ serviceName:'billing' })
// → sub: 'service:billing'); carries NO scope / permission.
const billingPrincipal = { sub: 'service:billing', role: 'owner' };

describe('PUT /reports/retention-sync/:orgId', () => {
  let router: any;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createRetentionSyncRoutes();
  });

  function getHandler() {
    const stack = router.stack.find((l: any) => l.route?.path === '/:orgId')?.route?.stack;
    return stack?.[stack.length - 1]?.handle;
  }

  function run(body: unknown, user: unknown, orgId = 'root-1') {
    return getHandler()({ params: { orgId }, body, user }, {});
  }

  it('accepts the billing service token and upserts both windows (happy path)', async () => {
    mockSetReportingSettings.mockResolvedValue();
    await run({ eventRetentionDays: 90, doraRetentionDays: 365 }, billingPrincipal);

    expect(mockSetReportingSettings).toHaveBeenCalledWith('root-1', { eventRetentionDays: 90, doraRetentionDays: 365 });
    expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200,
      expect.objectContaining({ orgId: 'root-1', eventRetentionDays: 90, doraRetentionDays: 365, ok: true }));
    expect(sendError).not.toHaveBeenCalled();
  });

  it('passes `-1` (unlimited) through unchanged', async () => {
    mockSetReportingSettings.mockResolvedValue();
    await run({ eventRetentionDays: -1, doraRetentionDays: -1 }, billingPrincipal);

    expect(mockSetReportingSettings).toHaveBeenCalledWith('root-1', { eventRetentionDays: -1, doraRetentionDays: -1 });
  });

  it('clamps a value above 730 down to the ceiling', async () => {
    mockSetReportingSettings.mockResolvedValue();
    await run({ eventRetentionDays: 900, doraRetentionDays: 365 }, billingPrincipal);

    expect(mockSetReportingSettings).toHaveBeenCalledWith('root-1', { eventRetentionDays: 730, doraRetentionDays: 365 });
  });

  it('400s on a non-integer value and does not upsert', async () => {
    await run({ eventRetentionDays: 90.5, doraRetentionDays: 365 }, billingPrincipal);

    expect(sendBadRequest).toHaveBeenCalled();
    expect(mockSetReportingSettings).not.toHaveBeenCalled();
  });

  it('400s on an out-of-range value like 0 and does not upsert', async () => {
    await run({ eventRetentionDays: 30, doraRetentionDays: 0 }, billingPrincipal);

    expect(sendBadRequest).toHaveBeenCalled();
    expect(mockSetReportingSettings).not.toHaveBeenCalled();
  });

  it('rejects a non-service caller (plain org user) with 403', async () => {
    await run({ eventRetentionDays: 90, doraRetentionDays: 365 },
      { sub: 'user-1', role: 'owner', permissions: ['reports:read', 'org:settings'] });

    expect(sendError).toHaveBeenCalledWith(expect.anything(), 403, expect.any(String), expect.anything());
    expect(mockSetReportingSettings).not.toHaveBeenCalled();
  });

  it('also accepts a system-admin caller', async () => {
    mockSetReportingSettings.mockResolvedValue();
    await run({ eventRetentionDays: 90, doraRetentionDays: 365 }, { sub: 'user-1', isSuperAdmin: true });

    expect(mockSetReportingSettings).toHaveBeenCalledWith('root-1', { eventRetentionDays: 90, doraRetentionDays: 365 });
  });
});

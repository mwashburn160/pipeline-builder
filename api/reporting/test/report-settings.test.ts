// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-org reporting-settings surface (report-settings.ts).
 *
 * D3 — retention is BILLING-OWNED: the admin `PUT /incidents` body accepts ONLY
 * `incidentWindowHours`; `eventRetentionDays`/`doraRetentionDays` are rejected
 * (`.strict()`) so an org admin can't bypass their billing entitlement. `GET`
 * still returns retention for read-only display.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockSendBadRequest = jest.fn((_res: any, msg: string, _code?: string) => msg);
const mockSetSettings = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockGetSettings = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({
  incidentWindowHours: 48, defaultWindowHours: 24,
  eventRetentionDays: null, doraRetentionDays: 545,
  defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180,
});

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: {
    getIncidentSettings: (...a: unknown[]) => mockGetSettings(...a),
    setReportingSettings: (...a: unknown[]) => mockSetSettings(...a),
  },
}));

const { createReportSettingsRoutes } = await import('../src/routes/report-settings.js');

describe('reporting settings routes', () => {
  let router: any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  // PUT is [requirePermission gate, withRoute] — the withRoute handler is last.
  const putHandler = () => {
    const stack = router.stack.find((l: any) => l.route?.path === '/incidents' && l.route?.methods.put)?.route?.stack;
    return stack[stack.length - 1].handle;
  };
  const getHandler = () => {
    const stack = router.stack.find((l: any) => l.route?.path === '/incidents' && l.route?.methods.get)?.route?.stack;
    return stack[stack.length - 1].handle;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    router = createReportSettingsRoutes();
  });

  it('GET returns the settings incl. retention (for read-only display)', async () => {
    await getHandler()({ query: {} }, res());
    expect(mockGetSettings).toHaveBeenCalledWith('acme');
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.settings).toMatchObject({ incidentWindowHours: 48, doraRetentionDays: 545 });
  });

  it('PUT accepts incidentWindowHours and writes only that', async () => {
    await putHandler()({ body: { incidentWindowHours: 72 } }, res());
    expect(mockSetSettings).toHaveBeenCalledWith('acme', { incidentWindowHours: 72 });
  });

  it('PUT REJECTS a retention field (entitlement bypass closed) and does not write', async () => {
    await putHandler()({ body: { incidentWindowHours: 72, doraRetentionDays: 730 } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it('PUT REJECTS an eventRetentionDays-only body (no retention lever at all)', async () => {
    await putHandler()({ body: { eventRetentionDays: 90 } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it('PUT REJECTS an empty body (incidentWindowHours is required)', async () => {
    await putHandler()({ body: {} }, res());
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockSetSettings).not.toHaveBeenCalled();
  });
});

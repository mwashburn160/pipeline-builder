// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-org reporting-settings surface (report-settings.ts).
 *
 * retention is BILLING-OWNED: the admin `PUT /incidents` body accepts ONLY
 * `incidentWindowHours`; `eventRetentionDays`/`doraRetentionDays` are rejected
 * (`.strict()`) so an org admin can't bypass their billing entitlement. `GET`
 * still returns retention for read-only display.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ASK_AGENT_PROPOSER, ASK_PROPOSED_BY_HEADER } from '@pipeline-builder/api-core/ask-proposals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRecordAudit = jest.fn<(event: any) => void>();
const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockSendBadRequest = jest.fn((_res: any, msg: string, _code?: string) => msg);
const mockSetSettings = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockGetSettings = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({
  incidentWindowHours: 48,
  defaultWindowHours: 24,
  eventRetentionDays: null,
  doraRetentionDays: 545,
  defaultEventRetentionDays: 30,
  defaultDoraRetentionDays: 180,
});

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  recordAudit: (event: any) => mockRecordAudit(event),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: {
    getReportingSettings: (...a: unknown[]) => mockGetSettings(...a),
    setReportingSettings: (...a: unknown[]) => mockSetSettings(...a),
  },
}));

const { createReportSettingsRoutes } = await import('../src/routes/report-settings.js');

describe('reporting settings routes', () => {
  let router: any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  // PUT is [requirePermission gate, audited(...), withRoute] — the handler is last.
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
    expect(mockGetSettings).toHaveBeenCalledWith('acme', 'acme');
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.settings).toMatchObject({ incidentWindowHours: 48, doraRetentionDays: 545 });
  });

  it('PUT accepts incidentWindowHours and writes only that', async () => {
    await putHandler()({ body: { incidentWindowHours: 72 } }, res());
    expect(mockSetSettings).toHaveBeenCalledWith('acme', { incidentWindowHours: 72 });
  });

  // ---------------------------------------------------------------------------
  // Agent provenance (design rule 6). The Ask panel commits an org-settings
  // proposal through THIS route, with the user's own session, so the audit event
  // must say an AI drafted it — and a client must not be able to write anything
  // else into `details`.
  // ---------------------------------------------------------------------------
  describe('ask-agent provenance', () => {
    const put = (headers: Record<string, unknown> = {}) =>
      putHandler()({ body: { incidentWindowHours: 72 }, headers }, res());
    const auditDetails = () => mockRecordAudit.mock.calls[0][0].details;

    it('gates the route with `proposable`, ahead of the handler', () => {
      const stack = router.stack.find((l: any) => l.route?.path === '/incidents' && l.route?.methods.put)?.route?.stack;
      const names = stack.map((l: any) => l.handle.name);
      expect(names).toContain('proposable');
      // Before the handler: a refusal must never leave a written change whose
      // provenance was discarded.
      expect(names.indexOf('proposable')).toBeLessThan(names.length - 1);
    });

    it('records proposedBy when the request carries the marker', async () => {
      await put({ [ASK_PROPOSED_BY_HEADER]: ASK_AGENT_PROPOSER });
      expect(auditDetails()).toEqual({ incidentWindowHours: 72, proposedBy: ASK_AGENT_PROPOSER });
    });

    it('records NO proposer for an ordinary admin edit', async () => {
      await put();
      expect(auditDetails()).toEqual({ incidentWindowHours: 72 });
      expect(auditDetails()).not.toHaveProperty('proposedBy');
    });

    it('does NOT store a forged proposer', async () => {
      await put({ [ASK_PROPOSED_BY_HEADER]: 'the-admin' });
      expect(auditDetails()).not.toHaveProperty('proposedBy');
      expect(auditDetails()).toEqual({ incidentWindowHours: 72 });
    });

    it('cannot overwrite what the handler put in details', async () => {
      await put({ [ASK_PROPOSED_BY_HEADER]: ASK_AGENT_PROPOSER });
      // The handler's own key survives verbatim; provenance only ADDS.
      expect(auditDetails().incidentWindowHours).toBe(72);
      expect(mockSetSettings).toHaveBeenCalledWith('acme', { incidentWindowHours: 72 });
    });
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

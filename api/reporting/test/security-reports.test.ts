// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The advanced security routes (/reports/security/vulnerabilities and
 * /compliance-trend).
 *
 * Pinned: the advanced_reporting gate (tagged on each route, like /dora), the
 * interval / tz / weekStart validation, date-only bounds read as local midnights
 * in tz (so the window lines up with the stakeholder period), the retention cap,
 * and the rollup gate. The numbers themselves — and their parity with the
 * stakeholder sections — are tested against a real Postgres in pipeline-data's
 * security-reports.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockVulns = jest.fn<AnyFn>();
const mockCompliance = jest.fn<AnyFn>();
const mockResolveOrgRollup = jest.fn<AnyFn>();
const mockGetReportingSettings = jest.fn<AnyFn>();
const permCheck = (req: any, perm: string) =>
  req?.user?.isSuperAdmin === true || (req?.user?.permissions ?? []).includes(perm);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn<AnyFn>(),
  sendBadRequest: jest.fn<AnyFn>(),
  getServiceAuthHeader: jest.fn(() => ({})),
  userHasPermission: jest.fn(permCheck),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn() }, orgId: 'acme', userId: 'user-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

jest.unstable_mockModule('../src/helpers/report-helpers.js', () => {
  const actual = jest.requireActual('../src/helpers/report-helpers.js') as Record<string, unknown>;
  return {
    ...actual,
    rollupIds: (req: any, orgId: string) =>
      req?.query?.includeDescendants === 'true' && permCheck(req, 'reports:rollup')
        ? mockResolveOrgRollup(orgId)
        : Promise.resolve(undefined),
  };
});

const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as typeof import('@pipeline-builder/pipeline-data');
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: { getReportingSettings: mockGetReportingSettings },
  getVulnerabilityExposure: mockVulns,
  getComplianceTrend: mockCompliance,
  securityBound: actualData.securityBound,
}));

const { sendSuccess, sendBadRequest } = await import('@pipeline-builder/api-core');
const { createSecurityReportRoutes } = await import('../src/routes/security-reports.js');

const UNLIMITED = { eventRetentionDays: -1, doraRetentionDays: -1, defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180 };

describe.each([
  ['/vulnerabilities', mockVulns, 'vulnerabilities'],
  ['/compliance-trend', mockCompliance, 'compliance'],
] as const)('GET /reports/security%s', (path, mockFn, key) => {
  let router: any;
  const stack = () => router.stack.find((l: any) => l.route?.path === path)?.route?.stack;
  const handler = () => stack()[stack().length - 1].handle;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetReportingSettings.mockResolvedValue(UNLIMITED);
    mockFn.mockResolvedValue({ ok: true });
    router = createSecurityReportRoutes();
  });

  it('is gated on advanced_reporting, like /execution/dora', () => {
    const gates = stack().slice(0, -1).map((l: any) => l.handle.__feature);
    expect(gates).toEqual(['advanced_reporting']);
  });

  it('reads date-only bounds as local midnights in tz and passes the bucketing through', async () => {
    await handler()({ query: { from: '2026-09-01', to: '2026-10-01', interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' } }, {});
    expect(mockFn).toHaveBeenCalledWith(
      { orgId: 'acme', from: '2026-09-01T05:00:00.000Z', to: '2026-10-01T05:00:00.000Z' },
      { interval: 'week', tz: 'America/Chicago', weekStart: 'sunday' },
    );
    expect(sendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { [key]: { ok: true } });
  });

  it('defaults to UTC / Monday', async () => {
    await handler()({ query: { from: '2026-09-01', to: '2026-09-08' } }, {});
    expect(mockFn).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-09-01T00:00:00.000Z' }),
      expect.objectContaining({ tz: 'UTC', weekStart: 'monday' }),
    );
  });

  it('400s a bad interval or timezone without querying', async () => {
    await handler()({ query: { interval: 'fortnight' } }, {});
    await handler()({ query: { tz: 'Mars/Olympus' } }, {});
    expect(sendBadRequest).toHaveBeenCalledTimes(2);
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('400s a range past the retention cap without querying', async () => {
    mockGetReportingSettings.mockResolvedValue({ ...UNLIMITED, eventRetentionDays: 30 });
    await handler()({ query: { from: '2025-01-01', to: '2026-01-01' } }, {});
    expect(sendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/exceeds maximum/), expect.anything());
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('rolls up over the team subtree only for a reports:rollup holder', async () => {
    mockResolveOrgRollup.mockResolvedValue(['acme', 'team-1']);
    await handler()({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:rollup'] } }, {});
    expect(mockFn).toHaveBeenLastCalledWith(expect.objectContaining({ orgIds: ['acme', 'team-1'] }), expect.anything());
    await handler()({ query: { includeDescendants: 'true' }, user: { permissions: ['reports:read'] } }, {});
    expect(mockFn).toHaveBeenLastCalledWith(expect.not.objectContaining({ orgIds: expect.anything() }), expect.anything());
  });
});

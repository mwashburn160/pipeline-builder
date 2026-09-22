// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /reports/incidents — the machine (PagerDuty/Datadog/Alertmanager
 * webhook) upsert of a production incident that feeds automated post-deploy CFR +
 * real MTTR. Auth mirrors ingest-health: requireAuth + the `reporting:ingest`
 * scope; the org comes from the token identity, never the body.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { routeChain } from './helpers/route-chain.js';

const mockSendError = jest.fn((_res: any, code: number, msg: string, ..._rest: unknown[]) => ({ error: msg, code }));
const mockSendBadRequest = jest.fn((_res: any, msg: string, _code?: string) => msg);
const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockSendPaginated = jest.fn((_res: any, key: string, data: any, opts: any) => ({ [key]: data, pagination: opts }));
const mockRecordIncident = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockListIncidents = jest.fn<(...a: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
const mockTestCorrelation = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({ correlated: false });

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: req.__orgId ?? '', userId: 'svc' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: opts?.requireOrgId === false ? (req.__orgId ?? '') : 'acme', userId: 'svc' });
  },
  // The org-admin routes build per-route guards at module load; passthrough stubs.
  requireOrgId: () => (_req: any, _res: any, next: any) => next && next(),
  withTenantContext: () => (_req: any, _res: any, next: any) => next && next(),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  sendError: mockSendError,
  sendPaginatedNested: mockSendPaginated,
  hasScope: (req: any, scope: string) => req?.user?.scope === scope,
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: {
    recordIncident: (...a: unknown[]) => mockRecordIncident(...a),
    listIncidents: (...a: unknown[]) => mockListIncidents(...a),
    testIncidentCorrelation: (...a: unknown[]) => mockTestCorrelation(...a),
  },
}));

const { createIncidentRoutes } = await import('../src/routes/incidents.js');

describe('POST /reports/incidents', () => {
  let router: any;
  const res = () => ({ status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() });
  const getHandler = () => routeChain(router, '/');

  const validBody = {
    incidentId: 'pd-123',
    environment: 'production',
    openedAt: '2026-07-05T00:00:00Z',
    resolvedAt: '2026-07-05T01:00:00Z',
    severity: 'critical',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    router = createIncidentRoutes();
  });

  it('upserts an incident for an org-scoped ingest token', async () => {
    await getHandler()({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, body: validBody }, res());

    expect(mockRecordIncident).toHaveBeenCalledWith('acme', validBody);
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { incidentId: 'pd-123', ok: true });
  });

  it('accepts an open incident (no resolvedAt)', async () => {
    const { resolvedAt: _drop, ...open } = validBody;
    await getHandler()({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, body: open }, res());
    expect(mockRecordIncident).toHaveBeenCalledWith('acme', open);
  });

  it('403s a token without the reporting:ingest scope', async () => {
    await getHandler()({ __orgId: 'acme', user: { scope: 'other' }, body: validBody }, res());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 403, expect.stringContaining('reporting:ingest'), expect.anything());
    expect(mockRecordIncident).not.toHaveBeenCalled();
  });

  it('400s an ingest token with no org identity', async () => {
    await getHandler()({ user: { scope: 'reporting:ingest' }, body: validBody }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('org-scoped'), 'VALIDATION_ERROR');
    expect(mockRecordIncident).not.toHaveBeenCalled();
  });

  it('400s a missing incidentId and does not write', async () => {
    const { incidentId: _drop, ...bad } = validBody;
    await getHandler()({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, body: bad }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockRecordIncident).not.toHaveBeenCalled();
  });

  it('400s an invalid openedAt timestamp and does not write', async () => {
    await getHandler()({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, body: { ...validBody, openedAt: 'not-a-date' } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockRecordIncident).not.toHaveBeenCalled();
  });

  it('400s a missing severity and does not write', async () => {
    const { severity: _drop, ...bad } = validBody;
    await getHandler()({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, body: bad }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'VALIDATION_ERROR');
    expect(mockRecordIncident).not.toHaveBeenCalled();
  });
});

describe('POST /reports/incidents/alertmanager (native adapter)', () => {
  let router: any;
  const res = () => ({ status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() });
  // Run the full chain so the per-route requireIngestScope guard is exercised.
  const getHandler = (path: string, method = 'post') => routeChain(router, path, method);

  const firingPayload = {
    status: 'firing',
    alerts: [{
      status: 'firing',
      labels: { environment: 'production', severity: 'critical', alertname: 'HighErrorRate' },
      startsAt: '2026-07-05T00:00:00Z',
      endsAt: '0001-01-01T00:00:00Z',
      fingerprint: 'abc123',
    }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    router = createIncidentRoutes();
  });

  it('maps a FIRING alert → an open incident (fingerprint@startsAt id, env label, no resolvedAt)', async () => {
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, query: {}, body: firingPayload }, res());

    expect(mockRecordIncident).toHaveBeenCalledTimes(1);
    expect(mockRecordIncident).toHaveBeenCalledWith('acme', {
      incidentId: 'abc123@2026-07-05T00:00:00.000Z',
      environment: 'production',
      openedAt: '2026-07-05T00:00:00Z',
      resolvedAt: undefined, // firing → the zero endsAt is NOT treated as a resolve
      severity: 'critical',
    });
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { received: 1, ingested: 1, skipped: 0, ok: true });
  });

  it('maps a RESOLVED alert → sets resolvedAt from endsAt', async () => {
    const resolved = {
      status: 'resolved',
      alerts: [{
        status: 'resolved',
        labels: { environment: 'production', severity: 'critical' },
        startsAt: '2026-07-05T00:00:00Z',
        endsAt: '2026-07-05T01:00:00Z',
        fingerprint: 'abc123',
      }],
    };
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, query: {}, body: resolved }, res());

    expect(mockRecordIncident).toHaveBeenCalledWith('acme', {
      incidentId: 'abc123@2026-07-05T00:00:00.000Z',
      environment: 'production',
      openedAt: '2026-07-05T00:00:00Z',
      resolvedAt: '2026-07-05T01:00:00Z',
      severity: 'critical',
    });
  });

  it('honors a configurable environment label via ?environmentLabel=', async () => {
    const payload = {
      status: 'firing',
      alerts: [{ status: 'firing', labels: { deploy_env: 'staging', severity: 'warning' }, startsAt: '2026-07-05T00:00:00Z', fingerprint: 'fp-2' }],
    };
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, query: { environmentLabel: 'deploy_env' }, body: payload }, res());
    expect(mockRecordIncident).toHaveBeenCalledWith('acme', expect.objectContaining({ environment: 'staging', severity: 'warning' }));
  });

  it('skips an alert missing the environment label (counts skipped, does not write)', async () => {
    const payload = {
      status: 'firing',
      alerts: [{ status: 'firing', labels: { severity: 'warning' }, startsAt: '2026-07-05T00:00:00Z', fingerprint: 'fp-3' }],
    };
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, query: {}, body: payload }, res());
    expect(mockRecordIncident).not.toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { received: 1, ingested: 0, skipped: 1, ok: true });
  });

  it('403s a token without the reporting:ingest scope', async () => {
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'other' }, query: {}, body: firingPayload }, res());
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 403, expect.stringContaining('reporting:ingest'), expect.anything());
    expect(mockRecordIncident).not.toHaveBeenCalled();
  });

  it('BATCHES duplicate fingerprints into a single upsert (last write wins)', async () => {
    const dup = {
      status: 'firing',
      alerts: [
        { status: 'firing', labels: { environment: 'production', severity: 'warning' }, startsAt: '2026-07-05T00:00:00Z', fingerprint: 'same' },
        // Same fingerprint, later resolve → supersedes the firing one.
        { status: 'resolved', labels: { environment: 'production', severity: 'critical' }, startsAt: '2026-07-05T00:00:00Z', endsAt: '2026-07-05T01:00:00Z', fingerprint: 'same' },
      ],
    };
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, query: {}, body: dup }, res());
    // Two alerts received, but only ONE distinct incident upsert (no redundant
    // write + cache invalidation for the duplicate).
    expect(mockRecordIncident).toHaveBeenCalledTimes(1);
    expect(mockRecordIncident).toHaveBeenCalledWith('acme', expect.objectContaining({
      incidentId: 'same@2026-07-05T00:00:00.000Z', severity: 'critical', resolvedAt: '2026-07-05T01:00:00Z',
    }));
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { received: 2, ingested: 1, skipped: 0, ok: true });
  });

  it('a RECURRENCE (same fingerprint, new startsAt) is a DISTINCT incident — the earlier outage is kept', async () => {
    const payload = {
      status: 'firing',
      alerts: [
        { status: 'resolved', labels: { environment: 'production', severity: 'critical' }, startsAt: '2026-07-05T00:00:00Z', endsAt: '2026-07-05T01:00:00Z', fingerprint: 'fp' },
        { status: 'firing', labels: { environment: 'production', severity: 'critical' }, startsAt: '2026-07-06T00:00:00Z', fingerprint: 'fp' },
      ],
    };
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, query: {}, body: payload }, res());
    expect(mockRecordIncident).toHaveBeenCalledTimes(2);
    expect(mockRecordIncident).toHaveBeenCalledWith('acme', expect.objectContaining({ incidentId: 'fp@2026-07-05T00:00:00.000Z', resolvedAt: '2026-07-05T01:00:00Z' }));
    expect(mockRecordIncident).toHaveBeenCalledWith('acme', expect.objectContaining({ incidentId: 'fp@2026-07-06T00:00:00.000Z', resolvedAt: undefined }));
  });

  it('a firing copy AFTER the resolve in one batch does not drop the resolve', async () => {
    const payload = {
      status: 'firing',
      alerts: [
        { status: 'resolved', labels: { environment: 'production', severity: 'critical' }, startsAt: '2026-07-05T00:00:00Z', endsAt: '2026-07-05T01:00:00Z', fingerprint: 'fp' },
        { status: 'firing', labels: { environment: 'production', severity: 'critical' }, startsAt: '2026-07-05T00:00:00Z', fingerprint: 'fp' },
      ],
    };
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, query: {}, body: payload }, res());
    expect(mockRecordIncident).toHaveBeenCalledTimes(1);
    expect(mockRecordIncident).toHaveBeenCalledWith('acme', expect.objectContaining({ resolvedAt: '2026-07-05T01:00:00Z' }));
  });

  it('400s (and writes nothing) when the alerts batch exceeds the cap', async () => {
    const alerts = Array.from({ length: 1001 }, (_v, i) => ({
      status: 'firing',
      labels: { environment: 'production', severity: 'warning' },
      startsAt: '2026-07-05T00:00:00Z',
      fingerprint: `fp-${i}`,
    }));
    await getHandler('/alertmanager')({ __orgId: 'acme', user: { scope: 'reporting:ingest' }, query: {}, body: { status: 'firing', alerts } }, res());
    expect(mockSendBadRequest).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('maximum'), 'VALIDATION_ERROR');
    expect(mockRecordIncident).not.toHaveBeenCalled();
  });
});

describe('org-admin incident surfaces', () => {
  let router: any;
  const res = () => ({ status: jest.fn<AnyFn>().mockReturnThis(), json: jest.fn<AnyFn>() });
  // Admin routes carry per-route guards; the withRoute handler is the LAST stack layer.
  const getHandler = (path: string, method: string) =>
    router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method])?.route?.stack.slice(-1)[0]?.handle;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createIncidentRoutes();
  });

  it('GET / returns the paginated incidents list', async () => {
    mockListIncidents.mockResolvedValueOnce([{ incidentId: 'i1', correlatedExecutionId: 'exec-A', resolved: true }]);
    await getHandler('/', 'get')({ query: { limit: '25', offset: '0' }, user: {} }, res());
    expect(mockListIncidents).toHaveBeenCalledWith('acme', { limit: 25, offset: 0 });
    expect(mockSendPaginated).toHaveBeenCalledWith(expect.anything(), 'incidents', expect.any(Array), expect.objectContaining({ limit: 25, offset: 0, hasMore: false }));
  });

  it('POST /test runs a dry-run correlation for the given environment', async () => {
    mockTestCorrelation.mockResolvedValueOnce({ environment: 'production', correlated: true, executionId: 'exec-A', windowHours: 24 });
    await getHandler('/test', 'post')({ body: { environment: 'production' }, user: {} }, res());
    expect(mockTestCorrelation).toHaveBeenCalledWith('acme', 'production');
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { test: expect.objectContaining({ correlated: true }) });
  });

  it('POST /test accepts a bodyless request (no JSON body parsed) and defaults to production', async () => {
    await getHandler('/test', 'post')({ body: undefined, user: {} }, res());
    expect(mockSendBadRequest).not.toHaveBeenCalled();
    expect(mockTestCorrelation).toHaveBeenCalledWith('acme', 'production');
  });

  it('POST /test defaults to production when no environment is supplied', async () => {
    await getHandler('/test', 'post')({ body: {}, user: {} }, res());
    expect(mockTestCorrelation).toHaveBeenCalledWith('acme', 'production');
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `/reports/ingest-health`:
 *  - POST — the machine (events-Lambda) upsert of per-org forwarded/dropped/
 *    last-seen ingestion health.
 *  - GET  — the USER-facing read behind the Reports freshness indicator. The
 *    heartbeat used to be write-only, so the UI could not tell a quiet week from
 *    a dead ingest pipeline. It is gated like the other report reads
 *    (`reports:read`), deliberately NOT by the machine `reporting:ingest` scope,
 *    and it reports "never ingested" as its own state rather than as staleness.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { routeChain } from './helpers/route-chain.js';

const mockSendError = jest.fn((_res: any, code: number, msg: string) => ({ error: msg, code }));
const mockSendBadRequest = jest.fn((_res: any, msg: string, _code?: string) => msg);
const mockSendSuccess = jest.fn((_res: any, _code: number, data: any) => data);
const mockRecordHealth = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockGetHealth = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(null);

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  // requireOrgId:false — the org is taken from the token identity; the mock
  // mirrors withRoute by reading it from req.__orgId (default '' = absent).
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: req.__orgId ?? '', userId: 'svc' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: opts?.requireOrgId === false ? (req.__orgId ?? '') : 'acme', userId: 'svc' });
  },
  // The GET's own guards (the mount is the bare machine requireAuth). Mirrors
  // the real middleware closely enough to prove the gate is wired: no org on the
  // token ⇒ 400 before the handler; tenant context is a pass-through here.
  requireOrgId: () => (req: any, res: any, next: () => void) => (
    req.__orgId ? next() : res.status(400).json({ error: 'Organization ID is required' })
  ),
  withTenantContext: () => (_req: any, _res: any, next: () => void) => next(),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  sendError: mockSendError,
  hasScope: (req: any, scope: string) => req?.user?.scope === scope,
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: {
    recordIngestHealth: (...a: unknown[]) => mockRecordHealth(...a),
    getIngestHealth: (...a: unknown[]) => mockGetHealth(...a),
  },
}));

const { createIngestHealthRoutes } = await import('../src/routes/ingest-health.js');

describe('POST /reports/ingest-health', () => {
  let router: any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const getHandler = () => routeChain(router, '/');

  beforeEach(() => {
    jest.clearAllMocks();
    router = createIngestHealthRoutes();
  });

  it('upserts health for an org-scoped ingest token', async () => {
    await getHandler()({
      __orgId: 'acme',
      user: { scope: 'reporting:ingest' },
      body: { forwarded: 100, dropped: 2, lastEventAt: '2026-07-05T00:00:00Z' },
    }, res());

    expect(mockRecordHealth).toHaveBeenCalledWith('acme', { forwarded: 100, dropped: 2, lastEventAt: '2026-07-05T00:00:00Z' });
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });
  });

  it('attributes to the body orgId for the deployment-wide forwarder', async () => {
    // The Lambda that forwards MANY orgs runs as the system org, which is what
    // earns it cross-org attribution.
    await getHandler()({
      __orgId: '000000000000000000000001',
      user: { scope: 'reporting:ingest' },
      body: { orgId: 'tenant-b', forwarded: 7, dropped: 0, lastEventAt: '2026-07-05T00:00:00Z' },
    }, res());

    // Body orgId wins; it must NOT leak into the health payload passed downstream.
    expect(mockRecordHealth).toHaveBeenCalledWith('tenant-b', { forwarded: 7, dropped: 0, lastEventAt: '2026-07-05T00:00:00Z' });
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });
  });

  it('refuses a TENANT key naming another org, and never writes that org\'s row', async () => {
    // `reporting:ingest` is the only gate here and a tenant's own ingest key
    // carries it, so an unconditional body orgId let any tenant overwrite
    // another org's freshness row — its Reports page would read "flowing" while
    // its forwarder was dead, or the reverse.
    await getHandler()({
      __orgId: 'tenant-a',
      user: { scope: 'reporting:ingest' },
      body: { orgId: 'tenant-b', forwarded: 7 },
    }, res());

    expect(mockRecordHealth).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 403, expect.any(String), expect.any(String));
  });

  it('lets a tenant key name its OWN org redundantly', async () => {
    await getHandler()({
      __orgId: 'tenant-a',
      user: { scope: 'reporting:ingest' },
      body: { orgId: 'tenant-a', forwarded: 7 },
    }, res());

    expect(mockRecordHealth).toHaveBeenCalledWith('tenant-a', { forwarded: 7 });
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

describe('GET /reports/ingest-health', () => {
  let router: any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const getHandler = () => routeChain(router, '/', 'get');
  /** A `reports:read` holder — the ordinary dashboard reader. */
  const reader = { sub: 'u1', permissions: ['reports:read'] };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHealth.mockResolvedValue(null);
    router = createIngestHealthRoutes();
  });

  it('returns the org\'s health plus the SERVER clock', async () => {
    const health = { updatedAt: '2026-07-05T01:00:00.000Z', lastEventAt: '2026-07-05T00:59:00.000Z', forwarded: 12, dropped: 0 };
    mockGetHealth.mockResolvedValue(health);

    await getHandler()({ __orgId: 'acme', user: reader }, res());

    expect(mockGetHealth).toHaveBeenCalledWith('acme');
    // `now` is the server's, so a skewed browser can neither fake nor mask staleness.
    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { health, now: expect.any(String) });
  });

  it('returns health:null — "never ingested" — rather than inventing a stale row', async () => {
    mockGetHealth.mockResolvedValue(null);

    await getHandler()({ __orgId: 'acme', user: reader }, res());

    expect(mockSendSuccess).toHaveBeenCalledWith(expect.anything(), 200, { health: null, now: expect.any(String) });
  });

  it('is gated on reports:read, NOT the machine ingest scope', async () => {
    const r = res();
    // Holds the ingest scope the POST accepts, but no user permission.
    await getHandler()({ __orgId: 'acme', user: { sub: 'svc', scope: 'reporting:ingest', permissions: [] } }, r);

    expect(r.status).toHaveBeenCalledWith(403);
    expect(mockGetHealth).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    const r = res();
    await getHandler()({ __orgId: 'acme' }, r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(mockGetHealth).not.toHaveBeenCalled();
  });

  it('400s when the token carries no org', async () => {
    const r = res();
    await getHandler()({ user: reader }, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(mockGetHealth).not.toHaveBeenCalled();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner-link routes' behaviour over the in-memory runner doubles: each
 * link status, Find runner again (a single match replaces the link, anything
 * else keeps it and records the result), the runner's pipeline list and its
 * count, and no account id or runner URL in any answer.
 */

import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from '../helpers/mock-api-core.js';

const ORG_ID = '0123456789abcdef01234567';
const mockFindById = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockFindById } }));
const mockAudit = jest.fn<AnyFn>();
const mockStepUp = jest.fn<AnyFn>((_req, _res, next: () => void) => next());
const mockAssurance = jest.fn<AnyFn>((_req, _res, next: () => void) => next());
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  getParam: (p: Record<string, string>, k: string) => p[k],
  requireStepUp: mockStepUp,
  requireAssurance: () => mockAssurance,
}));
const mockRateLimit = jest.fn<AnyFn>((_req, _res, next: () => void) => next());
const limiterOpts: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  createAuthenticatedWithOrgRoute: () => [],
  rateLimitByOrg: (opts: Record<string, unknown>) => { limiterOpts.push(opts); return mockRateLimit; },
  withRoute: (handler: any) => async (req: any, response: any) => {
    await handler({ req, res: response, ctx: { log: jest.fn() }, orgId: ORG_ID, userId: 'user-1' });
  },
}));

const { createRunnerLinkRoutes } = await import('../../src/routes/runner-link-routes.js');
const { setRunnerDepsForTesting } = await import('../../src/runners/deps.js');
const { claimsOf, ORG, PARENT, PIPE, reply, runnerRow, testDeps, URL_A } = await import('../helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const router = createRunnerLinkRoutes() as any;
const stackOf = (method: string, path: string) => router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]).route.stack.map((s: any) => s.handle);
const handler = (method: string, path: string) => stackOf(method, path).at(-1);

function res() {
  const r: any = { statusCode: 0, body: undefined as any };
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: unknown) => { r.body = b; return r; });
  r.setHeader = jest.fn();
  return r;
}
const data = (r: any) => r.body?.data ?? r.body;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let deps: Deps;
const add = (over: Parameters<typeof runnerRow>[0] = {}) => { const r = runnerRow(over); deps.store.runners.set(r.id, r); return r; };
const getLink = async (pipelineId = PIPE) => { const r = res(); await handler('get', '/:pipelineId/runner-link')({ params: { pipelineId }, query: {}, user: {} }, r); return r; };
const refresh = async (pipelineId = PIPE) => { const r = res(); await handler('post', '/:pipelineId/runner-link/refresh')({ params: { pipelineId }, query: {}, user: {} }, r); await flush(); await flush(); return r; };

beforeEach(() => {
  jest.clearAllMocks();
  expect(ORG).toBe(ORG_ID);
  mockFindById.mockResolvedValue({ id: PIPE });
  deps = testDeps();
  setRunnerDepsForTesting(deps);
});
afterEach(() => { setRunnerDepsForTesting(null); });

describe('GET /:pipelineId/runner-link', () => {
  it('404 for a pipeline that is not registered, not visible, or malformed', async () => {
    expect((await getLink()).statusCode).toBe(404);
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
    mockFindById.mockResolvedValue(null);
    expect((await getLink()).statusCode).toBe(404);
    expect((await getLink('nope')).statusCode).toBe(404);
  });

  it.each(['linked', 'unlinked', 'not_found', 'ambiguous', 'checking'] as const)('reports status %s with the runner, last check and labels — never a URL or account id', async (status) => {
    const r = add({ label: 'prod', lastDeliveryAt: new Date('2026-11-18T00:00:00Z') });
    const checkedAt = new Date('2026-11-19T10:00:00Z');
    deps.store.registry.set(PIPE, {
      orgId: ORG,
      pipelineName: 'arn-free-name',
      region: 'us-east-1',
      runnerId: status === 'unlinked' ? null : r.id,
      linkStatus: status,
      linkCheckedAt: checkedAt,
      linkDetail: { runnersChecked: ['prod'], matched: status === 'linked' ? ['prod'] : [], errorCode: null },
    });
    const out = await getLink();
    expect(out.statusCode).toBe(200);
    expect(data(out)).toEqual({
      pipelineId: PIPE,
      status,
      runner: status === 'unlinked' ? null : { id: r.id, label: 'prod', health: 'healthy', lastDeliveryAt: '2026-11-18T00:00:00.000Z', ownerOrgName: null, isOwn: true, capabilities: [] },
      checkedAt: checkedAt.toISOString(),
      detail: { runnersChecked: ['prod'], matched: status === 'linked' ? ['prod'] : [], errorCode: null },
      deliveriesPaused: false,
    });
    expect(JSON.stringify(out.body)).not.toContain(URL_A);
    // No AWS account id (a 12-digit run outside the uuids) and no ARN.
    expect(JSON.stringify(out.body).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')).not.toMatch(/\d{12}|arn:/);
  });

  it('names the owner of an inherited (parent) runner, and says when deliveries are paused', async () => {
    const p = add({ orgId: PARENT, label: 'parent' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: p.id, linkStatus: 'linked' });
    deps.availability.available = false;
    deps.availability.reason = 'paused';
    expect(data(await getLink())).toMatchObject({ runner: { ownerOrgName: expect.any(String), isOwn: false }, deliveriesPaused: true });
  });

  it('carries the linked runner\'s capabilities (deploy:1: a purge removes the stack through it)', async () => {
    const r = add({ label: 'deployer', capabilities: ['deploy:1'] });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: 'us-east-1', runnerId: r.id, linkStatus: 'linked' });
    expect(data(await getLink())).toMatchObject({ runner: { id: r.id, capabilities: ['deploy:1'] } });
  });
});

describe('POST /:pipelineId/runner-link/refresh (Find runner again)', () => {
  it('sits behind step-up and an MFA-grade session, after the availability check, with the per-org limit', () => {
    const chain = stackOf('post', '/:pipelineId/runner-link/refresh');
    const iAssure = chain.indexOf(mockAssurance);
    const iStepUp = chain.indexOf(mockStepUp);
    expect(iAssure).toBeGreaterThan(0);
    expect(iStepUp).toBeGreaterThan(iAssure);
    expect(chain.indexOf(mockRateLimit)).toBeGreaterThan(iStepUp);
    // The refresh limit fails closed (a limit-store outage refuses, never lifts it).
    expect(limiterOpts).toContainEqual(expect.objectContaining({ name: 'pipeline-runner-link-refresh', failClosed: true }));
  });

  it('409 RUNNERS_UNAVAILABLE before any step-up is spent', async () => {
    deps.availability.available = false;
    deps.availability.reason = 'paused';
    const r = res();
    const next = jest.fn();
    const availability = stackOf('post', '/:pipelineId/runner-link/refresh').find((h: any) => h.name === 'requireRunnersAvailable');
    await availability({}, r, next);
    expect(r.statusCode).toBe(409);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 202 checking, then a single match replaces the link (audited, labels only)', async () => {
    const old = add({ label: 'old' });
    const fresh = add({ label: 'fresh' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: old.id, linkStatus: 'linked' });
    deps.fetchMock.mockImplementation(async (_u, o) => reply(200, { outcome: claimsOf(String(o.body)).aud === fresh.id ? 'match' : 'no_match' }));
    const out = await refresh();
    expect(out.statusCode).toBe(202);
    expect(data(out)).toMatchObject({ status: 'checking', runner: { id: old.id } });
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: fresh.id, linkStatus: 'linked', linkDetail: { matched: ['fresh'] } });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pipeline.runner.link.refresh',
      targetType: 'pipeline',
      targetId: PIPE,
      details: { status: 'linked', runnersChecked: ['old', 'fresh'], matched: ['fresh'] },
    }));
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(URL_A);
    expect(data(await getLink())).toMatchObject({ status: 'linked', runner: { id: fresh.id } });
  });

  it('anything but a single match keeps the old link and records the result', async () => {
    const old = add({ label: 'old' });
    add({ label: 'other' });
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: old.id, linkStatus: 'linked' });
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'match' }));
    await refresh();
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: old.id, linkStatus: 'ambiguous', linkDetail: { matched: ['old', 'other'], errorCode: 'AMBIGUOUS_RUNNER' } });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', details: expect.objectContaining({ status: 'ambiguous' }) }));
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'no_match' }));
    await refresh();
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: old.id, linkStatus: 'not_found' });
  });

  it('404 for an unregistered pipeline', async () => {
    expect((await refresh()).statusCode).toBe(404);
  });
});

describe('GET /runners/:id/pipelines', () => {
  it('lists the pipelines linked to one of the org\'s runners, paginated; the count matches the runner list\'s pipelineCount', async () => {
    const r = add({ label: 'prod' });
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'];
    ids.forEach((id, i) => deps.store.registry.set(id, { orgId: ORG, pipelineName: `pipe-${i}`, region: 'us-east-1', runnerId: r.id }));
    deps.store.registry.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { orgId: ORG, pipelineName: 'elsewhere', region: null, runnerId: null });
    const out = res();
    await handler('get', '/runners/:id/pipelines')({ params: { id: r.id }, query: { limit: '2', offset: '0' }, user: {} }, out);
    expect(out.statusCode).toBe(200);
    const body = data(out);
    expect(body.pipelines).toEqual([{ id: ids[0], name: 'pipe-0' }, { id: ids[1], name: 'pipe-1' }]);
    expect(body.pagination).toMatchObject({ total: 3 });
    const { listRunners } = await import('../../src/runners/admin.js');
    expect((await listRunners(deps, ORG)).own[0]!.pipelineCount).toBe(3);
  });

  it('404 for another org\'s (or an unknown) runner', async () => {
    const theirs = add({ orgId: PARENT });
    const out = res();
    await handler('get', '/runners/:id/pipelines')({ params: { id: theirs.id }, query: {}, user: {} }, out);
    expect(out.statusCode).toBe(404);
  });
});

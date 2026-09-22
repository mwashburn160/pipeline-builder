// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin-ecosystem route handlers (routes/publisher.ts,
 * routes/ecosystem-console.ts): each hands the acting caller and the body to
 * its service, answers with the service's result, and turns an
 * `EcosystemError` into its code AND its structured details. The request-kind
 * step-up (only sensitive kinds need one) is exercised here too; the gates
 * themselves are checked against the real route table in route-coverage and
 * ecosystem-governance.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const stepUp = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireStepUp: stepUp,
  requireEcosystemPermission: () => [(_q: unknown, _s: unknown, n: () => void) => n()],
  sendError: (res: any, statusCode: number, message: string, code?: string, details?: unknown) =>
    res.status(statusCode).json({ success: false, message, code, ...(details ? { details } : {}) }),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (fn: (a: unknown) => Promise<void>) => async (rq: any, rs: any) => {
    try {
      await fn({ req: rq, res: rs, ctx: { log: jest.fn() }, orgId: 'org-acme', userId: 'u-acme' });
    } catch (err: any) {
      rs.status(500).json({ success: false, message: err.message });
    }
  },
}));

const svc = <T extends string>(names: readonly T[]) => Object.fromEntries(names.map((n) => [n, jest.fn(async () => ({ ok: n }))])) as Record<T, ReturnType<typeof jest.fn>>;
const publishers = svc(['acceptTerms', 'claimPublisher', 'ownListings', 'pause', 'publisherState', 'updatePublisherProfile'] as const);
const reqs = svc(['draft', 'incomingTransfers', 'ownRequests', 'respondToTransfer', 'submit', 'withdraw'] as const);
const consoleSvc = svc([
  'approveRuleChange', 'asQueueItem', 'createRule', 'deleteReserved', 'deleteRule', 'listListings', 'listPublishers', 'listReserved', 'listRules',
  'overview', 'putReserved', 'queue', 'requestDetail', 'resignAll', 'setListingState', 'setPublisherTier', 'suspendPublisher', 'unsuspendPublisher',
  'unyankVersion', 'updateRule', 'yankVersion',
] as const);
const decisions = svc(['approve', 'reject', 'secondApprove'] as const);
const advisoriesSvc = svc([
  'consoleAdvisories', 'createModeratorDraft', 'deprecateOwnListedVersion', 'editDraft', 'publisherAdvisories', 'setListedVersionDeprecation', 'withdrawAdvisory',
] as const);
const requestById = jest.fn(async (): Promise<unknown> => null);
const insightsSvc = svc(['publisherInsights'] as const);

jest.unstable_mockModule('../src/services/ecosystem/publishers.js', () => publishers);
jest.unstable_mockModule('../src/services/ecosystem/requests.js', () => reqs);
jest.unstable_mockModule('../src/services/ecosystem/console.js', () => consoleSvc);
jest.unstable_mockModule('../src/services/ecosystem/decisions.js', () => decisions);
jest.unstable_mockModule('../src/services/ecosystem/advisories.js', () => advisoriesSvc);
jest.unstable_mockModule('../src/services/ecosystem/insights.js', () => insightsSvc);
jest.unstable_mockModule('../src/services/ecosystem/store.js', () => ({ requests: { byId: requestById } }));
jest.unstable_mockModule('../src/services/ecosystem/review-moderation.js', () =>
  svc(['holdReview', 'releaseReview', 'removeReply', 'removeReview', 'reviewQueue', 'reviewQueueCounts'] as const));
const recordDecision = jest.fn();
jest.unstable_mockModule('../src/services/ecosystem/metrics.js', () => ({ recordDecision }));
jest.unstable_mockModule('../src/services/ecosystem/submission-moderation.js', () => ({ submissionSbom: jest.fn(), submissionScan: jest.fn() }));

const { createPublisherRoutes } = await import('../src/routes/publisher.js');
const { createEcosystemConsoleRoutes } = await import('../src/routes/ecosystem-console.js');
const { EcosystemError } = await import('../src/services/ecosystem/context.js');
const { bodyOf, param } = await import('../src/routes/ecosystem-route.js');

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: any[]) => any; name?: string }> } };

function stackFor(router: unknown, method: string, path: string) {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  return layer.route!.stack.map((s) => s.handle);
}

async function call(router: unknown, method: string, path: string, req: Record<string, unknown> = {}) {
  const handlers = stackFor(router, method, path);
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  const request = { params: {}, query: {}, body: {}, headers: {}, user: { sub: 'u-acme', organizationId: 'ORG-ACME', parentOrganizationId: 'ORG-ACME', principalType: 'user', username: 'alice', permissions: ['plugins:read'], features: [] }, ...req };
  await handlers[handlers.length - 1]!(request, res, () => undefined);
  return res;
}

const publisherRouter = createPublisherRoutes();
const consoleRouter = createEcosystemConsoleRoutes();

beforeEach(() => {
  jest.clearAllMocks();
  requestById.mockResolvedValue(null);
});

describe('tenant publisher routes', () => {
  it.each([
    ['get', '/publisher', publishers.publisherState, 200],
    ['post', '/publisher', publishers.claimPublisher, 201],
    ['patch', '/publisher', publishers.updatePublisherProfile, 200],
    ['post', '/publisher/terms', publishers.acceptTerms, 200],
    ['get', '/publisher/listings', publishers.ownListings, 200],
    ['get', '/publisher/insights', insightsSvc.publisherInsights, 200],
    ['post', '/publisher/listings/:listingId/pause', publishers.pause, 200],
    ['post', '/publisher/listings/:listingId/deprecate', advisoriesSvc.deprecateOwnListedVersion, 200],
    ['get', '/publisher/advisories', advisoriesSvc.publisherAdvisories, 200],
    ['get', '/publisher/incoming-transfers', reqs.incomingTransfers, 200],
    ['get', '/publish-requests', reqs.ownRequests, 200],
    ['get', '/publish-requests/draft', reqs.draft, 200],
    ['post', '/publish-requests', reqs.submit, 201],
    ['post', '/publish-requests/:id/withdraw', reqs.withdraw, 200],
    ['post', '/publish-requests/:id/transfer-response', reqs.respondToTransfer, 200],
  ] as const)('%s %s calls its service', async (method, path, fn, status) => {
    const res = await call(publisherRouter, method, path, { params: { id: 'r-1', listingId: 'l-1' }, body: { version: '1.0.0', accept: true, termsVersion: 'v' }, query: { pluginId: 'p-1', status: 'open' } });
    expect(res.statusCode).toBe(status);
    expect(fn).toHaveBeenCalledTimes(1);
    // The caller is captured from the token: org lower-cased, a self-parent ignored.
    expect((fn.mock.calls[0] as unknown[])[0]).toMatchObject({ userId: 'u-acme', orgId: 'org-acme', principalType: 'user', name: 'alice' });
    expect((fn.mock.calls[0] as unknown[])[0]).not.toHaveProperty('parentOrgId');
  });

  it('passes a whole-listing pause when no version is given', async () => {
    await call(publisherRouter, 'post', '/publisher/listings/:listingId/pause', { params: { listingId: 'l-1' }, body: null });
    expect(publishers.pause).toHaveBeenCalledWith(expect.anything(), 'l-1', undefined);
  });

  it('answers an EcosystemError with its code and details, and anything else as a 500', async () => {
    reqs.submit.mockRejectedValueOnce(new EcosystemError('PUBLISH_GATE_FAILED' as any, 'gates failed', { gates: [{ id: 'license' }] }));
    const res = await call(publisherRouter, 'post', '/publish-requests', { body: { kind: 'new_listing' } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'PUBLISH_GATE_FAILED', details: { gates: [{ id: 'license' }] } });
    reqs.submit.mockRejectedValueOnce(new Error('boom'));
    expect((await call(publisherRouter, 'post', '/publish-requests', {})).statusCode).toBe(500);
  });
});

describe('Ecosystem console routes', () => {
  it.each([
    ['get', '/overview', consoleSvc.overview],
    ['get', '/requests', consoleSvc.queue],
    ['get', '/requests/:id', consoleSvc.requestDetail],
    ['get', '/publishers', consoleSvc.listPublishers],
    ['post', '/publishers/:id/suspend', consoleSvc.suspendPublisher],
    ['post', '/publishers/:id/unsuspend', consoleSvc.unsuspendPublisher],
    ['post', '/publishers/:id/tier', consoleSvc.setPublisherTier],
    ['get', '/listings', consoleSvc.listListings],
    ['post', '/listings/:id/state', consoleSvc.setListingState],
    ['post', '/listings/:id/versions/:version/yank', consoleSvc.yankVersion],
    ['post', '/listings/:id/versions/:version/unyank', consoleSvc.unyankVersion],
    ['post', '/listings/:id/versions/:version/deprecate', advisoriesSvc.setListedVersionDeprecation],
    ['get', '/advisories', advisoriesSvc.consoleAdvisories],
    ['patch', '/advisories/:id', advisoriesSvc.editDraft],
    ['post', '/advisories/:id/withdraw', advisoriesSvc.withdrawAdvisory],
    ['post', '/resign', consoleSvc.resignAll],
    ['get', '/rules', consoleSvc.listRules],
    ['patch', '/rules/:id', consoleSvc.updateRule],
    ['post', '/rules/:id/approve-change', consoleSvc.approveRuleChange],
    ['delete', '/rules/:id', consoleSvc.deleteRule],
    ['get', '/reserved-names', consoleSvc.listReserved],
    ['put', '/reserved-names/:name', consoleSvc.putReserved],
    ['delete', '/reserved-names/:name', consoleSvc.deleteReserved],
  ] as const)('%s %s calls its service', async (method, path, fn) => {
    const res = await call(consoleRouter, method, path, { params: { id: 'x', version: '1.0.0', name: 'n' } });
    expect(res.statusCode).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('creates a rule with 201', async () => {
    expect((await call(consoleRouter, 'post', '/rules', { body: { name: 'r' } })).statusCode).toBe(201);
  });

  it('opens a moderator advisory draft with 201, and hands the listing/version to deprecation', async () => {
    const res = await call(consoleRouter, 'post', '/advisories', { body: { listingId: 'l-1', severity: 'high' } });
    expect(res.statusCode).toBe(201);
    expect(advisoriesSvc.createModeratorDraft).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-acme' }), { listingId: 'l-1', severity: 'high' });
    await call(consoleRouter, 'post', '/listings/:id/versions/:version/deprecate', { params: { id: 'l-1', version: '1.0.0' }, body: { deprecated: false } });
    expect(advisoriesSvc.setListedVersionDeprecation).toHaveBeenCalledWith(expect.anything(), 'l-1', '1.0.0', { deprecated: false });
  });

  it('approves, second-approves and rejects, answering with the queue item', async () => {
    decisions.approve.mockResolvedValueOnce({ request: { id: 'r-1' }, executed: false });
    const a = await call(consoleRouter, 'post', '/requests/:id/approve', { params: { id: 'r-1' }, body: { note: '  ok  ' } });
    expect(decisions.approve).toHaveBeenCalledWith(expect.anything(), 'r-1', 'ok');
    expect(a.body.data).toEqual({ request: { ok: 'asQueueItem' }, executed: false });
    expect(recordDecision).toHaveBeenLastCalledWith({ id: 'r-1' }, 'first_approval');

    decisions.secondApprove.mockResolvedValueOnce({ request: { id: 'r-1' }, executed: true });
    await call(consoleRouter, 'post', '/requests/:id/second-approve', { params: { id: 'r-1' }, body: {} });
    expect(decisions.secondApprove).toHaveBeenCalledWith(expect.anything(), 'r-1', null);
    expect(recordDecision).toHaveBeenLastCalledWith({ id: 'r-1' }, 'second_approval');
    decisions.approve.mockResolvedValueOnce({ request: { id: 'r-2' }, executed: true });
    await call(consoleRouter, 'post', '/requests/:id/approve', { params: { id: 'r-2' }, body: {} });
    expect(recordDecision).toHaveBeenLastCalledWith({ id: 'r-2' }, 'approved');

    const r = await call(consoleRouter, 'post', '/requests/:id/reject', { params: { id: 'r-1' }, body: { reason: ' bad ' } });
    expect(r.statusCode).toBe(200);
    expect(decisions.reject).toHaveBeenCalledWith(expect.anything(), 'r-1', 'bad');
    expect(recordDecision).toHaveBeenLastCalledWith({ ok: 'reject' }, 'rejected');
    const missing = await call(consoleRouter, 'post', '/requests/:id/reject', { params: { id: 'r-1' }, body: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.body.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('asks for a step-up only when the request being decided is a sensitive kind', async () => {
    const [, sensitive] = stackFor(consoleRouter, 'post', '/requests/:id/approve');
    const next = jest.fn();
    requestById.mockResolvedValueOnce({ kind: 'new_version' });
    await sensitive!({ params: { id: 'r-1' } }, {}, next);
    expect(stepUp).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    requestById.mockResolvedValueOnce({ kind: 'yank' });
    await sensitive!({ params: { id: 'r-2' } }, {}, next);
    expect(stepUp).toHaveBeenCalledTimes(1);

    requestById.mockRejectedValueOnce(new Error('db'));
    await sensitive!({ params: {} }, {}, next);
    expect(next).toHaveBeenCalledTimes(3);
  });
});

describe('route helpers', () => {
  it('reads a body and params defensively', () => {
    expect(bodyOf({ body: [1] } as any)).toEqual({});
    expect(bodyOf({ body: { a: 1 } } as any)).toEqual({ a: 1 });
    expect(param({ params: { id: ['a', 'b'] } } as any, 'id')).toBe('a');
    expect(param({ params: {} } as any, 'id')).toBe('');
  });
});

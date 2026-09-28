// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The free preview.
 *
 * Four properties, each of which a plausible implementation gets wrong:
 *
 *  - ONCE, EVER. Enforced by a conditional claim, not a read-then-write, so two tabs
 *    produce one preview. The route just reports what the claim decided.
 *  - AN ENTITLED ORG IS REFUSED WITHOUT SPENDING IT. Burning somebody's one-off sample on
 *    a request they did not need is unfair in a way nobody can undo.
 *  - NOTHING IS PERSISTED. That is what makes the preview unschedulable and unshareable —
 *    no definition to schedule, no run id to mint a link against — so the test asserts
 *    the store was never asked to create either.
 *  - THE WATERMARK IS IN THE PAYLOAD, not only the UI. A screenshot of a preview that does
 *    not say it is a preview is a number somebody quotes in a meeting.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockSendSuccess = jest.fn<AnyFn>();
const mockSendError = jest.fn<AnyFn>();
const mockCompose = jest.fn<AnyFn>();
const mockBillingEnabled = jest.fn<AnyFn>();

const store = {
  claimReportPreview: jest.fn<AnyFn>(),
  reportPreviewUsed: jest.fn<AnyFn>(),
  createDefinition: jest.fn<AnyFn>(),
  createRun: jest.fn<AnyFn>(),
  createShareLink: jest.fn<AnyFn>(),
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (...a: unknown[]) => mockSendSuccess(...a),
  sendError: (...a: unknown[]) => mockSendError(...a),
  isBillingEnabled: () => mockBillingEnabled(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme', userId: 'user-lead' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-lead' });
  },
  rateLimitByOrg: () => (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  stakeholderReportStore: store,
  composeSnapshot: (...a: unknown[]) => mockCompose(...a),
  getTemplate: (t: string) => (t === 'weekly_delivery' ? { sections: ['success_rate', 'dora'] } : undefined),
  resolvePeriod: () => ({
    start: new Date('2026-09-14T00:00:00Z'),
    end: new Date('2026-09-21T00:00:00Z'),
    prevStart: new Date('2026-09-07T00:00:00Z'),
    prevEnd: new Date('2026-09-14T00:00:00Z'),
    label: '2026-W38',
  }),
  reportingService: {},
}));

jest.unstable_mockModule('../src/services/report-posture.js', () => ({
  readPosture: () => Promise.resolve({ compliance: null, access: null }),
}));

const { createReportPreviewRoutes } = await import('../src/routes/report-preview.js');

/** Drive the mounted handler for a method. */
async function call(method: 'post' | 'get', features: string[] = []): Promise<void> {
  const router = createReportPreviewRoutes() as any;
  const layer = router.stack.find((l: any) => l.route?.path === '/' && l.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  await handler({ params: {}, query: {}, body: {}, user: { features } }, {});
}

const payload = () => mockSendSuccess.mock.calls[0]?.[2] as Record<string, unknown>;
const errorOf = () => mockSendError.mock.calls[0];

const SNAPSHOT = {
  period: { start: 'a', end: 'b', label: '2026-W38' },
  previousPeriod: { start: 'c', end: 'd' },
  timezone: 'UTC',
  weekStart: 'monday',
  sections: [{ id: 'success_rate', title: 'Success rate', state: 'ok', current: 91 }],
  notes: [],
  methodology: 'Computed over the window shown.',
  generatedAt: '2026-09-21T06:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockBillingEnabled.mockReturnValue(true);
  store.claimReportPreview.mockResolvedValue(true);
  store.reportPreviewUsed.mockResolvedValue(false);
  mockCompose.mockResolvedValue(SNAPSHOT);
});

describe('POST /reports/stakeholder-preview', () => {
  it('claims the preview and returns a watermarked snapshot', async () => {
    await call('post');
    expect(store.claimReportPreview).toHaveBeenCalledWith('acme');
    expect(payload()).toMatchObject({ preview: true, template: 'weekly_delivery' });
    expect(String(payload().watermark)).toContain('PREVIEW');
  });

  it('folds the watermark into the snapshot\'s own methodology line', async () => {
    await call('post');
    const snapshot = payload().snapshot as { methodology: string };
    // In the payload, not only the UI: a screenshot that does not say "preview" becomes a
    // number somebody quotes.
    expect(snapshot.methodology).toContain('PREVIEW');
    expect(snapshot.methodology).toContain('Computed over the window shown.');
  });

  it('PERSISTS NOTHING — no definition, no run, no share link', async () => {
    await call('post');
    // This is what makes the preview unschedulable and unshareable structurally, rather
    // than leaving both properties to a flag every future caller must remember to check.
    expect(store.createDefinition).not.toHaveBeenCalled();
    expect(store.createRun).not.toHaveBeenCalled();
    expect(store.createShareLink).not.toHaveBeenCalled();
  });

  it('composes as if entitled, so the sample is not full of locked panels', async () => {
    await call('post');
    const features = (mockCompose.mock.calls[0]?.[1] as { features: string[] }).features;
    // A sample with its headline numbers locked behind a second purchase is a worse
    // advertisement than no sample. The exposure is bounded by "once, ever".
    expect(features).toContain('stakeholder_reports');
    expect(features).toContain('advanced_reporting');
  });

  it('refuses an ALREADY-ENTITLED org WITHOUT spending the preview', async () => {
    await call('post', ['stakeholder_reports']);
    expect(store.claimReportPreview).not.toHaveBeenCalled();
    expect(errorOf()?.[1]).toBe(409);
    expect(String(errorOf()?.[2])).toContain('already has Stakeholder Reports');
  });

  it('refuses on a billing-disabled install without spending it', async () => {
    mockBillingEnabled.mockReturnValue(false);
    await call('post');
    // Those orgs run as the unlimited tier and already hold the feature; spending a
    // preview they have no use for would be pure loss.
    expect(store.claimReportPreview).not.toHaveBeenCalled();
    expect(errorOf()?.[1]).toBe(409);
  });

  it('reports a SPENT preview as a 409 naming the add-on', async () => {
    store.claimReportPreview.mockResolvedValue(false);
    await call('post');
    expect(errorOf()?.[1]).toBe(409);
    expect(String(errorOf()?.[2])).toContain('already used its free preview');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('does NOT roll the claim back when the compose fails, and says the preview is safe', async () => {
    mockCompose.mockRejectedValue(new Error('db down'));
    await call('post');
    // Deliberate: a rollback makes the claim re-runnable, which turns a reliably failing
    // compose into an unbounded free compute loop. Support can re-grant it.
    expect(errorOf()?.[1]).toBe(500);
    expect(String(errorOf()?.[2])).toContain('has not been lost');
  });
});

describe('GET /reports/stakeholder-preview', () => {
  it('reports whether the preview is spent, without spending it', async () => {
    store.reportPreviewUsed.mockResolvedValue(true);
    await call('get');
    expect(payload()).toEqual({ used: true });
    expect(store.claimReportPreview).not.toHaveBeenCalled();
  });

  it('reports an unspent preview', async () => {
    await call('get');
    expect(payload()).toEqual({ used: false });
  });
});

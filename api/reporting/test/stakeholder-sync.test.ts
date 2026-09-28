// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The billing → reporting entitlement sync.
 *
 * Three behaviours carry real money or real trust, and each is here for that reason:
 *
 *  - IT COVERS THE WHOLE ACCOUNT. Entitlement is pooled at the root, but definitions live
 *    in whichever org made them — including teams. Pausing only the org billing named
 *    leaves every team's reports running on a cancelled subscription.
 *  - AN UNRESOLVABLE HIERARCHY IS A REFUSAL, not a partial apply. Half-pausing an account
 *    is worse than retrying, because the half that kept running is the half nobody checks.
 *  - A STALE PUSH IS IGNORED. Billing's legs are retried, so "lapsed" and "renewed" can
 *    arrive out of order; the store's watermark decides, and the route must report the
 *    skip rather than treating it as "nothing to do".
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockSendSuccess = jest.fn<AnyFn>();
const mockSendError = jest.fn<AnyFn>();
const mockSendBadRequest = jest.fn<AnyFn>();
const mockRecordAudit = jest.fn<AnyFn>();
const mockRollup = jest.fn<AnyFn>();
const mockNotifyPaused = jest.fn<AnyFn>();
const mockSync = jest.fn<AnyFn>();
const scopes: Array<{ orgId?: string }> = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (...a: unknown[]) => mockSendSuccess(...a),
  sendError: (...a: unknown[]) => mockSendError(...a),
  sendBadRequest: (...a: unknown[]) => mockSendBadRequest(...a),
  recordAudit: (e: unknown) => mockRecordAudit(e),
  requireInternalService: () => (_req: any, _res: any, next: any) => next(),
  audited: () => (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme', userId: 'svc' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'svc' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  stakeholderReportStore: { syncReportEntitlement: (...a: unknown[]) => mockSync(...a) },
  runWithTenantContext: <T>(ctx: { orgId?: string }, fn: () => T) => {
    scopes.push(ctx);
    return fn();
  },
}));

jest.unstable_mockModule('../src/helpers/report-helpers.js', () => ({
  resolveOrgRollup: (...a: unknown[]) => mockRollup(...a),
  REPORTING_HTTP_TIMEOUT_MS: 3000,
}));

jest.unstable_mockModule('../src/services/report-delivery.js', () => ({
  notifyPaused: (...a: unknown[]) => mockNotifyPaused(...a),
}));

jest.unstable_mockModule('../src/services/report-schedule.js', () => ({
  nextRunFor: () => new Date('2026-09-28T11:00:00.000Z'),
  reportSettleHours: () => 6,
}));

const { createStakeholderSyncRoutes } = await import('../src/routes/stakeholder-sync.js');

const definition = (over: Record<string, unknown> = {}) => ({
  id: 'def-1', orgId: 'acme', name: 'Weekly delivery', cadence: 'weekly', ...over,
});

async function call(body: Record<string, unknown>, orgId = 'root-org'): Promise<void> {
  const router = createStakeholderSyncRoutes() as any;
  const layer = router.stack.find((l: any) => l.route?.path === '/:orgId');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  await handler({ params: { orgId }, query: {}, body, user: { sub: 'svc' } }, {});
}

const payload = () => mockSendSuccess.mock.calls[0]?.[2] as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  scopes.length = 0;
  mockRollup.mockResolvedValue(['root-org']);
  mockSync.mockResolvedValue({ skipped: false, paused: [], resumed: [] });
  mockNotifyPaused.mockResolvedValue(undefined);
});

describe('PUT /reports/stakeholder-sync/:orgId', () => {
  it('pauses on a lapse and reports the count', async () => {
    mockSync.mockResolvedValue({ skipped: false, paused: [definition()], resumed: [] });
    await call({ entitled: false });
    expect(mockSync).toHaveBeenCalledWith('root-org', false, expect.anything());
    expect(payload()).toMatchObject({ ok: true, paused: 1, resumed: 0 });
  });

  it('resumes on a renewal', async () => {
    mockSync.mockResolvedValue({ skipped: false, paused: [], resumed: [definition()] });
    await call({ entitled: true });
    expect(mockSync).toHaveBeenCalledWith('root-org', true, expect.anything());
    expect(payload()).toMatchObject({ paused: 0, resumed: 1 });
  });

  it('applies to EVERY org in the account, each in its own tenant context', async () => {
    mockRollup.mockResolvedValue(['root-org', 'team-a', 'team-b']);
    await call({ entitled: false });
    // Pausing only the root would leave the teams' reports running on a cancelled
    // subscription — the revenue-leak version of this bug.
    expect(mockSync).toHaveBeenCalledTimes(3);
    expect(scopes.map((s) => s.orgId)).toEqual(['root-org', 'team-a', 'team-b']);
  });

  it('falls back to the single org when there is no hierarchy', async () => {
    mockRollup.mockResolvedValue(undefined);
    await call({ entitled: false });
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it('REFUSES rather than half-applying when the hierarchy cannot be resolved', async () => {
    mockRollup.mockRejectedValue(new Error('platform down'));
    await call({ entitled: false });
    expect(mockSync).not.toHaveBeenCalled();
    // 503 so billing's own retry re-drives it; a partial apply would leave the half that
    // kept running as the half nobody checks.
    expect(mockSendError.mock.calls[0]?.[1]).toBe(503);
  });

  it('notifies each paused definition\'s lead, naming the entitlement', async () => {
    mockSync.mockResolvedValue({ skipped: false, paused: [definition(), definition({ id: 'def-2' })], resumed: [] });
    await call({ entitled: false });
    expect(mockNotifyPaused).toHaveBeenCalledTimes(2);
    expect(mockNotifyPaused.mock.calls[0]?.[1]).toBe('entitlement');
  });

  it('does not notify on a resume — nothing stopped', async () => {
    mockSync.mockResolvedValue({ skipped: false, paused: [], resumed: [definition()] });
    await call({ entitled: true });
    expect(mockNotifyPaused).not.toHaveBeenCalled();
  });

  it('survives a notification failure without failing the sync', async () => {
    mockSync.mockResolvedValue({ skipped: false, paused: [definition()], resumed: [] });
    mockNotifyPaused.mockRejectedValue(new Error('message service down'));
    await call({ entitled: false });
    // The pause is the durable part and it already landed; a lost notice must not make
    // billing retry a change that was applied.
    expect(payload()).toMatchObject({ paused: 1 });
  });

  it('audits a pause and a resume as DIFFERENT actions', async () => {
    mockSync
      .mockResolvedValueOnce({ skipped: false, paused: [definition()], resumed: [] })
      .mockResolvedValueOnce({ skipped: false, paused: [], resumed: [definition({ id: 'def-2' })] });
    mockRollup.mockResolvedValue(['root-org', 'team-a']);
    await call({ entitled: false });
    const actions = mockRecordAudit.mock.calls.map((c) => (c[0] as { action: string }).action);
    // "When did this account's reporting stop" and "when did it resume" are different
    // questions; one action with a detail would make the second one a full-table read.
    expect(actions).toContain('reporting.report.paused');
    expect(actions).toContain('reporting.report.resumed');
  });

  it('reports a STALE push distinctly from "nothing to do"', async () => {
    mockSync.mockResolvedValue({ skipped: true, paused: [], resumed: [] });
    await call({ entitled: true, occurredAt: '2026-09-01T00:00:00.000Z' });
    // Both produce zero pauses and zero resumes; only `staleOrgs` tells billing that its
    // push lost to a newer one rather than finding nothing to change.
    expect(payload()).toMatchObject({ paused: 0, resumed: 0, staleOrgs: 1 });
  });

  it('passes occurredAt through so the store can refuse an out-of-order push', async () => {
    await call({ entitled: false, occurredAt: '2026-09-21T10:00:00.000Z' });
    const opts = mockSync.mock.calls[0]?.[2] as { occurredAt?: Date };
    expect(opts.occurredAt?.toISOString()).toBe('2026-09-21T10:00:00.000Z');
  });

  it.each([
    ['a missing entitled flag', {}],
    ['a non-boolean entitled flag', { entitled: 'yes' }],
    ['a malformed occurredAt', { entitled: true, occurredAt: 'nope' }],
  ])('refuses %s before touching anything', async (_case, body) => {
    await call(body);
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('refuses a missing orgId', async () => {
    await call({ entitled: true }, '');
    expect(mockSendBadRequest).toHaveBeenCalled();
  });
});

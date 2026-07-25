// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-emission tests for the scan-schedule routes. create/update/delete emit
 * the matching `compliance.scan-schedule.*` event; the active toggle has no
 * dedicated action, so it is modelled as an UPDATE carrying `{ active }`. Each
 * emits only AFTER a successful mutation, never on validation-failure/not-found.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const createMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const updateMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const toggleMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const softDeleteMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const emitComplianceAuditMock = jest.fn();

let validatePasses = true;
let cronValid = true;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateBody: (req: any) =>
    validatePasses ? { ok: true, value: req.body } : { ok: false, error: 'invalid' },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendEntityNotFound: jest.fn((res: any, what: string) => res.status(404).json({ message: what })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.user?.sub });
  },
}));

jest.unstable_mockModule('../src/helpers/scan-scheduler.js', () => ({
  CRON_VALIDATION_HINT: 'hint',
  isValidCronExpression: () => cronValid,
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('../src/services/compliance-scan-schedule-service.js', () => ({
  complianceScanScheduleService: {
    list: async () => ({ schedules: [], total: 0 }),
    create: (...a: unknown[]) => createMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    toggleActive: (...a: unknown[]) => toggleMock(...a),
    softDelete: (...a: unknown[]) => softDeleteMock(...a),
  },
}));

const { createScanScheduleRoutes } = await import('../src/routes/scan-schedules.js');

function lastHandler(path: string, method: string) {
  const router = createScanScheduleRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method],
  );
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const SCHED_ID = '44444444-4444-4444-8444-444444444444';
const USER = { sub: 'u-1', email: 'u1@example.com', organizationId: 'org-a' };

beforeEach(() => {
  jest.clearAllMocks();
  validatePasses = true;
  cronValid = true;
});

describe('POST / — create emits compliance.scan-schedule.create', () => {
  it('emits on success', async () => {
    createMock.mockResolvedValueOnce({ id: SCHED_ID, target: 'plugin' });
    const handler = lastHandler('/', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', body: { target: 'plugin', cronExpression: '* * * * *' }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(201);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.scan-schedule.create',
      actorId: 'u-1',
      targetType: 'scan-schedule',
      targetId: SCHED_ID,
      details: { target: 'plugin' },
    }));
  });

  it('does not emit when the cron expression is invalid', async () => {
    cronValid = false;
    const handler = lastHandler('/', 'post');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', body: { target: 'plugin', cronExpression: 'bad' }, user: USER } as any, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(createMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});

describe('PUT /:id — update emits compliance.scan-schedule.update', () => {
  it('emits on success', async () => {
    updateMock.mockResolvedValueOnce({ id: SCHED_ID, target: 'all' });
    const handler = lastHandler('/:id', 'put');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: SCHED_ID }, body: { target: 'all' }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.scan-schedule.update',
      targetId: SCHED_ID,
      details: { target: 'all' },
    }));
  });

  it('does not emit when not found', async () => {
    updateMock.mockResolvedValueOnce(null);
    const handler = lastHandler('/:id', 'put');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { id: SCHED_ID }, body: { target: 'all' }, user: USER } as any, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /:id/active — toggle emits compliance.scan-schedule.update with { active }', () => {
  it('emits an update carrying the new active state', async () => {
    toggleMock.mockResolvedValueOnce({ id: SCHED_ID, target: 'plugin', isActive: false });
    const handler = lastHandler('/:id/active', 'patch');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: SCHED_ID }, body: { isActive: false }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.scan-schedule.update',
      targetId: SCHED_ID,
      details: { active: false },
    }));
  });

  it('does not emit when not found', async () => {
    toggleMock.mockResolvedValueOnce(null);
    const handler = lastHandler('/:id/active', 'patch');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { id: SCHED_ID }, body: { isActive: true }, user: USER } as any, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /:id — delete emits compliance.scan-schedule.delete', () => {
  it('emits on success', async () => {
    softDeleteMock.mockResolvedValueOnce({ id: SCHED_ID, target: 'pipeline' });
    const handler = lastHandler('/:id', 'delete');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: SCHED_ID }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.scan-schedule.delete',
      targetId: SCHED_ID,
      details: { target: 'pipeline' },
    }));
  });

  it('does not emit when not found', async () => {
    softDeleteMock.mockResolvedValueOnce(null);
    const handler = lastHandler('/:id', 'delete');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { id: SCHED_ID }, user: USER } as any, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});

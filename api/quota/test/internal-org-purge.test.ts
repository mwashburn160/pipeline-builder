// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * quota's org-purge cascade leg (`QUOTA_INTERNAL.purgeOrg`): drops everything
 * quota holds for the purged org, answers the outbox's ack, and records what it removed
 * (or that it failed) as an `org.data.purge` row against the purged org.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { routeHandler, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/internal-org-purge-test';

const mockRecordAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockRecordAudit,
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json({ success: true, data }); return res; },
  sendError: (res: any, status: number, message: string) => { res.status(status).json({ success: false, message }); return res; },
  sendBadRequest: (res: any, message: string) => { res.status(400).json({ success: false, message }); return res; },
}));

const { createInternalOrgPurgeRoutes } = await import('../src/routes/internal-org-purge.js');

const mockPurge = jest.fn<(orgId: string) => Promise<Record<string, number>>>();
const handler = routeHandler(createInternalOrgPurgeRoutes({ purgeOrg: mockPurge } as any), 'post', '/internal/orgs/:orgId/purge');

function makeRes() {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /quotas/internal/orgs/:orgId/purge', () => {
  it('drops the org\'s rows and audits the counts against the purged org', async () => {
    mockPurge.mockResolvedValue({ organizations: 1, usageEvents: 3 });
    const res = makeRes();
    await handler({ params: { orgId: 'org-9' } }, res);

    expect(mockPurge).toHaveBeenCalledWith('org-9');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { orgId: 'org-9', tables: { organizations: 1, usageEvents: 3 } } });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.data.purge',
      actorId: 'system',
      affectedOrgId: 'org-9',
      targetType: 'organization',
      targetId: 'org-9',
      details: { owner: 'quota', tables: { organizations: 1, usageEvents: 3 } },
    }));
  });

  it('is idempotent: an already-absent document still answers 200 (the ack)', async () => {
    mockPurge.mockResolvedValue({ organizations: 0 });
    const res = makeRes();
    await handler({ params: { orgId: 'org-9' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { orgId: 'org-9', tables: { organizations: 0 } } });
  });

  it('a store failure is a 500 (the leg retries) and a failure row', async () => {
    mockPurge.mockRejectedValue(new Error('mongo down'));
    const res = makeRes();
    await handler({ params: { orgId: 'org-9' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.data.purge', targetId: 'org-9', outcome: 'failure',
    }));
  });

  it('never lets a throwing audit recorder turn the ack into an error', async () => {
    mockPurge.mockResolvedValue({ organizations: 1 });
    mockRecordAudit.mockImplementationOnce(() => { throw new Error('audit sink down'); });
    const res = makeRes();
    await handler({ params: { orgId: 'org-9' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('400s without an org id and deletes nothing', async () => {
    const res = makeRes();
    await handler({ params: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});

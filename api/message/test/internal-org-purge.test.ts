// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The internal org-purge route: the blob reclaim the platform org-delete
 * cascade calls, and the `message.org.purge` row that records what it reclaimed
 * (or that it did not complete).
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockPurgeOrgBlobs = jest.fn<(orgId: string) => Promise<number>>();
jest.unstable_mockModule('../src/services/attachment-service.js', () => ({ attachmentService: { purgeOrgBlobs: mockPurgeOrgBlobs } }));
const mockRecordAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockRecordAudit,
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json({ success: true, data }); return res; },
  sendError: (res: any, status: number, message: string) => { res.status(status).json({ success: false, message }); return res; },
  sendBadRequest: (res: any, message: string) => { res.status(400).json({ success: false, message }); return res; },
}));

const { createInternalOrgPurgeRoutes } = await import('../src/routes/internal-org-purge.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}

/** The final (real) handler, skipping the auth middlewares. */
function handler() {
  const router: any = createInternalOrgPurgeRoutes();
  const layer = router.stack.find((l: any) => l.route?.path === '/internal/org/:orgId/attachments');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('DELETE /messages/internal/org/:orgId/attachments', () => {
  it('purges and audits the blob count against the purged org', async () => {
    mockPurgeOrgBlobs.mockResolvedValue(4);
    const res = makeRes();
    await handler()({ params: { orgId: 'org-9' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'message.org.purge',
      actorId: 'system',
      affectedOrgId: 'org-9',
      targetType: 'organization',
      targetId: 'org-9',
      details: { blobsDeleted: 4 },
    }));
  });

  it('records a failed reclaim as a failure row and answers non-2xx', async () => {
    mockPurgeOrgBlobs.mockRejectedValue(new Error('storage down'));
    const res = makeRes();
    await handler()({ params: { orgId: 'org-9' } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'message.org.purge', targetId: 'org-9', outcome: 'failure',
    }));
  });

  it('400s without an org id and audits nothing', async () => {
    const res = makeRes();
    await handler()({ params: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});

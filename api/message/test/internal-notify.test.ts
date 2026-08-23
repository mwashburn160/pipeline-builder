// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/message-service.js', () => ({ messageService: { create: mockCreate } }));
// The route imports `incCounter` from api-server; mock it so the real api-server
// (and its heavier api-core surface) isn't pulled into this unit test.
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ incCounter: jest.fn() }));
// runWithTenantContext just runs the callback (no real ALS/DB needed here).
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({ runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn() }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireServicePrincipal: (_req: any, _res: any, next: any) => next(),
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json({ success: true, data }); return res; },
  sendError: (res: any, status: number, message: string) => { res.status(status).json({ success: false, message }); return res; },
  sendBadRequest: (res: any, message: string) => { res.status(400).json({ success: false, message }); return res; },
}));

const { createInternalNotifyRoutes } = await import('../src/routes/internal-notify.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const mockSse = { send: jest.fn() } as any;

/** Grab the final (real) handler for POST /internal/notify, skipping the auth middlewares. */
function handler() {
  const router: any = createInternalNotifyRoutes(mockSse);
  const layer = router.stack.find((l: any) => l.route?.path === '/internal/notify');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /messages/internal/notify', () => {
  it('400 when required fields are missing', async () => {
    const res = makeRes();
    await handler()({ body: { recipientOrgId: 'org-1' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects the "*" broadcast recipient', async () => {
    const res = makeRes();
    await handler()({ body: { recipientOrgId: '*', subject: 's', content: 'c' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('creates a SYSTEM-authored message + pushes SSE + 201', async () => {
    mockCreate.mockResolvedValue({ id: 'm1' });
    const res = makeRes();
    await handler()({ body: { recipientOrgId: 'Org-1', subject: 'hi', content: 'body' } }, res);

    const data = mockCreate.mock.calls[0][0] as any;
    expect(data.orgId).toBe('000000000000000000000001'); // system is the sender
    expect(data.recipientOrgId).toBe('org-1');            // lowercased
    expect(data.createdBy).toBe('system');
    expect(data.messageType).toBe('conversation');
    expect(mockSse.send).toHaveBeenCalledWith('org-1', 'MESSAGE', 'New message', expect.objectContaining({ action: 'NEW_MESSAGE', messageId: 'm1' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('redacts the subject in the SSE ping for a targeted DM', async () => {
    mockCreate.mockResolvedValue({ id: 'm2' });
    const res = makeRes();
    await handler()({ body: { recipientOrgId: 'org-1', recipientUserId: 'u9', subject: 'secret', content: 'body' } }, res);
    const ssePayload = (mockSse.send as jest.Mock).mock.calls[0][3] as any;
    expect(ssePayload.subject).toBeUndefined();
  });
});

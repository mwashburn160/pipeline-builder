// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the attachment upload/download routes — focused on the upload happy
 * path/validation and the SECURITY-CRITICAL download visibility gate (a linked
 * attachment is readable only if its parent message is; a pending one only by
 * its uploader).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindByMessageId = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCreatePending = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindVisibleById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPutAttachment = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockGetAttachmentStream = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDeleteAttachment = jest.fn<(...a: unknown[]) => Promise<void>>();

let identity = { orgId: 'org-1', userId: 'user-1' };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: any) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: any, message: string, code?: string) => res.status(400).json({ message, code }),
  sendError: (res: any, status: number, message: string, code?: string) => res.status(status).json({ message, code }),
  sendEntityNotFound: (res: any, entity: string) => res.status(404).json({ message: `${entity} not found.` }),
  getParam: (p: any, k: string) => p?.[k],
  requirePermission: () => (_req: any, _res: any, next: () => void) => next(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  incrementQuotaFromCtx: jest.fn(),
  rateLimitByOrg: () => (_req: any, _res: any, next: () => void) => next(),
  requireAuth: (_req: any, _res: any, next: () => void) => next(),
  requireOrgId: () => (_req: any, _res: any, next: () => void) => next(),
  withTenantContext: () => (_req: any, _res: any, next: () => void) => next(),
  createProtectedRoute: () => [],
  withRoute: (handler: Function) => async (req: any, res: any) => {
    try {
      await handler({ req, res, ctx: { log: jest.fn() }, orgId: identity.orgId, userId: identity.userId });
    } catch (err: any) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  },
}));

jest.unstable_mockModule('../src/services/attachment-service.js', () => ({
  attachmentService: {
    findById: mockFindById,
    findByMessageId: mockFindByMessageId,
    createPending: mockCreatePending,
    linkToMessage: jest.fn(async () => []),
  },
}));

const mockGetAttachmentStreamOrNull = jest.fn<(...args: unknown[]) => unknown>();
const mockGenerateThumbnail = jest.fn<(...args: unknown[]) => unknown>().mockResolvedValue(null);

jest.unstable_mockModule('../src/services/attachment-storage.js', () => ({
  putAttachment: mockPutAttachment,
  getAttachmentStream: mockGetAttachmentStream,
  getAttachmentStreamOrNull: mockGetAttachmentStreamOrNull,
  deleteAttachment: mockDeleteAttachment,
  deleteAttachments: jest.fn(async () => undefined),
  generateThumbnail: mockGenerateThumbnail,
  thumbnailKeyFor: (orgId: string, id: string) => `${orgId}/${id}/thumb`,
  thumbnailContentType: (ct: string) => (ct === 'image/png' ? 'image/png' : 'image/jpeg'),
}));

jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: { findVisibleById: mockFindVisibleById },
}));

const { createAttachmentRoutes } = await import('../src/routes/attachment-routes.js');

const router: any = createAttachmentRoutes({ increment: jest.fn(), check: jest.fn(), getUsage: jest.fn() } as any);

function getHandler(method: string, path: string) {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route?.methods[method]);
  if (!layer) throw new Error(`No handler for ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.headersSent = false;
  res.destroy = jest.fn();
  res.end = jest.fn();
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  identity = { orgId: 'org-1', userId: 'user-1' };
});

describe('POST /attachments (upload)', () => {
  const handler = getHandler('post', '/attachments');

  it('stores the blob + metadata and returns 201', async () => {
    mockPutAttachment.mockResolvedValue(undefined);
    mockCreatePending.mockResolvedValue({ id: 'att-1', filename: 'pic.png', contentType: 'image/png', sizeBytes: 12 });
    const req: any = { file: { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'pic.png', size: 12 } };
    const res = mockRes();
    await handler(req, res);

    expect(mockPutAttachment).toHaveBeenCalled();
    expect(mockCreatePending).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', uploadedBy: 'user-1', contentType: 'image/png' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 400 when no file is present', async () => {
    const req: any = {};
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPutAttachment).not.toHaveBeenCalled();
  });

  it('reclaims the blob if the metadata insert fails', async () => {
    mockPutAttachment.mockResolvedValue(undefined);
    mockCreatePending.mockRejectedValue(new Error('db down'));
    const req: any = { file: { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'p.png', size: 3 } };
    const res = mockRes();
    await handler(req, res);
    expect(mockDeleteAttachment).toHaveBeenCalled(); // orphan blob reclaimed
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /attachments/:id (download visibility gate)', () => {
  const handler = getHandler('get', '/attachments/:id');
  const fakeStream = () => ({ on: jest.fn(), pipe: jest.fn() });

  it('streams a linked attachment when the parent message is visible', async () => {
    mockFindById.mockResolvedValue({ id: 'att-1', messageId: 'msg-1', storageKey: 'k', contentType: 'image/png', filename: 'p.png', sizeBytes: 5, uploadedBy: 'user-1' });
    mockFindVisibleById.mockResolvedValue({ id: 'msg-1' });
    const stream = fakeStream();
    mockGetAttachmentStream.mockResolvedValue(stream);
    const req: any = { params: { id: 'att-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(mockFindVisibleById).toHaveBeenCalledWith('msg-1', 'org-1', 'user-1');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });

  it('404s a linked attachment whose parent message is NOT visible to the caller', async () => {
    mockFindById.mockResolvedValue({ id: 'att-1', messageId: 'msg-1', storageKey: 'k', contentType: 'application/pdf', filename: 'd.pdf', sizeBytes: 5, uploadedBy: 'other' });
    mockFindVisibleById.mockResolvedValue(null); // not visible to this viewer
    const req: any = { params: { id: 'att-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGetAttachmentStream).not.toHaveBeenCalled();
  });

  it('404s a pending attachment for a non-uploader', async () => {
    mockFindById.mockResolvedValue({ id: 'att-1', messageId: null, storageKey: 'k', contentType: 'application/pdf', filename: 'd.pdf', sizeBytes: 5, uploadedBy: 'someone-else' });
    const req: any = { params: { id: 'att-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGetAttachmentStream).not.toHaveBeenCalled();
  });

  it('404s when the attachment does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    const req: any = { params: { id: 'missing' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

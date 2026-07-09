// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /internal/notify-email — the internal email-send endpoint
 * compliance calls. Exercises recipient resolution (targetUsers intersected
 * with active membership, or all admins when null), validation, and the
 * zero-recipient case. Models + EmailService are mocked.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockMembershipFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFind = jest.fn<(...a: unknown[]) => unknown>();
const mockSend = jest.fn<(...a: unknown[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));

jest.unstable_mockModule('mongoose', () => {
  // Functional ObjectId so `toOrgId` (org-id.js) can run: 24-hex → ObjectId,
  // else the string unchanged. Include a `default` export (org-id.js default-imports mongoose).
  class ObjectId {
    v: unknown;
    constructor(v?: unknown) { this.v = v; }
    toString() { return String(this.v); }
    static isValid(v: unknown) { return typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v); }
  }
  class Schema { constructor() { /* no-op */ } index() { /* no-op */ } method() { /* no-op */ } static Types = { Mixed: class {}, ObjectId }; }
  const api = { Types: { Mixed: class {}, ObjectId }, Schema, models: {}, model: jest.fn() };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/middleware/index.js', () => ({
  requireServiceAuth: jest.fn(),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  UserOrganization: { find: (...a: unknown[]) => ({ lean: () => mockMembershipFind(...a) }) },
  User: { find: (...a: unknown[]) => ({ lean: () => mockUserFind(...a) }) },
}));

jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { send: (...a: unknown[]) => mockSend(...a) },
  default: { send: (...a: unknown[]) => mockSend(...a) },
}));

const { handleNotifyEmail } = await import('../src/routes/notify-email.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockMembershipFind.mockReset();
  mockUserFind.mockReset();
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
});

describe('handleNotifyEmail', () => {
  it('400s when required fields are missing', async () => {
    const res = mockRes();
    await handleNotifyEmail({ body: { subject: 's', text: 't' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it('emails all active admins/owners when targetUsers is null', async () => {
    mockMembershipFind.mockResolvedValue([
      { userId: 'u1', role: 'admin' },
      { userId: 'u2', role: 'member' },
      { userId: 'u3', role: 'owner' },
    ]);
    mockUserFind.mockResolvedValue([{ email: 'a@x.com' }, { email: 'o@x.com' }]);

    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', targetUsers: null, subject: 'S', text: 'T' } } as any, res);

    // only the admin + owner userIds are looked up (member filtered out)
    const userIdArg = (mockUserFind.mock.calls[0][0] as { _id: { $in: string[] } })._id.$in;
    expect(userIdArg).toEqual(['u1', 'u3']);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@x.com', 'o@x.com'], subject: 'S', text: 'T' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('intersects targetUsers with active membership (drops outsiders)', async () => {
    mockMembershipFind.mockResolvedValue([
      { userId: 'u1', role: 'member' },
      { userId: 'u2', role: 'admin' },
    ]);
    mockUserFind.mockResolvedValue([{ email: 'u1@x.com' }]);

    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', targetUsers: ['u1', 'u-outsider'], subject: 'S', text: 'T' } } as any, res);

    const userIdArg = (mockUserFind.mock.calls[0][0] as { _id: { $in: string[] } })._id.$in;
    expect(userIdArg).toEqual(['u1']); // u-outsider not a member → dropped
  });

  it('returns ok with recipientCount 0 when no recipients resolve (no send)', async () => {
    mockMembershipFind.mockResolvedValue([]);
    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', targetUsers: null, subject: 'S', text: 'T' } } as any, res);
    expect(mockSend).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { ok: true, recipientCount: 0 } }));
  });

  it('500s when the resolution/send throws', async () => {
    mockMembershipFind.mockRejectedValue(new Error('mongo down'));
    const res = mockRes();
    await handleNotifyEmail({ body: { orgId: 'org-1', subject: 'S', text: 'T' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

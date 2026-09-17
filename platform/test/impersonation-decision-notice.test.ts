// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSend = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/helpers/in-app-notify.js', () => ({
  sendInAppNotification: (...a: unknown[]) => mockSend(...a),
  sendInAppNotificationConfirmed: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: jest.fn() },
  UserOrganization: { find: jest.fn() },
}));

const { notifyRequesterOfDecision } = await import('../src/helpers/impersonation-notify.js');

const users: Record<string, unknown> = {
  op: { username: 'op-jane', lastActiveOrgId: 'system' },
  cust: { username: 'customer' },
  approver: { username: 'org-admin' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  mockUserFindById.mockImplementation((id: unknown) => ({ select: () => ({ lean: () => Promise.resolve(users[String(id)] ?? null) }) }));
});

describe('notifyRequesterOfDecision', () => {
  it('tells the requester, in their own inbox, that access was approved and to open it within the hour', async () => {
    await notifyRequesterOfDecision({ requesterId: 'op', targetUserId: 'cust', deciderId: 'approver', approved: true, breakglass: false });

    const msg = mockSend.mock.calls[0]![0] as { recipientOrgId: string; recipientUserId: string; content: string };
    expect(msg.recipientOrgId).toBe('system');
    expect(msg.recipientUserId).toBe('op');
    expect(msg.content).toMatch(/org-admin approved/);
    expect(msg.content).toMatch(/within 1 hour/);
    expect(msg.content).toContain('/dashboard/access-requests');
  });

  it('tells the requester when access was denied', async () => {
    await notifyRequesterOfDecision({ requesterId: 'op', targetUserId: 'cust', deciderId: 'approver', approved: false, breakglass: false });
    expect((mockSend.mock.calls[0]![0] as { content: string }).content).toMatch(/denied/);
  });

  it('names emergency access as such', async () => {
    await notifyRequesterOfDecision({ requesterId: 'op', targetUserId: 'cust', deciderId: 'approver', approved: true, breakglass: true });
    expect((mockSend.mock.calls[0]![0] as { subject: string }).subject).toBe('Emergency access approved');
  });

  it('sends nothing when the requester has no inbox to deliver to', async () => {
    users.orphan = { username: 'orphan' };
    await notifyRequesterOfDecision({ requesterId: 'orphan', targetUserId: 'cust', deciderId: 'approver', approved: true, breakglass: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mockSend.mockRejectedValue(new Error('message service down'));
    await expect(notifyRequesterOfDecision({ requesterId: 'op', targetUserId: 'cust', deciderId: 'approver', approved: true, breakglass: false })).resolves.toBeUndefined();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure new-message helpers shared by create/reply/internal
 * notify: the synchronous recipient-shape validator and the NEW_MESSAGE SSE
 * notifier (subject redaction + broadcast/send routing).
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { validateRecipient, notifyNewMessage } = await import('../src/helpers/new-message.js');

describe('validateRecipient', () => {
  const conv = { messageType: 'conversation' as const, recipientOrgId: 'org-2', isSysadmin: false };
  const ann = { messageType: 'announcement' as const, recipientOrgId: '*', isSysadmin: true };

  it('accepts an org-wide conversation to a concrete org', () => {
    expect(validateRecipient(conv)).toBeNull();
  });

  it('accepts a per-user targeted conversation to a concrete org', () => {
    expect(validateRecipient({ ...conv, recipientUserId: 'user-42' })).toBeNull();
  });

  it('accepts a sysadmin broadcast announcement', () => {
    expect(validateRecipient(ann)).toBeNull();
  });

  it('403s a non-sysadmin announcement (checked before the recipient shape)', () => {
    expect(validateRecipient({ ...ann, recipientOrgId: 'org-2', isSysadmin: false })).toEqual({
      status: 403, message: 'Only sysadmins can create announcements', code: 'INSUFFICIENT_PERMISSIONS',
    });
  });

  it('400s an announcement that is not a "*" broadcast', () => {
    expect(validateRecipient({ ...ann, recipientOrgId: 'org-2' })).toEqual({
      status: 400, message: 'Announcements must use "*" as recipientOrgId for broadcast', code: 'VALIDATION_ERROR',
    });
  });

  it('400s a conversation without a recipient', () => {
    expect(validateRecipient({ ...conv, recipientOrgId: '' })).toEqual({
      status: 400, message: 'recipientOrgId is required for conversations', code: 'VALIDATION_ERROR',
    });
  });

  it.each([false, true])('400s a "*" conversation even for sysadmin=%s', (isSysadmin) => {
    expect(validateRecipient({ ...conv, recipientOrgId: '*', isSysadmin })).toEqual({
      status: 400,
      message: 'Conversations cannot use "*" as recipientOrgId; "*" is reserved for announcement broadcasts',
      code: 'VALIDATION_ERROR',
    });
  });

  it('400s recipientUserId on an announcement', () => {
    expect(validateRecipient({ ...ann, recipientUserId: 'user-42' })).toEqual({
      status: 400, message: 'recipientUserId is only valid on a conversation to a specific organization', code: 'VALIDATION_ERROR',
    });
  });
});

describe('notifyNewMessage', () => {
  const sse = () => ({
    send: jest.fn<(...args: unknown[]) => number>(() => 1),
    broadcast: jest.fn<(...args: unknown[]) => number>(() => 1),
  });
  const base = { messageId: 'm-1', subject: 'Hello', senderOrgId: 'org-1', messageType: 'conversation' as const, targeted: false };

  it('sends "New message" to the lower-cased recipient org with the subject', () => {
    const s = sse();
    notifyNewMessage(s, { ...base, recipientOrgId: 'ORG-2' }, jest.fn());
    expect(s.send).toHaveBeenCalledWith('org-2', 'MESSAGE', 'New message', {
      action: 'NEW_MESSAGE', messageId: 'm-1', subject: 'Hello', senderOrgId: 'org-1', messageType: 'conversation',
    });
    expect(s.broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts "New announcement" for a "*" recipient', () => {
    const s = sse();
    notifyNewMessage(s, { ...base, recipientOrgId: '*', messageType: 'announcement' }, jest.fn());
    expect(s.broadcast).toHaveBeenCalledWith('MESSAGE', 'New announcement', expect.objectContaining({ messageId: 'm-1', messageType: 'announcement' }));
    expect(s.send).not.toHaveBeenCalled();
  });

  it('sends "New reply" with the threadId for a reply', () => {
    const s = sse();
    notifyNewMessage(s, { ...base, recipientOrgId: 'org-2', threadId: 'root-1' }, jest.fn());
    expect(s.send).toHaveBeenCalledWith('org-2', 'MESSAGE', 'New reply', expect.objectContaining({ threadId: 'root-1' }));
  });

  it('redacts the subject and never leaks a target user for a targeted message', () => {
    const s = sse();
    notifyNewMessage(s, { ...base, recipientOrgId: 'org-2', targeted: true }, jest.fn());
    const data = (s.send.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(data.subject).toBeUndefined();
    expect(data).not.toHaveProperty('recipientUserId');
  });

  it('reports a delivery failure to onError instead of throwing', () => {
    const s = sse();
    s.send.mockImplementation(() => { throw new Error('SSE down'); });
    const onError = jest.fn();
    expect(() => notifyNewMessage(s, { ...base, recipientOrgId: 'org-2' }, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'SSE down' }));
  });
});

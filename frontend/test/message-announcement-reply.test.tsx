// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Replying to an announcement. The server never threads an answer under a
 * broadcast: a customer's reply opens a support conversation of its own, and
 * the announcement's sender (support staff) cannot reply on the broadcast at
 * all. The thread view must follow the new conversation rather than leave the
 * reply as a bubble under the announcement, and must not offer the sender a
 * composer the server will refuse.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThreadView } from '../src/components/message/ThreadView';
import type { Message } from '../src/types';

const getThread = jest.fn<AnyFn>();
const replyToMessage = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getThread: (...a: unknown[]) => getThread(...a),
    replyToMessage: (...a: unknown[]) => replyToMessage(...a),
    editMessage: jest.fn<AnyFn>(),
    uploadAttachment: jest.fn<AnyFn>(),
  },
}));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ organizations: [{ id: 'org-1', name: 'Acme' }] })));

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const SYSTEM = '000000000000000000000001';
const announcement = {
  id: 'ann-1', subject: 'Maintenance Saturday', content: 'Planned downtime', orgId: SYSTEM, recipientOrgId: '*',
  createdBy: 'staff', messageType: 'announcement', priority: 'normal', createdAt: '2026-11-01T00:00:00Z',
  isRead: true, attachments: [],
} as unknown as Message;

function renderAs(currentOrgId: string, onFollowUpCreated = jest.fn<AnyFn>()) {
  getThread.mockResolvedValue({ data: { messages: [announcement] } });
  render(
    <ThreadView
      rootMessage={announcement}
      currentOrgId={currentOrgId}
      currentUserId="u1"
      onBack={jest.fn<AnyFn>()}
      onThreadRead={jest.fn<AnyFn>()}
      onFollowUpCreated={onFollowUpCreated}
      canWrite
    />,
  );
  return onFollowUpCreated;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('ThreadView — replying to an announcement', () => {
  it('a customer reply that comes back as a new thread drops the bubble and hands the thread up', async () => {
    const followUp = { ...announcement, id: 'new-1', threadId: null, orgId: 'org-1', recipientOrgId: SYSTEM, messageType: 'conversation', subject: 'Re: Maintenance Saturday', content: 'Will builds queue?' };
    replyToMessage.mockResolvedValue({ data: followUp });
    const onFollowUpCreated = renderAs('org-1');

    const box = await screen.findByPlaceholderText(/start a conversation with support/i);
    fireEvent.change(box, { target: { value: 'Will builds queue?' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(onFollowUpCreated).toHaveBeenCalledWith(followUp));
    expect(screen.queryByText('Will builds queue?')).not.toBeInTheDocument();
  });

  it('the announcement sender gets no composer, with the reason', async () => {
    renderAs(SYSTEM);
    const box = await screen.findByPlaceholderText(/Announcements are one-way/i);
    expect(box).toBeDisabled();
  });
});

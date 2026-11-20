// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An open thread re-reads when the live stream says a message in it was
 * edited elsewhere (MESSAGE_EDITED, surfaced by useMessages as `lastEdit`),
 * so the new text shows without reopening the thread. An edit of another
 * thread does not re-read this one.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { ThreadView } from '../src/components/message/ThreadView';
import type { Message } from '../src/types';

const getThread = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getThread: (...a: unknown[]) => getThread(...a) },
}));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ organizations: [{ id: 'org-1', name: 'Acme' }] })));

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const ROOT = {
  id: 'm1', subject: 'Maintenance', content: 'down at 9',
  orgId: 'org-2', recipientOrgId: 'org-1', createdBy: 'u2', messageType: 'direct',
  priority: 'normal', createdAt: '2026-09-01T00:00:00Z', isRead: true, attachments: [],
} as unknown as Message;

function thread(lastEdit: React.ComponentProps<typeof ThreadView>['lastEdit']) {
  return (
    <ThreadView
      rootMessage={ROOT}
      currentOrgId="org-1"
      currentUserId="u1"
      onBack={jest.fn<AnyFn>()}
      onThreadRead={jest.fn<AnyFn>()}
      canWrite
      lastEdit={lastEdit}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  getThread.mockResolvedValue({ data: { messages: [ROOT] } });
});

describe('ThreadView — live edits', () => {
  it('re-reads and shows the edited text when a message in THIS thread was edited', async () => {
    const { rerender } = render(thread(null));
    expect(await screen.findByText('down at 9')).toBeInTheDocument();
    expect(getThread).toHaveBeenCalledTimes(1);

    getThread.mockResolvedValue({ data: { messages: [{ ...ROOT, content: 'down at 10' }] } });
    rerender(thread({ messageId: 'm1', threadId: 'm1', seq: 1 }));
    expect(await screen.findByText('down at 10')).toBeInTheDocument();
    expect(getThread).toHaveBeenCalledTimes(2);
  });

  it('ignores an edit in another thread', async () => {
    const { rerender } = render(thread(null));
    await screen.findByText('down at 9');
    rerender(thread({ messageId: 'x1', threadId: 'x1', seq: 1 }));
    await waitFor(() => expect(getThread).toHaveBeenCalledTimes(1));
    expect(screen.getByText('down at 9')).toBeInTheDocument();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The thread's WRITE affordances against what the message service enforces.
 *
 * `PATCH /messages/:id`, `POST /messages/:id/reply` and
 * `POST /messages/attachments` all sit behind `messages:write`, while the
 * Messages page itself only needs `messages:read` — so a read-only member opens
 * a thread they may read and must not be offered edit / reply / attach.
 *
 * Edit disappears (it is an author-only affordance that was never there for
 * most rows anyway); the composer stays but goes inert with the reason on it,
 * because the viewer is already reading the conversation.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThreadView } from '../src/components/message/ThreadView';
import type { Message } from '../src/types';

const getThread = jest.fn<AnyFn>();
const replyToMessage = jest.fn<AnyFn>();
const replyToSupportCase = jest.fn<AnyFn>();
const editMessage = jest.fn<AnyFn>();
const uploadAttachment = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getThread: (...a: unknown[]) => getThread(...a),
    replyToMessage: (...a: unknown[]) => replyToMessage(...a),
    replyToSupportCase: (...a: unknown[]) => replyToSupportCase(...a),
    editMessage: (...a: unknown[]) => editMessage(...a),
    uploadAttachment: (...a: unknown[]) => uploadAttachment(...a),
  },
}));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ organizations: [{ id: 'org-1', name: 'Acme' }] })));

// jsdom implements no scrolling; the thread scrolls its tail into view on load.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const ROOT = {
  id: 'm1', subject: 'Build broke', content: 'the nightly build is red',
  orgId: 'org-1', recipientOrgId: 'org-2', createdBy: 'u1', messageType: 'direct',
  priority: 'normal', createdAt: '2026-09-01T00:00:00Z', isRead: true, attachments: [],
} as unknown as Message;

function renderThread(canWrite: boolean, extra: Partial<React.ComponentProps<typeof ThreadView>> = {}) {
  return render(
    <ThreadView
      rootMessage={ROOT}
      currentOrgId="org-1"
      currentUserId="u1"
      onBack={jest.fn<AnyFn>()}
      onThreadRead={jest.fn<AnyFn>()}
      canWrite={canWrite}
      {...extra}
    />,
  );
}

const CASE = {
  threadId: 'm1', displayNumber: 7, status: 'open', severity: 'normal', level: 'support_standard',
  openedWithIncident: false, tenantContact: 'u1', firstResponseAt: null, createdAt: '2026-09-01T00:00:00Z', closedAt: null,
};

describe('ThreadView write gate (messages:write)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getThread.mockResolvedValue({ data: { messages: [ROOT] } });
  });

  it('offers edit, reply and attach to a writer', async () => {
    renderThread(true);
    await waitFor(() => expect(screen.getByText('the nightly build is red')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply to conversation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled();
  });

  it('sends a reply for a writer', async () => {
    // The reply route answers with the message itself, not an envelope.
    replyToMessage.mockResolvedValue({ data: { ...ROOT, id: 'm2', content: 'on it' } });
    renderThread(true);
    await waitFor(() => expect(screen.getByText('the nightly build is red')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('textbox', { name: 'Reply to conversation' }), { target: { value: 'on it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => expect(replyToMessage).toHaveBeenCalledWith('m1', 'on it', undefined, expect.any(String)));
  });

  it('sends a support-case reply with the bubble\'s idempotency key', async () => {
    replyToSupportCase.mockResolvedValue({ data: { ...ROOT, id: 'm2', content: 'on it' } });
    renderThread(false, { supportCase: CASE });
    await waitFor(() => expect(screen.getByText('the nightly build is red')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('textbox', { name: 'Reply to conversation' }), { target: { value: 'on it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() => expect(replyToSupportCase).toHaveBeenCalledWith('m1', 'on it', undefined, expect.any(String)));
    expect(replyToMessage).not.toHaveBeenCalled();
  });

  it('drops the edit affordance for a reader — even on their OWN message', async () => {
    // The route checks messages:write BEFORE authorship, so an author without it
    // would have got a 404 on save.
    renderThread(false);
    await waitFor(() => expect(screen.getByText('the nightly build is red')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('leaves the composer visible but inert for a reader, with the reason', async () => {
    renderThread(false);
    await waitFor(() => expect(screen.getByText('the nightly build is red')).toBeInTheDocument());

    const box = screen.getByRole('textbox', { name: 'Reply to conversation' });
    const attach = screen.getByRole('button', { name: 'Attach files' });
    expect(box).toBeDisabled();
    expect(attach).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(attach).toHaveAttribute('title', expect.stringContaining('messages:write'));
    expect(screen.getByText(/replying and attaching files need/i)).toBeInTheDocument();
  });

  it('does not reply on Enter for a reader (the keyboard path bypasses the button)', async () => {
    renderThread(false);
    await waitFor(() => expect(screen.getByText('the nightly build is red')).toBeInTheDocument());

    const box = screen.getByRole('textbox', { name: 'Reply to conversation' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(replyToMessage).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });
});

describe('ThreadView in a read-only (impersonation) session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getThread.mockResolvedValue({ data: { messages: [ROOT] } });
  });

  it('the case author\'s reply carve-out does not survive read-only — every write is refused', async () => {
    // Without read-only, the case author may reply on messages:read alone.
    const { unmount } = renderThread(false, { supportCase: CASE });
    await waitFor(() => expect(screen.getByText('the nightly build is red')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Reply to conversation' })).toBeEnabled();
    unmount();

    renderThread(false, { supportCase: CASE, readOnly: true });
    await waitFor(() => expect(screen.getByText('the nightly build is red')).toBeInTheDocument());
    const box = screen.getByRole('textbox', { name: 'Reply to conversation' });
    expect(box).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach files' })).toHaveAttribute('title', expect.stringMatching(/Read-only session/));
    // The case controls are writes too.
    expect(screen.getByRole('combobox', { name: 'Case status' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close case' })).toBeDisabled();
    // The permission hint would send them looking for a grant they already hold.
    expect(screen.queryByText(/replying and attaching files need/i)).not.toBeInTheDocument();
  });
});

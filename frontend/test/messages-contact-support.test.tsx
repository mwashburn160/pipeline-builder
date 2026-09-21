// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contact support from the compose form.
 *
 * The Messages page is gated on `messages:read`, and it deliberately offers
 * "Contact Support" to every member — including a read-only one. That send
 * cannot use `POST /messages` (gated on `messages:write`, correctly, for
 * ordinary org-to-org sends), so it goes to `POST /messages/support`, which is
 * gated on `messages:read` and forces the recipient server-side.
 *
 * Two halves are covered here:
 *  - ComposeModal marks a support send (`support: true`) and, for a member
 *    without `messages:write`, offers no way to address anything else;
 *  - `useMessages().sendMessage` routes a `support` send to
 *    `api.sendSupportMessage` and sends NO recipient with it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, renderHook, act } from '@testing-library/react';
import { ComposeModal } from '../src/components/message/ComposeModal';
import { useMessages } from '../src/hooks/useMessages';
import type { ApiCore } from '../src/lib/api/core';
import { messagesApi } from '../src/lib/api/domains/messages';

const sendMessage = jest.fn<AnyFn>();
const sendSupportMessage = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    sendSupportMessage: (...a: unknown[]) => sendSupportMessage(...a),
    getMessages: () => Promise.resolve({ data: { messages: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } }),
    getUnreadCount: () => Promise.resolve({ data: { count: 0 } }),
  },
}));
jest.mock('@/hooks/useMessageNotifications', () => ({
  __esModule: true,
  useMessageNotifications: () => ({ unreadCount: 0, connected: false, everConnected: false, onNotification: () => () => {} }),
}));
jest.mock('@/hooks/usePolling', () => ({ __esModule: true, usePolling: () => {} }));

const SUPPORT_ALIAS = 'support@x.io';
/** The system support org the server resolves the alias to. */
const SYSTEM_ORG = '000000000000000000000001';

function renderCompose(canWrite: boolean, onSend: jest.Mock<AnyFn>) {
  return render(
    <ComposeModal
      isOpen
      onClose={jest.fn<AnyFn>()}
      onSend={onSend}
      canWrite={canWrite}
      isSuperAdmin={false}
      supportAlias={SUPPORT_ALIAS}
      supportAliases={[SUPPORT_ALIAS]}
      recipientSuggestions={[{ value: 'team-2', label: 'Platform', isTeam: true }]}
    />,
  );
}

/** Type a body and press Send. */
function compose(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '' }) ?? screen.getByPlaceholderText(/type your message/i), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
}

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ data: { id: 'm-sent' } });
  sendSupportMessage.mockReset().mockResolvedValue({ data: { id: 'm-support' } });
});

describe('ComposeModal — support-only contact form (no messages:write)', () => {
  it('marks the send as a support send', async () => {
    const onSend = jest.fn<AnyFn>().mockResolvedValue(true);
    renderCompose(false, onSend);

    compose('the build page is blank');

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
      support: true,
      messageType: 'conversation',
      channel: 'support',
      content: 'the build page is blank',
    }));
    // No per-user target on a support send.
    expect(onSend.mock.calls[0][0]).not.toHaveProperty('recipientUserId');
  });

  it('offers no way to address anything but support — the recipient is not editable', () => {
    renderCompose(false, jest.fn<AnyFn>().mockResolvedValue(true));

    // Shown as the alias's LOCAL-PART, like every other support surface — the
    // fixed To field used to print the raw `support@x.io` routing address.
    expect(screen.getByTestId('support-recipient')).toHaveTextContent('support');
    expect(screen.getByTestId('support-recipient')).not.toHaveTextContent(SUPPORT_ALIAS);
    // The editable recipient field belongs to full compose only.
    expect(screen.queryByRole('textbox', { name: /recipient/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /recipient/i })).toBeNull();
  });
});

describe('ComposeModal — full compose (messages:write)', () => {
  it('marks a send left addressed to the support alias as a support send', async () => {
    const onSend = jest.fn<AnyFn>().mockResolvedValue(true);
    renderCompose(true, onSend);

    compose('a question for the desk');

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ support: true, channel: 'support' }));
  });

  it('does NOT mark an ordinary org-to-org send', async () => {
    const onSend = jest.fn<AnyFn>().mockResolvedValue(true);
    renderCompose(true, onSend);

    // An <input list=…> is a combobox to the a11y tree, hence the role here.
    fireEvent.change(screen.getByRole('combobox', { name: /recipient organization/i }), { target: { value: 'team-2' } });
    compose('hello team');

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0][0]).not.toHaveProperty('support');
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ recipientOrgId: 'team-2' }));
  });
});

describe('ComposeModal — attachments on a support send', () => {
  /** A writer contacting support: the attach control is there (uploading is
   *  `messages:write`), and the ids ride along on the support send, which the
   *  support route links exactly like POST /messages does. */
  it('carries uploaded attachment ids on the support send', async () => {
    const onSend = jest.fn<AnyFn>().mockResolvedValue(true);
    const onUploadAttachment = jest.fn<AnyFn>()
      .mockResolvedValueOnce({ id: 'att-1', filename: 'log.txt', contentType: 'text/plain', sizeBytes: 12 })
      .mockResolvedValueOnce({ id: 'att-2', filename: 'shot.png', contentType: 'image/png', sizeBytes: 34 });
    render(
      <ComposeModal
        isOpen
        onClose={jest.fn<AnyFn>()}
        onSend={onSend}
        canWrite
        isSuperAdmin={false}
        supportAlias={SUPPORT_ALIAS}
        supportAliases={[SUPPORT_ALIAS]}
        onUploadAttachment={onUploadAttachment}
      />,
    );

    const picker = screen.getByLabelText(/attach files/i);
    const file = (name: string) => new File(['x'], name, { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(picker, { target: { files: [file('log.txt'), file('shot.png')] } });
    });
    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledTimes(2));

    // Second thoughts about one of them: removing it drops its id from the send.
    fireEvent.click(screen.getByRole('button', { name: /remove shot.png/i }));
    compose('log attached');

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ support: true, attachmentIds: ['att-1'] }));
  });
});

describe('useMessages().sendMessage — support routing', () => {
  it('posts a support send to the contact-support route, with NO recipient', async () => {
    const { result } = renderHook(() => useMessages('org-1'));

    await act(async () => {
      await result.current.sendMessage({
        recipientOrgId: SYSTEM_ORG,
        messageType: 'conversation',
        channel: 'support',
        subject: 'help',
        content: 'the build page is blank',
        priority: 'normal',
        attachmentIds: ['att-1'],
        support: true,
      });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendSupportMessage).toHaveBeenCalledWith({
      subject: 'help',
      content: 'the build page is blank',
      priority: 'normal',
      attachmentIds: ['att-1'],
    });
    // The recipient the composer computed never leaves the client: the server
    // decides it, so sending it would only invite the illusion that it matters.
    const body = sendSupportMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('recipientOrgId');
    expect(body).not.toHaveProperty('recipientUserId');
  });

  it('posts an ordinary send to POST /messages', async () => {
    const { result } = renderHook(() => useMessages('org-1'));

    await act(async () => {
      await result.current.sendMessage({
        recipientOrgId: 'team-2',
        messageType: 'conversation',
        subject: 'hello',
        content: 'team',
      });
    });

    expect(sendSupportMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ recipientOrgId: 'team-2' }));
  });
});

/**
 * URL + body contract for the send family, exercised against the REAL domain
 * module (the page-level tests above mock `@/lib/api`). The support call is the
 * point: it must hit its own path and carry no recipient at all.
 */
describe('messagesApi send contracts', () => {
  function makeApi() {
    const calls: { path: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
    const core = {
      request: jest.fn<AnyFn>((path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
        calls.push({ path, init });
        return Promise.resolve({ success: true, data: {} });
      }),
    } as unknown as ApiCore;
    return { api: messagesApi(core), calls };
  }

  it('sendSupportMessage POSTs /api/messages/support with no recipient', async () => {
    const { api, calls } = makeApi();
    await api.sendSupportMessage({ subject: 'help', content: 'the build page is blank', priority: 'normal' });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/messages/support');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body ?? '{}')).toEqual({ subject: 'help', content: 'the build page is blank', priority: 'normal' });
  });

  it('sendSupportMessage carries a fresh idempotency key, or the caller\'s', async () => {
    const { api, calls } = makeApi();
    await api.sendSupportMessage({ subject: 'a', content: 'b' });
    await api.sendSupportMessage({ subject: 'a', content: 'b' });
    await api.sendSupportMessage({ subject: 'a', content: 'b', idempotencyKey: 'fixed-key' });

    const keys = calls.map((c) => c.init.headers?.['Idempotency-Key']);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe('fixed-key');
    // The key is a header, never part of the body the server validates.
    expect(JSON.parse(calls[2].init.body ?? '{}')).not.toHaveProperty('idempotencyKey');
  });

  it('sendMessage still POSTs /api/messages with the recipient', async () => {
    const { api, calls } = makeApi();
    await api.sendMessage({ recipientOrgId: 'team-2', messageType: 'conversation', subject: 's', content: 'c' });

    expect(calls[0].path).toBe('/api/messages');
    expect(JSON.parse(calls[0].init.body ?? '{}')).toMatchObject({ recipientOrgId: 'team-2' });
  });

  it('replyToMessage POSTs to the thread', async () => {
    const { api, calls } = makeApi();
    await api.replyToMessage('m1', 'on it', ['att-1']);

    expect(calls[0].path).toBe('/api/messages/m1/reply');
    expect(JSON.parse(calls[0].init.body ?? '{}')).toEqual({ content: 'on it', attachmentIds: ['att-1'] });
  });
});

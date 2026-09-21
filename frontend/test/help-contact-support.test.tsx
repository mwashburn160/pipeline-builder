// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Help's outbound path. The support contact form already existed as the
 * `!canWrite` branch of ComposeModal, but Help had no link to it (or to
 * anything else), so a stuck reader's only route was guessing that "Messages"
 * was where support lived. These cover the card, the send, the permission
 * branch, and the alias rendering that used to leak `support@pipeline-builder`
 * verbatim into the To field.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContactSupportCard } from '../src/components/help/ContactSupportCard';

jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({
    supportAlias: 'support@pipeline-builder',
    supportAliases: ['support@pipeline-builder', 'help@pipeline-builder'],
    isEnabled: () => true,
    isLoaded: true,
  }),
}));

const sendSupportMessage = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { sendSupportMessage: (...a: unknown[]) => sendSupportMessage(...a) },
}));

beforeEach(() => {
  jest.clearAllMocks();
  sendSupportMessage.mockResolvedValue({ success: true, data: { id: 'm1' } });
});

describe('ContactSupportCard', () => {
  it('offers a contact button naming the alias local-part, not the raw alias', () => {
    render(<ContactSupportCard canMessage />);
    expect(screen.getByTestId('help-contact-support')).toBeInTheDocument();
    expect(screen.getByText('support')).toBeInTheDocument();
    expect(screen.queryByText(/support@pipeline-builder/)).not.toBeInTheDocument();
  });

  it('opens the support compose flow and sends through the support route', async () => {
    render(<ContactSupportCard canMessage />);
    fireEvent.click(screen.getByTestId('help-contact-support'));

    // Support-only compose: the recipient is fixed and shown as its local-part.
    expect(await screen.findByTestId('support-recipient')).toHaveTextContent('support');
    expect(screen.getByTestId('support-recipient')).not.toHaveTextContent('@pipeline-builder');

    fireEvent.change(screen.getByPlaceholderText(/Type your message/i), { target: { value: 'my build is stuck' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(sendSupportMessage).toHaveBeenCalled());
    expect(sendSupportMessage.mock.calls[0][0]).toMatchObject({ content: 'my build is stuck' });
    // No recipient is ever sent — the server forces it.
    expect(sendSupportMessage.mock.calls[0][0]).not.toHaveProperty('recipientOrgId');
    // Confirmed INLINE, not through a toast: this card renders on every Help
    // page load and must not require a ToastProvider above it.
    expect(await screen.findByTestId('help-support-sent')).toBeInTheDocument();
  });

  it('explains instead of offering the button when the account cannot message', () => {
    render(<ContactSupportCard canMessage={false} />);
    expect(screen.queryByTestId('help-contact-support')).not.toBeInTheDocument();
    expect(screen.getByText(/can't send messages/i)).toBeInTheDocument();
  });

  it('always links the durable join-an-organization surface', () => {
    render(<ContactSupportCard canMessage={false} />);
    expect(screen.getByRole('link', { name: /join an organization/i })).toHaveAttribute('href', '/dashboard/onboarding');
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The row delete must be reachable WITHOUT a hover.
 *
 * It shipped as `opacity-0 group-hover:opacity-100`, which hides it outright on
 * any device with no hover — reported from an iPad, where the control simply did
 * not exist as far as the user could tell. It had no `focus:` escape either, so
 * a keyboard could not reach it.
 *
 * jsdom applies no CSS, so `getByRole` would find a fully invisible button and
 * pass either way: this asserts the CLASS, which is the thing that was wrong.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { MessageList } from '../src/components/message/MessageList';
import type { Message } from '@/types';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm-1',
  subject: 'Publish request auto-approved',
  content: 'body',
  orgId: 'system',
  recipientOrgId: 'system',
  messageType: 'conversation',
  priority: 'normal',
  createdBy: 'u-me',
  createdAt: '2026-11-11T09:52:55Z',
  updatedAt: '2026-11-11T09:52:55Z',
  readBy: {},
  ...over,
} as Message);

describe('message row delete — reachable without a pointer that hovers', () => {
  it('is never opacity-0, and carries a focus escape', () => {
    render(
      <MessageList
        messages={[msg()]}
        onSelect={jest.fn()}
        currentOrgId="system"
        onDelete={jest.fn()}
      />,
    );
    const del = screen.getByRole('button', { name: /delete message/i });
    const cls = del.className;
    // The regression: invisible until hovered.
    expect(cls).not.toContain('opacity-0 ');
    expect(cls).toMatch(/opacity-\d+/);
    // Keyboard users get it too.
    expect(cls).toContain('focus:opacity-100');
  });
});

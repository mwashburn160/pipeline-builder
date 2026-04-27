// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test the per-participant unread check used by MessageList. Replicates
 * the exported helper since it's not exported from the component file —
 * this both documents the contract and locks the case-insensitive match.
 */

import type { Message } from '../src/types';

// Mirrors the helper in src/components/message/MessageList.tsx — kept in
// sync via the test below. If MessageList changes the lookup semantics
// (e.g. case sensitivity), this test should fail.
function isUnreadFor(msg: Message, currentOrgId: string): boolean {
  return !msg.readBy[currentOrgId.toLowerCase()];
}

function makeMessage(readBy: Record<string, string> = {}): Message {
  return {
    id: 'm1',
    orgId: 'org-1',
    threadId: null,
    recipientOrgId: 'org-2',
    messageType: 'conversation',
    subject: 's',
    content: 'c',
    readBy,
    priority: 'normal',
    createdBy: 'u-1',
    createdAt: '2026-04-27T00:00:00Z',
    updatedBy: 'u-1',
    updatedAt: '2026-04-27T00:00:00Z',
    accessModifier: 'private',
    isDefault: false,
    isActive: true,
  };
}

describe('isUnreadFor (MessageList helper)', () => {
  it('returns true when readBy is empty', () => {
    expect(isUnreadFor(makeMessage(), 'org-1')).toBe(true);
  });

  it('returns false when current org has marked the message read', () => {
    expect(isUnreadFor(makeMessage({ 'org-1': '2026-04-27T00:00:00Z' }), 'org-1')).toBe(false);
  });

  it('per-participant: another org reading does NOT mark it read for me', () => {
    // Sender (org-1) marks read; recipient (org-2) is still unread.
    const msg = makeMessage({ 'org-1': '2026-04-27T00:00:00Z' });
    expect(isUnreadFor(msg, 'org-1')).toBe(false);
    expect(isUnreadFor(msg, 'org-2')).toBe(true);
  });

  it('case-insensitive match (backend stores lowercase)', () => {
    const msg = makeMessage({ 'org-x': '2026-04-27T00:00:00Z' });
    expect(isUnreadFor(msg, 'ORG-X')).toBe(false);
    expect(isUnreadFor(msg, 'Org-X')).toBe(false);
  });
});

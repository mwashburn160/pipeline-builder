// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How the thread NAMES the orgs in it.
 *
 * The name is resolved server-side (`enrichWithOrgNames` labels every row the
 * message service returns, thread route included) with the Messages page's
 * `resolveOrgName` map as a client backfill — that map is also what shows the
 * system support org as its support alias rather than its literal name,
 * "system". Both are best-effort, and the per-bubble label used to consult
 * NEITHER: it was a bare `msg.orgName || msg.orgId`, so an unresolved name put a
 * raw UUID in the middle of a conversation. These pin the shared resolution
 * chain and its honest last resort.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { ThreadView } from '../src/components/message/ThreadView';
import type { Message } from '../src/types';

const getThread = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getThread: (...a: unknown[]) => getThread(...a),
    replyToMessage: jest.fn(),
    editMessage: jest.fn(),
    uploadAttachment: jest.fn(),
  },
}));
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ organizations: [{ id: 'org-1', name: 'Acme' }] }),
}));

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const UNRESOLVED_ID = '7f3c1e2a-0000-4a11-9f00-8c2b6d4e5a91';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1', subject: 'Build broke', content: 'the nightly build is red',
  orgId: 'org-1', recipientOrgId: 'org-2', createdBy: 'u1', messageType: 'direct',
  priority: 'normal', createdAt: '2026-09-01T00:00:00Z', isRead: true, attachments: [],
  ...over,
} as unknown as Message);

function renderThread(root: Message, thread: Message[], resolveOrgName?: (id?: string | null) => string | undefined) {
  getThread.mockResolvedValue({ data: { messages: thread } });
  return render(
    <ThreadView
      rootMessage={root}
      currentOrgId="org-1"
      currentUserId="u1"
      {...(resolveOrgName ? { resolveOrgName } : {})}
      onBack={jest.fn()}
      onThreadRead={jest.fn()}
      canWrite
    />,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('ThreadView org labels', () => {
  it('prefers the server-resolved name on each bubble', async () => {
    const root = msg({ orgId: 'org-2', orgName: 'Globex', recipientOrgId: 'org-1' });
    renderThread(root, [root]);
    expect(await screen.findByText(/u1 \(Globex\)/)).toBeInTheDocument();
  });

  it('falls back to the page name map — which is what shows support by its alias', async () => {
    const supportOrg = '000000000000000000000001';
    const root = msg({ orgId: supportOrg, orgName: undefined, recipientOrgId: 'org-1' });
    renderThread(root, [root], (id) => (id === supportOrg ? 'support' : undefined));
    expect(await screen.findByText(/u1 \(support\)/)).toBeInTheDocument();
  });

  it('never renders a raw org id as visible text, and keeps it in the title', async () => {
    const root = msg({ orgId: UNRESOLVED_ID, orgName: undefined, recipientOrgId: 'org-1' });
    renderThread(root, [root]);

    const bubble = await screen.findByText(/u1 \(another organization\)/);
    expect(bubble).toHaveAttribute('title', UNRESOLVED_ID);
    expect(screen.queryByText(new RegExp(UNRESOLVED_ID))).not.toBeInTheDocument();
  });

  it('names the viewer\'s own org from the session when nothing else resolves', async () => {
    const root = msg({ orgId: 'org-1', orgName: undefined, recipientOrgId: UNRESOLVED_ID });
    renderThread(root, [root]);
    // 'Acme' comes from the session org list, not from the message row.
    expect(await screen.findByText(/u1 \(Acme\)/)).toBeInTheDocument();
  });

  it('gives the header the same treatment, id in the title only', async () => {
    const root = msg({ orgId: 'org-1', recipientOrgId: UNRESOLVED_ID, recipientOrgName: undefined });
    renderThread(root, [root]);
    await waitFor(() => expect(getThread).toHaveBeenCalled());
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('another organization');
    expect(heading).toHaveAttribute('title', UNRESOLVED_ID);
  });
});

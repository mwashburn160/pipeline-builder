// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compose recipients come from the message service's account listing
 * (`GET /messages/recipients/orgs`) — every org in the caller's account, teams
 * labelled — not from the user's own memberships. The listing is fetched only
 * while composing, and the caller's own org is not offered as a recipient.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import MessagesPage from '../pages/dashboard/messages';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/RecentlyDeletedPanel', () => ({ __esModule: true, RecentlyDeletedPanel: () => null }));
// Memberships include an org OUTSIDE the account — it must not be offered.
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ organizations: [{ id: 'org-1', name: 'Mine' }, { id: 'other-acct', name: 'Elsewhere' }] }),
}));
jest.mock('@/hooks/useFeatures', () => ({ __esModule: true, useFeatures: () => ({ supportAlias: 'support@x.io', supportAliases: [] }) }));
jest.mock('@/hooks/useMessageNotifications', () => ({
  __esModule: true,
  useMessageNotifications: () => ({ unreadCount: 0, connected: false, everConnected: false, onNotification: () => () => {} }),
}));
jest.mock('@/hooks/usePolling', () => ({ __esModule: true, usePolling: () => {} }));

// Capture what the page hands the compose modal.
const composeProps: Array<{ recipientSuggestions?: unknown }> = [];
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => (props: { recipientSuggestions?: unknown }) => {
    composeProps.push(props);
    return <div data-testid="compose" />;
  },
}));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/messages', isReady: true, replace: jest.fn(), push: jest.fn() };
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

const getRecipientOrgs = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getMessages: () => Promise.resolve({ data: { messages: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } }),
    getUnreadCount: () => Promise.resolve({ data: { count: 0 } }),
    getRecipientOrgs: (...a: unknown[]) => getRecipientOrgs(...a),
  },
}));

beforeEach(() => {
  composeProps.length = 0;
  getRecipientOrgs.mockReset().mockResolvedValue({
    success: true,
    data: {
      orgs: [
        { orgId: 'root-1', name: 'Acme', isTeam: false },
        { orgId: 'org-1', name: 'Mine', isTeam: true },
        { orgId: 'team-2', name: 'Platform', isTeam: true },
      ],
    },
  });
});

it('feeds the picker every account org (teams labelled, own org excluded), fetched on compose', async () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  render(<MessagesPage />);

  expect(getRecipientOrgs).not.toHaveBeenCalled(); // nothing until compose opens
  fireEvent.click(await screen.findByRole('button', { name: 'New Message' }));

  await waitFor(() => expect(getRecipientOrgs).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(composeProps.at(-1)?.recipientSuggestions).toEqual([
    { value: 'root-1', label: 'Acme', isTeam: false },
    { value: 'team-2', label: 'Platform', isTeam: true },
  ]));
});

it('does not call the listing without messages:write', async () => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => false });
  render(<MessagesPage />);

  fireEvent.click(await screen.findByRole('button', { name: 'Contact Support' }));
  await screen.findByTestId('compose');
  expect(getRecipientOrgs).not.toHaveBeenCalled();
  expect(composeProps.at(-1)?.recipientSuggestions).toEqual([]);
});

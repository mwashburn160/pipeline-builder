// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { TabbedPage, usePageTabs } from '@/components/ui/TabbedPage';
import NotificationsTab from '@/components/inbox/NotificationsTab';
import MessagesTab from '@/components/message/MessagesTab';
import AccessRequestsTab from '@/components/access-requests/AccessRequestsTab';
import { hasPermission } from '@/lib/auth-helpers';
import { INBOX_PATH } from '@/lib/tabbed-pages';
import { MESSAGE_VIEW_KEY } from '@/hooks/useInboxQuery';

/** Query keys only the Messages tab reads (`useInboxQuery` and the thread deep link). */
const MESSAGES_ONLY_KEYS = [MESSAGE_VIEW_KEY, 'message', 'read', 'priority', 'channel', 'from', 'org', 'removed', 'q'];

/**
 * Inbox: the action-item queue (Notifications), Messages, and Access requests.
 * Open to every signed-in user; the Messages tab keeps `messages:read`.
 */
export default function InboxPage() {
  // Open to everyone (Notifications and Access requests are ungated), so there
  // is no page-level denial to render; the Messages tab rides its own gate.
  const { user, isReady } = useAuthGuard();
  const { tabs, activeId, select } = usePageTabs(INBOX_PATH, { hasPermission: (p) => hasPermission(user, p) }, MESSAGES_ONLY_KEYS);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <TabbedPage title="Inbox" idPrefix="inbox" ariaLabel="Inbox sections" tabs={tabs} activeId={activeId} onSelect={select}>
      {activeId === 'notifications' && <NotificationsTab />}
      {activeId === 'messages' && <MessagesTab />}
      {activeId === 'access-requests' && <AccessRequestsTab />}
    </TabbedPage>
  );
}

import { useState, useCallback, useEffect, useRef } from 'react';
import { useEventCallback, useKeyedValue } from '@/hooks/useLatest';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useMessages } from '@/hooks/useMessages';
import { useInboxQuery, inboxListFilters, inboxFiltersActive } from '@/hooks/useInboxQuery';
import { useDebounce } from '@/hooks/useDebounce';
import { useFetch } from '@/hooks/useFetch';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useDelete } from '@/hooks/useDelete';
import { TabbedLayout as DashboardLayout } from '@/components/ui/TabbedPage';
import { Card } from '@/components/ui/Card';
import { LoadingPage } from '@/components/ui/Loading';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { MessageBadge } from '@/components/message/MessageBadge';
import { BELOW_LG, useMediaQuery } from '@/components/ui/responsive';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { Message } from '@/types';
import { FILTER_NOUN, MESSAGE_QUERY_KEY, type MessageFilter } from './messages-tab-shared';
import { InboxFilterBar } from './InboxFilterBar';
import { MessagesComposer } from './MessagesComposer';
import { MessagesThreadList } from './MessagesThreadList';
import { MessagesThreadPanel } from './MessagesThreadPanel';
import { useInboxBulkActions } from './useInboxBulkActions';
import { useInboxCompose } from './useInboxCompose';
import { useInboxFilterOptions, useInboxOrgNames, useSupportDesk } from './useInboxData';

// Loaded on demand: the recently-deleted panel only for writers — it does not
// belong in the inbox's first paint. (Compose loads on demand in MessagesComposer.)
const RecentlyDeletedPanel = dynamic(() => import('@/components/RecentlyDeletedPanel').then((m) => m.RecentlyDeletedPanel), { ssr: false });

/** Message inbox page. Displays conversations in a split-panel layout with compose, thread view, and unread tracking. */
export default function MessagesTab() {
  const { accessDenied, user, isReady, isSuperAdmin, can, isReadOnly } = useAuthGuard();
  // `messages:write` unlocks full compose (address other orgs/teams directly)
  // vs. the support-only contact form. Broadcast-to-all-orgs announcements stay
  // sysadmin-only (see ComposeModal `isSuperAdmin`). Role-admins hold the perm.
  const canWrite = can('messages:write');
  /**
   * Who may delete a message, matching the server exactly: `messages:write`
   * PLUS, for anyone who is not a sysadmin, their OWN root message
   * (`authorizeOwnRootMessage` — author only, and never a reply).
   *
   * Without the ownership half the trash icon appeared on every received
   * message and the request came back 403. `createdBy` is already on the row,
   * so this costs nothing to check.
   */
  const canDeleteMessage = useCallback(
    (msg: Message) => canWrite && (isSuperAdmin || (msg.createdBy === user?.id && !msg.threadId)),
    [canWrite, isSuperAdmin, user?.id],
  );
  const { organizations } = useAuth();
  const { supportAlias, supportAliases } = useFeatures();
  const router = useRouter();
  // Tab, filters and search live in the URL (linkable, survive reload).
  const [inboxQuery, setQuery] = useInboxQuery(router);
  const searchInput = inboxQuery.q;
  const setSearchInput = useCallback((q: string) => setQuery({ q }), [setQuery]);
  // Debounce so each keystroke doesn't fire a request; the hook refetches page 0
  // server-side whenever this settles.
  const debouncedSearch = useDebounce(searchInput.trim(), 300);
  // The tab IS the endpoint the data hook fetches.
  const messageFilter: MessageFilter = inboxQuery.tab;
  const removedView = inboxQuery.removed;
  const listFiltersKey = JSON.stringify(inboxListFilters(inboxQuery));
  // Keyed on the serialised filters, not the query object's identity.
  const listFilters = useKeyedValue(inboxListFilters(inboxQuery), listFiltersKey);
  const filtersActive = inboxFiltersActive(inboxQuery);
  const {
    messages,
    loading,
    error,
    unreadCount,
    total,
    livePaused,
    hasMore,
    loadingMore,
    loadMore,
    sendMessage,
    markAsRead,
    markThreadAsRead,
    deleteMessage,
    fetchMessages,
    fetchUnreadCount,
    lastEdit,
  } = useMessages(user?.organizationId, debouncedSearch, messageFilter, listFilters);

  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);

  const currentOrgId = user?.organizationId?.toLowerCase() || '';

  const { orgNameById, resolveOrgName } = useInboxOrgNames(organizations, messages, supportAlias);

  const { recentRecipients, handleSend, fetchMembers, searchRecipients, recipientSuggestions, uploadAttachment } = useInboxCompose({
    messages, currentOrgId, resolveOrgName, sendMessage, isSuperAdmin, canWrite, showCompose,
  });

  // Heading count: the SERVER's total for the active tab + search + filters —
  // not `messages.length`, which is just the pages fetched so far. Every filter
  // is applied server-side, so the total always describes what's rendered.
  const noun = FILTER_NOUN[messageFilter];
  const headingCount = total;

  // Mirror the open message into the URL (shallow) so the view is linkable and
  // Back closes it; `null` drops the key. Stable identity; writes onto the CURRENT query.
  const writeMessageParam = useEventCallback((id: string | null) => {
    const rest = { ...router.query };
    delete rest[MESSAGE_QUERY_KEY];
    void router.replace({ pathname: router.pathname, query: id ? { ...rest, [MESSAGE_QUERY_KEY]: id } : rest }, undefined, { shallow: true });
  });

  /** Open a message: select it and mark it read for the current org. */
  const openMessage = useCallback((msg: Message) => {
    setSelectedMessage(msg);
    setDeepLinkError(null);
    // Per-participant read state — mark as read only if the *current* org
    // hasn't already done so.
    const currentOrg = user?.organizationId?.toLowerCase();
    if (currentOrg && !msg.readBy?.[currentOrg]) {
      void markAsRead(msg.id);
    }
  }, [markAsRead, user?.organizationId]);

  const handleSelectMessage = useCallback((msg: Message) => {
    openMessage(msg);
    writeMessageParam(msg.id);
  }, [openMessage, writeMessageParam]);

  // Below `lg` the list and the thread are one column at a time: only the pane
  // in use is rendered, and focus follows the swap (to the thread's Back on
  // open, back to the row it came from on Back) — the element that had focus
  // just left the screen. The `hidden lg:flex` classes on the panes carry the
  // first paint, before this can read the viewport.
  const compact = useMediaQuery(BELOW_LG);
  const returnFocusTo = useRef<string | null>(null);

  const handleBack = useCallback(() => {
    if (compact) returnFocusTo.current = selectedMessage?.id ?? null;
    setSelectedMessage(null);
    writeMessageParam(null);
    void fetchMessages();
  }, [compact, fetchMessages, selectedMessage?.id, writeMessageParam]);

  // Back refetches the list, so the row exists again only once that settles.
  useEffect(() => {
    const id = returnFocusTo.current;
    if (!id || selectedMessage || loading) return;
    returnFocusTo.current = null;
    Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((el) => el.dataset.messageId === id)
      ?.focus();
  }, [selectedMessage, loading, messages]);

  // Deep link: `?message=<id>` opens that message even when it isn't on the
  // loaded page (or in the active tab/filters) — it's fetched by id through the
  // viewer-scoped `GET /messages/:id`, so a link to a message the viewer can't
  // see resolves to "not found", never to someone else's message.
  const rawLinked = router.query[MESSAGE_QUERY_KEY];
  const linkedId = router.isReady ? (Array.isArray(rawLinked) ? rawLinked[0] : rawLinked) : undefined;
  const selectedId = selectedMessage?.id;
  const openMessageRef = useRef(openMessage);
  openMessageRef.current = openMessage;
  useFetch(
    async (signal) => {
      const res = await api.getMessage(linkedId!, { signal });
      if (!res.success || !res.data?.message) {
        throw new Error('That message could not be found — it may have been deleted, or it isn’t addressed to you.');
      }
      return res.data.message;
    },
    [isReady, linkedId, selectedId],
    {
      enabled: isReady && !!linkedId && linkedId !== selectedId,
      onSuccess: (message) => openMessageRef.current(message),
      onError: (err) => setDeepLinkError(formatError(err, 'Failed to open the linked message')),
    },
  );

  // Deleting has no undo, so both the row and the thread trash icon stage the
  // id and confirm here. `useDelete` owns the confirm triplet; `deleteMessage`
  // owns the step-up replay (it is what holds the list state the replay updates).
  // The open thread closes only once the delete actually happened: a failed
  // delete (error banner) leaves it open, and a step-up-parked one closes when
  // the replay lands.
  const handleDelete = useCallback(async (id: string) => {
    const closeIfOpen = () => setSelectedMessage((prev) => (prev?.id === id ? null : prev));
    if (await deleteMessage(id, closeIfOpen)) closeIfOpen();
  }, [deleteMessage]);
  const del = useDelete<string>(handleDelete);

  const bulk = useInboxBulkActions({
    messages, messageFilter, listFilters, listFiltersKey, debouncedSearch, removedView, total,
    selectedMessage, setSelectedMessage, writeMessageParam, fetchMessages, fetchUnreadCount, setQuery, canDeleteMessage,
  });
  const { pendingRemove, setPendingRemove, removeFromInbox, hiding, removeCount, pendingBulkDelete, setPendingBulkDelete, deleteSelected, bulkDeleting } = bulk;

  const { setMembersWanted, teammateOptions, counterpartyOptions } = useInboxFilterOptions({
    user, currentOrgId, from: inboxQuery.from, org: inboxQuery.org, orgNameById,
  });
  const pendingSubject = messages.find((m) => m.id === del.target)?.subject;

  const { supportCasesQ, supportContactsQ } = useSupportDesk(currentOrgId);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Messages"
      subtitle="Inbox and conversations with your team"
      titleExtra={unreadCount > 0 ? <MessageBadge count={unreadCount} /> : undefined}
    >
      <div className="page-section">
        {/* `dvh`, not `vh`: on a phone `100vh` is the height with the browser's
            toolbars retracted, so the composer at the bottom of the thread sat
            under them. The floor is lower on a phone, where 500px is most of
            the screen. */}
        <Card className="flex overflow-hidden p-0 sm:p-5 h-[calc(100dvh-140px)] min-h-[420px] sm:min-h-[500px]">

          {/* Left panel: conversation list */}
          {(!compact || !selectedMessage) && (
          <MessagesThreadList
            messages={messages}
            loading={loading}
            error={error}
            selectedMessage={selectedMessage}
            onSelect={handleSelectMessage}
            currentOrgId={currentOrgId}
            resolveOrgName={resolveOrgName}
            onDelete={canWrite ? ((id: string) => del.open(id)) : undefined}
            canDeleteMessage={canDeleteMessage}
            hasMore={hasMore}
            loadingMore={loadingMore}
            loadMore={loadMore}
            fetchMessages={fetchMessages}
            casesByThread={supportCasesQ.data ?? undefined}
            bulk={bulk}
            livePaused={livePaused}
            total={total}
            headingCount={headingCount}
            noun={noun}
            messageFilter={messageFilter}
            removedView={removedView}
            filtersActive={filtersActive}
            debouncedSearch={debouncedSearch}
            canWrite={canWrite}
            isReadOnly={isReadOnly}
            onCompose={() => setShowCompose(true)}
            filters={(
              <InboxFilterBar
                inboxQuery={inboxQuery}
                setQuery={setQuery}
                searchInput={searchInput}
                setSearchInput={setSearchInput}
                deepLinkError={deepLinkError}
                onDismissDeepLinkError={() => { setDeepLinkError(null); writeMessageParam(null); }}
                messageFilter={messageFilter}
                removedView={removedView}
                filtersActive={filtersActive}
                teammateOptions={teammateOptions}
                counterpartyOptions={counterpartyOptions}
                onSenderFocus={() => setMembersWanted(true)}
                total={total}
                isReadOnly={isReadOnly}
                selectedCount={bulk.selectedIds.size}
                onRemoveAllMatching={() => setPendingRemove({ kind: 'matching', count: total ?? 0 })}
              />
            )}
          />
          )}

          {/* Right panel: chat or empty state */}
          {(!compact || selectedMessage) && (
          <MessagesThreadPanel
            autoFocusBack={compact}
            selectedMessage={selectedMessage}
            casesByThread={supportCasesQ.data ?? undefined}
            supportContacts={supportContactsQ.data ?? []}
            onCaseChanged={supportCasesQ.refetch}
            currentOrgId={currentOrgId}
            currentUserId={user.id}
            resolveOrgName={resolveOrgName}
            fetchMembers={fetchMembers}
            onBack={handleBack}
            onThreadRead={markThreadAsRead}
            onDelete={canWrite ? ((id: string) => del.open(id)) : undefined}
            onFollowUpCreated={(root) => { handleSelectMessage(root); void fetchMessages(); }}
            canDelete={canDeleteMessage}
            canWrite={canWrite}
            readOnly={isReadOnly}
            lastEdit={lastEdit}
          />
          )}
        </Card>

        {/* Recently deleted — restore soft-deleted messages within the retention
            window. Only for users who can write (restore is messages:write +
            step-up gated). */}
        {canWrite && (
          <div className="mt-6">
            <RecentlyDeletedPanel resource="message" onRestored={fetchMessages} />
          </div>
        )}
      </div>

      <MessagesComposer
        open={showCompose}
        onClose={() => setShowCompose(false)}
        onSend={handleSend}
        canWrite={canWrite}
        isSuperAdmin={isSuperAdmin}
        supportAlias={supportAlias}
        supportAliases={supportAliases}
        fetchMembers={fetchMembers}
        // Attachment uploads are `messages:write` (POST /messages/attachments);
        // omitting the handler hides the attach control in the support-only
        // contact form a read-only viewer gets.
        onUploadAttachment={canWrite ? uploadAttachment : undefined}
        recentRecipients={recentRecipients}
        searchRecipients={isSuperAdmin ? searchRecipients : undefined}
        recipientSuggestions={recipientSuggestions}
      />

      {/* `ConfirmDialog`, not `DeleteConfirmModal`: this deletes nothing and is
          not irreversible, and that component's copy says both. It is the
          documented non-delete sibling for a consequential action the server
          does not step-up gate (see `test/one-dialog-rule.test.ts`, which names
          the three confirmation primitives and why a fourth is not wanted). */}
      {pendingRemove && (
        <ConfirmDialog
          title="Remove from your inbox?"
          confirmLabel="Remove"
          tone="danger"
          loading={hiding}
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => void removeFromInbox(pendingRemove)}
        >
          <p className="text-sm text-fg-muted mb-1">
            Remove <strong className="text-fg">{removeCount} {pendingRemove.kind === 'ids' ? 'selected ' : ''}message{removeCount === 1 ? '' : 's'}</strong>
            {pendingRemove.kind === 'matching' && (filtersActive || debouncedSearch) ? ' matching the current filters' : ''} from your organization&apos;s inbox?
          </p>
          <p className="text-sm text-fg-muted">
            This clears them from your view only. Nothing is deleted — the sender keeps their copy,
            a later reply still arrives, and you can restore them from the Removed view.
          </p>
        </ConfirmDialog>
      )}
      {pendingBulkDelete && (
        <DeleteConfirmModal
          title={`Delete ${pendingBulkDelete.length} message${pendingBulkDelete.length === 1 ? '' : 's'}`}
          itemName={pendingBulkDelete.length === 1 ? '1 selected message and its replies' : `${pendingBulkDelete.length} selected messages and their replies`}
          loading={bulkDeleting}
          onCancel={() => setPendingBulkDelete(null)}
          onConfirm={() => void deleteSelected(pendingBulkDelete)}
        />
      )}
      {del.target && (
        <DeleteConfirmModal
          title="Delete message"
          itemName={pendingSubject || 'this message'}
          loading={del.loading}
          onCancel={del.close}
          onConfirm={() => void del.confirm()}
        />
      )}
    </DashboardLayout>
  );
}

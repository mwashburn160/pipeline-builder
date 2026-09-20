import { useState, useCallback, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { Plus, MessageCircle, Search, X } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useMessages, type MessageView, type MessageFilters } from '@/hooks/useMessages';
import { useDebounce } from '@/hooks/useDebounce';
import { useFetch } from '@/hooks/useFetch';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { Button } from '@/components/ui/Button';
import { MessageList } from '@/components/message/MessageList';
import { ThreadView } from '@/components/message/ThreadView';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { RetryError } from '@/components/ui/RetryError';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { MessageBadge } from '@/components/message/MessageBadge';
import { LiveStatusIndicator } from '@/components/message/LiveStatusIndicator';
import api from '@/lib/api';
import { aliasLocalPart } from '@/lib/support-label';
import { SYSTEM_ORG_ID, formatError } from '@/lib/constants';
import type { Message, MessagePriority } from '@/types';
import type { MemberOption } from '@/components/message/RecipientPicker';

// Loaded on demand: compose only mounts while open, and the recently-deleted
// panel only for writers — neither belongs in the inbox's first paint.
const ComposeModal = dynamic(() => import('@/components/message/ComposeModal').then((m) => m.ComposeModal), { ssr: false });
const RecentlyDeletedPanel = dynamic(() => import('@/components/RecentlyDeletedPanel').then((m) => m.RecentlyDeletedPanel), { ssr: false });


/**
 * Inbox tab. Each value is a distinct SERVER endpoint (`/messages`,
 * `/messages/conversations`, `/messages/announcements`) with its own pagination
 * — not a client-side filter over the mixed inbox, which only ever saw the
 * pages already loaded and so under-reported both the list and its count.
 */
type MessageFilter = MessageView;

const FILTER_TABS: { key: MessageFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'announcements', label: 'Announcements' },
];

/** Plural noun for the active tab (heading + empty states). */
const FILTER_NOUN: Record<MessageFilter, string> = {
  all: 'messages',
  conversations: 'conversations',
  announcements: 'announcements',
};

/**
 * Server-side list filters. `''` means "any" (the filter is not sent). Each
 * narrows the ACTIVE tab on the server, so the list, its count and its empty
 * state describe the whole corpus rather than the pages loaded so far.
 */
type ReadFilter = '' | 'unread' | 'read';
type PriorityFilter = '' | MessagePriority;
/** Known channels (open-ended server-side; `support` is the one the product sends). */
type ChannelFilter = '' | 'support';

/** Query-string key of the message deep link: `/dashboard/messages?message=<id>`. */
export const MESSAGE_QUERY_KEY = 'message';

/** Placeholder shown in the thread panel when no conversation is selected. */
function EmptyChat() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <EmptyState
        icon={MessageCircle}
        illustration="messages"
        title="Select a conversation"
        description="Choose from your conversations or start a new one"
      />
    </div>
  );
}

/** Message inbox page. Displays conversations in a split-panel layout with compose, thread view, and unread tracking. */
export default function MessagesPage() {
  const { accessDenied, user, isReady, isSuperAdmin, can, isReadOnly } = useAuthGuard();
  // `messages:write` unlocks full compose (address other orgs/teams directly)
  // vs. the support-only contact form. Broadcast-to-all-orgs announcements stay
  // sysadmin-only (see ComposeModal `isSuperAdmin`). Role-admins hold the perm.
  const canWrite = can('messages:write');
  const { organizations } = useAuth();
  const { supportAlias, supportAliases } = useFeatures();
  const [searchInput, setSearchInput] = useState('');
  // Debounce so each keystroke doesn't fire a request; the hook refetches page 0
  // server-side whenever this settles.
  const debouncedSearch = useDebounce(searchInput.trim(), 300);
  // Declared before the data hook: the tab IS the endpoint the hook fetches.
  const [messageFilter, setMessageFilter] = useState<MessageFilter>('all');
  const [readFilter, setReadFilter] = useState<ReadFilter>('');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('');
  const listFilters = useMemo<MessageFilters>(() => ({
    ...(readFilter ? { isRead: readFilter === 'read' } : {}),
    ...(priorityFilter ? { priority: priorityFilter } : {}),
    ...(channelFilter ? { channel: channelFilter } : {}),
  }), [readFilter, priorityFilter, channelFilter]);
  const filtersActive = !!(readFilter || priorityFilter || channelFilter);
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
  } = useMessages(user?.organizationId, debouncedSearch, messageFilter, listFilters);

  const router = useRouter();
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);

  const currentOrgId = user?.organizationId?.toLowerCase() || '';

  // Client-side org id → name map for DISPLAY backfill. Prefers the authoritative
  // `orgName`/`recipientOrgName` the server enriches onto each message, falls back
  // to the caller's own org memberships, and special-cases the system support org.
  // Lets the UI show a name even before/without server-side name resolution.
  const orgNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of organizations) m.set(o.id.toLowerCase(), o.name);
    for (const msg of messages) {
      if (msg.orgName) m.set(msg.orgId.toLowerCase(), msg.orgName);
      if (msg.recipientOrgName && msg.recipientOrgId !== '*') {
        m.set(msg.recipientOrgId.toLowerCase(), msg.recipientOrgName);
      }
    }
    // The system tenant is the support desk: show the primary support alias's
    // local-part (e.g. "support") — override its raw org name ("system"), which is
    // enriched onto messages and would otherwise win.
    m.set(SYSTEM_ORG_ID, aliasLocalPart(supportAlias));
    return m;
  }, [organizations, messages, supportAlias]);

  const resolveOrgName = useCallback(
    (id?: string | null): string | undefined => (id ? orgNameById.get(id.toLowerCase()) : undefined),
    [orgNameById],
  );

  // Recent recipients (#1) — distinct counterparty orgs from the loaded inbox,
  // most-recent first, for a one-tap quick-pick in compose. Excludes broadcasts
  // and the caller's own org; labels resolve to names (id fallback).
  const recentRecipients = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const m of messages) {
      if (m.messageType === 'announcement') continue;
      const isMine = m.orgId.toLowerCase() === currentOrgId;
      const otherId = isMine ? m.recipientOrgId : m.orgId;
      const otherName = isMine ? m.recipientOrgName : m.orgName;
      if (!otherId || otherId === '*') continue;
      const key = otherId.toLowerCase();
      if (key === currentOrgId || seen.has(key)) continue;
      seen.add(key);
      out.push({ value: otherId, label: otherName || resolveOrgName(otherId) || otherId });
      if (out.length >= 6) break;
    }
    return out;
  }, [messages, currentOrgId, resolveOrgName]);

  // Heading count: the SERVER's total for the active tab + search + filters —
  // not `messages.length`, which is just the pages fetched so far. Every filter
  // is applied server-side, so the total always describes what's rendered.
  const noun = FILTER_NOUN[messageFilter];
  const headingCount = total;

  // Mirror the open message into the URL (shallow) so the view is linkable and
  // Back closes it; `null` drops the key.
  const writeMessageParam = useCallback((id: string | null) => {
    const rest = { ...router.query };
    delete rest[MESSAGE_QUERY_KEY];
    void router.replace({ pathname: router.pathname, query: id ? { ...rest, [MESSAGE_QUERY_KEY]: id } : rest }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router identity changes each render
  }, [router.query, router.pathname]);

  /** Open a message: select it and mark it read for the current org. */
  const openMessage = useCallback((msg: Message) => {
    setSelectedMessage(msg);
    setDeepLinkError(null);
    // Per-participant read state — mark as read only if the *current* org
    // hasn't already done so.
    const currentOrg = user?.organizationId?.toLowerCase();
    if (currentOrg && !msg.readBy?.[currentOrg]) {
      markAsRead(msg.id);
    }
  }, [markAsRead, user?.organizationId]);

  const handleSelectMessage = useCallback((msg: Message) => {
    openMessage(msg);
    writeMessageParam(msg.id);
  }, [openMessage, writeMessageParam]);

  const handleBack = useCallback(() => {
    setSelectedMessage(null);
    writeMessageParam(null);
    fetchMessages();
  }, [fetchMessages, writeMessageParam]);

  // Deep link: `?message=<id>` opens that message even when it isn't on the
  // loaded page (or in the active tab/filters) — it's fetched by id through the
  // viewer-scoped `GET /messages/:id`, so a link to a message the viewer can't
  // see resolves to "not found", never to someone else's message.
  const rawLinked = router.query[MESSAGE_QUERY_KEY];
  const linkedId = router.isReady ? (Array.isArray(rawLinked) ? rawLinked[0] : rawLinked) : undefined;
  const selectedId = selectedMessage?.id;
  useEffect(() => {
    if (!isReady || !linkedId || linkedId === selectedId) return;
    const controller = new AbortController();
    api.getMessage(linkedId, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.success && res.data?.message) openMessage(res.data.message);
        else setDeepLinkError('That message could not be found — it may have been deleted, or it isn’t addressed to you.');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setDeepLinkError(formatError(err, 'Failed to open the linked message'));
      });
    return () => controller.abort();
    // `openMessage` is stable per org; the id pair is what drives a (re)load.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `openMessage` is stable per org; the id pair is what drives a (re)load
  }, [isReady, linkedId, selectedId]);

  // Deleting used to fire straight from the row/thread trash icon with no
  // prompt and no undo. Both call sites now stage the id and confirm here.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const pendingSubject = messages.find((m) => m.id === pendingDelete)?.subject;

  const handleDelete = useCallback(async (id: string) => {
    await deleteMessage(id);
    if (selectedMessage?.id === id) {
      setSelectedMessage(null);
    }
  }, [deleteMessage, selectedMessage]);

  const handleSend = useCallback(async (data: Parameters<typeof sendMessage>[0]): Promise<boolean> => {
    const result = await sendMessage(data);
    return result !== null;
  }, [sendMessage]);

  // Member search backing the compose "specific user" typeahead. Server-side
  // search over the selected org's roster; caps the page and maps to the minimal
  // shape the picker needs. Best-effort — a failure yields no suggestions.
  const fetchMembers = useCallback(async (orgId: string, search: string): Promise<MemberOption[]> => {
    try {
      const res = await api.getOrganizationMembers(orgId, { search, limit: 10, status: 'active' });
      return (res.data?.members ?? []).map((m) => ({ id: m.id, username: m.username, email: m.email }));
    } catch {
      return [];
    }
  }, []);

  // Cross-org directory search (#8) backing the compose recipient combobox —
  // SYSADMIN ONLY, since only sysadmins may message an org they don't belong to
  // (the send-reachability gate is bypassed for isSystemAdmin). Reuses the
  // sysadmin org roster (GET /api/organizations, supports `search`); best-effort.
  const searchRecipients = useCallback(async (query: string): Promise<{ value: string; label: string }[]> => {
    const q = query.trim();
    if (!isSuperAdmin || !q) return [];
    try {
      const res = await api.listOrganizations({ search: q, limit: 10 });
      return (res.data?.organizations ?? [])
        .filter((o) => o.id.toLowerCase() !== currentOrgId)
        .map((o) => ({ value: o.id, label: o.name }));
    } catch {
      return [];
    }
  }, [isSuperAdmin, currentOrgId]);

  // Compose recipients: every org in the caller's account (root + teams), from
  // the message service's own reachability listing — the same set its send gate
  // admits, not just the orgs this user happens to belong to. Fetched only while
  // composing, and only for `messages:write` holders (the endpoint's gate).
  const recipientOrgsQ = useFetch(async () => {
    if (!canWrite || !showCompose) return [];
    const res = await api.getRecipientOrgs();
    return res.data?.orgs ?? [];
  }, [canWrite, showCompose, currentOrgId]);
  const recipientSuggestions = useMemo(
    () => (recipientOrgsQ.data ?? [])
      .filter((o) => o.orgId.toLowerCase() !== currentOrgId)
      .map((o) => ({ value: o.orgId, label: o.name, isTeam: o.isTeam })),
    [recipientOrgsQ.data, currentOrgId],
  );

  // Upload one attachment; returns its metadata (id linked on send).
  const uploadAttachment = useCallback(async (file: File) => {
    const res = await api.uploadAttachment(file);
    if (!res.data?.attachment) throw new Error('Upload failed');
    return res.data.attachment;
  }, []);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Messages"
      subtitle="Inbox and conversations with your team"
      titleExtra={unreadCount > 0 ? <MessageBadge count={unreadCount} /> : undefined}
    >
      <div className="page-section">
        <Card className="flex overflow-hidden" style={{ height: 'calc(100vh - 140px)', minHeight: '500px' }}>

          {/* Left panel: conversation list */}
          <div className={`${selectedMessage ? 'hidden lg:flex' : 'flex'} w-full lg:w-80 flex-shrink-0 lg:border-r border-default flex-col`}>
            {/* List header */}
            <div className="flex items-center justify-between px-3 py-3 border-b border-default">
              {/* Heading names the ACTIVE tab and carries the server's total for
                  it, so the count can't disagree with what the backend holds. */}
              <h2 className="text-sm font-semibold text-fg-muted capitalize">
                {noun}
                {headingCount !== null && (
                  <span className="ml-1.5 font-normal text-fg-subtle">{headingCount}</span>
                )}
              </h2>
              <Button
                size="sm"
                onClick={() => setShowCompose(true)}
                readOnly={isReadOnly}
                title={canWrite ? 'New Message' : 'Contact Support'}
                aria-label={canWrite ? 'New Message' : 'Contact Support'}
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>

            {/* Search — free-text over subject/content (server-side). */}
            <div className="px-3 py-2 border-b border-default">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-subtle pointer-events-none" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search messages"
                  aria-label="Search messages"
                  className="w-full pl-8 pr-8 py-1.5 text-xs rounded-lg border border-default bg-surface text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand transition-colors"
                />
                {searchInput && (
                  <button
                    onClick={() => setSearchInput('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-fg-subtle hover:text-fg"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {deepLinkError && (
              <div className="px-3 py-2 border-b border-default">
                <RetryError message={deepLinkError} onRetry={() => { setDeepLinkError(null); writeMessageParam(null); }} />
              </div>
            )}

            {/* Filter tabs — message type */}
            <div className="flex items-center gap-1 px-3 py-2 border-b border-default">
              {FILTER_TABS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setMessageFilter(key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
                    messageFilter === key
                      ? 'bg-info-bg text-info'
                      : 'text-fg-muted hover:text-fg hover:bg-surface-muted'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* Server-side filters — read state, priority, channel. */}
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-default">
              <FilterSelect aria-label="Filter by read state" value={readFilter} onChange={(e) => setReadFilter(e.target.value as ReadFilter)} className="text-xs">
                <option value="">Any status</option>
                <option value="unread">Unread</option>
                <option value="read">Read</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by priority" value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)} className="text-xs">
                <option value="">Any priority</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by channel" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as ChannelFilter)} className="text-xs">
                <option value="">All channels</option>
                <option value="support">Support</option>
              </FilterSelect>
              {filtersActive && (
                <button
                  type="button"
                  onClick={() => { setReadFilter(''); setPriorityFilter(''); setChannelFilter(''); }}
                  className="text-xs font-medium text-info hover:underline"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Live-updates status — only shown when SSE has dropped after a
                healthy connection; the list keeps refreshing via polling. */}
            {livePaused && (
              <div className="px-3 py-2 border-b border-default">
                <LiveStatusIndicator paused={livePaused} />
              </div>
            )}

            {/* Message list */}
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <LoadingSpinner size="sm" />
              </div>
            ) : error ? (
              <div className="flex-1 flex flex-col justify-center px-3">
                <RetryError message={error} onRetry={fetchMessages} />
              </div>
            ) : (
              <MessageList
                messages={messages}
                onSelect={handleSelectMessage}
                selectedId={selectedMessage?.id}
                currentOrgId={currentOrgId}
                resolveOrgName={resolveOrgName}
                onDelete={canWrite ? ((id: string) => setPendingDelete(id)) : undefined}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                emptyTitle={debouncedSearch || messageFilter !== 'all' || filtersActive ? `No matching ${noun}` : undefined}
                emptyDescription={
                  // Honest now that the tab and filters are server-side: "no
                  // announcements" means the SERVER has none for this org, not
                  // "none in the pages we happened to load".
                  debouncedSearch ? `No ${noun} match "${debouncedSearch}"`
                    : filtersActive ? `No ${noun} match these filters — clear them to see everything.`
                      : messageFilter === 'announcements' ? 'No announcements have been sent to your organization.'
                        : messageFilter === 'conversations' ? 'No conversations yet — start one with the + button.'
                          : undefined
                }
              />
            )}
          </div>

          {/* Right panel: chat or empty state */}
          <div className={`${selectedMessage ? 'flex' : 'hidden lg:flex'} flex-1 flex-col min-w-0`}>
            {selectedMessage ? (
              <ThreadView
                rootMessage={selectedMessage}
                currentOrgId={currentOrgId}
                currentUserId={user.id}
                resolveOrgName={resolveOrgName}
                fetchMembers={fetchMembers}
                onBack={handleBack}
                onThreadRead={markThreadAsRead}
                onDelete={canWrite ? ((id: string) => setPendingDelete(id)) : undefined}
                canWrite={canWrite}
              />
            ) : (
              <EmptyChat />
            )}
          </div>
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

      {/* Compose modal — mounted only while open (it starts a fresh draft on
          every open anyway), so its chunk loads on first use. */}
      {showCompose && (
      <ComposeModal
        isOpen
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
      )}

      {pendingDelete && (
        <DeleteConfirmModal
          title="Delete message"
          itemName={pendingSubject || 'this message'}
          loading={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            setDeleting(true);
            try { await handleDelete(pendingDelete); } finally { setDeleting(false); setPendingDelete(null); }
          }}
        />
      )}
    </DashboardLayout>
  );
}

import { useState, useCallback, useMemo } from 'react';
import { Plus, MessageCircle, Search, X } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useMessages } from '@/hooks/useMessages';
import { useDebounce } from '@/hooks/useDebounce';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { Button } from '@/components/ui/Button';
import { MessageList } from '@/components/message/MessageList';
import { ThreadView } from '@/components/message/ThreadView';
import { ComposeModal } from '@/components/message/ComposeModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { MessageBadge } from '@/components/message/MessageBadge';
import { LiveStatusIndicator } from '@/components/message/LiveStatusIndicator';
import { RecentlyDeletedPanel } from '@/components/RecentlyDeletedPanel';
import api from '@/lib/api';
import { aliasLocalPart } from '@/lib/support-label';
import type { Message } from '@/types';
import type { MemberOption } from '@/components/message/RecipientPicker';

/** The system tenant's well-known org id (api-core SYSTEM_ORG_ID default). */
const SYSTEM_ORG_ID = '000000000000000000000001';

type MessageFilter = 'all' | 'conversations' | 'announcements';

const FILTER_TABS: { key: MessageFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'announcements', label: 'Announcements' },
];

/**
 * Channel filter. `'all'` matches every channel + the no-channel case;
 * `'none'` matches only messages with no channel (org-to-org); any other
 * string matches an exact channel value (`'support'`, `'help'`, …).
 */
type ChannelFilter = 'all' | 'none' | string;

const CHANNEL_TABS: { key: ChannelFilter; label: string }[] = [
  { key: 'all',     label: 'All channels' },
  { key: 'support', label: 'Support' },
  { key: 'none',    label: 'Other' },
];

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
  const { user, isReady, isSuperAdmin, can, isReadOnly } = useAuthGuard({ requirePermission: 'messages:read' });
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
  const {
    messages,
    loading,
    error,
    unreadCount,
    livePaused,
    hasMore,
    loadingMore,
    loadMore,
    sendMessage,
    markAsRead,
    markThreadAsRead,
    deleteMessage,
    fetchMessages,
  } = useMessages(user?.organizationId, debouncedSearch);

  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [messageFilter, setMessageFilter] = useState<MessageFilter>('all');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');

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

  // The channel filter is only meaningful when the inbox actually spans more than
  // one channel bucket (a distinct channel value, or the no-channel "Other").
  // For a single-channel inbox — the common case — hide the row to cut chrome and
  // treat the filter as "all" so a stale selection can't hide everything.
  const channelBuckets = useMemo(() => new Set(messages.map((m) => m.channel || 'none')), [messages]);
  const showChannelFilter = channelBuckets.size > 1;
  const effectiveChannelFilter = showChannelFilter ? channelFilter : 'all';

  const filteredMessages = useMemo(() => {
    let out = messages;
    if (messageFilter === 'announcements') {
      out = out.filter((m) => m.messageType === 'announcement');
    } else if (messageFilter === 'conversations') {
      out = out.filter((m) => m.messageType !== 'announcement');
    }
    if (effectiveChannelFilter === 'none') {
      out = out.filter((m) => !m.channel);
    } else if (effectiveChannelFilter !== 'all') {
      out = out.filter((m) => m.channel === effectiveChannelFilter);
    }
    return out;
  }, [messages, messageFilter, effectiveChannelFilter]);

  const handleSelectMessage = useCallback((msg: Message) => {
    setSelectedMessage(msg);
    // Per-participant read state — mark as read only if the *current* org
    // hasn't already done so.
    const currentOrg = user?.organizationId?.toLowerCase();
    if (currentOrg && !msg.readBy[currentOrg]) {
      markAsRead(msg.id);
    }
  }, [markAsRead, user?.organizationId]);

  const handleBack = useCallback(() => {
    setSelectedMessage(null);
    fetchMessages();
  }, [fetchMessages]);

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

  // Upload one attachment; returns its metadata (id linked on send).
  const uploadAttachment = useCallback(async (file: File) => {
    const res = await api.uploadAttachment(file);
    if (!res.data?.attachment) throw new Error('Upload failed');
    return res.data.attachment;
  }, []);

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
          <div className={`${selectedMessage ? 'hidden lg:flex' : 'flex'} w-full lg:w-80 flex-shrink-0 lg:border-r border-gray-200 dark:border-gray-700 flex-col`}>
            {/* List header */}
            <div className="flex items-center justify-between px-3 py-3 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Conversations</h2>
              <Button
                size="sm"
                onClick={() => setShowCompose(true)}
                disabled={isReadOnly}
                title={isReadOnly ? 'Read-only session' : (canWrite ? 'New Message' : 'Contact Support')}
                aria-label={canWrite ? 'New Message' : 'Contact Support'}
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>

            {/* Search — free-text over subject/content (server-side). */}
            <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-500 pointer-events-none" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search messages"
                  aria-label="Search messages"
                  className="w-full pl-8 pr-8 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                />
                {searchInput && (
                  <button
                    onClick={() => setSearchInput('')}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Filter tabs — message type */}
            <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
              {FILTER_TABS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setMessageFilter(key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
                    messageFilter === key
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-300 dark:hover:bg-gray-700/50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* Filter tabs — channel (only when the inbox spans >1 channel) */}
            {showChannelFilter && (
            <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
              {CHANNEL_TABS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setChannelFilter(key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors whitespace-nowrap ${
                    channelFilter === key
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-300 dark:hover:bg-gray-700/50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            )}

            {/* Live-updates status — only shown when SSE has dropped after a
                healthy connection; the list keeps refreshing via polling. */}
            {livePaused && (
              <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
                <LiveStatusIndicator paused={livePaused} />
              </div>
            )}

            {/* Message list */}
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <LoadingSpinner size="sm" />
              </div>
            ) : error ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
                <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
                <button
                  onClick={fetchMessages}
                  className="action-link mt-2"
                >
                  Try again
                </button>
              </div>
            ) : (
              <MessageList
                messages={filteredMessages}
                onSelect={handleSelectMessage}
                selectedId={selectedMessage?.id}
                currentOrgId={currentOrgId}
                resolveOrgName={resolveOrgName}
                onDelete={canWrite ? handleDelete : undefined}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                emptyTitle={debouncedSearch ? 'No results' : undefined}
                emptyDescription={debouncedSearch ? `No messages match "${debouncedSearch}"` : undefined}
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
                onDelete={canWrite ? handleDelete : undefined}
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

      {/* Compose modal */}
      <ComposeModal
        isOpen={showCompose}
        onClose={() => setShowCompose(false)}
        onSend={handleSend}
        canWrite={canWrite}
        isSuperAdmin={isSuperAdmin}
        supportAlias={supportAlias}
        supportAliases={supportAliases}
        fetchMembers={fetchMembers}
        onUploadAttachment={uploadAttachment}
        recentRecipients={recentRecipients}
        searchRecipients={isSuperAdmin ? searchRecipients : undefined}
        recipientSuggestions={organizations
          .filter((o) => o.id.toLowerCase() !== currentOrgId)
          .map((o) => ({ value: o.id, label: o.name }))}
      />
    </DashboardLayout>
  );
}

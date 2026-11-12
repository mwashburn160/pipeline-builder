import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { Plus, MessageCircle, Search, X } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useMessages, type MessageView } from '@/hooks/useMessages';
import { useInboxQuery, inboxListFilters, inboxFiltersActive, type ReadFilter, type PriorityFilter, type ChannelFilter, type FromFilter } from '@/hooks/useInboxQuery';
import { useInboxSelection } from '@/hooks/useInboxSelection';
import { useDebounce } from '@/hooks/useDebounce';
import { useFetch } from '@/hooks/useFetch';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { useToast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useDelete } from '@/hooks/useDelete';
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
import { MessageBulkBar, SelectAllCheckbox } from '@/components/message/MessageBulkBar';
import api from '@/lib/api';
import { aliasLocalPart } from '@/lib/support-label';
import { SYSTEM_ORG_ID, formatError } from '@/lib/constants';
import type { Message, SupportCaseSummary } from '@/types';
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
 * What a confirmed remove-from-inbox acts on: the ticked rows, or EVERY
 * message the active tab + filters + search match on the server.
 */
type RemoveScope = { kind: 'ids'; ids: string[] } | { kind: 'matching'; count: number };

/** Most ids one bulk call takes (mirrors api-core's `MESSAGE_BULK_MAX_IDS`); larger selections are chunked. */
const MESSAGE_BULK_MAX_IDS = 200;

/** Split `ids` into bulk-route-sized chunks. */
function chunks(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += MESSAGE_BULK_MAX_IDS) out.push(ids.slice(i, i + MESSAGE_BULK_MAX_IDS));
  return out;
}

/** "1 message" / "3 messages". */
const plural = (n: number, noun = 'message') => `${n} ${noun}${n === 1 ? '' : 's'}`;

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialised filters, not the query object
  const listFilters = useMemo(() => inboxListFilters(inboxQuery), [listFiltersKey]);
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
  } = useMessages(user?.organizationId, debouncedSearch, messageFilter, listFilters);

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

  // Recent recipients — distinct counterparty orgs from the loaded inbox,
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
      void markAsRead(msg.id);
    }
  }, [markAsRead, user?.organizationId]);

  const handleSelectMessage = useCallback((msg: Message) => {
    openMessage(msg);
    writeMessageParam(msg.id);
  }, [openMessage, writeMessageParam]);

  const handleBack = useCallback(() => {
    setSelectedMessage(null);
    writeMessageParam(null);
    void fetchMessages();
  }, [fetchMessages, writeMessageParam]);

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
  const handleDelete = useCallback(async (id: string) => {
    await deleteMessage(id);
    if (selectedMessage?.id === id) {
      setSelectedMessage(null);
    }
  }, [deleteMessage, selectedMessage]);

  const toast = useToast();
  const del = useDelete<string>(handleDelete);

  // ── Bulk selection ────────────────────────────────────────────────────────
  // Resets whenever the query changes: a selection made under one tab / filter
  // / search must never be acted on under another.
  const selection = useInboxSelection(messages, `${messageFilter}|${listFiltersKey}|${debouncedSearch}`);
  const { selectedMessages, selectedIds, allMatching, clear: clearSelection } = selection;

  /** The list's active filters as the hide route takes them (`'all'` sends no type). */
  const activeHideFilters = useMemo(() => {
    const { hidden: _hidden, ...rest } = listFilters;
    return {
      ...(messageFilter === 'conversations' ? { messageType: 'conversation' as const } : {}),
      ...(messageFilter === 'announcements' ? { messageType: 'announcement' as const } : {}),
      ...rest,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
    };
  }, [messageFilter, listFilters, debouncedSearch]);

  /** Close the open thread when a bulk action took it out of the list. */
  const closeIfAffected = useCallback((ids: string[] | 'all') => {
    if (selectedMessage && (ids === 'all' || ids.includes(selectedMessage.id))) {
      setSelectedMessage(null);
      writeMessageParam(null);
    }
  }, [selectedMessage, writeMessageParam]);

  /** After any bulk write: drop the selection, refetch the page AND the badge. */
  const afterBulk = useCallback(async () => {
    clearSelection();
    await Promise.all([fetchMessages(), fetchUnreadCount()]);
  }, [clearSelection, fetchMessages, fetchUnreadCount]);

  const [bulkBusy, setBulkBusy] = useState(false);

  /** Put rows back into the inbox (Restore in the Removed view, and Undo). */
  const restoreToInbox = useCallback(async (ids: string[]) => {
    setBulkBusy(true);
    try {
      let restored = 0;
      for (const part of chunks(ids)) restored += (await api.unhideMessages(part)).data?.restored ?? 0;
      toast.success(`Restored ${plural(restored)} to your inbox`);
      if (removedView) closeIfAffected(ids);
      await afterBulk();
    } catch (err) {
      toast.error(formatError(err, 'Could not restore those messages'));
    } finally {
      setBulkBusy(false);
    }
  }, [toast, removedView, closeIfAffected, afterBulk]);

  // Remove-from-inbox. Its own confirm rather than `useDelete`, which keys on a
  // single target id — this one acts on a selection or a whole filter.
  const [pendingRemove, setPendingRemove] = useState<RemoveScope | null>(null);
  const [hiding, setHiding] = useState(false);
  const removeFromInbox = useCallback(async (scope: RemoveScope) => {
    setHiding(true);
    try {
      // A selection sends ONLY its ids: the rows were picked off this screen,
      // and a filter added on top could silently skip one whose read state
      // moved since. "All matching" sends the filters the list is showing.
      let removed = 0;
      if (scope.kind === 'ids') {
        for (const part of chunks(scope.ids)) removed += (await api.hideMessages({ ids: part })).data?.hidden ?? 0;
      } else {
        removed = (await api.hideMessages(activeHideFilters)).data?.hidden ?? 0;
      }
      // Undo for a selection (the ids are known); for "all matching" the ids
      // never reached the client, so point at the Removed view instead.
      toast.success(
        `Removed ${plural(removed)} from your inbox`,
        undefined,
        scope.kind === 'ids'
          ? { label: 'Undo', onClick: () => void restoreToInbox(scope.ids) }
          : { label: 'View removed', onClick: () => setQuery({ removed: true }) },
      );
      setPendingRemove(null);
      closeIfAffected(scope.kind === 'ids' ? scope.ids : 'all');
      await afterBulk();
    } catch (err) {
      toast.error(formatError(err, 'Could not remove those messages'));
    } finally {
      setHiding(false);
    }
  }, [activeHideFilters, toast, restoreToInbox, setQuery, closeIfAffected, afterBulk]);
  const removeSelected = useCallback(() => {
    setPendingRemove(allMatching ? { kind: 'matching', count: total ?? messages.length } : { kind: 'ids', ids: [...selectedIds] });
  }, [allMatching, total, messages.length, selectedIds]);
  const removeCount = pendingRemove ? (pendingRemove.kind === 'ids' ? pendingRemove.ids.length : pendingRemove.count) : 0;

  /** Bulk read / unread for the ticked rows — no confirm: it is reversible view state. */
  const setReadState = useCallback(async (isRead: boolean) => {
    const ids = [...selectedIds];
    setBulkBusy(true);
    try {
      for (const part of chunks(ids)) await api.setMessagesReadState(part, isRead);
      toast.success(`Marked ${plural(ids.length)} ${isRead ? 'read' : 'unread'}`);
      await afterBulk();
    } catch (err) {
      toast.error(formatError(err, `Could not mark those messages ${isRead ? 'read' : 'unread'}`));
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds, toast, afterBulk]);

  // Bulk delete — the ticked rows only, and only when EVERY one is deletable by
  // this viewer (the bar disables it otherwise). One `POST /messages/delete`
  // per chunk: the server runs the same per-row rule as the single delete and
  // reports any row it refused instead of failing the whole call.
  const [pendingBulkDelete, setPendingBulkDelete] = useState<string[] | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const canDeleteSelected = selectedMessages.length > 0 && selectedMessages.every(canDeleteMessage);
  const deleteSelected = useCallback(async (ids: string[]) => {
    setBulkDeleting(true);
    const deleted: string[] = [];
    let leftOver = 0;
    let failure: unknown = null;
    try {
      for (const part of chunks(ids)) {
        const res = await api.deleteMessages(part);
        deleted.push(...(res.data?.deleted ?? []));
        leftOver += (res.data?.refused?.length ?? 0) + (res.data?.notFound?.length ?? 0);
      }
    } catch (err) {
      failure = err;
    }
    setBulkDeleting(false);
    setPendingBulkDelete(null);
    closeIfAffected(deleted);
    if (deleted.length > 0) toast.success(`Deleted ${plural(deleted.length)}`);
    const notDeleted = ids.length - deleted.length;
    if (failure) toast.error(`${formatError(failure, 'Delete failed')} — ${plural(notDeleted)} not deleted`);
    else if (leftOver > 0) toast.error(`${plural(leftOver)} could not be deleted (already gone, or not yours to delete)`);
    await afterBulk();
  }, [closeIfAffected, toast, afterBulk]);

  // ── Sender / counterparty filter options ───────────────────────────────────
  // Teammates for "Sent by <person>": fetched on first use of the sender
  // select (or when a linked URL already names one), not on every inbox load.
  const [membersWanted, setMembersWanted] = useState(false);
  const wantMembers = membersWanted || inboxQuery.from.startsWith('user:');
  const membersQ = useFetch(async () => {
    if (!wantMembers || !user?.organizationId) return [];
    try {
      const res = await api.getOrganizationMembers(user.organizationId, { limit: 50, status: 'active' });
      return (res.data?.members ?? []).map((m) => ({ id: m.id, label: m.username || m.email || m.id }));
    } catch {
      return []; // best-effort: no teammate options, the relative choices still work
    }
  }, [wantMembers, currentOrgId]);
  const teammateOptions = useMemo(() => {
    const list = (membersQ.data ?? []).filter((m) => m.id !== user?.id);
    const linked = inboxQuery.from.startsWith('user:') ? inboxQuery.from.slice('user:'.length) : '';
    if (linked && !list.some((m) => m.id === linked) && linked !== user?.id) list.unshift({ id: linked, label: linked });
    return list;
  }, [membersQ.data, inboxQuery.from, user?.id]);
  // Counterparty orgs: every org this inbox knows a name for (memberships +
  // orgs on loaded rows), minus our own, plus a linked one not yet seen.
  const counterpartyOptions = useMemo(() => {
    const out = [...orgNameById.entries()]
      .filter(([id]) => id !== currentOrgId && id !== '*')
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (inboxQuery.org && !out.some((o) => o.id === inboxQuery.org.toLowerCase())) out.unshift({ id: inboxQuery.org, name: inboxQuery.org });
    return out;
  }, [orgNameById, currentOrgId, inboxQuery.org]);
  const pendingSubject = messages.find((m) => m.id === del.target)?.subject;

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

  // Cross-org directory search backing the compose recipient combobox —
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

  /**
   * The org's support cases, keyed by `threadId` so a row looks itself up.
   *
   * Fetched once per org rather than per row: the case identity IS the root
   * message id, so one list joins onto every support row in the inbox without
   * an N+1. Scoped server-side by RLS — there is no org parameter to get wrong.
   *
   * Failure resolves to `{}` rather than an error state: a missing case chip
   * degrades a row to exactly how it looked before cases existed, which is not
   * worth interrupting an inbox for.
   */
  const supportCasesQ = useFetch(async () => {
    const res = await api.getSupportCases();
    const byThread: Record<string, SupportCaseSummary> = {};
    for (const c of res.data?.cases ?? []) byThread[c.threadId] = c;
    return byThread;
  }, [currentOrgId]);

  /**
   * This org's designated support contacts — the handover candidates.
   *
   * Fetched alongside the cases rather than per-case: the list is per ORG, so
   * one request serves every case in the inbox. Failure resolves to `[]`, which
   * hides the handover control rather than breaking the panel — a picker with no
   * candidates is worse than no picker.
   */
  const supportContactsQ = useFetch(async () => {
    const res = await api.getSupportContacts();
    return res.data?.contacts ?? [];
  }, [currentOrgId]);

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
              <div className="flex items-center gap-2 min-w-0">
                {!loading && !error && !isReadOnly && (
                  <SelectAllCheckbox
                    loadedCount={messages.length}
                    selectedCount={selectedIds.size}
                    allMatching={allMatching}
                    onToggle={selection.toggleAllLoaded}
                  />
                )}
              <h2 className="text-sm font-semibold text-fg-muted capitalize">
                {removedView ? `Removed ${noun}` : noun}
                {headingCount !== null && (
                  <span className="ml-1.5 font-normal text-fg-subtle">{headingCount}</span>
                )}
              </h2>
              </div>
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
                  onClick={() => setQuery({ tab: key })}
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
            {/* Server-side filters — inbox vs removed, read state, priority,
                channel, sender and counterparty. */}
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-default">
              <FilterSelect aria-label="Show inbox or removed" value={removedView ? 'removed' : 'inbox'} onChange={(e) => setQuery({ removed: e.target.value === 'removed' })} className="text-xs">
                <option value="inbox">Inbox</option>
                <option value="removed">Removed</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by read state" value={inboxQuery.read} onChange={(e) => setQuery({ read: e.target.value as ReadFilter })} className="text-xs">
                <option value="">Any status</option>
                <option value="unread">Unread</option>
                <option value="read">Read</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by priority" value={inboxQuery.priority} onChange={(e) => setQuery({ priority: e.target.value as PriorityFilter })} className="text-xs">
                <option value="">Any priority</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </FilterSelect>
              <FilterSelect aria-label="Filter by channel" value={inboxQuery.channel} onChange={(e) => setQuery({ channel: e.target.value as ChannelFilter })} className="text-xs">
                <option value="">All channels</option>
                <option value="support">Support</option>
              </FilterSelect>
              <FilterSelect
                aria-label="Filter by sender"
                value={inboxQuery.from}
                onChange={(e) => setQuery({ from: e.target.value as FromFilter })}
                onFocus={() => setMembersWanted(true)}
                className="text-xs"
              >
                <option value="">Sent by anyone</option>
                <option value="me">Sent by me</option>
                <option value="org">Sent by my org</option>
                <option value="others">Received</option>
                {teammateOptions.length > 0 && (
                  <optgroup label="Teammate">
                    {teammateOptions.map((m) => <option key={m.id} value={`user:${m.id}`}>{m.label}</option>)}
                  </optgroup>
                )}
              </FilterSelect>
              {counterpartyOptions.length > 0 && (
                <FilterSelect aria-label="Filter by organization" value={inboxQuery.org} onChange={(e) => setQuery({ org: e.target.value })} className="text-xs">
                  <option value="">Any organization</option>
                  {counterpartyOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </FilterSelect>
              )}
              {filtersActive && (
                <button
                  type="button"
                  onClick={() => setQuery({ read: '', priority: '', channel: '', from: '', org: '' })}
                  className="text-xs font-medium text-info hover:underline"
                >
                  Clear
                </button>
              )}
              {/* "Remove all" acts on exactly what the filters describe, so it
                  sits with them. `total` is the SERVER's count for this tab +
                  search + filters, which is what will actually be removed. */}
              {!removedView && (total ?? 0) > 0 && !isReadOnly && selectedIds.size === 0 && (
                <button
                  type="button"
                  onClick={() => setPendingRemove({ kind: 'matching', count: total ?? 0 })}
                  className="ml-auto text-xs font-medium text-danger hover:underline"
                >
                  Remove all {total}
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

            {/* Bulk actions — only once something is ticked. Hidden while the
                list is loading or errored: there is nothing on screen to act on. */}
            {!loading && !error && (
              <MessageBulkBar
                loadedCount={messages.length}
                selectedCount={selectedIds.size}
                allMatching={allMatching}
                total={total}
                onSelectAllMatching={selection.selectAllMatching}
                onClear={clearSelection}
                removedView={removedView}
                canAct={!isReadOnly}
                canDeleteAny={canWrite && !isReadOnly}
                canDeleteSelected={canDeleteSelected}
                busy={bulkBusy || hiding || bulkDeleting}
                onMarkRead={() => void setReadState(true)}
                onMarkUnread={() => void setReadState(false)}
                onRemove={removeSelected}
                onRestore={() => void restoreToInbox([...selectedIds])}
                onDelete={() => setPendingBulkDelete([...selectedIds])}
              />
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
                onDelete={canWrite ? ((id: string) => del.open(id)) : undefined}
                canDelete={canDeleteMessage}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                casesByThread={supportCasesQ.data ?? undefined}
                selectedIds={selectedIds}
                onToggleSelect={isReadOnly ? undefined : selection.toggle}
                emptyTitle={removedView ? `No removed ${noun}` : debouncedSearch || messageFilter !== 'all' || filtersActive ? `No matching ${noun}` : undefined}
                emptyDescription={
                  // The tab and filters are server-side, so "no announcements"
                  // means the SERVER has none for this org — not "none in the
                  // pages we happened to load".
                  removedView ? 'Messages you remove from your inbox show up here, and can be restored.'
                  : debouncedSearch ? `No ${noun} match "${debouncedSearch}"`
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
                supportCase={selectedMessage ? supportCasesQ.data?.[selectedMessage.id] : undefined}
                supportContacts={supportContactsQ.data ?? []}
                onCaseChanged={supportCasesQ.refetch}
                rootMessage={selectedMessage}
                currentOrgId={currentOrgId}
                currentUserId={user.id}
                resolveOrgName={resolveOrgName}
                fetchMembers={fetchMembers}
                onBack={handleBack}
                onThreadRead={markThreadAsRead}
                onDelete={canWrite ? ((id: string) => del.open(id)) : undefined}
                canDelete={canDeleteMessage}
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

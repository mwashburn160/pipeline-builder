// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useToast } from '@/components/ui/Toast';
import type { InboxQuery, inboxListFilters } from '@/hooks/useInboxQuery';
import { useInboxSelection } from '@/hooks/useInboxSelection';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { Message } from '@/types';
import { chunks, plural, type MessageFilter, type RemoveScope } from './messages-tab-shared';

interface InboxBulkActionsArgs {
  messages: Message[];
  messageFilter: MessageFilter;
  listFilters: ReturnType<typeof inboxListFilters>;
  /** The serialised list filters (the selection resets when they change). */
  listFiltersKey: string;
  debouncedSearch: string;
  removedView: boolean;
  /** The SERVER's total for the active tab + filters + search. */
  total: number | null;
  selectedMessage: Message | null;
  setSelectedMessage: Dispatch<SetStateAction<Message | null>>;
  writeMessageParam: (id: string | null) => void;
  fetchMessages: () => Promise<unknown>;
  fetchUnreadCount: () => Promise<unknown>;
  setQuery: (patch: Partial<InboxQuery>) => void;
  canDeleteMessage: (msg: Message) => boolean;
}

/**
 * The inbox's bulk selection and the writes it drives: remove from / restore
 * to the inbox (a selection, or everything the filters match), mark read /
 * unread, and delete — each chunked to the bulk routes' id cap.
 */
export function useInboxBulkActions({
  messages, messageFilter, listFilters, listFiltersKey, debouncedSearch, removedView, total,
  selectedMessage, setSelectedMessage, writeMessageParam, fetchMessages, fetchUnreadCount, setQuery, canDeleteMessage,
}: InboxBulkActionsArgs) {
  const toast = useToast();

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
  }, [selectedMessage, setSelectedMessage, writeMessageParam]);

  /** After any bulk write: drop the selection, refetch the page AND the badge. */
  const afterBulk = useCallback(async () => {
    clearSelection();
    await Promise.all([fetchMessages(), fetchUnreadCount()]);
  }, [clearSelection, fetchMessages, fetchUnreadCount]);

  /** Put rows back into the inbox (Restore in the Removed view, and Undo). */
  const restoreM = useMutation({
    fn: async (ids: string[]) => {
      let restored = 0;
      for (const part of chunks(ids)) restored += (await api.unhideMessages(part)).data?.restored ?? 0;
      return restored;
    },
    errorFallback: 'Could not restore those messages',
    toast: { error: true },
    onSuccess: async (restored, ids) => {
      toast.success(`Restored ${plural(restored)} to your inbox`);
      if (removedView) closeIfAffected(ids);
      await afterBulk();
    },
  });
  const { run: restoreToInbox } = restoreM;

  // Remove-from-inbox. Its own confirm rather than `useDelete`, which keys on a
  // single target id — this one acts on a selection or a whole filter.
  const [pendingRemove, setPendingRemove] = useState<RemoveScope | null>(null);
  const removeM = useMutation({
    fn: async (scope: RemoveScope) => {
      // A selection sends ONLY its ids: the rows were picked off this screen,
      // and a filter added on top could silently skip one whose read state
      // moved since. "All matching" sends the filters the list is showing.
      let removed = 0;
      if (scope.kind === 'ids') {
        for (const part of chunks(scope.ids)) removed += (await api.hideMessages({ ids: part })).data?.hidden ?? 0;
      } else {
        removed = (await api.hideMessages(activeHideFilters)).data?.hidden ?? 0;
      }
      return removed;
    },
    errorFallback: 'Could not remove those messages',
    toast: { error: true },
    onSuccess: async (removed, scope) => {
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
    },
  });
  const { run: removeFromInbox, pending: hiding } = removeM;
  const removeSelected = useCallback(() => {
    setPendingRemove(allMatching ? { kind: 'matching', count: total ?? messages.length } : { kind: 'ids', ids: [...selectedIds] });
  }, [allMatching, total, messages.length, selectedIds]);
  const removeCount = pendingRemove ? (pendingRemove.kind === 'ids' ? pendingRemove.ids.length : pendingRemove.count) : 0;

  /** Bulk read / unread for the ticked rows — no confirm: it is reversible view state. */
  const readStateM = useMutation({
    fn: async (ids: string[], isRead: boolean) => {
      for (const part of chunks(ids)) await api.setMessagesReadState(part, isRead);
    },
    onSuccess: async (_r, ids, isRead) => {
      toast.success(`Marked ${plural(ids.length)} ${isRead ? 'read' : 'unread'}`);
      await afterBulk();
    },
    onError: (err, _message, _ids, isRead) => {
      toast.error(formatError(err, `Could not mark those messages ${isRead ? 'read' : 'unread'}`));
    },
  });
  const setReadState = (isRead: boolean) => readStateM.run([...selectedIds], isRead);
  const bulkBusy = restoreM.pending || readStateM.pending;

  // Bulk delete — the ticked rows only, and only when EVERY one is deletable by
  // this viewer (the bar disables it otherwise). One `POST /messages/delete`
  // per chunk: the server runs the same per-row rule as the single delete and
  // reports any row it refused instead of failing the whole call.
  const [pendingBulkDelete, setPendingBulkDelete] = useState<string[] | null>(null);
  const canDeleteSelected = selectedMessages.length > 0 && selectedMessages.every(canDeleteMessage);
  // A PARTIAL outcome, not a pass/fail: chunks that landed stay deleted even
  // when a later one fails, so `fn` reports what happened rather than throwing.
  const bulkDeleteM = useMutation({
    fn: async (ids: string[]) => {
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
      return { deleted, leftOver, failure };
    },
    onSuccess: async ({ deleted, leftOver, failure }, ids) => {
      setPendingBulkDelete(null);
      closeIfAffected(deleted);
      if (deleted.length > 0) toast.success(`Deleted ${plural(deleted.length)}`);
      const notDeleted = ids.length - deleted.length;
      if (failure) toast.error(`${formatError(failure, 'Delete failed')} — ${plural(notDeleted)} not deleted`);
      else if (leftOver > 0) toast.error(`${plural(leftOver)} could not be deleted (already gone, or not yours to delete)`);
      await afterBulk();
    },
  });
  const { run: deleteSelected, pending: bulkDeleting } = bulkDeleteM;

  return {
    selection, selectedIds, allMatching, clearSelection,
    restoreToInbox, pendingRemove, setPendingRemove, removeFromInbox, hiding, removeSelected, removeCount,
    setReadState, bulkBusy, pendingBulkDelete, setPendingBulkDelete, canDeleteSelected, deleteSelected, bulkDeleting,
  };
}

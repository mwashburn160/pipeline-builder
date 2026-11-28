// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { TAP_TARGET } from '@/components/ui/responsive';
import type { Message, SupportCaseSummary } from '@/types';
import { LiveStatusIndicator } from './LiveStatusIndicator';
import { MessageBulkBar, SelectAllCheckbox } from './MessageBulkBar';
import { MessageList } from './MessageList';
import type { MessageFilter } from './messages-tab-shared';
import type { useInboxBulkActions } from './useInboxBulkActions';

interface MessagesThreadListProps {
  messages: Message[];
  loading: boolean;
  error: string | null;
  /** The open message (the list hides on small screens while one is open). */
  selectedMessage: Message | null;
  onSelect: (msg: Message) => void;
  currentOrgId: string;
  resolveOrgName: (id?: string | null) => string | undefined;
  /** Stage a delete for confirmation; absent without `messages:write`. */
  onDelete?: (id: string) => void;
  canDeleteMessage: (msg: Message) => boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
  fetchMessages: () => Promise<void>;
  casesByThread?: Record<string, SupportCaseSummary>;
  bulk: ReturnType<typeof useInboxBulkActions>;
  /** The search box and filters, rendered under the heading. */
  filters: ReactNode;
  livePaused: boolean;
  total: number | null;
  headingCount: number | null;
  noun: string;
  messageFilter: MessageFilter;
  removedView: boolean;
  filtersActive: boolean;
  debouncedSearch: string;
  canWrite: boolean;
  isReadOnly: boolean;
  onCompose: () => void;
}

/** The inbox's left panel: heading and compose, filters, live status, bulk bar, and the message list. */
export function MessagesThreadList({
  messages, loading, error, selectedMessage, onSelect, currentOrgId, resolveOrgName, onDelete, canDeleteMessage,
  hasMore, loadingMore, loadMore, fetchMessages, casesByThread, bulk, filters, livePaused, total, headingCount, noun,
  messageFilter, removedView, filtersActive, debouncedSearch, canWrite, isReadOnly, onCompose,
}: MessagesThreadListProps) {
  return (
    <div className={`${selectedMessage ? 'hidden lg:flex' : 'flex'} w-full lg:w-80 flex-shrink-0 lg:border-r border-default flex-col`}>
      {/* List header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-default">
        {/* Heading names the ACTIVE tab and carries the server's total for
            it, so the count can't disagree with what the backend holds. */}
        <div className="flex items-center gap-2 min-w-0">
          {!loading && !error && !isReadOnly && (
            <SelectAllCheckbox
              loadedCount={messages.length}
              selectedCount={bulk.selectedIds.size}
              allMatching={bulk.allMatching}
              onToggle={bulk.selection.toggleAllLoaded}
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
          onClick={onCompose}
          readOnly={isReadOnly}
          className={TAP_TARGET}
          title={canWrite ? 'New Message' : 'Contact Support'}
          aria-label={canWrite ? 'New Message' : 'Contact Support'}
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {filters}

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
          selectedCount={bulk.selectedIds.size}
          allMatching={bulk.allMatching}
          total={total}
          onSelectAllMatching={bulk.selection.selectAllMatching}
          onClear={bulk.clearSelection}
          removedView={removedView}
          canAct={!isReadOnly}
          canDeleteAny={canWrite && !isReadOnly}
          canDeleteSelected={bulk.canDeleteSelected}
          busy={bulk.bulkBusy || bulk.hiding || bulk.bulkDeleting}
          onMarkRead={() => void bulk.setReadState(true)}
          onMarkUnread={() => void bulk.setReadState(false)}
          onRemove={bulk.removeSelected}
          onRestore={() => void bulk.restoreToInbox([...bulk.selectedIds])}
          onDelete={() => bulk.setPendingBulkDelete([...bulk.selectedIds])}
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
          onSelect={onSelect}
          selectedId={selectedMessage?.id}
          currentOrgId={currentOrgId}
          resolveOrgName={resolveOrgName}
          onDelete={onDelete}
          canDelete={canDeleteMessage}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          casesByThread={casesByThread}
          selectedIds={bulk.selectedIds}
          onToggleSelect={isReadOnly ? undefined : bulk.selection.toggle}
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
  );
}

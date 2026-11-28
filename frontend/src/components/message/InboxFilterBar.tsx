// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Search, X } from 'lucide-react';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { RetryError } from '@/components/ui/RetryError';
import { TAP_TARGET } from '@/components/ui/responsive';
import type { ChannelFilter, FromFilter, InboxQuery, PriorityFilter, ReadFilter } from '@/hooks/useInboxQuery';
import { MESSAGE_PRIORITY_IDS, MESSAGE_PRIORITY_META } from '@/lib/message-priority';
import { FILTER_TABS, type MessageFilter } from './messages-tab-shared';

/** 16px and a full tap target on a phone: iOS zooms into any smaller field. */
const FILTER_SELECT_CLASS = 'text-xs max-sm:text-base max-sm:min-h-11';

interface InboxFilterBarProps {
  inboxQuery: InboxQuery;
  setQuery: (patch: Partial<InboxQuery>) => void;
  searchInput: string;
  setSearchInput: (q: string) => void;
  /** Why a `?message=<id>` deep link could not be opened, if it could not. */
  deepLinkError: string | null;
  onDismissDeepLinkError: () => void;
  messageFilter: MessageFilter;
  removedView: boolean;
  filtersActive: boolean;
  teammateOptions: { id: string; label: string }[];
  counterpartyOptions: { id: string; name: string }[];
  /** The sender select was focused: fetch the teammate options. */
  onSenderFocus: () => void;
  /** The SERVER's total for the active tab + search + filters. */
  total: number | null;
  isReadOnly: boolean;
  selectedCount: number;
  onRemoveAllMatching: () => void;
}

/** The inbox list's search box, deep-link error, type tabs and server-side filters. */
export function InboxFilterBar({
  inboxQuery, setQuery, searchInput, setSearchInput, deepLinkError, onDismissDeepLinkError, messageFilter, removedView,
  filtersActive, teammateOptions, counterpartyOptions, onSenderFocus, total, isReadOnly, selectedCount, onRemoveAllMatching,
}: InboxFilterBarProps) {
  return (
    <>
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
            className="w-full pl-8 pr-8 py-1.5 text-xs max-sm:text-base max-sm:py-2 rounded-lg border border-default bg-surface text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand transition-colors"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              aria-label="Clear search"
              className={`absolute right-2 max-sm:right-0 top-1/2 -translate-y-1/2 p-0.5 rounded text-fg-subtle hover:text-fg ${TAP_TARGET}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {deepLinkError && (
        <div className="px-3 py-2 border-b border-default">
          <RetryError message={deepLinkError} onRetry={onDismissDeepLinkError} />
        </div>
      )}

      {/* Filter tabs — message type */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-default overflow-x-auto">
        {FILTER_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setQuery({ tab: key })}
            className={`px-2.5 py-1 max-sm:py-2.5 text-xs font-medium rounded-full whitespace-nowrap transition-colors ${
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
      {/* One row that scrolls sideways on a phone, rather than six wrapped
          rows of selects pushing the conversations below the fold. */}
      <div className="flex max-lg:flex-nowrap flex-wrap items-center gap-1.5 px-3 py-2 border-b border-default max-lg:overflow-x-auto [&>*]:shrink-0">
        <FilterSelect aria-label="Show inbox or removed" value={removedView ? 'removed' : 'inbox'} onChange={(e) => setQuery({ removed: e.target.value === 'removed' })} className={FILTER_SELECT_CLASS}>
          <option value="inbox">Inbox</option>
          <option value="removed">Removed</option>
        </FilterSelect>
        <FilterSelect aria-label="Filter by read state" value={inboxQuery.read} onChange={(e) => setQuery({ read: e.target.value as ReadFilter })} className={FILTER_SELECT_CLASS}>
          <option value="">Any status</option>
          <option value="unread">Unread</option>
          <option value="read">Read</option>
        </FilterSelect>
        <FilterSelect aria-label="Filter by priority" value={inboxQuery.priority} onChange={(e) => setQuery({ priority: e.target.value as PriorityFilter })} className={FILTER_SELECT_CLASS}>
          <option value="">Any priority</option>
          {MESSAGE_PRIORITY_IDS.map((p) => <option key={p} value={p}>{MESSAGE_PRIORITY_META[p].label}</option>)}
        </FilterSelect>
        <FilterSelect aria-label="Filter by channel" value={inboxQuery.channel} onChange={(e) => setQuery({ channel: e.target.value as ChannelFilter })} className={FILTER_SELECT_CLASS}>
          <option value="">All channels</option>
          <option value="support">Support</option>
        </FilterSelect>
        <FilterSelect
          aria-label="Filter by sender"
          value={inboxQuery.from}
          onChange={(e) => setQuery({ from: e.target.value as FromFilter })}
          onFocus={onSenderFocus}
          className={FILTER_SELECT_CLASS}
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
          <FilterSelect aria-label="Filter by organization" value={inboxQuery.org} onChange={(e) => setQuery({ org: e.target.value })} className={FILTER_SELECT_CLASS}>
            <option value="">Any organization</option>
            {counterpartyOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </FilterSelect>
        )}
        {filtersActive && (
          <button
            type="button"
            onClick={() => setQuery({ read: '', priority: '', channel: '', from: '', org: '' })}
            className="text-xs font-medium text-info hover:underline whitespace-nowrap max-sm:min-h-11"
          >
            Clear
          </button>
        )}
        {/* "Remove all" acts on exactly what the filters describe, so it
            sits with them. `total` is the SERVER's count for this tab +
            search + filters, which is what will actually be removed. */}
        {!removedView && (total ?? 0) > 0 && !isReadOnly && selectedCount === 0 && (
          <button
            type="button"
            onClick={onRemoveAllMatching}
            className="ml-auto text-xs font-medium text-danger hover:underline whitespace-nowrap max-sm:min-h-11"
          >
            Remove all {total}
          </button>
        )}
      </div>
    </>
  );
}

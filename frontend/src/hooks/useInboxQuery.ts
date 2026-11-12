// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox's tab, filters and search, mirrored into the URL.
 *
 * Every value lives in the query string (`?tab=…&read=…&from=…&q=…`) so a
 * filtered inbox can be linked, survives a reload, and Back restores it. The
 * URL is the source of truth on load; after that the hook owns the state and
 * writes it back with a SHALLOW replace (no history entry per keystroke, no
 * page refetch). Keys it doesn't own — notably `?message=` — are preserved.
 *
 * Unknown or malformed values parse to the default rather than failing, so a
 * hand-edited or stale link degrades to the plain inbox.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NextRouter } from 'next/router';
import type { MessagePriority } from '@/types';
import type { MessageFilters, MessageView } from './useMessages';

export type ReadFilter = '' | 'unread' | 'read';
export type PriorityFilter = '' | MessagePriority;
/** Known channels (open-ended server-side; `support` is the one the product sends). */
export type ChannelFilter = '' | 'support';

/**
 * Sender filter value: `''` (anyone), a relative choice (`me` / `org` /
 * `others`), or one specific author as `user:<id>`.
 */
export type FromFilter = '' | 'me' | 'org' | 'others' | `user:${string}`;

export interface InboxQuery {
  tab: MessageView;
  read: ReadFilter;
  priority: PriorityFilter;
  channel: ChannelFilter;
  from: FromFilter;
  /** Counterparty org id, or `''` for any. */
  org: string;
  /** Show what this org removed from its inbox instead of the inbox. */
  removed: boolean;
  /** The search box's (un-debounced) text. */
  q: string;
}

export const DEFAULT_INBOX_QUERY: InboxQuery = {
  tab: 'all', read: '', priority: '', channel: '', from: '', org: '', removed: false, q: '',
};

/** Query-string key per field. Short, stable, and distinct from `message`. */
const KEYS: Record<keyof InboxQuery, string> = {
  tab: 'tab', read: 'read', priority: 'priority', channel: 'channel', from: 'from', org: 'org', removed: 'removed', q: 'q',
};

const TABS: readonly MessageView[] = ['all', 'conversations', 'announcements'];
const READS: readonly ReadFilter[] = ['unread', 'read'];
const PRIORITIES: readonly PriorityFilter[] = ['normal', 'high', 'urgent'];
const CHANNELS: readonly ChannelFilter[] = ['support'];
const RELATIVE_FROM = ['me', 'org', 'others'] as const;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}
function oneOf<T extends string>(v: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Parse a `from` value; `user:` must carry a non-empty id. */
function parseFrom(v: string): FromFilter {
  if ((RELATIVE_FROM as readonly string[]).includes(v)) return v as FromFilter;
  if (v.startsWith('user:') && v.length > 'user:'.length) return v as FromFilter;
  return '';
}

/** Read an {@link InboxQuery} out of a router query object. */
export function parseInboxQuery(query: NextRouter['query']): InboxQuery {
  return {
    tab: oneOf(first(query[KEYS.tab]), TABS, 'all'),
    read: oneOf(first(query[KEYS.read]), READS, ''),
    priority: oneOf(first(query[KEYS.priority]), PRIORITIES, ''),
    channel: oneOf(first(query[KEYS.channel]), CHANNELS, ''),
    from: parseFrom(first(query[KEYS.from])),
    org: first(query[KEYS.org]).slice(0, 255),
    removed: first(query[KEYS.removed]) === '1',
    q: first(query[KEYS.q]).slice(0, 200),
  };
}

/** The non-default fields as query-string entries (defaults are omitted). */
function toQueryEntries(q: InboxQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.tab !== 'all') out[KEYS.tab] = q.tab;
  if (q.read) out[KEYS.read] = q.read;
  if (q.priority) out[KEYS.priority] = q.priority;
  if (q.channel) out[KEYS.channel] = q.channel;
  if (q.from) out[KEYS.from] = q.from;
  if (q.org) out[KEYS.org] = q.org;
  if (q.removed) out[KEYS.removed] = '1';
  if (q.q) out[KEYS.q] = q.q;
  return out;
}

/** The server-side list filters an {@link InboxQuery} describes (search excluded — it is debounced separately). */
export function inboxListFilters(q: InboxQuery): MessageFilters {
  return {
    ...(q.read ? { isRead: q.read === 'read' } : {}),
    ...(q.priority ? { priority: q.priority } : {}),
    ...(q.channel ? { channel: q.channel } : {}),
    ...(q.from.startsWith('user:') ? { senderUserId: q.from.slice('user:'.length) } : q.from ? { sentBy: q.from as 'me' | 'org' | 'others' } : {}),
    ...(q.org ? { counterpartyOrgId: q.org } : {}),
    ...(q.removed ? { hidden: true } : {}),
  };
}

/** True when any narrowing filter (not the tab, search or removed view) is set. */
export function inboxFiltersActive(q: InboxQuery): boolean {
  return !!(q.read || q.priority || q.channel || q.from || q.org);
}

/**
 * URL-synced inbox query. Returns the current query and a patch setter.
 *
 * @param router - The page's Next router (passed in so tests can supply one).
 */
export function useInboxQuery(router: NextRouter): [InboxQuery, (patch: Partial<InboxQuery>) => void] {
  const [query, setQueryState] = useState<InboxQuery>(() => (router.isReady ? parseInboxQuery(router.query) : DEFAULT_INBOX_QUERY));
  // Adopt the URL once the router is ready (a static export hydrates with an
  // empty query first). Only once: afterwards this hook is the writer.
  const adopted = useRef(router.isReady);
  useEffect(() => {
    if (adopted.current || !router.isReady) return;
    adopted.current = true;
    setQueryState(parseInboxQuery(router.query));
  }, [router.isReady, router.query]);

  const setQuery = useCallback((patch: Partial<InboxQuery>) => {
    setQueryState((prev) => ({ ...prev, ...patch }));
  }, []);

  // Write back on change. Compared as a string so an unchanged query never
  // issues a replace (which would loop through the router's own update).
  const entries = useMemo(() => toQueryEntries(query), [query]);
  const entriesKey = JSON.stringify(entries);
  const routerRef = useRef(router);
  routerRef.current = router;
  useEffect(() => {
    const r = routerRef.current;
    if (!adopted.current || !r.isReady) return;
    const rest: Record<string, string | string[] | undefined> = { ...r.query };
    for (const k of Object.values(KEYS)) delete rest[k];
    const next = { ...rest, ...entries };
    const current = toQueryEntries(parseInboxQuery(r.query));
    if (JSON.stringify(current) === entriesKey) return;
    void r.replace({ pathname: r.pathname, query: next }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `entries` is captured by `entriesKey`
  }, [entriesKey]);

  return [query, setQuery];
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MessageView } from '@/hooks/useMessages';

/**
 * Inbox tab. Each value is a distinct SERVER endpoint (`/messages`,
 * `/messages/conversations`, `/messages/announcements`) with its own pagination
 * — not a client-side filter over the mixed inbox, which only ever saw the
 * pages already loaded and so under-reported both the list and its count.
 */
export type MessageFilter = MessageView;

export const FILTER_TABS: { key: MessageFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'announcements', label: 'Announcements' },
];

/** Plural noun for the active tab (heading + empty states). */
export const FILTER_NOUN: Record<MessageFilter, string> = {
  all: 'messages',
  conversations: 'conversations',
  announcements: 'announcements',
};

/**
 * What a confirmed remove-from-inbox acts on: the ticked rows, or EVERY
 * message the active tab + filters + search match on the server.
 */
export type RemoveScope = { kind: 'ids'; ids: string[] } | { kind: 'matching'; count: number };

/** Most ids one bulk call takes (mirrors api-core's `MESSAGE_BULK_MAX_IDS`); larger selections are chunked. */
export const MESSAGE_BULK_MAX_IDS = 200;

/** Split `ids` into bulk-route-sized chunks. */
export function chunks(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += MESSAGE_BULK_MAX_IDS) out.push(ids.slice(i, i + MESSAGE_BULK_MAX_IDS));
  return out;
}

/** "1 message" / "3 messages". */
export const plural = (n: number, noun = 'message') => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Query-string key of the message deep link: `/dashboard/inbox?tab=messages&message=<id>`. */
export const MESSAGE_QUERY_KEY = 'message';

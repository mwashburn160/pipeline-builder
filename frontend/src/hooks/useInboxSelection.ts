// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checkbox selection over the inbox's loaded rows.
 *
 * Holds the ticked ids plus whether the person escalated to "all N matching"
 * (every server-side match, loaded or not). The selection:
 *
 * - resets whenever `resetKey` changes — a selection made under one tab /
 *   filter / search must never be acted on under another;
 * - only ever reports rows still on screen (SSE deletes and refetches drop rows
 *   without touching the raw ticked set);
 * - supports shift-click RANGES: shift-ticking a row applies the anchor row's
 *   new state to every row between them, in list order.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '@/types';

export interface InboxSelection {
  /** Ticked rows that are still loaded, in list order. */
  selectedMessages: Message[];
  selectedIds: ReadonlySet<string>;
  allMatching: boolean;
  /** Tick / untick one row; `range` (shift-click) extends from the last toggled row. */
  toggle: (id: string, range?: boolean) => void;
  /** Tick every loaded row, or clear when they already are. */
  toggleAllLoaded: () => void;
  selectAllMatching: () => void;
  clear: () => void;
}

export function useInboxSelection(messages: Message[], resetKey: string): InboxSelection {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [allMatching, setAllMatching] = useState(false);
  // The last row toggled WITHOUT shift — where the next shift-click range starts.
  const anchorRef = useRef<string | null>(null);

  const clear = useCallback(() => {
    setTicked(new Set());
    setAllMatching(false);
    anchorRef.current = null;
  }, []);
  useEffect(() => { clear(); }, [clear, resetKey]);

  const selectedMessages = useMemo(() => messages.filter((m) => ticked.has(m.id)), [messages, ticked]);
  const selectedIds = useMemo(() => new Set(selectedMessages.map((m) => m.id)), [selectedMessages]);

  // Keep a ref to the list so `toggle` stays stable across renders.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const toggle = useCallback((id: string, range = false) => {
    setAllMatching(false);
    setTicked((prev) => {
      const next = new Set(prev);
      const list = messagesRef.current;
      const anchor = anchorRef.current;
      const from = anchor ? list.findIndex((m) => m.id === anchor) : -1;
      const to = list.findIndex((m) => m.id === id);
      if (range && from >= 0 && to >= 0) {
        // The range takes the ANCHOR's state: shift-click after ticking ticks
        // the span, after unticking clears it — the convention mail clients use.
        const tick = prev.has(anchor!);
        const [lo, hi] = from < to ? [from, to] : [to, from];
        for (let i = lo; i <= hi; i++) {
          if (tick) next.add(list[i]!.id); else next.delete(list[i]!.id);
        }
        return next;
      }
      if (next.has(id)) next.delete(id); else next.add(id);
      anchorRef.current = id;
      return next;
    });
  }, []);

  const toggleAllLoaded = useCallback(() => {
    if (allMatching || (selectedIds.size > 0 && selectedIds.size === messages.length)) clear();
    else setTicked(new Set(messages.map((m) => m.id)));
  }, [allMatching, selectedIds.size, messages, clear]);

  // Loading another page while "all matching" is on keeps everything ticked.
  useEffect(() => {
    if (allMatching) setTicked(new Set(messages.map((m) => m.id)));
  }, [allMatching, messages]);

  const selectAllMatching = useCallback(() => setAllMatching(true), []);

  return { selectedMessages, selectedIds, allMatching, toggle, toggleAllLoaded, selectAllMatching, clear };
}

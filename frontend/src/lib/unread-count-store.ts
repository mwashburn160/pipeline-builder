// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The signed-in user's unread-message count, shared by every surface that shows
 * it (the sidebar badge, the messages page).
 *
 * One store instead of a count per component: when the messages page learns a
 * new count over SSE — or marks a message read — the sidebar badge shows it
 * immediately instead of lagging until its own next poll. And while a live
 * source (useMessages) is mounted, the sidebar stops polling altogether.
 */

import { useSyncExternalStore } from 'react';
import api from '@/lib/api';

let count = 0;
/** Bumped on every publish, so a fetch that started before a newer count
 *  arrived (e.g. over SSE) can tell its answer is stale. */
let version = 0;
let liveSources = 0;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Publish a new count (or derive it from the current one). */
export function setUnreadCount(next: number | ((prev: number) => number)): void {
  const value = Math.max(0, typeof next === 'function' ? next(count) : next);
  version += 1;
  if (value === count) return;
  count = value;
  emit();
}

/** Fetch the count from the server and publish it. Failures are ignored — the
 *  message service may not be running, and the badge is non-critical. */
export async function refreshUnreadCount(): Promise<void> {
  const startedAt = version;
  try {
    const result = await api.getUnreadCount();
    // A newer count was published while this request was out — keep it.
    if (version !== startedAt) return;
    setUnreadCount(result.data?.count || 0);
  } catch {
    /* keep the last known count */
  }
}

/** The layout's poll: a no-op while a live source is keeping the count fresh
 *  (checked at call time, so a source that mounted in the same commit counts). */
export function pollUnreadCount(): Promise<void> {
  return liveSources > 0 ? Promise.resolve() : refreshUnreadCount();
}

/**
 * Declare a component that keeps the count current by itself (SSE, or its own
 * fallback polling). Returns the release function; call it on unmount.
 */
export function acquireLiveUnreadSource(): () => void {
  liveSources += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveSources -= 1;
    emit();
  };
}

/** Current count, and whether a live source is keeping it fresh. */
export function useUnreadCount(): { unreadCount: number; hasLiveSource: boolean } {
  const unreadCount = useSyncExternalStore(subscribe, () => count, () => 0);
  const hasLiveSource = useSyncExternalStore(subscribe, () => liveSources > 0, () => false);
  return { unreadCount, hasLiveSource };
}

/** Test-only: reset the module state between tests. */
export function __resetUnreadCountStoreForTests(): void {
  count = 0;
  version = 0;
  liveSources = 0;
  emit();
}

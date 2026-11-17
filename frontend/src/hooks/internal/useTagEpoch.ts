// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useSyncExternalStore } from 'react';
import { getTagEpoch, subscribeQueries } from '@/lib/query-cache';

/**
 * The combined invalidation epoch of `tags` — a number that changes whenever an
 * `invalidate.*` call touches any of them. Feed it into a reader's effect deps
 * and the reader re-runs after the write, the same way a `useQuery` consumer
 * does. `undefined` / empty subscribes to nothing and always returns 0.
 */
export function useTagEpoch(tags: ReadonlyArray<string> | undefined): number {
  // Joined so a fresh array literal each render doesn't change the snapshot fn.
  const joined = tags && tags.length > 0 ? tags.join('\u0000') : '';
  const read = useCallback(
    () => (joined ? joined.split('\u0000').reduce((n, t) => n + getTagEpoch(t), 0) : 0),
    [joined],
  );
  // An untagged reader never touches the store at all (so a test that mocks
  // `@/lib/query-cache` without these exports still renders it).
  const subscribe = joined ? subscribeQueries : subscribeNothing;
  return useSyncExternalStore(subscribe, read, read);
}

const subscribeNothing = (): (() => void) => () => undefined;

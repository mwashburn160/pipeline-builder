// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface TagListState {
  tags: string[] | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Module-level cache so consumers in different parts of the registry page
 * (e.g. the active TagTable and a deeply-nested CopyTagModal) see the same
 * snapshot. After a successful copy, the modal calls `invalidateImageTags`
 * with the target repo so a subsequent `useImageTags` mount fetches fresh
 * data instead of serving stale cached tags.
 */
const cache = new Map<string, TagListState>();

/** Drop the cached tag list for a single repo. */
export function invalidateImageTags(name: string): void {
  cache.delete(name);
}

/**
 * Fetches every tag for one repository (`name`). The distribution registry
 * has no pagination on tag listings, so the full set is small enough to
 * sort/filter client-side. Returns `null` for `tags` when the repo exists
 * but has no tags (distribution returns `null`, not `[]`).
 */
export function useImageTags(name: string | null) {
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const load = useCallback(async () => {
    if (!name) return;
    cache.set(name, { tags: cache.get(name)?.tags ?? null, loading: true, error: null });
    bump();
    try {
      const res = await api.listImageTags(name);
      cache.set(name, { tags: res.data?.tags ?? null, loading: false, error: null });
    } catch (err) {
      cache.set(name, { tags: null, loading: false, error: err as Error });
    }
    bump();
  }, [name, bump]);

  useEffect(() => {
    if (!name) return;
    if (!cache.has(name)) void load();
    bump();
  }, [name, load, bump]);

  const refresh = useCallback(() => {
    if (!name) return;
    cache.delete(name);
    void load();
  }, [name, load]);

  const state = name ? cache.get(name) : undefined;
  return {
    tags: state?.tags ?? null,
    loading: state?.loading ?? false,
    error: state?.error ?? null,
    refresh,
  };
}

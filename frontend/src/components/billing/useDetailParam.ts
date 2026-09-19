// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { useRouter } from 'next/router';

/**
 * The record a billing-admin list page has open in its detail drawer, carried in
 * `?id=` so the drawer is deep-linkable (share a discount/promotion with a
 * colleague, refresh, Back closes it). Shallow updates keep the list's own
 * filters and page in the query untouched.
 */
export function useDetailParam(): [string | null, (id: string | null) => void] {
  const router = useRouter();
  const raw = router.query.id;
  const id = (Array.isArray(raw) ? raw[0] : raw) || null;
  const setId = useCallback((next: string | null) => {
    const { id: _omit, ...rest } = router.query;
    void router.replace({ query: next ? { ...rest, id: next } : rest }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router identity changes each render
  }, [router.query]);
  return [id, setId];
}

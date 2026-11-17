// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Refreshing the SAME repo keeps the rows it already has while the refetch
 * runs: each resolved tag is merged into the previous map. Rebuilding from an
 * empty map flashed every not-yet-refetched row back to "—". A different repo
 * still starts clean, and a tag that left the list is dropped.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTagsWithMetadata } from '../src/hooks/useTagsWithMetadata';

const getImageManifest = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: { getImageManifest: (...a: unknown[]) => getImageManifest(...a) },
}));

const manifest = (digest: string) => ({
  data: {
    digest, mediaType: 'application/vnd.oci.image.manifest.v1+json', size: 1,
    body: { config: { size: 10 }, layers: [{ size: 5 }] },
  },
});

/** Deferred manifest reads, resolved by the test per tag. */
let pending: Record<string, (v: unknown) => void> = {};
beforeEach(() => {
  pending = {};
  getImageManifest.mockReset().mockImplementation((_repo: string, tag: string) =>
    new Promise((resolve) => { pending[tag] = resolve; }));
});

it('a same-repo refresh keeps existing rows until each new read lands', async () => {
  let tags = ['v1', 'v2'];
  const { result, rerender } = renderHook(({ r, t }) => useTagsWithMetadata(r, t), { initialProps: { r: 'app', t: tags } });
  await waitFor(() => expect(pending.v1 && pending.v2).toBeTruthy());
  await act(async () => { pending.v1(manifest('sha256:111')); pending.v2(manifest('sha256:222')); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.metadata.get('v2')?.digest).toBe('sha256:222');

  // Refresh: a new array for the same repo.
  pending = {};
  tags = ['v1', 'v2'];
  rerender({ r: 'app', t: tags });
  await waitFor(() => expect(pending.v1).toBeTruthy());
  await act(async () => { pending.v1(manifest('sha256:aaa')); });

  // v1 updated; v2 still shows its previous metadata — no blank row.
  expect(result.current.metadata.get('v1')?.digest).toBe('sha256:aaa');
  expect(result.current.metadata.get('v2')?.digest).toBe('sha256:222');
});

it('drops tags no longer listed, and a different repo starts clean', async () => {
  const { result, rerender } = renderHook(({ r, t }) => useTagsWithMetadata(r, t), { initialProps: { r: 'app', t: ['v1', 'v2'] } });
  await waitFor(() => expect(pending.v1 && pending.v2).toBeTruthy());
  await act(async () => { pending.v1(manifest('sha256:111')); pending.v2(manifest('sha256:222')); });
  await waitFor(() => expect(result.current.metadata.size).toBe(2));

  rerender({ r: 'app', t: ['v1'] });
  expect(result.current.metadata.has('v2')).toBe(false);
  expect(result.current.metadata.get('v1')?.digest).toBe('sha256:111');

  rerender({ r: 'other', t: ['v1'] });
  expect(result.current.metadata.size).toBe(0);
});

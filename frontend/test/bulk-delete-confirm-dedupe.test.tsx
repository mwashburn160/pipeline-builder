// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bulk tag delete dedupes by digest. Distribution deletes the MANIFEST, so two
 * tags on one image: the first delete removes it and a second delete through
 * the sibling tag 404s — which used to be counted as a failure. Now one delete
 * goes out per digest, every tag in the group settles with its outcome, and a
 * 404 for a digest this batch already removed counts as success.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../src/lib/api/errors';
import { BulkDeleteConfirm } from '../src/components/registry/BulkDeleteConfirm';

const getImageManifest = jest.fn<AnyFn>();
const deleteImageManifest = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: {
    getImageManifest: (...a: unknown[]) => getImageManifest(...a),
    deleteImageManifest: (...a: unknown[]) => deleteImageManifest(...a),
  },
}));

const DIGESTS: Record<string, string | undefined> = { v1: 'sha256:aaa', latest: 'sha256:aaa', v2: 'sha256:bbb' };

beforeEach(() => {
  jest.clearAllMocks();
  getImageManifest.mockImplementation((_repo: string, ref: string) =>
    DIGESTS[ref] ? Promise.resolve({ data: { digest: DIGESTS[ref] } }) : Promise.reject(new ApiError('nope', 500)));
});

async function run(refs: string[]) {
  const onProgress = jest.fn<AnyFn>();
  const onDone = jest.fn<AnyFn>();
  render(<BulkDeleteConfirm repo="app" refs={refs} onClose={() => {}} onProgress={onProgress} onDone={onDone} />);
  await screen.findByText(/distinct digest|point at distinct digests/);
  fireEvent.click(screen.getByRole('button', { name: `Delete ${refs.length}` }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  return { onProgress, onDone };
}

it('issues one delete per digest and counts every sibling tag as succeeded', async () => {
  deleteImageManifest.mockImplementation((_repo: string, ref: string) =>
    Promise.resolve({ data: { name: 'app', digest: DIGESTS[ref], deleted: true } }));

  const { onProgress, onDone } = await run(['v1', 'latest', 'v2']);

  expect(deleteImageManifest).toHaveBeenCalledTimes(2);
  expect(deleteImageManifest.mock.calls.map((c) => c[1]).sort()).toEqual(['v1', 'v2']);
  expect(onDone).toHaveBeenCalledWith({ succeeded: 3, failed: 0 });
  expect(onProgress).toHaveBeenCalledWith('latest', 'sha256:aaa', undefined);
});

it('treats a 404 for a digest already deleted in this batch as success', async () => {
  // `mystery`'s digest could not be read by the scan, so it is its own group;
  // its delete removes sha256:aaa while v1's (same digest) is in flight and 404s.
  let releaseV1: () => void = () => {};
  deleteImageManifest.mockImplementation((_repo: string, ref: string) => {
    if (ref === 'mystery') return Promise.resolve({ data: { name: 'app', digest: 'sha256:aaa', deleted: true } });
    return new Promise((_res, rej) => { releaseV1 = () => rej(new ApiError('manifest unknown', 404)); });
  });

  const onProgress = jest.fn<AnyFn>();
  const onDone = jest.fn<AnyFn>();
  render(<BulkDeleteConfirm repo="app" refs={['v1', 'mystery']} onClose={() => {}} onProgress={onProgress} onDone={onDone} />);
  await screen.findByText(/distinct digest/);
  fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
  await waitFor(() => expect(onProgress).toHaveBeenCalledWith('mystery', 'sha256:aaa', undefined));
  releaseV1();
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({ succeeded: 2, failed: 0 }));
});

it('still counts a genuine failure as failed', async () => {
  deleteImageManifest.mockImplementation((_repo: string, ref: string) =>
    ref === 'v2'
      ? Promise.reject(new ApiError('manifest unknown', 404))
      : Promise.resolve({ data: { name: 'app', digest: DIGESTS[ref], deleted: true } }));

  const { onDone, onProgress } = await run(['v1', 'v2']);
  expect(onDone).toHaveBeenCalledWith({ succeeded: 1, failed: 1 });
  expect(onProgress).toHaveBeenCalledWith('v2', undefined, expect.any(ApiError));
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Delete repository shows the blast radius from a tag listing. A listing that
 * FAILED must not read as "this repository has no tags — prune the empty
 * shell": that understates a delete that removes every tag it holds. Only a
 * 404 (the repository is already gone) is an empty shell.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen } from '@testing-library/react';
import { ApiError } from '@/lib/api/errors';

const listImageTags = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const api = { listImageTags: (...a: unknown[]) => listImageTags(...a), deleteRepository: jest.fn<AnyFn>() };
  return { __esModule: true, api, default: api };
});

import { DeleteRepoConfirm } from '@/components/registry/DeleteRepoConfirm';

describe('DeleteRepoConfirm', () => {
  beforeEach(() => { listImageTags.mockReset(); });

  it('a failed tag listing says so and still names the delete, never "prune the empty shell"', async () => {
    listImageTags.mockRejectedValue(new ApiError('Registry unavailable', 503));
    render(<DeleteRepoConfirm repo="team/app" onClose={() => {}} onDeleted={() => {}} />);
    expect(await screen.findByText(/could not list this repository's tags/i)).toBeInTheDocument();
    expect(screen.queryByText(/prune the empty shell/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete repository' })).toBeEnabled();
  });

  it('a 404 is an empty shell to prune', async () => {
    listImageTags.mockRejectedValue(new ApiError('Not found', 404));
    render(<DeleteRepoConfirm repo="team/app" onClose={() => {}} onDeleted={() => {}} />);
    expect(await screen.findByText(/prune the empty shell/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prune' })).toBeEnabled();
  });

  it('lists the tags it will delete', async () => {
    listImageTags.mockResolvedValue({ success: true, data: { tags: ['v1', 'v2'] } });
    render(<DeleteRepoConfirm repo="team/app" onClose={() => {}} onDeleted={() => {}} />);
    expect(await screen.findByText(/All 2 tags in this repository will be deleted/)).toBeInTheDocument();
  });
});

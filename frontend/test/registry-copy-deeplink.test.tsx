// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `?action=copy&source=<repo:ref>` deep link opens the copy/promote modal —
 * but only for a viewer who may copy (`registry:write`). A `registry:read`-only
 * viewer following a shared link lands on the tag, not on a form whose submit
 * the image registry can only refuse.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const mockRouter = {
  query: {} as Record<string, string>, pathname: '/dashboard/registry', isReady: true,
  replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>(),
};
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

jest.mock('@/hooks/useRepositoryList', () => ({
  __esModule: true,
  useRepositoryList: () => ({ groups: [], repos: [], hasMore: false, loading: false, error: null, loadMore: jest.fn<AnyFn>(), refresh: jest.fn<AnyFn>() }),
}));
jest.mock('@/hooks/useImageTags', () => ({
  __esModule: true,
  useImageTags: () => ({ tags: null, loading: false, error: null, refresh: jest.fn<AnyFn>() }),
  invalidateImageTags: jest.fn<AnyFn>(),
}));
jest.mock('@/hooks/useImageDetail', () => ({ __esModule: true, useImageDetail: () => ({ kind: null, loading: false, error: null }) }));
jest.mock('@/hooks/useTagsWithMetadata', () => ({ __esModule: true, useTagsWithMetadata: () => ({ metadata: {}, loading: false }) }));
jest.mock('@/components/registry/RepositoryList', () => ({ __esModule: true, RepositoryList: () => null }));
jest.mock('@/components/registry/TagTable', () => ({ __esModule: true, TagTable: () => null }));
jest.mock('@/components/registry/ManifestDetail', () => ({ __esModule: true, ManifestDetail: () => null }));
jest.mock('@/components/registry/RecentActionsPanel', () => ({ __esModule: true, RecentActionsPanel: () => null }));
jest.mock('@/components/registry/CopyTagModal', () => ({
  __esModule: true,
  CopyTagModal: ({ sourceRepo, sourceRef }: { sourceRepo: string; sourceRef: string }) => <div data-testid="copy-modal">{sourceRepo}:{sourceRef}</div>,
}));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: { listImages: async () => ({ success: true, data: {} }) },
  ApiError: jest.requireActual<typeof import('@/lib/api/errors')>('@/lib/api/errors').ApiError,
}));

import RegistryPage from '../pages/dashboard/registry';

beforeEach(() => {
  jest.clearAllMocks();
  // `repo` is what the effect's own `setQuery` would write; the mock router is static.
  mockRouter.query = { action: 'copy', source: 'acme/app:v1', repo: 'acme/app' };
});

describe('registry copy deep link', () => {
  it('opens the copy modal for a registry:write holder', async () => {
    mockAuthGuard({ can: () => true });
    render(<RegistryPage />);
    expect(await screen.findByTestId('copy-modal')).toHaveTextContent('acme/app:v1');
  });

  it('a read-only viewer lands on the tag without the modal', async () => {
    mockAuthGuard({ can: (p: string) => p !== 'registry:write' });
    render(<RegistryPage />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ repo: 'acme/app', tag: 'v1' }) }),
      undefined,
      { shallow: true },
    ));
    expect(screen.queryByTestId('copy-modal')).not.toBeInTheDocument();
  });
});

describe('registry columns (axe color-contrast)', () => {
  it('never dims a column with opacity — the empty state\'s copy keeps its full text colour', async () => {
    mockAuthGuard({ can: () => true });
    mockRouter.query = {};
    render(<RegistryPage />);
    const hint = await screen.findByText(/Select a repository to view its tags/);
    for (let el: HTMLElement | null = hint; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)opacity-\d/);
    }
  });
});

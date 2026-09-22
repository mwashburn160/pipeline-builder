// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Copy affordances ride useCopyToClipboard rather than calling
 * `navigator.clipboard.writeText` themselves. What must hold for the user: the "copied" feedback
 * appears only once the write resolves, and a refused write never claims
 * success.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, fireEvent, render, screen } from '@testing-library/react';
import DownloadsPage from '../pages/dashboard/downloads';
import { CopyTagModal } from '../src/components/registry/CopyTagModal';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/lib/api', () => ({ __esModule: true, api: {}, default: {}, ApiError: class extends Error {}, ConflictError: class extends Error {} }));
jest.mock('@/hooks/useImageTags', () => ({ __esModule: true, invalidateImageTags: jest.fn<AnyFn>() }));

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText } });
}

describe('Downloads page install-command copy', () => {
  const firstCopy = () => screen.getAllByRole('button', { name: 'Copy to clipboard' })[0];
  // The checkmark rides the success token now that the page is tokenised.
  const showsCheck = (btn: HTMLElement) => btn.querySelector('svg')?.getAttribute('class')?.includes('text-success') ?? false;

  it('copies the command and shows the checkmark once the write resolves', async () => {
    const writeText = jest.fn<AnyFn>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render(<DownloadsPage />);

    await act(async () => { fireEvent.click(firstCopy()); });

    expect(writeText).toHaveBeenCalledWith('npm install -g @pipeline-builder/pipeline-manager');
    expect(showsCheck(firstCopy())).toBe(true);
  });

  it('shows no checkmark when the clipboard refuses the write', async () => {
    mockClipboard(jest.fn<AnyFn>().mockRejectedValue(new Error('denied')));
    render(<DownloadsPage />);

    await act(async () => { fireEvent.click(firstCopy()); });

    expect(showsCheck(firstCopy())).toBe(false);
  });
});

describe('CopyTagModal share link', () => {
  const renderModal = () => render(
    <CopyTagModal sourceRepo="org-a/app" sourceRef="v1" knownRepos={[]} onClose={jest.fn<AnyFn>()} onSuccess={jest.fn<AnyFn>()} />,
  );

  it('copies a deep-link that re-opens the copy modal and says so', async () => {
    const writeText = jest.fn<AnyFn>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    renderModal();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy share link' })); });

    const link = new URL(writeText.mock.calls[0][0]);
    expect(link.searchParams.get('action')).toBe('copy');
    expect(link.searchParams.get('source')).toBe('org-a/app:v1');
    expect(screen.getByRole('button', { name: 'Share link copied' })).toBeInTheDocument();
  });

  it('says the clipboard is unavailable instead of claiming success', async () => {
    mockClipboard(jest.fn<AnyFn>().mockRejectedValue(new Error('denied')));
    renderModal();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy share link' })); });

    expect(screen.queryByRole('button', { name: 'Share link copied' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clipboard unavailable/i })).toBeInTheDocument();
  });
});

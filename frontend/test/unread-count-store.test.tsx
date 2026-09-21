// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The sidebar badge and the messages page share one unread count. While the
 * messages hook is mounted (it keeps the count live over SSE or its own
 * fallback poll) the layout must not poll a second time, and a count the page
 * learns must reach the badge immediately.
 */

import { renderHook, render, screen, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const getUnreadCount = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getUnreadCount: (...a: unknown[]) => getUnreadCount(...a),
    getMessages: jest.fn().mockResolvedValue({ data: { messages: [], pagination: { hasMore: false } } }),
  },
}));
// The stream hook is transport only — it carries no count (see useMessages).
const mockSse = { connected: true, everConnected: true, onNotification: () => () => {} };
jest.mock('../src/hooks/useMessageNotifications', () => ({ useMessageNotifications: () => mockSse }));

// DashboardLayout with its heavy chrome stubbed; the badge count is what matters.
const mockRouter = { pathname: '/dashboard', asPath: '/dashboard', push: jest.fn(), events: { on: jest.fn(), off: jest.fn() } };
jest.mock('next/router', () => ({ useRouter: () => mockRouter }));
jest.mock('next/head', () => ({ __esModule: true, default: ({ children }: { children: ReactNode }) => <>{children}</> }));
jest.mock('@/hooks/useAuthGuard', () => ({
  useAuthGuard: () => ({ user: { id: 'u1', organizationId: 'org-1' }, isReady: true, isSuperAdmin: false, isAdmin: false, logout: jest.fn() }),
}));
jest.mock('@/hooks/useDarkMode', () => ({ useDarkMode: () => ({ isDark: false, toggle: jest.fn() }) }));
jest.mock('@/hooks/useFeatures', () => ({ useFeatures: () => ({ isLoaded: true, isEnabled: () => false }) }));
jest.mock('../src/components/ui/Sidebar', () => ({ Sidebar: ({ unreadCount }: { unreadCount: number }) => <span data-testid="badge">{unreadCount}</span> }));
for (const mod of ['OrgSwitcher', 'QuotaBanner', 'ImpersonationBanner', 'AuthErrorBanner', 'MfaEnrolmentNudge', 'MfaRequiredBanner', 'MfaRequiredDialog', 'CommandPalette']) {
  jest.doMock(`../src/components/ui/${mod}`, () => ({ [mod]: () => null }));
}
jest.mock('@/components/ask/AskPanel', () => ({ AskPanel: () => null }));
jest.mock('@/components/admin/StepUpModal', () => ({ StepUpModal: () => null }));
// The layout resumes a refused action and reports the outcome, so it now
// consumes the toast context this bare render has no provider for.
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

import {
  __resetUnreadCountStoreForTests,
  acquireLiveUnreadSource,
  pollUnreadCount,
  refreshUnreadCount,
  setUnreadCount,
  useUnreadCount,
} from '../src/lib/unread-count-store';
import { usePolling } from '../src/hooks/usePolling';
import { useMessages } from '../src/hooks/useMessages';
import { DashboardLayout } from '../src/components/ui/DashboardLayout';

/** What DashboardLayout does with the store. */
function useSidebarBadge() {
  const state = useUnreadCount();
  usePolling(pollUnreadCount, 30_000, { enabled: !state.hasLiveSource });
  return state;
}

describe('unread-count store', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetUnreadCountStoreForTests();
    getUnreadCount.mockResolvedValue({ data: { count: 3 } });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('the sidebar polls when no live source is mounted', async () => {
    const { result } = renderHook(() => useSidebarBadge());
    await act(async () => { await Promise.resolve(); });
    expect(getUnreadCount).toHaveBeenCalledTimes(1);
    expect(result.current.unreadCount).toBe(3);

    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(getUnreadCount).toHaveBeenCalledTimes(2);
  });

  it('a live source stops the sidebar poll and its counts reach the badge at once', async () => {
    const { result } = renderHook(() => useSidebarBadge());
    await act(async () => { await Promise.resolve(); });
    getUnreadCount.mockClear();

    let release!: () => void;
    act(() => { release = acquireLiveUnreadSource(); });
    expect(result.current.hasLiveSource).toBe(true);

    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(getUnreadCount).not.toHaveBeenCalled();

    // e.g. the messages page received a new count over SSE, then marked one read.
    act(() => { setUnreadCount(7); });
    expect(result.current.unreadCount).toBe(7);
    act(() => { setUnreadCount((n) => n - 1); });
    expect(result.current.unreadCount).toBe(6);

    // Leaving the messages page hands polling back to the sidebar.
    await act(async () => { release(); await Promise.resolve(); });
    expect(result.current.hasLiveSource).toBe(false);
    expect(getUnreadCount).toHaveBeenCalledTimes(1);
  });

  it('never goes below zero and keeps the last count when the fetch fails', async () => {
    const { result } = renderHook(() => useUnreadCount());
    act(() => { setUnreadCount(1); setUnreadCount((n) => n - 5); });
    expect(result.current.unreadCount).toBe(0);

    act(() => { setUnreadCount(4); });
    getUnreadCount.mockRejectedValueOnce(new Error('message service down'));
    await act(async () => { await refreshUnreadCount(); });
    expect(result.current.unreadCount).toBe(4);
  });

  it('on the messages page the badge follows the SERVER count and the layout stops polling', async () => {
    function MessagesPage() {
      useMessages('org-1');
      return <DashboardLayout title="Messages"><p>inbox</p></DashboardLayout>;
    }
    const home = render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    await act(async () => { await Promise.resolve(); });
    expect(getUnreadCount).toHaveBeenCalledTimes(1); // no live source → the layout polls
    home.unmount();
    getUnreadCount.mockClear();

    // The count comes from the server when the stream connects — never from the
    // stream itself, whose own count started at 0 and used to overwrite this.
    getUnreadCount.mockResolvedValue({ data: { count: 9 } });
    const page = render(<MessagesPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    for (const badge of screen.getAllByTestId('badge')) expect(badge).toHaveTextContent('9');
    const onConnect = getUnreadCount.mock.calls.length;
    // ...and while the stream is live there is no interval poll on top of it.
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(getUnreadCount).toHaveBeenCalledTimes(onConnect);

    page.unmount();
    getUnreadCount.mockClear();
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    await act(async () => { await Promise.resolve(); });
    expect(getUnreadCount).toHaveBeenCalledTimes(1); // polling handed back to the layout
  });

  it('a poll that resolves after a newer live count does not overwrite it', async () => {
    let resolve!: (v: unknown) => void;
    getUnreadCount.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useUnreadCount());

    let pending!: Promise<void>;
    act(() => { pending = refreshUnreadCount(); });
    act(() => { setUnreadCount(5); }); // newer count arrives over SSE
    await act(async () => { resolve({ data: { count: 2 } }); await pending; });

    expect(result.current.unreadCount).toBe(5);
  });
});

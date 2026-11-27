// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inactivity warning and sign-out (`IdleSessionGuard`, mounted once by
 * `_app`):
 *
 *  - 2 minutes before the idle deadline a dialog says "You'll be signed out in
 *    2 minutes for inactivity", with a live countdown; focus is trapped in it;
 *  - "Stay signed in" counts as activity and refreshes at once; "Sign out"
 *    signs out;
 *  - at the deadline every tab signs out (the API client broadcasts it), with
 *    the inactivity reason and the timeout for the sign-in page;
 *  - real input before the warning pushes the deadline out and is reported to
 *    the server well before the SERVER's deadline; ambient input while the
 *    warning is up does not dismiss it, but "Stay signed in" in another tab does.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, fireEvent, render, screen } from '@testing-library/react';

const MINUTE = 60_000;

interface Idle { idleTimeoutMinutes: number; lastActiveAt: number; idleExpiresAt: number }
let idle: Idle | null = null;
const idleListeners = new Set<() => void>();
function setIdle(lastActiveAt: number, minutes = 15) {
  idle = { idleTimeoutMinutes: minutes, lastActiveAt, idleExpiresAt: lastActiveAt + minutes * MINUTE };
  idleListeners.forEach((cb) => cb());
}
const reportActivity = jest.fn<AnyFn>(async () => { setIdle(Date.now(), idle?.idleTimeoutMinutes); return true; });
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getSessionIdle: () => idle,
    onSessionIdleChange: (cb: () => void) => { idleListeners.add(cb); return () => { idleListeners.delete(cb); }; },
    reportActivity: (...a: unknown[]) => reportActivity(...a),
    isAuthenticated: () => idle !== null,
  },
}));
const logout = jest.fn<AnyFn>(async () => undefined);
let mockAuth: Record<string, unknown> = {};
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => mockAuth));

import { IdleSessionGuard, IDLE_WARNING_MS } from '../src/components/auth/IdleSessionGuard';
import { ActivityTracker, activityTracker } from '../src/lib/session/activity';

/** jsdom ships no BroadcastChannel: every same-name channel delivers to its peers, never itself. */
class TestBroadcastChannel {
  static peers = new Map<string, Set<TestBroadcastChannel>>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(public readonly name: string) {
    const set = TestBroadcastChannel.peers.get(name) ?? new Set();
    set.add(this);
    TestBroadcastChannel.peers.set(name, set);
  }
  postMessage(data: unknown): void {
    for (const peer of TestBroadcastChannel.peers.get(this.name) ?? []) {
      if (peer !== this) peer.onmessage?.({ data } as MessageEvent);
    }
  }
  close(): void { TestBroadcastChannel.peers.get(this.name)?.delete(this); }
}

const advance = async (ms: number) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };
const dialog = () => screen.queryByRole('dialog');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = TestBroadcastChannel;
  activityTracker.resetForTests();
  reportActivity.mockClear();
  logout.mockClear();
  idleListeners.clear();
  mockAuth = { user: { id: 'u1' }, logout };
  setIdle(Date.now());
});

afterEach(() => {
  jest.useRealTimers();
  TestBroadcastChannel.peers.clear();
  delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  localStorage.clear();
});

describe('IdleSessionGuard', () => {
  it('warns 2 minutes before the deadline, with a live countdown', async () => {
    expect(IDLE_WARNING_MS).toBe(2 * MINUTE);
    render(<IdleSessionGuard />);
    await advance(13 * MINUTE - 1000);
    expect(dialog()).not.toBeInTheDocument();

    await advance(1000);
    expect(dialog()).toBeInTheDocument();
    const live = screen.getByText(/You'll be signed out in/);
    expect(live).toHaveTextContent("You'll be signed out in 2 minutes for inactivity");
    expect(live.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('timer')).toHaveTextContent('2:00');

    await advance(1000);
    expect(screen.getByRole('timer')).toHaveTextContent('1:59');
    await advance(60_000);
    expect(screen.getByRole('timer')).toHaveTextContent('0:59');
    expect(screen.getByText(/You'll be signed out in/)).toHaveTextContent("You'll be signed out in 60 seconds for inactivity");
  });

  it('traps focus: it opens on "Stay signed in" and Tab cycles inside the dialog', async () => {
    render(<IdleSessionGuard />);
    await advance(13 * MINUTE);
    const stay = screen.getByRole('button', { name: 'Stay signed in' });
    expect(document.activeElement).toBe(stay);
    const buttons = Array.from(dialog()!.querySelectorAll('button'));
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('"Stay signed in" counts as activity, refreshes at once and closes the warning', async () => {
    render(<IdleSessionGuard />);
    await advance(13 * MINUTE + 30_000);
    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    await advance(0);
    expect(activityTracker.lastActivityAt()).toBe(Date.now());
    expect(reportActivity).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeInTheDocument();
    // A fresh 15 minutes from now — no sign-out at the old deadline.
    await advance(5 * MINUTE);
    expect(logout).not.toHaveBeenCalled();
  });

  it('"Sign out" signs out now', async () => {
    render(<IdleSessionGuard />);
    await advance(13 * MINUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await advance(0);
    expect(logout).toHaveBeenCalledWith();
  });

  it('at the deadline it signs out for inactivity (every tab, via the API client), naming the timeout', async () => {
    render(<IdleSessionGuard />);
    await advance(15 * MINUTE);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith({ reason: 'idle', idleTimeoutMinutes: 15 });
    await advance(5000);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('polling is not activity: API traffic alone still reaches the deadline', async () => {
    render(<IdleSessionGuard />);
    for (let i = 0; i < 30; i++) {
      // A poll's passive refresh brings back the SAME idle deadline.
      act(() => { setIdle(idle!.lastActiveAt); });
      await advance(30_000);
    }
    expect(logout).toHaveBeenCalledWith({ reason: 'idle', idleTimeoutMinutes: 15 });
  });

  it('real input before the warning pushes the deadline out, and is reported halfway to the server deadline', async () => {
    render(<IdleSessionGuard />);
    await advance(3 * MINUTE);
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    expect(reportActivity).not.toHaveBeenCalled();
    // Halfway (7.5 min) to the server's deadline: the input is reported.
    await advance(4 * MINUTE + 30_000);
    expect(reportActivity).toHaveBeenCalledTimes(1);
    // The deadline is now 15 minutes from that report — no warning at the old time.
    await advance(6 * MINUTE);
    expect(dialog()).not.toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  it('ambient input while the warning is up does not dismiss it — the person must answer', async () => {
    render(<IdleSessionGuard />);
    await advance(13 * MINUTE);
    act(() => { window.dispatchEvent(new Event('pointermove')); window.dispatchEvent(new Event('keydown')); });
    await advance(1000);
    expect(dialog()).toBeInTheDocument();
  });

  it('"Stay signed in" in ANOTHER tab closes the warning here', async () => {
    const stopHere = activityTracker.start();
    const otherTab = new ActivityTracker();
    const stopOther = otherTab.start();
    render(<IdleSessionGuard />);
    await advance(13 * MINUTE);
    expect(dialog()).toBeInTheDocument();
    act(() => { otherTab.record(); });
    await advance(1000);
    expect(dialog()).not.toBeInTheDocument();
    stopOther(); stopHere();
  });

  it('does nothing without an interactive session', async () => {
    idle = null;
    render(<IdleSessionGuard />);
    await advance(20 * MINUTE);
    expect(dialog()).not.toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });
});

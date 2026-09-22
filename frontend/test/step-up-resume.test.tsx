// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A step-up refusal has to FINISH the action, not just re-verify.
 *
 * The global fallback used to pass an empty `onConfirmed`: the person
 * re-verified, the dialog closed, and nothing happened — leaving them to guess
 * which control had failed and click it again. The refusal happens BEFORE the
 * server does anything, so replaying the identical request with the fresh token
 * is exactly what the user would have done by hand.
 *
 * Two halves, tested here together because neither is worth anything alone:
 *   - the api client emits `step-up-required` carrying a `retry` that replays
 *     the same request with `X-Step-Up-Token`;
 *   - the dashboard shell prompts, calls it, and reports the outcome — and when
 *     an event arrives without one, SAYS the action can't be resumed rather than
 *     silently doing nothing.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiCore } from '../src/lib/api/core';

// ---------------------------------------------------------------------------
// The api client: a refused write becomes a resumable event
// ---------------------------------------------------------------------------

describe('step-up refusal carries a retry', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  /** A 401 STEP_UP_REQUIRED first, then a success — what a stale tab sees. */
  function mockFetchSequence() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = jest.fn<AnyFn>((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const refused = calls.length === 1;
      return Promise.resolve({
        status: refused ? 401 : 200,
        ok: !refused,
        json: async () => (refused
          ? { code: 'STEP_UP_REQUIRED', message: 'Confirm it is you' }
          : { success: true, data: { deleted: true } }),
      } as unknown as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return calls;
  }

  it('dispatches a retry that replays the SAME request with the fresh token', async () => {
    const calls = mockFetchSequence();
    const core = new ApiCore();

    let detail: { code?: string; retry?: (t: string) => Promise<unknown> } | null = null;
    const listener = (e: Event) => { detail = (e as CustomEvent).detail; };
    window.addEventListener('step-up-required', listener);

    await expect(core.request('/api/user/keys/k1', { method: 'DELETE' })).rejects.toThrow(/confirm it is you/i);
    window.removeEventListener('step-up-required', listener);

    expect(detail!.code).toBe('STEP_UP_REQUIRED');
    expect(typeof detail!.retry).toBe('function');

    const result = await detail!.retry!('fresh-step-up-token');
    expect(result).toEqual({ success: true, data: { deleted: true } });

    // Same endpoint, same method — plus the header the route was asking for.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(calls[0].url);
    expect(calls[1].init.method).toBe('DELETE');
    expect((calls[1].init.headers as Record<string, string>)['X-Step-Up-Token']).toBe('fresh-step-up-token');
    expect((calls[0].init.headers as Record<string, string>)['X-Step-Up-Token']).toBeUndefined();
  });

  it('replays the original body, so the retry is the same write', async () => {
    const calls = mockFetchSequence();
    const core = new ApiCore();
    const seen: Array<(t: string) => Promise<unknown>> = [];
    const listener = (e: Event) => {
      const d = (e as CustomEvent).detail as { retry?: (t: string) => Promise<unknown> };
      if (d.retry) seen.push(d.retry);
    };
    window.addEventListener('step-up-required', listener);

    await expect(core.request('/api/user/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'ci-deploy' }),
    })).rejects.toThrow();
    window.removeEventListener('step-up-required', listener);

    await seen[0]('fresh');
    expect(calls[1].init.body).toBe(JSON.stringify({ name: 'ci-deploy' }));
  });
});

// ---------------------------------------------------------------------------
// The shell: confirming finishes the action
// ---------------------------------------------------------------------------

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => ({ __esModule: true, useToast: () => toast }));

// Capture what the global fallback renders, and drive its confirmation.
let stepUpProps: { action: string; details: ReactNode; onConfirmed: (t: string) => void | Promise<void>; onClose: () => void } | null = null;
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: (props: { action: string; details: ReactNode; onConfirmed: (t: string) => void | Promise<void>; onClose: () => void }) => {
    stepUpProps = props;
    return (
      <div data-testid="global-stepup">
        <span>{props.action}</span>
        <div data-testid="details">{props.details}</div>
      </div>
    );
  },
}));

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getUnreadCount: jest.fn<AnyFn>().mockResolvedValue({ data: { count: 0 } }) },
}));
const mockRouter = { pathname: '/dashboard', asPath: '/dashboard', push: jest.fn<AnyFn>(), events: { on: jest.fn<AnyFn>(), off: jest.fn<AnyFn>() } };
jest.mock('next/router', () => ({ useRouter: () => mockRouter }));
jest.mock('next/head', () => ({ __esModule: true, default: ({ children }: { children: ReactNode }) => <>{children}</> }));
jest.mock('@/hooks/useAuthGuard', () => ({
  useAuthGuard: () => ({ user: { id: 'u1', organizationId: 'org-1' }, isReady: true, isSuperAdmin: false, isAdmin: false, logout: jest.fn<AnyFn>() }),
}));
jest.mock('@/hooks/useDarkMode', () => ({ useDarkMode: () => ({ isDark: false, toggle: jest.fn<AnyFn>() }) }));
jest.mock('@/hooks/useFeatures', () => ({ useFeatures: () => ({ isLoaded: true, isEnabled: () => false }) }));
jest.mock('../src/components/ui/Sidebar', () => ({ Sidebar: () => null }));
for (const mod of ['OrgSwitcher', 'QuotaBanner', 'ImpersonationBanner', 'AuthErrorBanner', 'MfaEnrolmentNudge', 'MfaRequiredBanner', 'MfaRequiredDialog', 'CommandPalette']) {
  jest.doMock(`../src/components/ui/${mod}`, () => ({ [mod]: () => null }));
}
jest.mock('@/components/ask/AskPanel', () => ({ AskPanel: () => null }));

import { DashboardLayout } from '../src/components/ui/DashboardLayout';

/** Fire the event the api client dispatches on a step-up refusal. */
function refuse(detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent('step-up-required', { detail }));
  });
}

describe('the dashboard shell resumes the refused action', () => {
  beforeEach(() => {
    stepUpProps = null;
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it('runs the retry with the fresh token and says it completed', async () => {
    const retry = jest.fn<AnyFn>().mockResolvedValue({ success: true });
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    refuse({ code: 'STEP_UP_REQUIRED', message: 'Confirm it is you', retry });

    expect(await screen.findByTestId('global-stepup')).toBeInTheDocument();
    expect(screen.getByTestId('details')).toHaveTextContent(/completes the action you just tried/i);

    await act(async () => { await stepUpProps!.onConfirmed('fresh-token'); });

    expect(retry).toHaveBeenCalledWith('fresh-token');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/completed/i)));
  });

  it('surfaces a failed replay instead of pretending it worked', async () => {
    const retry = jest.fn<AnyFn>().mockRejectedValue(new Error('Organization not found'));
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    refuse({ code: 'STEP_UP_REQUIRED', message: 'Confirm it is you', retry });

    await act(async () => { await stepUpProps!.onConfirmed('fresh-token'); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Organization not found'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('SAYS SO when the refusal cannot be resumed, instead of a silent no-op', async () => {
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    // A stream refusal carries no retry — its consumer has already moved on.
    refuse({ code: 'STEP_UP_REQUIRED', message: 'Confirm it is you' });

    expect(await screen.findByTestId('global-stepup')).toBeInTheDocument();
    expect(screen.getByTestId('details')).toHaveTextContent(/can't be resumed automatically/i);

    await act(async () => { await stepUpProps!.onConfirmed('fresh-token'); });
    // No false "it completed" — there was nothing to complete.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('tells the refused call when the dialog is dismissed, so its resume settles', async () => {
    const cancel = jest.fn<AnyFn>();
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    refuse({ code: 'STEP_UP_REQUIRED', message: 'Confirm it is you', retry: jest.fn<AnyFn>(), cancel });
    await screen.findByTestId('global-stepup');
    act(() => { stepUpProps!.onClose(); });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('global-stepup')).not.toBeInTheDocument();
  });

  it('claims the refusal, so the api client attaches the replay to it', async () => {
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    const event = new CustomEvent('step-up-required', { cancelable: true, detail: { code: 'STEP_UP_REQUIRED' } });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  });

  it('asks for a strong factor when the route only accepts one', async () => {
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    refuse({ code: 'STEP_UP_METHOD_REQUIRED', message: 'Passkey or code required', retry: jest.fn<AnyFn>() });

    await screen.findByTestId('global-stepup');
    expect((stepUpProps as unknown as { requireStrongFactor: boolean }).requireStrongFactor).toBe(true);
  });
});

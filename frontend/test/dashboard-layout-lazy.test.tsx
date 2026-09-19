// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard shell loads StepUpModal and AskPanel on demand, and gates Ask
 * through `useFeatureGate`.
 *
 *  - Both are ~400-line components that were statically imported by every
 *    dashboard route. They're `next/dynamic` chunks now, rendered only once
 *    opened.
 *  - Step-up is triggered imperatively (the api client fires
 *    `step-up-required`). The listener lives in the always-loaded shell and the
 *    request is held in state, so a refusal that arrives BEFORE the dialog's
 *    chunk has loaded still opens it — with its `retry` intact.
 *  - Without the `ai_generation` entitlement, Ask is a locked entry leading to
 *    billing instead of silently vanishing.
 */

import { render, screen, act, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

jest.mock('@/components/ui/Toast', () => ({ __esModule: true, useToast: () => ({ success: jest.fn(), error: jest.fn() }) }));

let stepUpProps: { onConfirmed: (t: string) => void | Promise<void> } | null = null;
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: (props: { action: string; onConfirmed: (t: string) => void | Promise<void> }) => {
    stepUpProps = props;
    return <div data-testid="global-stepup">{props.action}</div>;
  },
}));
jest.mock('@/components/ask/AskPanel', () => ({
  __esModule: true,
  AskPanel: ({ onClose }: { onClose: () => void }) => <div data-testid="ask-panel"><button onClick={onClose}>close ask</button></div>,
}));

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getUnreadCount: jest.fn().mockResolvedValue({ data: { count: 0 } }) },
}));
const mockRouter = { pathname: '/dashboard', asPath: '/dashboard', push: jest.fn(), events: { on: jest.fn(), off: jest.fn() } };
jest.mock('next/router', () => ({ useRouter: () => mockRouter }));
jest.mock('next/head', () => ({ __esModule: true, default: ({ children }: { children: ReactNode }) => <>{children}</> }));
jest.mock('@/hooks/useAuthGuard', () => ({
  useAuthGuard: () => ({ user: { id: 'u1', organizationId: 'org-1' }, isReady: true, isSuperAdmin: false, isAdmin: false, logout: jest.fn() }),
}));
jest.mock('@/hooks/useDarkMode', () => ({ useDarkMode: () => ({ isDark: false, toggle: jest.fn() }) }));
let aiEntitled = false;
jest.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ isLoaded: true, isSuperAdmin: false, isEnabled: (f: string) => f === 'ai_generation' && aiEntitled }),
}));
jest.mock('../src/components/ui/Sidebar', () => ({ Sidebar: () => null }));
for (const mod of ['OrgSwitcher', 'QuotaBanner', 'ImpersonationBanner', 'AuthErrorBanner', 'MfaRequiredBanner', 'MfaRequiredDialog', 'CommandPalette']) {
  jest.doMock(`../src/components/ui/${mod}`, () => ({ [mod]: () => null }));
}

import { DashboardLayout } from '../src/components/ui/DashboardLayout';

beforeEach(() => { stepUpProps = null; aiEntitled = false; });

describe('step-up loads on demand without dropping the request', () => {
  it('renders no step-up dialog (and loads none) until one is requested', () => {
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    expect(screen.queryByTestId('global-stepup')).toBeNull();
    expect(stepUpProps).toBeNull();
  });

  it('holds a refusal fired before the chunk arrives and opens with its retry once it does', async () => {
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    const retry = jest.fn().mockResolvedValue({ ok: true });
    act(() => {
      window.dispatchEvent(new CustomEvent('step-up-required', { detail: { code: 'STEP_UP_REQUIRED', message: 'Confirm it', retry } }));
    });
    // The chunk resolves asynchronously — nothing is on screen yet — and the
    // request must survive the wait.
    expect(screen.queryByTestId('global-stepup')).toBeNull();
    expect(await screen.findByTestId('global-stepup')).toHaveTextContent(/Confirm it/);
    await act(async () => { await stepUpProps!.onConfirmed('fresh'); });
    expect(retry).toHaveBeenCalledWith('fresh');
  });
});

describe('Ask entry point', () => {
  it('opens the lazily loaded panel when entitled', async () => {
    aiEntitled = true;
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    expect(screen.queryByTestId('ask-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByTestId('ask-panel')).toBeInTheDocument();
  });

  it('shows a locked entry leading to billing when the plan lacks ai_generation', () => {
    render(<DashboardLayout title="Home"><p>home</p></DashboardLayout>);
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
    const locked = screen.getByTestId('feature-locked-ai_generation');
    expect(locked).toHaveAttribute('href', '/dashboard/billing?highlight=ai_generation');
    expect(locked).toHaveAccessibleName(/Ask — requires .*Open billing to add it/);
  });
});

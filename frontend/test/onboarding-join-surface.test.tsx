// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/dashboard/onboarding` as a DURABLE surface.
 *
 * It must not bounce an already-onboarded user straight to the dashboard:
 * since both "Continue" and "Skip for now" clear `needsOnboarding` for good —
 * and the page is in no nav or palette — that made domain discovery + the join
 * request a strictly one-shot feature, with no way to ever see what became of a
 * request that came back `status: 'requested'`. These cover the join mode, each
 * per-org state, and that a first-run user's flow is unchanged.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OnboardingPage from '../pages/dashboard/onboarding';

let user: Record<string, unknown> | null = { id: 'u1', organizationName: 'Personal', needsOnboarding: false };
const refreshUser = jest.fn<AnyFn>();
const replace = jest.fn<AnyFn>();
const push = jest.fn<AnyFn>();

jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ replace, push, query: {}, pathname: '/dashboard/onboarding', isReady: true })));

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule(() => ({ user, isReady: true, refreshUser })));

jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ markOnboardingComplete: jest.fn<AnyFn>() })));

jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: () => false, isLoaded: true }),
}));

jest.mock('@/hooks/usePlans', () => ({
  __esModule: true,
  usePlans: () => ({ plans: [], loading: false }),
}));

const getDomainOrgs = jest.fn<AnyFn>();
const joinDomainOrg = jest.fn<AnyFn>();
const completeOnboarding = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getDomainOrgs: (...a: unknown[]) => getDomainOrgs(...a),
    joinDomainOrg: (...a: unknown[]) => joinDomainOrg(...a),
    completeOnboarding: (...a: unknown[]) => completeOnboarding(...a),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  user = { id: 'u1', organizationName: 'Personal', needsOnboarding: false };
  getDomainOrgs.mockResolvedValue({ success: true, data: { orgs: [] } });
  joinDomainOrg.mockResolvedValue({ success: true, data: { status: 'requested' } });
  completeOnboarding.mockResolvedValue({ success: true, data: {} });
});

describe('onboarding page — join mode', () => {
  it('shows the join surface instead of redirecting an onboarded user', async () => {
    render(<OnboardingPage />);
    expect(await screen.findByRole('heading', { name: /join an organization/i })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('explains what is missing when nothing matches the email domain', async () => {
    render(<OnboardingPage />);
    expect(await screen.findByText(/No organizations match your email address/i)).toBeInTheDocument();
    expect(screen.getByText(/ask an administrator there to send you an invitation/i)).toBeInTheDocument();
  });

  it('surfaces a pending request rather than offering to re-send it', async () => {
    getDomainOrgs.mockResolvedValue({
      success: true,
      data: { orgs: [{ orgId: 'o1', orgName: 'Acme', autoJoin: 'request', requestStatus: 'pending' }] },
    });
    render(<OnboardingPage />);
    expect(await screen.findByTestId('org-state-o1')).toHaveTextContent(/Request sent/i);
    expect(screen.queryByRole('button', { name: /request access/i })).not.toBeInTheDocument();
  });

  it('surfaces a refused request, which the backend will not re-open', async () => {
    getDomainOrgs.mockResolvedValue({
      success: true,
      data: { orgs: [{ orgId: 'o1', orgName: 'Acme', autoJoin: 'request', requestStatus: 'denied' }] },
    });
    render(<OnboardingPage />);
    expect(await screen.findByTestId('org-state-o1')).toHaveTextContent(/declined/i);
    expect(screen.queryByRole('button', { name: /request access/i })).not.toBeInTheDocument();
  });

  it('says so for an org already joined', async () => {
    getDomainOrgs.mockResolvedValue({
      success: true,
      data: { orgs: [{ orgId: 'o1', orgName: 'Acme', autoJoin: 'auto', isMember: true }] },
    });
    render(<OnboardingPage />);
    expect(await screen.findByTestId('org-state-o1')).toHaveTextContent(/You're a member/i);
    expect(screen.queryByRole('button', { name: /^join$/i })).not.toBeInTheDocument();
  });

  it('files a request and re-reads the list, without touching completeOnboarding', async () => {
    getDomainOrgs.mockResolvedValue({
      success: true,
      data: { orgs: [{ orgId: 'o1', orgName: 'Acme', autoJoin: 'request' }] },
    });
    render(<OnboardingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /request access/i }));

    await waitFor(() => expect(joinDomainOrg).toHaveBeenCalledWith('o1'));
    // Already onboarded — the first-run flag is not in play any more.
    expect(completeOnboarding).not.toHaveBeenCalled();
    await waitFor(() => expect(getDomainOrgs.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('onboarding page — first run', () => {
  it('still shows the set-up flow and its skip escape hatch', async () => {
    user = { id: 'u1', organizationName: 'Personal', needsOnboarding: true };
    render(<OnboardingPage />);
    expect(await screen.findByRole('heading', { name: /Welcome to Pipeline Builder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /skip for now/i })).toBeInTheDocument();
    // And it now says where the join flow lives afterwards.
    expect(screen.getByText(/Skipping is not final/i)).toBeInTheDocument();
  });
});

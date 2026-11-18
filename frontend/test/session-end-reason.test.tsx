// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Why a person lands back on sign-in, said in plain words.
 *
 *  - `/auth/refresh` 401 `SESSION_EXPIRED` → `/?reason=session-expired` →
 *    "Your session expired. Sign in again." (the api-core half lives in
 *    api-core-session.test.ts; the useAuth redirect in use-auth-return-to).
 *  - switch-org 403 `SESSION_POLICY_REAUTH_REQUIRED` → a prompt (not an error
 *    toast) that the organization needs a fresh sign-in, offering one; the
 *    person stays in their current org until they take it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { UserOrgMembership } from '@/types';

let mockQuery: Record<string, string> = {};
const router = { asPath: '/dashboard', pathname: '/dashboard', replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ ...router, query: mockQuery })));

const logout = jest.fn<AnyFn>(async () => undefined);
const switchOrganization = jest.fn<AnyFn>();
let mockAuth: Record<string, unknown> = {};
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => mockAuth));
const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOAuthProviders: jest.fn<AnyFn>().mockResolvedValue({ data: { providers: [] } }),
    discoverSso: jest.fn<AnyFn>().mockResolvedValue({ data: { sso: false } }),
  },
}));
jest.mock('@/lib/passkeys', () => ({
  __esModule: true,
  browserSupportsWebAuthn: () => false,
  browserSupportsWebAuthnAutofill: async () => false,
  cancelPasskeyCeremony: () => undefined,
}));

import { SignInCard } from '../src/components/auth/SignInCard';
import { OrgSwitcher } from '../src/components/ui/OrgSwitcher';
import { OrgReauthDialog } from '../src/components/ui/OrgReauthDialog';
import { isSessionPolicyReauth, parseSignInReason, signInHref } from '../src/lib/sign-in-reason';

const org = (over: Partial<UserOrgMembership>): UserOrgMembership => ({
  id: 'own', name: 'Own Org', role: 'owner', childOrgCount: 0, roleNames: [], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery = {};
  mockAuth = { login: jest.fn<AnyFn>(), completeMfaLogin: jest.fn<AnyFn>(), loginWithPasskey: jest.fn<AnyFn>(), isSubmitting: false, logout };
});

describe('sign-in reason helpers', () => {
  it('only accepts the reasons the app sets', () => {
    expect(parseSignInReason('session-expired')).toBe('session-expired');
    expect(parseSignInReason(['org-reauth'])).toBe('org-reauth');
    expect(parseSignInReason('constructor')).toBeNull();
    expect(parseSignInReason('<script>')).toBeNull();
    expect(parseSignInReason(undefined)).toBeNull();
    expect(signInHref('session-expired')).toBe('/?reason=session-expired');
  });

  it('recognises the switch-org refusal by its code', () => {
    expect(isSessionPolicyReauth({ code: 'SESSION_POLICY_REAUTH_REQUIRED' })).toBe(true);
    expect(isSessionPolicyReauth({ code: 'MFA_REQUIRED' })).toBe(false);
    expect(isSessionPolicyReauth(null)).toBe(false);
  });
});

describe('the sign-in card says why the person is here', () => {
  it('a session past its lifetime: "Your session expired. Sign in again."', async () => {
    mockQuery = { reason: 'session-expired' };
    await act(async () => { render(<SignInCard />); });
    expect(screen.getByRole('status')).toHaveTextContent('Your session expired. Sign in again.');
  });

  it('an org that needs a fresh sign-in', async () => {
    mockQuery = { reason: 'org-reauth' };
    await act(async () => { render(<SignInCard />); });
    expect(screen.getByRole('status')).toHaveTextContent(/requires a recent sign-in/);
  });

  it('the generic rejection keeps its older wording; an unknown reason shows nothing', async () => {
    mockQuery = { expired: '1' };
    const { unmount } = render(<SignInCard />);
    expect(await screen.findByText(/take you back to where you were/)).toBeInTheDocument();
    unmount();

    mockQuery = { reason: 'nonsense' };
    await act(async () => { render(<SignInCard />); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('switch-org refused by the destination org\'s session policy', () => {
  const refusal = Object.assign(new Error('Your session is older than this organization\'s session policy allows'), {
    statusCode: 403, code: 'SESSION_POLICY_REAUTH_REQUIRED',
  });

  beforeEach(() => {
    mockAuth = {
      ...mockAuth,
      user: { organizationId: 'own' },
      organizations: [org({}), org({ id: 'acme', name: 'Acme', role: 'member' })],
      switchOrganization,
    };
  });

  it('prompts to sign in again instead of an error toast, and stays in the current org', async () => {
    switchOrganization.mockRejectedValue(refusal);
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /acme/i }));

    expect(await screen.findByText('Sign in again to switch')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText(/you stay in/)).toHaveTextContent('Own Org');
    expect(toast.error).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();

    // "Not now" closes it; nothing else happens.
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByText('Sign in again to switch')).not.toBeInTheDocument());
    expect(logout).not.toHaveBeenCalled();
  });

  it('any other refusal is still an error toast', async () => {
    switchOrganization.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 403, code: 'FORBIDDEN' }));
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /acme/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
    expect(screen.queryByText('Sign in again to switch')).not.toBeInTheDocument();
  });

  it('"Sign in again" signs out with the org-reauth reason', () => {
    const onClose = jest.fn<AnyFn>();
    render(<OrgReauthDialog orgName="Acme" onClose={onClose} />);
    expect(screen.getByText(/your current organization/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onClose).toHaveBeenCalled();
    expect(logout).toHaveBeenCalledWith({ reason: 'org-reauth' });
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Two browser legs of the SAML completeness work:
 *   - SIGN-OUT asks the platform for an SP-initiated Single Logout redirect
 *     BEFORE ending the session (it needs the session to find the SAML handle),
 *     then ends the session and — only when there is one — sends the browser to
 *     the IdP's SLO endpoint. A failed lookup never blocks signing out.
 *   - The SAML landing page, reached with `?test=<state>` by an admin's TEST
 *     CONNECTION popup, hands the state back to the settings page and closes —
 *     it never redeems anything or signs anyone in.
 */

import { render, screen, waitFor } from '@testing-library/react';
import SamlLandingPage from '../pages/auth/sso/[orgId]/saml';
import { authApi } from '../src/lib/api/domains/auth';
import type { ApiCore } from '../src/lib/api/core';

let mockQuery: Record<string, string> = {};
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: mockQuery, replace: jest.fn() }),
}));
const mockRefreshUser = jest.fn();
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => ({ refreshUser: mockRefreshUser }) }));
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: new Proxy({}, { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }),
}));
jest.mock('@/lib/api', () => {
  const api = { completeSamlLogin: jest.fn() };
  return { __esModule: true, default: api, api };
});
const mockApi = jest.requireMock('@/lib/api').api as Record<'completeSamlLogin', jest.Mock>;

function fakeCore(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const core = {
    request: jest.fn(async (path: string) => {
      calls.push(path);
      const r = responses[path];
      if (r instanceof Error) throw r;
      return r ?? { success: true };
    }),
    clearTokens: jest.fn(),
  } as unknown as ApiCore;
  return { core, calls };
}

describe('sign-out with Single Logout', () => {
  beforeEach(() => { window.location.hash = ''; });

  it('asks for the SLO redirect first, ends the session, then goes to the IdP', async () => {
    const { core, calls } = fakeCore({ '/api/auth/sso/logout': { success: true, data: { redirectUrl: '#idp-slo' } } });
    await authApi(core).logout();
    expect(calls).toEqual(['/api/auth/sso/logout', '/api/auth/logout']);
    expect((core as unknown as { clearTokens: jest.Mock }).clearTokens).toHaveBeenCalled();
    expect(window.location.hash).toBe('#idp-slo');
  });

  it('stays local when the session was not a SAML sign-in', async () => {
    const { core } = fakeCore({ '/api/auth/sso/logout': { success: true, data: { redirectUrl: null } } });
    await authApi(core).logout();
    expect(window.location.hash).toBe('');
  });

  it('still signs out when the SLO lookup fails', async () => {
    const { core, calls } = fakeCore({ '/api/auth/sso/logout': new Error('boom') });
    await authApi(core).logout();
    expect(calls).toContain('/api/auth/logout');
    expect((core as unknown as { clearTokens: jest.Mock }).clearTokens).toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });
});

describe('SAML landing page — a test connection', () => {
  it('hands the test state back to the opener and closes, redeeming nothing', async () => {
    const posted: unknown[] = [];
    Object.defineProperty(window, 'opener', { value: { postMessage: (m: unknown) => posted.push(m) }, configurable: true });
    window.close = jest.fn();
    mockQuery = { orgId: 'org-1', test: 'ssotest.abc.sig' };
    render(<SamlLandingPage />);

    await waitFor(() => expect(window.close).toHaveBeenCalled());
    expect(posted).toEqual([{ type: 'pb-sso-test', state: 'ssotest.abc.sig' }]);
    expect(mockApi.completeSamlLogin).not.toHaveBeenCalled();
    expect(mockRefreshUser).not.toHaveBeenCalled();
    expect(screen.getByText(/Test complete/)).toBeInTheDocument();
    Object.defineProperty(window, 'opener', { value: null, configurable: true });
  });

  it('explains a refused single-logout message', () => {
    mockQuery = { orgId: 'org-1', error: 'SAML_INVALID_LOGOUT' };
    render(<SamlLandingPage />);
    expect(screen.getByText(/single-logout message from your identity provider could not be verified/i)).toBeInTheDocument();
  });
});

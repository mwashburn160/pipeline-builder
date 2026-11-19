// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useAuth.refreshUser` signs the person out only on a GENUINE 401 (token
 * expired or revoked). `MfaRequiredError` and `StepUpRequiredError` are 401
 * subclasses too, but they mean "the session is fine, it needs a stronger
 * factor" — the api client raises a dialog for them. Treating them as signed
 * out would drop a live session (core.ts says it must not).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiError, MfaRequiredError, StepUpRequiredError } from '../src/lib/api/errors';

jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ push: jest.fn() })));

const profile = {
  success: true,
  data: { user: { id: 'u1', username: 'ada', email: 'ada@example.com', role: 'owner', organizationId: 'o1' } },
};
const mockApi = {
  isAuthenticated: jest.fn<AnyFn>(() => true),
  restoreSession: jest.fn<AnyFn>(async () => true),
  isImpersonating: jest.fn<AnyFn>(() => false),
  getProfile: jest.fn<AnyFn>(async () => profile),
  getUserOrganizations: jest.fn<AnyFn>(async () => ({ data: { organizations: [] } })),
  setOrganizationId: jest.fn<AnyFn>(),
  onAccessTokenChange: () => () => undefined,
  onOrganizationChange: () => () => undefined,
  onIdentityChange: () => () => undefined,
  onSessionExpired: jest.fn<AnyFn>(() => () => { /* unsubscribe */ }),
};
jest.mock('@/lib/api', () => {
  const errors = jest.requireActual<typeof import('../src/lib/api/errors')>('../src/lib/api/errors');
  return { __esModule: true, default: mockApi, ApiError: errors.ApiError };
});

import { AuthProvider, useAuth } from '../src/hooks/useAuth';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

async function signedIn() {
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.user?.id).toBe('u1'));
  return result;
}

describe('useAuth.refreshUser — which 401s sign the person out', () => {
  beforeEach(() => { mockApi.getProfile.mockImplementation(async () => profile); });

  it.each([
    ['MfaRequiredError', () => new MfaRequiredError('MFA required', 'MFA_REQUIRED')],
    ['StepUpRequiredError', () => new StepUpRequiredError('Step-up required', 'STEP_UP_REQUIRED')],
  ])('keeps the user signed in when the profile answers %s', async (_name, make) => {
    const result = await signedIn();
    mockApi.getProfile.mockImplementation(async () => { throw make(); });
    await act(async () => { await result.current.refreshUser(); });
    expect(result.current.user?.id).toBe('u1');
  });

  it('still signs the person out on a plain 401', async () => {
    const result = await signedIn();
    mockApi.getProfile.mockImplementation(async () => { throw new ApiError('Unauthorized', 401); });
    await act(async () => { await result.current.refreshUser(); });
    expect(result.current.user).toBeNull();
  });
});

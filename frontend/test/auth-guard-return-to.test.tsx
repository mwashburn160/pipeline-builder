// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A signed-out visitor bounced off a guarded page is sent to sign in with the
 * page remembered, so signing in lands them back on it.
 */

import { it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook } from '@testing-library/react';

const replace = jest.fn<AnyFn>();
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ pathname: '/dashboard/pipelines', asPath: '/dashboard/pipelines?q=deploy', replace, push: jest.fn<AnyFn>() }),
}));

jest.mock('../src/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    isInitialized: true,
    isLoading: false,
    isReadOnly: false,
    logout: jest.fn<AnyFn>(),
    refreshUser: jest.fn<AnyFn>(),
  }),
}));

import { useAuthGuard } from '../src/hooks/useAuthGuard';
import { POST_SIGN_IN_KEY } from '../src/lib/return-to';

it('remembers the guarded page before bouncing to sign-in', () => {
  window.sessionStorage.clear();
  renderHook(() => useAuthGuard());
  expect(replace).toHaveBeenCalledWith('/');
  expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBe('/dashboard/pipelines?q=deploy');
});

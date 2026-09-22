// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The public directory pages get the light app shell: no `/api/config` fetch
 * (FeaturesProvider) and a session restore deferred to idle — while the app's
 * own pages keep the full shell. `/plugins/submit` is the signed-in submission
 * flow and is NOT a public page.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, act } from '@testing-library/react';
import { isPublicDirectoryRoute } from '../src/lib/public-directory/routes';

let pathname = '/plugins';
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ pathname, asPath: pathname, query: {}, push: jest.fn<AnyFn>(), events: { on: jest.fn<AnyFn>(), off: jest.fn<AnyFn>() } })));
const getConfig = jest.fn<AnyFn>(async () => ({ success: true, data: { serviceFeatures: {} } }));
const restoreSession = jest.fn<AnyFn>(async () => false);
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    restoreSession: (...a: unknown[]) => restoreSession(...a),
    isAuthenticated: () => false,
    isImpersonating: () => false,
    onAccessTokenChange: () => () => undefined,
    onSessionExpired: () => () => undefined,
    getBillingConfig: async () => ({ success: true, data: { enabled: false } }),
  },
  ApiError: class extends Error {},
}));
jest.mock('@/lib/error-reporter', () => ({ initClientErrorReporting: () => undefined }));
jest.mock('@/styles/globals.css', () => ({}), { virtual: true });

import App from '../pages/_app';

const Page = () => <p>page body</p>;

beforeEach(() => { jest.clearAllMocks(); jest.useRealTimers(); });

describe('isPublicDirectoryRoute', () => {
  it.each([
    ['/plugins', true], ['/plugins/category/[category]', true], ['/plugins/[publisher]/[name]', true],
    ['/plugins/submit', false], ['/plugins/submit/status', false], ['/dashboard/plugins', false], ['/', false],
  ])('%s → %s', (p, expected) => { expect(isPublicDirectoryRoute(p)).toBe(expected); });
});

describe('the app shell', () => {
  it('skips the feature-config fetch and defers the session restore on a public page', async () => {
    pathname = '/plugins';
    jest.useFakeTimers();
    await act(async () => { render(<App Component={Page} pageProps={{}} router={{} as never} />); });
    expect(screen.getByText('page body')).toBeInTheDocument();
    expect(getConfig).not.toHaveBeenCalled();
    expect(restoreSession).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(restoreSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the full shell on an app page', async () => {
    pathname = '/dashboard';
    await act(async () => { render(<App Component={Page} pageProps={{}} router={{} as never} />); });
    expect(getConfig).toHaveBeenCalled();
    expect(restoreSession).toHaveBeenCalled();
  });
});

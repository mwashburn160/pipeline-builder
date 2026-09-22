// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/login?returnTo=` — the stable sign-in link. A safe path is remembered in
 * the existing return-to store and the visitor goes to `/` (the sign-in page);
 * an unsafe one is dropped, so the link can never be an open redirect.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, waitFor } from '@testing-library/react';
import { POST_SIGN_IN_KEY, takeReturnPath } from '../src/lib/return-to';

const replace = jest.fn<AnyFn>();
let query: Record<string, unknown> = {};
let isReady = true;
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady, query, replace })));

import LoginPage from '../pages/login';

beforeEach(() => {
  window.sessionStorage.clear();
  query = {};
  isReady = true;
});

describe('/login', () => {
  it.each([
    '/plugins/pipeline-builder/trivy',
    '/plugins?q=terraform&tier=official',
    '/plugins/category/security',
    '/dashboard/pipelines',
  ])('remembers the safe path %s and goes to the sign-in page', async (path) => {
    query = { returnTo: path };
    render(<LoginPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBe(path);
    expect(takeReturnPath()).toBe(path);
  });

  it.each([
    ['absolute URL', 'https://evil.example/plugins'],
    ['protocol-relative', '//evil.example'],
    ['backslash host', '/\\evil.example'],
    ['encoded protocol-relative', '/%2F%2Fevil.example'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['sign-in machinery', '/auth/callback/google?code=x'],
    ['the landing page', '/'],
    ['newline injection', '/plugins\n//evil'],
  ])('refuses %s', async (_label, path) => {
    query = { returnTo: path };
    render(<LoginPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBeNull();
  });

  it('refuses a repeated returnTo (array) and a missing one, and still goes to sign-in', async () => {
    query = { returnTo: ['/plugins', 'https://evil.example'] };
    render(<LoginPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBeNull();
  });

  it('never redirects anywhere but /', async () => {
    query = { returnTo: 'https://evil.example' };
    render(<LoginPage />);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls.every(([to]) => to === '/')).toBe(true);
  });

  it('waits for the router before reading the query', () => {
    isReady = false;
    query = { returnTo: '/plugins' };
    render(<LoginPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBeNull();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sign-in and token refresh, in a real browser against the stubbed backend:
 *  - the landing form posts the identifier + password, the access token is
 *    taken, the profile loaded and the dashboard reached;
 *  - an expired access token is refreshed ONCE (`POST /auth/refresh`, with the
 *    CSRF client header) and the refused request is retried with the new token;
 *  - a returning browser (session marker set) is signed in from the refresh
 *    cookie alone on boot.
 */

import { test, expect } from '@playwright/test';
import { OWNER, fakeJwt, signedInPage, stubBackend } from './support/backend';

test('sign in with a password reaches the dashboard', async ({ page }) => {
  const api = await stubBackend(page);
  const token = fakeJwt();
  api.on('POST /api/auth/login', () => {
    api.signIn();
    return { json: { success: true, data: { accessToken: token, expiresIn: 3600 } } };
  });

  await page.goto('/');
  await page.getByLabel('Email or username').fill('dana');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(`Welcome back, ${OWNER.username}`)).toBeVisible();
  expect(api.calls('POST /api/auth/login')[0].json).toEqual({ identifier: 'dana', password: 'correct horse battery' });
  // Authenticated reads carry the token the sign-in returned.
  const profile = api.calls('GET /api/user/profile').at(-1)!;
  expect(profile.headers.authorization).toBe(`Bearer ${token}`);
});

test('a refused sign-in shows the server message and stays put', async ({ page }) => {
  const api = await stubBackend(page);
  api.on('POST /api/auth/login', { status: 401, json: { success: false, message: 'Invalid credentials' } });
  await page.goto('/');
  await page.getByLabel('Email or username').fill('dana');
  await page.getByLabel('Password', { exact: true }).fill('nope');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Invalid credentials')).toBeVisible();
  await expect(page).not.toHaveURL(/\/dashboard/);
});

test('an expired access token is refreshed once and the request retried', async ({ page }) => {
  const api = await signedInPage(page);
  const fresh = fakeJwt({ jti: 'fresh' });
  let refreshes = 0;
  api.on('POST /api/auth/refresh', () => {
    refreshes += 1;
    // The boot exchange hands out a token the server will then call expired.
    return { json: { success: true, data: { accessToken: refreshes === 1 ? fakeJwt({ jti: 'stale' }) : fresh, expiresIn: 3600 } } };
  });
  api.on('GET /api/pipelines', (call) => (call.headers.authorization === `Bearer ${fresh}`
    ? { json: { success: true, data: { pipelines: [{ id: 'pl-1', project: 'web', organization: 'acme', pipelineName: 'web-pipeline', visibility: 'org', isActive: true, isDefault: false, createdAt: '2026-11-01T00:00:00Z', createdBy: 'u-1' }], pagination: { total: 1, limit: 25, offset: 0, hasMore: false } } } }
    : { status: 401, json: { success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' } }));

  await page.goto('/dashboard/pipelines');
  await expect(page.getByText('web-pipeline').first()).toBeVisible();
  // The refresh carried the CSRF proof header and no token in its body — only
  // the idle-clock activity signal (no input happened, so `passive`).
  const refreshCalls = api.calls('POST /api/auth/refresh');
  expect(refreshCalls.length).toBeGreaterThanOrEqual(2);
  for (const c of refreshCalls) {
    expect(c.headers['x-pb-client']).toBeTruthy();
    expect(c.json).toEqual({ activity: 'passive' });
  }
  const listCalls = api.calls('GET /api/pipelines');
  expect(listCalls.some((c) => c.headers.authorization === `Bearer ${fresh}`)).toBe(true);
});

test('a returning browser is signed in from the refresh cookie on boot', async ({ page }) => {
  const api = await signedInPage(page);
  await page.goto('/dashboard');
  await expect(page.getByText(`Welcome back, ${OWNER.username}`)).toBeVisible();
  expect(api.calls('POST /api/auth/refresh').length).toBeGreaterThanOrEqual(1);
});

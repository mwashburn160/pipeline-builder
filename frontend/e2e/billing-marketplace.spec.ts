// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The money paths a buyer lands on from OUTSIDE the app:
 *  - the hosted-Checkout return (`/dashboard/usage?tab=billing&checkout=success`): the
 *    page says it is activating, polls the subscription until the webhook has
 *    provisioned it, and strips `?checkout=` so a reload does not re-toast;
 *    `?checkout=cancelled` says nothing changed;
 *  - AWS Marketplace fulfillment (`/marketplace/register`): a plain GET has no
 *    token and says to start again from AWS (the token is never read from the
 *    query string); a buyer back from sign-up with the registration ref stashed
 *    links it to their org and lands on billing.
 */

import { test, expect } from '@playwright/test';
import { signedInPage, stubBackend } from './support/backend';

const PLAN = { id: 'plan-pro', name: 'Pro', description: 'For teams', tier: 'pro', prices: { monthly: 4900, annual: 49000 }, features: [], isDefault: false, sortOrder: 2 };
const SUBSCRIPTION = {
  id: 'sub-1', orgId: 'org-1', planId: 'plan-pro', planName: 'Pro', tier: 'pro', status: 'active', interval: 'monthly',
  currentPeriodStart: '2026-11-01T00:00:00Z', currentPeriodEnd: '2026-12-01T00:00:00Z', cancelAtPeriodEnd: false,
  dunning: null, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
};

test('checkout success says it is activating and strips the outcome', async ({ page }) => {
  const api = await signedInPage(page);
  api.on('GET /api/billing/plans', { json: { success: true, data: { plans: [PLAN], total: 1 } } });
  api.on('GET /api/billing/subscriptions', { json: { success: true, data: { subscription: SUBSCRIPTION } } });
  // The URL the billing service builds for Checkout's success_url.
  await page.goto('/dashboard/usage?tab=billing&checkout=success');
  await expect(page.getByText('Checkout complete — activating your subscription…')).toBeVisible();
  // Stripped straight away, so a reload does not re-toast; the tab stays.
  await expect(page).not.toHaveURL(/checkout=/);
  await expect(page).toHaveURL(/\/dashboard\/usage\?tab=billing/);
  expect(api.pageErrors).toEqual([]);
});

// Regression: the app shell re-keyed on the session first loading (anon → user),
// remounting the page and killing the activation poll after one read.
test('checkout success keeps polling until the webhook provisions the subscription', async ({ page }) => {
  const api = await signedInPage(page);
  api.on('GET /api/billing/plans', { json: { success: true, data: { plans: [PLAN], total: 1 } } });
  let polls = 0;
  // The webhook "lands" on the third read.
  api.on('GET /api/billing/subscriptions', () => {
    polls += 1;
    return { json: { success: true, data: { subscription: polls >= 3 ? SUBSCRIPTION : null } } };
  });
  await page.goto('/dashboard/usage?tab=billing&checkout=success');
  await expect(page.getByText('Checkout complete — activating your subscription…')).toBeVisible();
  await expect.poll(() => polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
});

test('checkout cancelled says nothing changed', async ({ page }) => {
  const api = await signedInPage(page);
  api.on('GET /api/billing/plans', { json: { success: true, data: { plans: [PLAN], total: 1 } } });
  api.on('GET /api/billing/subscriptions', { json: { success: true, data: { subscription: SUBSCRIPTION } } });
  await page.goto('/dashboard/usage?tab=billing&checkout=cancelled');
  await expect(page.getByText('Checkout cancelled — no changes were made.')).toBeVisible();
  await expect(page).not.toHaveURL(/checkout=/);
});

test('marketplace register: a GET carries no token and says to start from AWS', async ({ page }) => {
  const api = await stubBackend(page);
  await page.goto('/marketplace/register?token=should-be-ignored');
  await expect(page.getByText(/No AWS Marketplace registration token was provided/)).toBeVisible();
  expect(api.calls('POST /api/billing/marketplace/claim')).toHaveLength(0);
});

test('marketplace register: a stashed ref is linked to the signed-in org', async ({ page }) => {
  const api = await signedInPage(page);
  api.on('POST /api/billing/marketplace/claim', { json: { success: true, data: { linked: true } } });
  await page.addInitScript(() => {
    // Once per tab, as the fulfillment page's own stash would be.
    try {
      if (!sessionStorage.getItem('e2e.stashed')) {
        sessionStorage.setItem('e2e.stashed', '1');
        sessionStorage.setItem('pb_marketplace_ref', JSON.stringify({ registrationRef: 'ref-123', planName: 'Team' }));
      }
    } catch { /* blocked */ }
  });
  await page.goto('/marketplace/register');
  await expect(page.getByText('Team')).toBeVisible();
  await page.getByRole('button', { name: 'Link to Acme' }).click();
  await expect(page).toHaveURL(/\/dashboard\/billing/);
  expect(api.calls('POST /api/billing/marketplace/claim')[0].json).toEqual({ registrationRef: 'ref-123' });
  // Claimed exactly once: the dashboard's pending-claim hook finds nothing left.
  await page.waitForLoadState('networkidle');
  expect(api.calls('POST /api/billing/marketplace/claim')).toHaveLength(1);
});

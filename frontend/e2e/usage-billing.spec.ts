// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Usage & billing (`/dashboard/usage`), as an org owner on Pro: the Quotas tab
 * shows each quota's usage against its limit; the Billing tab's four sections
 * (Overview, Plans, Add-ons, Billing history) render the stubbed subscription,
 * plan catalogue, add-on and event log; and both levels of tabs keep the URL
 * (`?tab=`, `?section=`) in step — including straight from a link. The Checkout
 * return paths are billing-marketplace.spec.ts's.
 */

import { test, expect } from '@playwright/test';
import { signedInPage } from './support/backend';
import { stubBilling } from './support/fixtures/billing';

test('Quotas tab shows usage against each limit', async ({ page }) => {
  const api = await signedInPage(page);
  stubBilling(api);
  await page.goto('/dashboard/usage');

  const tabs = page.getByRole('tablist', { name: 'Usage and billing sections' });
  await expect(tabs.getByRole('tab')).toHaveText(['Quotas', 'Billing']);
  await expect(tabs.getByRole('tab', { name: 'Quotas' })).toHaveAttribute('aria-selected', 'true');
  const quotas = page.getByRole('tabpanel', { name: 'Quotas' });
  // The stub's `GET /quota`: pipelines 14 of 1,000, registry 1 GB of 10 GB.
  await expect(quotas.getByRole('heading', { name: 'Pipelines', level: 3 })).toBeVisible();
  // (The figures are split across elements, so read the panel's text.)
  await expect(quotas).toContainText(/Pipelines created this period\s*Healthy\s*14\s*\/\s*1,000\s*986 remaining/);
  await expect(quotas).toContainText(/1\.0 GB\s*\/\s*10 GB\s*9\.0 GB remaining/);
  await expect(quotas.getByRole('heading', { name: 'What used this' })).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

test('Billing sections render and switching tabs keeps ?tab= and ?section= in step', async ({ page }) => {
  const api = await signedInPage(page);
  stubBilling(api);
  await page.goto('/dashboard/usage?tab=quotas');

  await page.getByRole('tab', { name: 'Billing', exact: true }).click();
  await expect(page).toHaveURL(/[?&]tab=billing/);
  const billing = page.getByRole('tabpanel', { name: 'Billing' });
  const sections = billing.getByRole('tablist', { name: 'Billing sections' });
  await expect(sections.getByRole('tab')).toHaveText(['Overview', 'Plans', 'Add-ons', 'Billing history']);

  // Overview: the current subscription.
  await expect(billing.getByRole('heading', { name: 'Current subscription' })).toBeVisible();
  await expect(billing.getByText('Active', { exact: true })).toBeVisible();
  await expect(billing.getByRole('button', { name: 'Manage billing' })).toBeVisible();

  // Plans: the catalogue, the current one marked and not re-selectable.
  await sections.getByRole('tab', { name: 'Plans' }).click();
  await expect(page).toHaveURL(/[?&]section=plans/);
  await expect(billing.getByRole('button', { name: 'Current Plan' })).toBeDisabled();
  await expect(billing.getByRole('button', { name: 'Switch to this plan' })).toBeEnabled();
  await expect(billing.getByText('$49.00')).toBeVisible();

  // Add-ons: the stackable pack, nothing to add until a quantity is chosen.
  await sections.getByRole('tab', { name: 'Add-ons' }).click();
  await expect(page).toHaveURL(/[?&]section=addons/);
  await expect(billing.getByRole('heading', { name: 'Build minutes pack' })).toBeVisible();
  await expect(billing.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await billing.getByRole('button', { name: 'Add one more 500 credits' }).click();
  await expect(billing.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();

  // Billing history: the event log loads on demand, from the org's own feed.
  await sections.getByRole('tab', { name: 'Billing history' }).click();
  await expect(page).toHaveURL(/[?&]section=history/);
  expect(api.calls('GET /api/billing/events')).toHaveLength(0);
  await billing.getByRole('button', { name: 'View events' }).click();
  await expect(billing.getByText('Credit applied')).toBeVisible();
  expect(api.calls('GET /api/billing/events')).toHaveLength(1);

  // Back to Quotas drops the billing-only `section` key.
  await page.getByRole('tab', { name: 'Quotas' }).click();
  await expect(page).toHaveURL(/[?&]tab=quotas/);
  await expect(page).not.toHaveURL(/section=/);
  expect(api.pageErrors).toEqual([]);
});

test('a link straight to a billing section opens it', async ({ page }) => {
  const api = await signedInPage(page);
  stubBilling(api);
  await page.goto('/dashboard/usage?tab=billing&section=addons');
  await expect(page.getByRole('tab', { name: 'Billing', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Add-ons' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Build minutes pack' })).toBeVisible();
});

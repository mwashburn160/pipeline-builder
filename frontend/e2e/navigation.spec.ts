// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The regrouped navigation (src/lib/nav.ts), as the platform operator who sees
 * all of it:
 *  - the sidebar's sections in order (Home, Build, Run, Insights, Organization,
 *    Platform), Build and Run pinned open, sub-pages (`paletteOnly`) left out;
 *  - Platform's sub-groups (Tenants, Catalog, Commerce, Operations), each
 *    collapsible, the state kept across a reload and re-opened when the
 *    current page is inside it;
 *  - Account items in the avatar menu and Help items in the help menu;
 *  - ⌘K finding pages that moved off the rail (Quotas, Teams) and a page by
 *    its Platform sub-group's name.
 * A tenant owner sees no Platform section at all.
 */

import { test, expect, type Page } from '@playwright/test';
import { OWNER, SYSADMIN, signedInPage } from './support/backend';

const rail = (page: Page) => page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Dashboard', exact: true }) });

test('sidebar sections and Platform sub-groups, in order', async ({ page }) => {
  const api = await signedInPage(page, SYSADMIN);
  await page.goto('/dashboard');
  const nav = rail(page);
  await expect(nav.getByRole('link', { name: 'Platform settings' })).toBeVisible();

  await expect(nav).toMatchAriaSnapshot(`
    - navigation:
      - button "Home" [expanded]
      - link "Dashboard"
      - link "Inbox"
      - link "My services"
      - link "Support"
      - text: Build
      - link "Pipelines"
      - link "Templates"
      - link "Plugins"
      - link "Publisher"
      - text: Run
      - link "Deployments"
      - link "Executions"
      - link "Builds"
      - link "Logs"
      - link "Observability"
      - button "Insights" [expanded]
      - link "Reports"
      - link "Compliance"
      - link "Audit log"
      - button "Organization" [expanded]
      - link "Members"
      - link "Usage & billing"
      - link "Org settings"
      - button "Platform" [expanded]
      - button "Tenants" [expanded]
      - link "All organizations"
      - link "All users"
      - button "Catalog" [expanded]
      - link "Registry"
      - link "Toolchain"
      - link "Ecosystem"
      - link "Plugin retention"
      - link "Runner signing keys"
      - button "Commerce" [expanded]
      - link "Billing admin"
      - link "Campaigns"
      - link "Discounts"
      - link "Promotions"
      - link "Offers"
      - button "Operations" [expanded]
      - link "Support queue"
      - link "Cascade outbox"
      - link "Platform settings"
  `);
  // Build and Run are pinned: a heading, not a toggle.
  await expect(nav.getByRole('button', { name: 'Build' })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: 'Run' })).toHaveCount(0);
  // Sub-pages are reached from their parent page (or ⌘K), not the rail; and
  // the Account / Help entries live in the top-bar menus.
  for (const name of ['Quotas', 'Teams', 'Roles', 'Invitations', 'Billing', 'Alerts', 'SSO roster', 'Profile', 'Security', 'Help', 'Downloads']) {
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  // The current page is marked.
  await expect(nav.getByRole('link', { name: 'Dashboard', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(api.pageErrors).toEqual([]);
});

test('a tenant owner sees no Platform section', async ({ page }) => {
  await signedInPage(page, OWNER);
  await page.goto('/dashboard');
  const nav = rail(page);
  await expect(nav.getByRole('link', { name: 'Members' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Platform' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Platform settings' })).toHaveCount(0);
});

test('Platform sub-groups collapse, persist across a reload and re-open for the current page', async ({ page }) => {
  await signedInPage(page, SYSADMIN);
  await page.goto('/dashboard');
  const nav = rail(page);

  // Collapse Catalog: its five rows go, the toggle shows how many it hides.
  await nav.getByRole('button', { name: 'Catalog' }).click();
  await expect(nav.getByRole('button', { name: 'Catalog 5' })).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByRole('link', { name: 'Registry' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Billing admin' })).toBeVisible();

  // Collapse the whole Platform section: every sub-group goes with it.
  await nav.getByRole('button', { name: 'Platform', exact: true }).click();
  await expect(nav.getByRole('button', { name: /^Platform \d+$/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByRole('button', { name: 'Commerce' })).toHaveCount(0);

  // Both stay collapsed after a reload.
  await page.reload();
  await expect(nav.getByRole('link', { name: 'Members' })).toBeVisible();
  await expect(nav.getByRole('button', { name: /^Platform \d+$/ })).toHaveAttribute('aria-expanded', 'false');

  // Arriving on a page inside them opens the section and the group again.
  await page.goto('/dashboard/registry');
  await expect(nav.getByRole('link', { name: 'Registry' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('button', { name: 'Catalog', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('button', { name: 'Platform', exact: true })).toHaveAttribute('aria-expanded', 'true');
});

test('the avatar menu holds Account, the help menu holds Help', async ({ page }) => {
  await signedInPage(page, SYSADMIN);
  await page.goto('/dashboard');

  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const account = page.getByRole('menu', { name: 'Account menu' });
  await expect(account.getByRole('menuitem')).toHaveText(['Profile', 'Security', 'Notification preferences', /mode$/, 'Sign out']);
  // Escape closes it, back on its trigger.
  await page.keyboard.press('Escape');
  await expect(account).toBeHidden();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeFocused();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await account.getByRole('menuitem', { name: 'Security' }).click();
  await expect(page).toHaveURL(/\/dashboard\/security$/);
  await expect(account).toBeHidden();

  await page.getByRole('button', { name: 'Help and resources' }).click();
  const help = page.getByRole('menu', { name: 'Help and resources' });
  // The help section's pages, then the keyboard-shortcuts overlay.
  await expect(help.getByRole('menuitem')).toHaveText(['Help', 'API catalog', 'Downloads', 'Keyboard shortcuts']);
  // Focus starts on the first item; the arrow keys move through it (wrapping).
  await expect(help.getByRole('menuitem', { name: 'Help', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(help.getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(help.getByRole('menuitem', { name: 'API catalog' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/api-catalog$/);
});

test('⌘K finds pages that moved off the rail', async ({ page }) => {
  await signedInPage(page, SYSADMIN);
  await page.goto('/dashboard');
  // The shortcut is bound once the shell has hydrated.
  await expect(rail(page).getByRole('link', { name: 'Members' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const palette = page.getByRole('dialog', { name: 'Command palette' });

  // Quotas is now a tab of Usage & billing.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill('quotas');
  await palette.getByRole('option', { name: 'Go to Quotas' }).click();
  await expect(page).toHaveURL(/\/dashboard\/usage\?tab=quotas$/);
  await expect(palette).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Quotas' })).toHaveAttribute('aria-selected', 'true');

  // Teams is a tab of Members; reached with the keyboard alone.
  await page.keyboard.press('ControlOrMeta+k');
  await palette.getByRole('combobox').fill('teams');
  const teams = palette.getByRole('option', { name: 'Go to Teams' });
  await expect(teams).toBeVisible();
  while (await teams.getAttribute('aria-selected') !== 'true') await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/members\?tab=teams$/);
  await expect(page.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');

  // A Platform sub-group's name finds its pages.
  await page.keyboard.press('ControlOrMeta+k');
  await palette.getByRole('combobox').fill('commerce');
  await expect(palette.getByRole('option', { name: 'Go to Discounts' })).toBeVisible();
  await expect(palette.getByRole('option', { name: 'Go to Registry' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the a11y walk and the screenshot specs open:
 *  - {@link SYSADMIN_NAV_PAGES}: every nav entry the stub's operator can see,
 *    derived from the ONE nav definition (`src/lib/nav.ts`) with the same
 *    visibility check the sidebar and ⌘K apply — the rail, the Platform
 *    sub-groups, the avatar and help menus, and the ⌘K-only tab entries. A page
 *    added to the nav is scanned without touching this suite.
 *  - the main modals, each opened the way a person opens it.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { NAV_SECTIONS, isNavItemVisible, type NavItem } from '../../src/lib/nav';
import { SYSADMIN, signedInPage, ok, type Backend } from './backend';
import { PIPELINE } from './fixtures/deploys';
import { listOf, pluginRow } from './fixtures/plugins';

export interface NavPage {
  title: string;
  /** Section label, plus the sub-group within it (`Platform / Catalog`). */
  where: string;
  href: string;
  paletteOnly: boolean;
}

const sysadminCtx = {
  isAdmin: true,
  isSuperAdmin: true,
  isSystemOrg: true,
  billingEnabled: true,
  hasPermission: () => true,
  isFeatureEnabled: () => true,
};

export const SYSADMIN_NAV_PAGES: NavPage[] = (() => {
  const seen = new Set<string>();
  const out: NavPage[] = [];
  for (const section of NAV_SECTIONS) {
    for (const item of section.items as NavItem[]) {
      if (!isNavItemVisible(item, sysadminCtx) || seen.has(item.href)) continue;
      seen.add(item.href);
      out.push({ title: item.title, where: item.group ? `${section.label} / ${item.group}` : section.label, href: item.href, paletteOnly: !!item.paletteOnly });
    }
  }
  return out;
})();

/** Wait until a dashboard page has rendered past its loading shell and settled. */
export async function settle(page: Page): Promise<void> {
  await expect(page.locator('main').first()).toBeVisible();
  await expect(page.locator('main h1, main [role="heading"][aria-level="1"]').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  // Late reads, then any running CSS/WAAPI transition (reduced motion makes them instant).
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

export interface OpenedModal { api: Backend; dialog: Locator }

const PIPELINES = ok({ pipelines: [PIPELINE], pagination: { total: 1, limit: 25, offset: 0, hasMore: false } });

/** Pipelines → a row's "Delete pipeline". */
export async function openDeletePipeline(page: Page): Promise<OpenedModal> {
  const api = await signedInPage(page);
  api.on('GET /api/pipelines', PIPELINES);
  await page.goto('/dashboard/pipelines');
  await page.getByRole('row', { name: new RegExp(PIPELINE.pipelineName) }).getByRole('button', { name: 'Delete pipeline' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete pipeline' });
  await expect(dialog).toBeVisible();
  return { api, dialog };
}

/** Plugins → a row's "Delete plugin". */
export async function openDeletePlugin(page: Page): Promise<OpenedModal> {
  const api = await signedInPage(page);
  api.on('GET /api/plugins', listOf([pluginRow()]));
  await page.goto('/dashboard/plugins');
  await page.getByRole('row', { name: /cdk-lint/ }).getByRole('button', { name: 'Delete plugin' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'cdk-lint' });
  await expect(dialog).toBeVisible();
  return { api, dialog };
}

export const ADMIN_SUBSCRIPTION = {
  id: 'sub-acme', orgId: 'org-acme', planId: 'plan-team', planName: 'Team', tier: 'pro', status: 'active', interval: 'annual',
  currency: 'usd', supportFloorOverride: null,
  currentPeriodStart: '2026-11-01T00:00:00Z', currentPeriodEnd: '2027-11-01T00:00:00Z', cancelAtPeriodEnd: false,
  dunning: null, createdAt: '2026-01-10T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};

/** Billing admin → a subscription's "Support floor". */
export async function openSupportFloor(page: Page): Promise<OpenedModal> {
  const api = await signedInPage(page, SYSADMIN);
  api.on('GET /api/billing/admin/subscriptions', ok({ subscriptions: [ADMIN_SUBSCRIPTION], total: 1, limit: 25, offset: 0 }));
  await page.goto('/dashboard/admin/billing');
  await page.getByRole('row', { name: /org-acme/ }).getByRole('button', { name: 'Support floor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Support floor' });
  await expect(dialog).toBeVisible();
  return { api, dialog };
}

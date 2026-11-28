// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * axe-core scans against the stubbed backend: the public pages, EVERY
 * dashboard page the stub's system admin can reach from the nav (rail,
 * Platform sub-groups, avatar and help menus, ⌘K-only tab entries — see
 * support/pages.ts), and the main modals opened the way a person opens them.
 * A scan FAILS on any `serious` or `critical` violation (WCAG 2.x A/AA rules)
 * that is not on the known-findings list below.
 *
 * KNOWN_FINDINGS is a ratchet, not an exemption list: each entry is a product
 * finding that exists today, recorded so this suite gates NEW regressions while
 * the fix lands separately. Fixing one makes its entry stale, and a stale entry
 * fails the scan ("no longer present — remove it") so the list only shrinks.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SYSADMIN, signedInPage, stubBackend } from './support/backend';
import { SYSADMIN_NAV_PAGES, openDeletePipeline, openDeletePlugin, openSupportFloor, settle, type OpenedModal } from './support/pages';
import { openIdleWarning, openStepUp } from './support/fixtures/session';
import { openKmsConfig } from './support/fixtures/admin';
import { stubInbox } from './support/fixtures/inbox';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// The app honours prefers-reduced-motion (globals.css + MotionConfig), so a
// scan never catches an element half-way through its entrance fade — a
// mid-fade heading reads as a contrast failure that no user sees at rest.
test.use({ reducedMotion: 'reduce' });

/**
 * Rule ids with serious/critical findings in the product today, per scan name
 * (the test title after "axe: ", without the href). Each is a product fix
 * reported with its selector; remove the entry with the fix.
 */
//  - label-content-name-mismatch (WCAG 2.5.3 Label in Name), on EVERY signed-in
//    page: the header search button (`button[aria-label="Search and commands"]`)
//    shows "Search… ⌘K", and the avatar button (`button[aria-label="Account
//    menu"]`) shows the user's initials — neither visible text is in the name.
const SHELL: string[] = ['label-content-name-mismatch'];
const KNOWN_FINDINGS: Record<string, string[]> = {
  //  link-in-text-block (WCAG 1.4.1): "Have an account? Sign in" is set apart
  //  from the sentence by colour alone.
  register: ['link-in-text-block'],
  //  nested-interactive (WCAG 4.1.2): each conversation row
  //  (`div[data-message-id][role="button"]`) contains its own buttons.
  'Home › Messages': ['nested-interactive'],
  //  link-in-text-block: the "Alert destinations page" / "Alerts page" links
  //  (`a.text-brand.hover:underline`) in the intro copy — colour only, 1.34:1.
  'Run › Alert rules': ['link-in-text-block'],
  'Run › Alert destinations': ['link-in-text-block'],
  //  color-contrast (WCAG 1.4.3): `.opacity-80` caption text, 4.2:1.
  'Insights › Compliance': ['color-contrast'],
  //  aria-valid-attr-value (WCAG 4.1.2): the join-requests tab
  //  `#join-requests-tab-pending` has aria-controls="join-requests-panel-pending"
  //  but no element carries that id.
  'Organization › Org settings': ['aria-valid-attr-value'],
  //  color-contrast: the empty state's `.p-6` copy (3.45:1) and its
  //  `.text-fg-subtle` line (2.81:1).
  'Platform / Catalog › Registry': ['color-contrast'],
  //  color-contrast: the `.btn-outline` copy button on the dark code block
  //  (#475569 on #101828, 2.34:1); scrollable-region-focusable (WCAG 2.1.1):
  //  the help article's `.overflow-x-auto` data tables and `pre` blocks
  //  scroll but cannot take focus.
  'Help › Help': ['color-contrast', 'scrollable-region-focusable'],
  //  color-contrast: the same `.btn-outline` on the install command block.
  'Help › Downloads': ['color-contrast'],
};

function known(name: string, signedIn: boolean): Set<string> {
  return new Set([...(signedIn ? SHELL : []), ...(KNOWN_FINDINGS[name] ?? [])]);
}

async function scan(page: Page, name: string, signedIn: boolean, include?: Locator) {
  let builder = new AxeBuilder({ page }).withTags(WCAG)
    // Next's dev-mode overlay is not the app.
    .exclude('nextjs-portal');
  if (include) {
    // A modal is scanned on its own: the page under it is scanned elsewhere.
    const id = await include.evaluate((el) => {
      el.setAttribute('data-axe-scope', '1');
      return '[data-axe-scope="1"]';
    });
    builder = builder.include(id);
  }
  const results = await builder.analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = blocking.map((v) => `${v.id} [${v.impact}] ×${v.nodes.length}: ${v.help} — ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(' | ')}`);
  if (summary.length) console.log(`axe ${name}:\n  ${summary.join('\n  ')}`);

  // A modal scan excludes the shell, so only the page's own findings apply.
  const expected = known(name, signedIn && !include);
  const found = new Set(blocking.map((v) => v.id));
  expect([...found].filter((id) => !expected.has(id)), `new serious/critical axe violations on ${name}:\n${summary.join('\n')}`).toEqual([]);
  expect([...expected].filter((id) => !found.has(id)), `known findings no longer present on ${name} — remove them from KNOWN_FINDINGS`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

const PUBLIC: { name: string; path: string; ready: (p: Page) => Locator }[] = [
  { name: 'landing / sign-in', path: '/', ready: (p) => p.getByRole('heading', { name: 'Sign in' }) },
  { name: 'register', path: '/auth/register', ready: (p) => p.getByRole('button', { name: /create account/i }).first() },
  { name: 'forgot password', path: '/auth/forgot-password', ready: (p) => p.getByRole('heading').first() },
  { name: 'verify email', path: '/auth/verify-email', ready: (p) => p.getByText('Verification failed') },
  { name: 'marketplace register', path: '/marketplace/register', ready: (p) => p.getByText(/No AWS Marketplace registration token/) },
];

for (const pc of PUBLIC) {
  test(`axe: ${pc.name}`, async ({ page }) => {
    await stubBackend(page);
    await page.goto(pc.path);
    await expect(pc.ready(page)).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    await scan(page, pc.name, false);
  });
}

// ---------------------------------------------------------------------------
// Every dashboard page in the nav
// ---------------------------------------------------------------------------

test('the walk covers every nav entry the sysadmin sees rendered', async ({ page }) => {
  await signedInPage(page, SYSADMIN);
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: 'Pipelines', exact: true })).toBeVisible();
  const walked = new Set(SYSADMIN_NAV_PAGES.map((p) => p.href));
  const rail = await page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Pipelines', exact: true }) })
    .locator('a[href^="/dashboard"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
  const menus: string[] = [];
  for (const name of ['Account menu', 'Help and resources']) {
    const trigger = page.getByRole('banner').getByRole('button', { name }).first();
    await trigger.click();
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    menus.push(...await menu.locator('a[href^="/dashboard"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!)));
    await page.keyboard.press('Escape');
  }
  // Quick actions (`?create=1`) open a modal on a page already walked.
  const pages = [...rail, ...menus].filter((h) => !h.includes('create=1'));
  expect(pages.length).toBeGreaterThan(30);
  expect(pages.filter((h) => !walked.has(h)), 'rendered nav entries missing from SYSADMIN_NAV_PAGES').toEqual([]);
});

for (const np of SYSADMIN_NAV_PAGES) {
  const name = `${np.where} › ${np.title}`;
  test(`axe: ${name} (${np.href})`, async ({ page }) => {
    const api = await signedInPage(page, SYSADMIN);
    if (np.href.startsWith('/dashboard/inbox')) stubInbox(api, SYSADMIN);
    await page.goto(np.href);
    await settle(page);
    await scan(page, name, true);
    expect(api.pageErrors).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

const MODALS: { name: string; open: (page: Page) => Promise<OpenedModal> }[] = [
  { name: 'step-up', open: openStepUp },
  { name: 'idle warning', open: openIdleWarning },
  { name: 'delete pipeline', open: openDeletePipeline },
  { name: 'delete plugin', open: openDeletePlugin },
  { name: 'KMS config', open: (page) => openKmsConfig(page) },
  { name: 'support floor', open: openSupportFloor },
];

for (const m of MODALS) {
  test(`axe: modal ${m.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    const { dialog } = await m.open(page);
    await page.waitForTimeout(400);
    await scan(page, `modal ${m.name}`, true, dialog);
  });
}

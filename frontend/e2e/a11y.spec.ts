// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * axe-core scans of the key pages (public and signed-in), against the stubbed
 * backend. A scan FAILS on any `serious` or `critical` violation (WCAG 2.x A/AA
 * rules) that is not on the known-findings list below.
 *
 * KNOWN_FINDINGS is a ratchet, not an exemption list: each entry is a finding
 * that exists today, recorded so this suite can gate NEW regressions while the
 * fix lands separately. Fixing one makes its entry stale, and a stale entry
 * fails the scan ("no longer present — remove it") so the list only shrinks.
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signedInPage, stubBackend } from './support/backend';

interface PageCase {
  name: string;
  path: string;
  signedIn: boolean;
  /** Something on the page that proves it rendered (not a loading shell). */
  ready: (page: Page) => ReturnType<Page['getByText']>;
}

const PAGES: PageCase[] = [
  { name: 'landing / sign-in', path: '/', signedIn: false, ready: (p) => p.getByRole('heading', { name: 'Sign in' }) },
  { name: 'register', path: '/auth/register', signedIn: false, ready: (p) => p.getByRole('button', { name: /create account/i }).first() },
  { name: 'forgot password', path: '/auth/forgot-password', signedIn: false, ready: (p) => p.getByRole('heading').first() },
  { name: 'verify email', path: '/auth/verify-email', signedIn: false, ready: (p) => p.getByText('Verification failed') },
  { name: 'marketplace register', path: '/marketplace/register', signedIn: false, ready: (p) => p.getByText(/No AWS Marketplace registration token/) },
  { name: 'dashboard home', path: '/dashboard', signedIn: true, ready: (p) => p.getByText('Generate a pipeline from Git') },
  { name: 'pipelines', path: '/dashboard/pipelines', signedIn: true, ready: (p) => p.getByRole('button', { name: 'Create pipeline' }).first() },
  { name: 'templates', path: '/dashboard/templates', signedIn: true, ready: (p) => p.getByRole('heading').first() },
  { name: 'billing', path: '/dashboard/usage?tab=billing', signedIn: true, ready: (p) => p.getByRole('heading').first() },
  { name: 'settings', path: '/dashboard/settings?tab=profile', signedIn: true, ready: (p) => p.getByRole('heading').first() },
];

/** `page name` → axe rule ids with serious/critical findings recorded on 2026-11-17. */
//  - label-content-name-mismatch (WCAG 2.5.3 Label in Name): DashboardLayout's
//    header search button shows "Search… ⌘K" but is named "Search and commands",
//    so a speech user saying "click Search" misses it — on EVERY signed-in page.
//    The dashboard home adds NewOrgWelcome's dismiss button (visible text vs
//    aria-label "Dismiss onboarding card").
//  - link-in-text-block (WCAG 1.4.1): register's "Have an account? Sign in" link
//    is distinguished from the sentence by colour alone (underline on hover only).
const SEARCH_BUTTON = 'label-content-name-mismatch';
const KNOWN_FINDINGS: Record<string, string[]> = {
  register: ['link-in-text-block'],
  'dashboard home': [SEARCH_BUTTON],
  pipelines: [SEARCH_BUTTON],
  templates: [SEARCH_BUTTON],
  billing: [SEARCH_BUTTON],
  settings: [SEARCH_BUTTON],
};

for (const pc of PAGES) {
  test(`axe: ${pc.name}`, async ({ page }) => {
    if (pc.signedIn) await signedInPage(page);
    else await stubBackend(page);
    await page.goto(pc.path);
    await expect(pc.ready(page)).toBeVisible();
    // Let entrance animations and late reads settle so the scan sees the page.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // Next's dev-mode overlay is not the app.
      .exclude('nextjs-portal')
      .analyze();
    const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    const summary = blocking.map((v) => `${v.id} [${v.impact}] ×${v.nodes.length}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    if (summary.length) console.log(`axe ${pc.name}:\n  ${summary.join('\n  ')}`);

    const known = new Set(KNOWN_FINDINGS[pc.name] ?? []);
    const found = new Set(blocking.map((v) => v.id));
    expect([...found].filter((id) => !known.has(id)), `new serious/critical axe violations on ${pc.name}`).toEqual([]);
    expect([...known].filter((id) => !found.has(id)), `known findings no longer present on ${pc.name} — remove them from KNOWN_FINDINGS`).toEqual([]);
  });
}

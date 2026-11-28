// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Visual regression: the app shell and the key pages, in light and dark, plus
 * a phone viewport (390×844) for the shell, the Inbox and a deploy in
 * progress. Runs in the `screenshots` project (playwright.config.ts).
 *
 * Deterministic by construction:
 *  - the browser clock is frozen at {@link NOW} (`page.clock.setFixedTime`:
 *    Date is fixed, timers still run), and the stub's tokens are minted at
 *    that same instant so the client never sees one expire;
 *  - every fixture date is fixed or relative to NOW, the time zone is UTC and
 *    the locale en-US (project `use`);
 *  - `<time>` elements (relative and absolute timestamps) are masked;
 *  - reduced motion, `animations: 'disabled'`, and support/screenshot.css
 *    (no transitions, no caret, no Next dev overlay).
 *
 * Baselines are LINUX renders — CI's OS — generated inside the Playwright
 * Docker image (see e2e/README.md). On any other OS the spec is skipped, since
 * a macOS render can never match them.
 */

import { test, expect, type Page } from '@playwright/test';
import { OWNER, SYSADMIN, fakeJwt, ok, signedInPage, stubBackend, type Backend, type StubUser } from './support/backend';
import { PIPELINE } from './support/fixtures/deploys';
import { deploy, stubDeployablePipeline } from './support/fixtures/deploys';
import { listOf, pluginRow } from './support/fixtures/plugins';
import { INBOX_NOW, stubInbox } from './support/fixtures/inbox';
import { OWNER_WITH_TEAM, stubMembers } from './support/fixtures/members';
import { stubBilling } from './support/fixtures/billing';
import { stubCascade, stubOrganizations } from './support/fixtures/admin';
import { settle } from './support/pages';

test.skip(process.platform !== 'linux', 'Screenshot baselines are Linux renders: run them in the Playwright Docker image (e2e/README.md).');

/** The frozen "now" every screenshot is taken at (the inbox fixtures' reference). */
const NOW = INBOX_NOW;
const NOW_S = Math.floor(NOW.getTime() / 1000);

/** Sign in as `user` with the browser clock frozen at {@link NOW}. */
async function frozen(page: Page, user: StubUser = OWNER): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const api = await signedInPage(page, user);
  api.on('POST /api/auth/refresh', ok({ accessToken: fakeJwt({ iat: NOW_S, exp: NOW_S + 3600, organizationId: user.organizationId }), expiresIn: 3600 }));
  return api;
}

/**
 * Relative times rendered as plain text ("1 hr. ago", "yesterday", "in 3 days")
 * rather than `<time>`: frozen by the clock already, masked so a wording change
 * in the formatter is not a visual regression.
 */
const RELATIVE_TIME = /^\s*(?:\d+\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?|mo|months?|y|yr|years?)\.?\s+ago|in\s+\d+\s*\w+\.?|just now|yesterday|today|tomorrow)\s*$/i;

async function shoot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(`${name}.png`, { mask: [page.locator('time'), page.getByText(RELATIVE_TIME)] });
}

const PIPELINES = ok({ pipelines: [PIPELINE, { ...PIPELINE, id: '55555555-5555-4555-8555-555555555556', project: 'api', pipelineName: 'acme-api-pipeline', visibility: 'private' }], pagination: { total: 2, limit: 25, offset: 0, hasMore: false } });

/** A deploy part-way through, as the pipeline page shows it. */
function deployInProgress(api: Backend) {
  const srv = stubDeployablePipeline(api, {
    latest: deploy({ requestId: 'rq-shot', status: 'deploying', stage: 'synthesizing', acceptedAt: '2026-11-27T08:59:30Z', requestedAt: '2026-11-27T08:59:00Z', deadlineAt: '2099-01-01T00:00:00Z' }),
  });
  srv.poll('rq-shot');
  return srv;
}

interface Shot { name: string; open: (page: Page) => Promise<void> }

const PAGES: Shot[] = [
  { name: 'sign-in', open: async (page) => { await page.clock.setFixedTime(NOW); await stubBackend(page); await page.goto('/'); await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible(); await page.waitForLoadState('networkidle'); } },
  { name: 'shell-home', open: async (page) => { await frozen(page); await page.goto('/dashboard'); await settle(page); } },
  { name: 'pipelines', open: async (page) => { const api = await frozen(page); api.on('GET /api/pipelines', PIPELINES); await page.goto('/dashboard/pipelines'); await settle(page); await expect(page.getByRole('link', { name: 'acme-api-pipeline' })).toBeVisible(); } },
  { name: 'pipeline-deploy-status', open: async (page) => { const api = await frozen(page); deployInProgress(api); await page.goto(`/dashboard/pipelines/${PIPELINE.id}`); await settle(page); const panel = page.getByText('Deploy through a pipeline runner').first(); await panel.scrollIntoViewIfNeeded(); await expect(page.getByText('Synthesizing').first()).toBeInViewport(); } },
  { name: 'plugins', open: async (page) => { const api = await frozen(page); api.on('GET /api/plugins', listOf([pluginRow(), pluginRow({ id: '44444444-4444-4444-8444-444444444445', name: 'node-build', version: '2.3.1', category: 'language', description: 'Build Node apps' })])); await page.goto('/dashboard/plugins'); await settle(page); await expect(page.getByRole('button', { name: 'node-build' })).toBeVisible(); } },
  { name: 'templates', open: async (page) => { await frozen(page); await page.goto('/dashboard/templates'); await settle(page); } },
  { name: 'inbox-notifications', open: async (page) => { const api = await frozen(page); stubInbox(api); await page.goto('/dashboard/inbox?tab=notifications'); await settle(page); } },
  { name: 'inbox-messages', open: async (page) => { const api = await frozen(page); stubInbox(api); await page.goto('/dashboard/inbox?tab=messages'); await settle(page); } },
  { name: 'members', open: async (page) => { const api = await frozen(page, OWNER_WITH_TEAM); stubMembers(api); await page.goto('/dashboard/members?tab=members'); await settle(page); } },
  { name: 'usage-quotas', open: async (page) => { await frozen(page); await page.goto('/dashboard/usage?tab=quotas'); await settle(page); } },
  { name: 'usage-billing', open: async (page) => { const api = await frozen(page); stubBilling(api); await page.goto('/dashboard/usage?tab=billing&section=overview'); await settle(page); } },
  { name: 'settings-profile', open: async (page) => { await frozen(page); await page.goto('/dashboard/settings?tab=profile'); await settle(page); } },
  { name: 'security', open: async (page) => { await frozen(page); await page.goto('/dashboard/security'); await settle(page); } },
  { name: 'deployments', open: async (page) => { await frozen(page); await page.goto('/dashboard/deployments'); await settle(page); } },
  { name: 'admin-organizations', open: async (page) => { const api = await frozen(page, SYSADMIN); stubOrganizations(api); await page.goto('/dashboard/organizations'); await settle(page); await expect(page.getByRole('row', { name: /Acme/ })).toBeVisible(); } },
  { name: 'admin-cascade', open: async (page) => { const api = await frozen(page, SYSADMIN); stubCascade(api); await page.goto('/dashboard/admin/cascade'); await settle(page); } },
  { name: 'help', open: async (page) => { await frozen(page); await page.goto('/dashboard/help'); await settle(page); } },
];

/** Pages also shot at phone size. */
const MOBILE = new Set(['shell-home', 'inbox-notifications', 'pipeline-deploy-status']);

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const shot of PAGES) {
      test(`${shot.name}`, async ({ page }) => {
        await shot.open(page);
        await shoot(page, `${shot.name}-${scheme}`);
      });
    }
    test.describe('mobile', () => {
      test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      for (const shot of PAGES.filter((s) => MOBILE.has(s.name))) {
        test(`${shot.name}`, async ({ page }) => {
          await shot.open(page);
          await shoot(page, `${shot.name}-${scheme}-mobile`);
        });
      }
    });
  });
}

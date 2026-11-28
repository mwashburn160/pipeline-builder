// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The idle sign-out, on a faked clock (`page.clock`) against a refresh stub
 * that models the platform's idle clock (support/fixtures/session.ts):
 *  - no warning while more than 2 minutes are left; "Are you still there?"
 *    with a countdown once 2 minutes or less are;
 *  - "Stay signed in" reports activity (a refresh with `activity: 'user'`),
 *    closes the warning and moves the deadline;
 *  - left alone, the session is signed out at the deadline and the sign-in
 *    page says why ("Signed out after 15 minutes of inactivity.").
 */

import { test, expect } from '@playwright/test';
import { OWNER } from './support/backend';
import { IDLE_TIMEOUT_MINUTES, idleSignedInPage } from './support/fixtures/session';

const WARNING = 'Are you still there?';

test('the idle warning appears 2 minutes before the deadline and Stay signed in keeps the session', async ({ page }) => {
  const { api, idle } = await idleSignedInPage(page);
  await page.goto('/dashboard');
  await expect(page.getByText(`Welcome back, ${OWNER.username}`)).toBeVisible();
  const dialog = page.getByRole('dialog', { name: WARNING });

  // 2m30s left: still quiet. (No input reaches the page — fastForward is time, not a person.)
  await page.clock.fastForward(`${IDLE_TIMEOUT_MINUTES - 3}:30`);
  await expect(dialog).toBeHidden();

  // 1m50s left: the warning, with the countdown and the coarse spoken time.
  await page.clock.fastForward('00:40');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("You'll be signed out in 2 minutes for inactivity.")).toBeVisible();
  await expect(dialog.getByRole('timer', { name: 'Time left before sign-out' })).toHaveText(/^1:[45]\d$/);
  await expect(dialog.getByRole('button', { name: 'Stay signed in' })).toBeFocused();
  // Only the boot exchange so far, and it was not a person.
  expect(idle.activity()).toEqual(['passive']);

  await dialog.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => idle.activity().at(-1)).toBe('user');

  // The deadline moved: the old one passes without a warning or a sign-out.
  await page.clock.fastForward('03:00');
  await expect(dialog).toBeHidden();
  expect(idle.signedOut()).toBe(false);
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(api.pageErrors).toEqual([]);
});

test('an unanswered idle warning signs the session out and the sign-in page says why', async ({ page }) => {
  const { api, idle } = await idleSignedInPage(page);
  // What the sign-out tells this browser's other tabs (they land on the same explanation).
  const broadcasts: unknown[] = [];
  await page.exposeFunction('__e2eAuthBroadcast', (m: unknown) => { broadcasts.push(m); });
  await page.addInitScript(() => {
    const channel = new BroadcastChannel('pipeline-builder:auth');
    channel.onmessage = (e) => { (window as unknown as { __e2eAuthBroadcast: (m: unknown) => void }).__e2eAuthBroadcast(e.data); };
  });
  await page.goto('/dashboard/pipelines');
  await expect(page.getByRole('button', { name: 'Create pipeline' }).first()).toBeVisible();

  await page.clock.fastForward(`${IDLE_TIMEOUT_MINUTES - 2}:10`);
  const dialog = page.getByRole('dialog', { name: WARNING });
  await expect(dialog).toBeVisible();

  // Run out the clock: signed out for inactivity, in every tab, and on the sign-in page.
  await page.clock.fastForward('02:00');
  await expect.poll(() => idle.signedOut()).toBe(true);
  await expect.poll(() => broadcasts).toContainEqual({ type: 'signed-out', reason: 'idle', idleTimeoutMinutes: IDLE_TIMEOUT_MINUTES });
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(dialog).toBeHidden();
  // Nobody clicked: no refresh ever reported a person.
  expect(idle.activity().every((a) => a === 'passive')).toBe(true);

  // Landed by the sign-out itself — the guarded page's own bounce goes to the
  // same destination, so the reason survives the race.
  await expect(page).toHaveURL(new RegExp(`/\\?reason=idle&minutes=${IDLE_TIMEOUT_MINUTES}$`));
  await expect(page.getByRole('status').filter({ hasText: `Signed out after ${IDLE_TIMEOUT_MINUTES} minutes of inactivity.` })).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The global step-up dialog ("Confirm it's you") with the second factors — the
 * password path is in pipelines.spec.ts:
 *  - a passkey (a Chromium virtual authenticator) mints the step-up token and
 *    the refused write is replayed ONCE with `X-Step-Up-Token`;
 *  - an authenticator-app code does the same, after a wrong code is refused
 *    in place with the server's words (and nothing replayed);
 *  - Cancel closes the dialog, replays nothing, and the page says the action
 *    did not happen.
 */

import { test, expect } from '@playwright/test';
import { STEP_UP_TOKEN, TOTP_REFUSAL, addVirtualPasskey, openStepUp } from './support/fixtures/session';

test('a passkey confirms the step-up and the refused write is replayed once', async ({ page }) => {
  const { api, dialog } = await openStepUp(page);
  const { credentialId } = await addVirtualPasskey(page, api);
  // Opens on the strongest factor the account holds.
  await expect(dialog.getByRole('button', { name: 'Use a passkey' })).toBeFocused();

  await dialog.getByRole('button', { name: 'Use a passkey' }).click();

  await expect.poll(() => api.calls('POST /api/pipelines').length).toBe(2);
  await expect(dialog).toBeHidden();
  const [refused, replayed] = api.calls('POST /api/pipelines');
  expect(refused.headers['x-step-up-token']).toBeUndefined();
  expect(replayed.headers['x-step-up-token']).toBe(STEP_UP_TOKEN);
  expect(replayed.json).toEqual(refused.json);
  // The assertion the browser produced for the stubbed challenge.
  const verify = api.calls('POST /api/auth/step-up/webauthn/verify')[0].json as { ceremonyId: string; response: { id: string; type: string } };
  expect(verify.ceremonyId).toBe('cer-1');
  expect(verify.response).toMatchObject({ id: credentialId, type: 'public-key' });
  await expect(page.getByText('Confirmed — the action completed.')).toBeVisible();
  await expect(page.getByText('Pipeline created successfully!')).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

test('an authenticator code confirms the step-up; a wrong one is refused in place', async ({ page }) => {
  const { api, dialog } = await openStepUp(page);
  const code = dialog.getByLabel('Authentication code');
  const verify = dialog.getByRole('button', { name: 'Verify' });
  await expect(verify).toBeDisabled();

  await code.fill('000000');
  await verify.click();
  await expect(dialog.getByText(TOTP_REFUSAL)).toBeVisible();
  // A refused code mints nothing, so nothing is replayed.
  expect(api.calls('POST /api/pipelines')).toHaveLength(1);
  await expect(dialog).toBeVisible();

  await code.fill('123456');
  await verify.click();
  await expect(dialog).toBeHidden();
  const totpCalls = api.calls('POST /api/auth/step-up/totp').map((c) => c.json);
  expect(totpCalls.at(-1)).toEqual({ code: '123456' });
  expect(totpCalls.slice(0, -1).every((b) => (b as { code: string }).code === '000000')).toBe(true);
  await expect.poll(() => api.calls('POST /api/pipelines').length).toBe(2);
  expect(api.calls('POST /api/pipelines')[1].headers['x-step-up-token']).toBe(STEP_UP_TOKEN);
  await expect(page.getByText('Pipeline created successfully!')).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

test('cancelling the step-up replays nothing and the action is reported as not done', async ({ page }) => {
  const { api, dialog } = await openStepUp(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // The refusal surfaces in the dialog that made the write, which stays open.
  const create = page.getByRole('dialog', { name: 'Create pipeline' });
  await expect(create).toBeVisible();
  await expect(create.getByText('Confirm it is you to create a pipeline.')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(api.calls('POST /api/pipelines')).toHaveLength(1);
  for (const key of ['POST /api/auth/step-up', 'POST /api/auth/step-up/totp', 'POST /api/auth/step-up/webauthn/verify']) {
    expect(api.calls(key)).toHaveLength(0);
  }
  await expect(page.getByText('Pipeline created successfully!')).toHaveCount(0);
  expect(api.pageErrors).toEqual([]);
});

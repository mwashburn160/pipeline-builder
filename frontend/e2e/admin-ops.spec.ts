// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform operations, as the operator (system org, superadmin):
 *  - the KMS runner-key re-wrap retry: an org whose last KMS change left its
 *    runner signing keys un-re-wrapped holds back Save / Clear and offers a
 *    retry. The retry asks for a SECOND factor (no password option); a retry
 *    that fails again says the cause is still there and keeps the hold, one
 *    that succeeds reports the counts and lifts it;
 *  - the cascade outbox redrive: a dead leg is redriven through the step-up
 *    (reset attempts, a reason for the audit log), the POST carries both and
 *    the step-up token, and the re-read row is pending again.
 */

import { test, expect } from '@playwright/test';
import { SYSADMIN, ok, signedInPage } from './support/backend';
import { ACME_ID, openKmsConfig, stubCascade, stubKmsConfig } from './support/fixtures/admin';

const REWRAP = `POST /api/admin/orgs/${ACME_ID}/kms-config/runner-keys/reencrypt`;

test.describe('KMS runner-key re-wrap', () => {
  test('a failed re-wrap is retried behind a second factor until it succeeds', async ({ page }) => {
    const { api, dialog } = await openKmsConfig(page, { rewrapPending: true });
    const kms = stubKmsConfig(api, { rewrapPending: true });
    let attempts = 0;
    api.on(REWRAP, () => {
      attempts += 1;
      if (attempts === 1) return { status: 500, json: { success: false, message: 'pipeline service unreachable' } };
      kms.rewrapPending = false;
      return ok({ runnerKeysReencrypted: 3, runnerKeysScanned: 3 });
    });
    let tokens = 0;
    api.on('POST /api/auth/step-up/totp', () => ok({ ok: true, stepUpToken: `su-totp-${++tokens}`, expiresAt: Date.now() + 60_000, method: 'totp', via: 'totp', recoveryCodesRemaining: 8 }));

    // The hold: Save and Clear are refused until the re-wrap finishes.
    const pending = dialog.getByRole('alert', { name: 'Runner-key re-wrap pending' });
    await expect(pending).toBeVisible();
    await dialog.getByLabel('KMS key id / alias').fill('alias/pb-org-acme-2');
    await dialog.getByLabel('Wrapped master (base64)').fill('AQICAHiexample');
    await expect(dialog.getByRole('button', { name: 'Save & re-encrypt' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Clear' })).toBeDisabled();

    const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
    const confirmWithCode = async (code: string) => {
      await expect(stepUp).toBeVisible();
      // A second factor only: no password field on a KMS route.
      await expect(stepUp.getByPlaceholder('Password')).toHaveCount(0);
      await stepUp.getByLabel('Authentication code').fill(code);
      await stepUp.getByRole('button', { name: 'Verify' }).click();
      await expect(stepUp).toBeHidden();
    };

    // First retry: the cause is still there.
    await pending.getByRole('button', { name: 'Retry runner-key re-wrap' }).click();
    await confirmWithCode('123456');
    await expect.poll(() => api.calls(REWRAP).length).toBe(1);
    expect(api.calls(REWRAP)[0].headers['x-step-up-token']).toBe('su-totp-1');
    expect(api.calls('POST /api/auth/step-up/totp')[0].json).toEqual({ code: '123456' });
    await expect(dialog.getByText('Runner-key re-wrap failed again, so its cause is still present: pipeline service unreachable')).toBeVisible();
    await expect(pending).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save & re-encrypt' })).toBeDisabled();

    // Second retry, with a fresh token: done, and changes are allowed again.
    await pending.getByRole('button', { name: 'Retry runner-key re-wrap' }).click();
    await confirmWithCode('654321');
    await expect.poll(() => api.calls(REWRAP).length).toBe(2);
    expect(api.calls(REWRAP)[1].headers['x-step-up-token']).toBe('su-totp-2');
    await expect(dialog.getByRole('status').filter({ hasText: 'Re-wrapped' })).toHaveText('Re-wrapped 3 of 3 runner signing keys. KMS changes are allowed again.');
    await expect(pending).toBeHidden();
    await expect(dialog.getByText('Runner-key re-wrap failed again')).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Save & re-encrypt' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Clear' })).toBeEnabled();
    expect(api.pageErrors).toEqual([]);
  });

  test('cancelling the second-factor prompt sends no retry', async ({ page }) => {
    const { api, dialog } = await openKmsConfig(page, { rewrapPending: true });
    await dialog.getByRole('button', { name: 'Retry runner-key re-wrap' }).click();
    const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
    await stepUp.getByRole('button', { name: 'Cancel' }).click();
    await expect(stepUp).toBeHidden();
    await expect(dialog.getByRole('alert', { name: 'Runner-key re-wrap pending' })).toBeVisible();
    expect(api.calls(REWRAP)).toHaveLength(0);
  });
});

test('redrive a dead cascade leg', async ({ page }) => {
  const api = await signedInPage(page, SYSADMIN);
  stubCascade(api);
  api.on('POST /api/auth/step-up', ok({ ok: true, stepUpToken: 'su-pw', expiresAt: Date.now() + 60_000, method: 'password' }));
  await page.goto('/dashboard/admin/cascade');

  const dead = page.getByRole('row', { name: /Org purge .* billing Dead 8 HTTP 503 · billing unavailable/ });
  await expect(dead).toBeVisible();
  // A delivered leg has nothing to redrive.
  await expect(page.getByRole('row', { name: /pipeline Done/ }).getByRole('button', { name: 'Redrive' })).toHaveCount(0);

  // Only the dead legs, then redrive.
  await page.getByLabel('Filter by state').selectOption('dead');
  await expect.poll(() => api.calls('GET /api/admin/cascade').at(-1)?.query.get('status')).toBe('dead');
  await expect(page.getByRole('row', { name: /pipeline Done/ })).toHaveCount(0);
  await dead.getByRole('button', { name: 'Redrive' }).click();

  const confirm = page.getByRole('dialog', { name: 'Redrive the billing leg?' });
  await expect(confirm.getByText(`Redrive the billing leg of Org purge ${ACME_ID}`)).toBeVisible();
  await expect(confirm.getByRole('checkbox', { name: /Reset attempts/ })).toBeChecked();
  await confirm.getByLabel(/Reason/).fill('billing redeployed');
  await confirm.getByPlaceholder('Password').fill('correct horse battery');
  await confirm.getByRole('button', { name: 'Confirm' }).click();

  await expect.poll(() => api.calls('POST /api/admin/cascade/leg-billing/redrive').length).toBe(1);
  const call = api.calls('POST /api/admin/cascade/leg-billing/redrive')[0];
  expect(call.json).toEqual({ resetAttempts: true, reason: 'billing redeployed' });
  expect(call.headers['x-step-up-token']).toBe('su-pw');
  await expect(page.getByText('Cascade leg to billing queued for redelivery')).toBeVisible();
  await expect(confirm).toBeHidden();

  // The re-read: no longer dead, so the dead filter is empty; all states shows it pending.
  await expect(page.getByText('No cascade legs')).toBeVisible();
  await page.getByLabel('Filter by state').selectOption('all');
  await expect(page.getByRole('row', { name: /Org purge .* billing Pending 0/ })).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

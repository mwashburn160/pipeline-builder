// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipelines page's Recently deleted tab, against the stubbed backend:
 *  - a tombstone past its purge date that is still deployed says it is kept
 *    ("Kept: still deployed …"), one inside its window shows the date;
 *  - purging the deployed one re-verifies the password (the dialog says the
 *    runner will remove its stack), POSTs the purge with the step-up token,
 *    drops the row and reports the undeploy it started;
 *  - a purge the server refuses because the stack would stay in the account
 *    is explained above the list, and the row stays.
 */

import { test, expect, type Page } from '@playwright/test';
import { signedInPage, type Backend } from './support/backend';
import { API, OLD, WEB } from './support/fixtures/deleted';

async function openDeleted(page: Page, api: Backend) {
  api.on('GET /api/pipelines/deleted', { json: { success: true, data: { pipelines: [WEB, API, OLD] } } });
  api.on('POST /api/auth/step-up', { json: { success: true, data: { ok: true, stepUpToken: 'su-purge', expiresAt: Date.now() + 300_000, method: 'password' } } });
  await page.goto('/dashboard/pipelines');
  await page.getByRole('tab', { name: 'Recently deleted' }).click();
  await expect(page.getByRole('heading', { name: 'Recently deleted' })).toBeVisible();
}

const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });

async function confirmPassword(page: Page) {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await stepUp.getByPlaceholder('Password').fill('correct horse battery');
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

test('a still-deployed tombstone says it is kept, and purging it removes the stack through its runner', async ({ page }) => {
  const api = await signedInPage(page);
  api.on(`POST /api/pipelines/${WEB.id}/purge`, { json: { success: true, data: { undeploy: { requestId: 'rq-undeploy', runnerLabel: 'prod' }, stackRetained: null } } });
  await openDeleted(page, api);

  // The Purges column: why the sweep keeps the deployed rows, the date for the other.
  await expect(page.getByTestId(`pipeline-purge-date-${WEB.id}`)).toHaveText('Kept: still deployed. Purge it to remove the stack.');
  await expect(page.getByTestId(`pipeline-purge-date-${API.id}`)).toHaveText('Kept: still deployed. Remove its stack and deregister it, then purge it.');
  await expect(page.getByTestId(`pipeline-purge-date-${OLD.id}`)).toHaveText(/2099/);
  await expect(page.getByText('Showing 3 deleted pipelines')).toBeVisible();

  await row(page, 'acme-web-pipeline').getByRole('button', { name: 'Purge' }).click();
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp.getByText(/PERMANENTLY delete the pipeline "acme-web-pipeline"/)).toBeVisible();
  await expect(stepUp.getByTestId('pipeline-stack-notice')).toContainText('prod');
  await confirmPassword(page);

  await expect.poll(() => api.calls(`POST /api/pipelines/${WEB.id}/purge`).length).toBe(1);
  expect(api.calls(`POST /api/pipelines/${WEB.id}/purge`)[0].headers['x-step-up-token']).toBe('su-purge');
  await expect(row(page, 'acme-web-pipeline')).toHaveCount(0);
  await expect(page.getByTestId('pipeline-purge-result')).toContainText('prod was asked to delete its stack');
  await expect(page.getByText('Showing 2 deleted pipelines')).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

test('a purge refused because the stack would stay deployed is explained, and the row stays', async ({ page }) => {
  const api = await signedInPage(page);
  api.on(`POST /api/pipelines/${API.id}/purge`, {
    status: 409,
    json: { success: false, code: 'PIPELINE_STACK_RETAINED', message: 'The stack is still deployed', details: { stackName: 'acme-api-pipeline', region: 'eu-west-1', stackRetainedReason: 'no_runner' } },
  });
  await openDeleted(page, api);

  await row(page, 'acme-api-pipeline').getByRole('button', { name: 'Purge' }).click();
  await confirmPassword(page);

  const result = page.getByTestId('pipeline-purge-result');
  await expect(result).toContainText('Not purged: acme-api-pipeline (eu-west-1) is still deployed.');
  await expect(result).toContainText('No pipeline runner is linked to it');
  await expect(row(page, 'acme-api-pipeline')).toHaveCount(1);
  await expect(page.getByText('Showing 3 deleted pipelines')).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

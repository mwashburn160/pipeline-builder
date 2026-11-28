// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin upload, end to end against the stubbed backend: the Upload tab takes
 * a package, shows what the dry-run inspect detected, POSTs it, follows the
 * queued build's SSE log (ticket first) to completion, closes, and the list
 * now carries the new plugin. A build whose final attempt fails says so and
 * offers Retry, which returns to the upload form.
 */

import { test, expect, type Page } from '@playwright/test';
import { signedInPage, type Backend } from './support/backend';
import { INSPECT_RESULT, listOf, pluginRow, streamBuildLog } from './support/fixtures/plugins';

const PACKAGE = { name: 'cdk-lint-1.2.0.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004 stub package') };

async function openUpload(page: Page, api: Backend) {
  api.on('POST /api/plugins/inspect', { json: { success: true, data: INSPECT_RESULT } });
  api.on('POST /api/plugins/upload', { status: 202, json: { success: true, statusCode: 202, data: { requestId: 'rq-build-1', pluginName: 'cdk-lint', version: '1.2.0' } } });
  await page.goto('/dashboard/plugins');
  await page.getByRole('button', { name: 'Upload Plugin' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create plugin' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Select a file').setInputFiles(PACKAGE);
  await expect(dialog.getByText('cdk-lint-1.2.0.zip')).toBeVisible();
  // The Catalog details step shows what the package declares.
  await expect(dialog.getByRole('heading', { name: 'Catalog details' })).toBeVisible();
  await expect(dialog.getByText('v1.2.0')).toBeVisible();
  expect(api.calls('POST /api/plugins/inspect')).toHaveLength(1);
  return dialog;
}

test('upload a plugin, follow its build to completion, and find it listed', async ({ page }) => {
  const api = await signedInPage(page);
  let built = false;
  api.on('GET /api/plugins', () => listOf(built ? [pluginRow()] : []));
  await streamBuildLog(page, 'rq-build-1', [
    { type: 'INFO', message: 'Build queued' },
    { type: 'INFO', message: 'Building image org-1/cdk-lint:1.2.0' },
    { type: 'COMPLETED', message: 'Plugin cdk-lint@1.2.0 deployed' },
  ]);
  // The build "runs" once its log stream is asked for.
  api.on('POST /api/plugins/logs/ticket', () => { built = true; return { json: { success: true, data: { ticket: 't-1' } } }; });

  const dialog = await openUpload(page, api);
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();

  await expect(dialog.getByText('Building image org-1/cdk-lint:1.2.0')).toBeVisible();
  await expect(dialog.getByText('Plugin deployed successfully!')).toBeVisible();
  expect(api.calls('POST /api/plugins/upload')).toHaveLength(1);
  expect(api.calls('POST /api/plugins/logs/ticket')[0].json).toMatchObject({ requestId: 'rq-build-1' });

  // It closes itself and the list re-reads with the new plugin in it.
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText('cdk-lint').first()).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

test('a build whose final attempt fails says why and offers Retry', async ({ page }) => {
  const api = await signedInPage(page);
  api.on('GET /api/plugins', listOf([]));
  await streamBuildLog(page, 'rq-build-1', [
    { type: 'INFO', message: 'Build queued' },
    { type: 'ERROR', message: 'Dockerfile step 3 failed: exit code 2', data: { attemptsMade: 3, maxAttempts: 3 } },
  ]);
  api.on('POST /api/plugins/logs/ticket', { json: { success: true, data: { ticket: 't-1' } } });
  const dialog = await openUpload(page, api);
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();

  await expect(dialog.getByText('Dockerfile step 3 failed: exit code 2').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry' }).click();
  // Back to a fresh upload form; nothing was listed.
  await expect(dialog.getByLabel('Select a file')).toBeAttached();
  await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
  expect(api.pageErrors).toEqual([]);
});

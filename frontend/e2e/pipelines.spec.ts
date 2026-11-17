// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline authoring and the step-up replay, in a real browser:
 *  - the Wizard (form builder) assembles a pipeline across its three steps and
 *    the page POSTs exactly that to `/api/pipelines`;
 *  - a write the server refuses with STEP_UP_REQUIRED opens the global
 *    "Confirm it's you" dialog; confirming with the password mints a step-up
 *    token and the SAME write is replayed once with `X-Step-Up-Token`.
 */

import { test, expect, type Page } from '@playwright/test';
import { signedInPage } from './support/backend';

const PROPS = {
  project: 'web', organization: 'acme',
  synth: { source: { type: 'github', options: { repo: 'acme/web' } }, plugin: { name: 'cdk-synth' } },
};

async function openCreate(page: Page) {
  await page.goto('/dashboard/pipelines');
  await page.getByRole('button', { name: 'Create pipeline' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Create pipeline' })).toBeVisible();
}

test('create a pipeline through the form builder', async ({ page }) => {
  const api = await signedInPage(page);
  api.on('POST /api/pipelines', { status: 201, json: { success: true, data: { inserted: true, pipeline: { id: 'pl-new' } } } });
  await openCreate(page);
  const dialog = page.getByRole('dialog', { name: 'Create pipeline' });
  await dialog.getByRole('tab', { name: 'Wizard' }).click();

  // Step 1 refuses to advance empty, inline.
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByText('Project is required')).toBeVisible();
  await dialog.getByLabel('Project *').fill('web');
  await dialog.getByLabel('Organization *').fill('acme');
  await expect(dialog.getByLabel('Pipeline name')).toHaveValue('acme-web-pipeline');
  await dialog.getByRole('button', { name: 'Next' }).click();

  // Step 2: source + synth plugin.
  await dialog.getByLabel('Repository *').fill('acme/web');
  await dialog.getByLabel('Branch').fill('main');
  await dialog.getByLabel('Plugin Name *').fill('cdk-synth');
  await dialog.getByRole('button', { name: 'Next' }).click();

  // Step 3: one stage with one step (the stages disclosure opens collapsed).
  await dialog.getByText('Pipeline Stages (0)').click();
  await dialog.getByRole('button', { name: '+ Add Stage' }).click();
  await dialog.getByLabel('Stage name *').fill('Deploy');
  await dialog.getByLabel('Step plugin Name *').fill('cdk-deploy');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  await expect.poll(() => api.calls('POST /api/pipelines').length).toBe(1);
  const body = api.calls('POST /api/pipelines')[0].json as Record<string, any>;
  expect(body).toMatchObject({ project: 'web', organization: 'acme', pipelineName: 'acme-web-pipeline', visibility: 'org' });
  expect(body.props.synth).toMatchObject({ source: { type: 'github', options: { repo: 'acme/web', branch: 'main' } }, plugin: { name: 'cdk-synth' } });
  expect(body.props.stages[0]).toMatchObject({ stageName: 'Deploy', steps: [{ plugin: { name: 'cdk-deploy' } }] });
  await expect(page.getByText('Pipeline created successfully!')).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

test('a step-up refusal prompts for the password and replays the write', async ({ page }) => {
  const api = await signedInPage(page);
  api.on('POST /api/pipelines', (call) => (call.headers['x-step-up-token'] === 'su-1'
    ? { status: 201, json: { success: true, data: { inserted: true, pipeline: { id: 'pl-new' } } } }
    : { status: 401, json: { success: false, code: 'STEP_UP_REQUIRED', message: 'Confirm it is you' } }));
  api.on('POST /api/auth/step-up', { json: { success: true, data: { ok: true, stepUpToken: 'su-1', expiresAt: Date.now() + 300_000, method: 'password' } } });

  await openCreate(page);
  const dialog = page.getByRole('dialog', { name: 'Create pipeline' });
  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await dialog.getByLabel('Pipeline Props (JSON)').fill(JSON.stringify(PROPS));
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByPlaceholder('Password').fill('correct horse battery');
  await stepUp.getByRole('button', { name: 'Confirm' }).click();

  await expect.poll(() => api.calls('POST /api/pipelines').length).toBe(2);
  const [refused, replayed] = api.calls('POST /api/pipelines');
  expect(refused.headers['x-step-up-token']).toBeUndefined();
  expect(replayed.headers['x-step-up-token']).toBe('su-1');
  expect(replayed.json).toEqual(refused.json);
  expect(api.calls('POST /api/auth/step-up')[0].json).toMatchObject({ password: 'correct horse battery' });
  await expect(stepUp).toBeHidden();
});

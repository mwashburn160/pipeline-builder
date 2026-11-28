// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Register deployment from a pipeline's own page, in a real browser: the
 * banner opens the dialog in place, it asks to register with the org's only
 * pipeline runner, POSTs that runner's id, then follows the link probe until
 * the runner found the pipeline.
 */

import { test, expect } from '@playwright/test';
import { signedInPage } from './support/backend';

const PIPELINE_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const PIPELINE = {
  id: PIPELINE_ID, orgId: 'org-1', project: 'axum', organization: 'system', pipelineName: 'system-axum_rust-pipeline',
  description: '', keywords: [], props: {}, visibility: 'org', isActive: true, isDefault: false,
  ownerId: 'u-1', ownerType: 'user', createdBy: 'u-1', createdAt: '2026-11-01T00:00:00Z', updatedBy: 'u-1', updatedAt: '2026-11-01T00:00:00Z',
};
const ok = (data: unknown) => ({ json: { success: true, data } });

test('register a deployed pipeline with its only runner, and see it linked', async ({ page }) => {
  const api = await signedInPage(page);
  // Deployed another way (it has reported), registration gone.
  api.on(`GET /api/pipelines/${PIPELINE_ID}`, ok({ pipeline: PIPELINE, registration: { registered: false, hasEvents: true, lastDeployed: null, stackName: null, region: null } }));
  api.on(`GET /api/pipelines/${PIPELINE_ID}/register-runners`, ok({
    pipelineId: PIPELINE_ID, available: true, unavailableReason: null, registered: false, hasEvents: true, linkedRunnerId: null,
    runners: [{ id: RUNNER_ID, label: 'default', isOwn: true, ownerOrgName: null, regions: ['us-east-1'], health: 'healthy' }],
  }));
  let registered = false;
  api.on('POST /api/pipelines/registry', () => { registered = true; return ok({ registry: { id: 'reg-1', pipelineId: PIPELINE_ID }, runnerLink: 'checking' }); });
  api.on(`GET /api/pipelines/${PIPELINE_ID}/runner-link`, () => (registered
    ? ok({ pipelineId: PIPELINE_ID, status: 'linked', runner: { id: RUNNER_ID, label: 'default', health: 'healthy', lastDeliveryAt: null, ownerOrgName: null, isOwn: true, capabilities: [] }, checkedAt: '2026-11-27T00:00:00Z', detail: null, deliveriesPaused: false })
    : { status: 404, json: { success: false, message: 'Pipeline is not registered.' } }));

  await page.goto(`/dashboard/pipelines/${PIPELINE_ID}`);
  await expect(page.getByText('Deployed but not registered.')).toBeVisible();
  await page.getByRole('button', { name: 'Register deployment' }).click();

  const dialog = page.getByRole('dialog', { name: 'Register deployment' });
  await expect(dialog.getByText('Register system-axum_rust-pipeline with the pipeline runner default?')).toBeVisible();
  await expect(dialog.getByLabel(/Region/)).toHaveValue('us-east-1');
  await dialog.getByRole('button', { name: 'Register with default' }).click();

  await expect.poll(() => api.calls('POST /api/pipelines/registry').length).toBe(1);
  expect(api.calls('POST /api/pipelines/registry')[0].json).toMatchObject({ pipelineId: PIPELINE_ID, runnerId: RUNNER_ID, region: 'us-east-1' });
  await expect(dialog.getByText('Registered and linked to default.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  expect(api.pageErrors).toEqual([]);
});

test('a never-deployed pipeline is steered to Deploy', async ({ page }) => {
  const api = await signedInPage(page);
  api.on(`GET /api/pipelines/${PIPELINE_ID}`, ok({ pipeline: PIPELINE, registration: { registered: false, hasEvents: false, lastDeployed: null, stackName: null, region: null } }));
  api.on(`GET /api/pipelines/${PIPELINE_ID}/register-runners`, ok({
    pipelineId: PIPELINE_ID, available: true, unavailableReason: null, registered: false, hasEvents: false, linkedRunnerId: null,
    runners: [{ id: RUNNER_ID, label: 'default', isOwn: true, ownerOrgName: null, regions: ['us-east-1'], health: 'healthy' }],
  }));

  await page.goto(`/dashboard/pipelines/${PIPELINE_ID}`);
  await expect(page.getByText('Not deployed yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Register deployment' }).click();

  const dialog = page.getByRole('dialog', { name: 'Register deployment' });
  await expect(dialog.getByText('This pipeline is not deployed yet.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Register with default' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Deploy it instead' }).click();
  await expect(dialog).toBeHidden();
  expect(api.calls('POST /api/pipelines/registry')).toHaveLength(0);
});

test('Run on a registered pipeline with no runner linked asks which runner, and runs through it', async ({ page }) => {
  const api = await signedInPage(page);
  api.on(`GET /api/pipelines/${PIPELINE_ID}`, ok({ pipeline: PIPELINE, registration: { registered: true, hasEvents: true, lastDeployed: null, stackName: null, region: null } }));
  api.on(`GET /api/pipelines/${PIPELINE_ID}/runner-link`, ok({ pipelineId: PIPELINE_ID, status: 'unlinked', runner: null, checkedAt: null, detail: null, deliveriesPaused: false }));
  api.on(`GET /api/pipelines/${PIPELINE_ID}/register-runners`, ok({
    pipelineId: PIPELINE_ID, available: true, unavailableReason: null, registered: true, hasEvents: true, linkedRunnerId: null,
    runners: [
      { id: RUNNER_ID, label: 'default', isOwn: true, ownerOrgName: null, regions: ['us-east-1'], health: 'healthy' },
      { id: '33333333-3333-4333-8333-333333333333', label: 'prod', isOwn: true, ownerOrgName: null, regions: ['us-east-1'], health: 'healthy' },
    ],
  }));
  api.on(`POST /api/pipelines/${PIPELINE_ID}/executions`, { status: 202, json: { success: true, data: { requestId: 'rq-1', status: 'queued', runnerLabel: 'prod' } } });

  await page.goto(`/dashboard/pipelines/${PIPELINE_ID}`);
  await page.getByRole('button', { name: /Run pipeline|Re-run/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Run pipeline' });
  await dialog.getByLabel('prod').check();
  await dialog.getByRole('button', { name: 'Run with prod' }).click();

  await expect.poll(() => api.calls(`POST /api/pipelines/${PIPELINE_ID}/executions`).length).toBe(1);
  expect(api.calls(`POST /api/pipelines/${PIPELINE_ID}/executions`)[0].json).toEqual({ runnerId: '33333333-3333-4333-8333-333333333333' });
  await expect(dialog).toBeHidden();
});

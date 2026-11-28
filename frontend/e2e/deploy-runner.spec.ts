// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deploying a never-deployed pipeline through a pipeline runner, from its own
 * page, against the stubbed backend:
 *  - pick one of several runners (a non-deployable one is offered disabled),
 *    confirm it's you, and the start carries the step-up token, runner and
 *    region; the deploy is followed through its stages and can be cancelled;
 *  - a failed deploy (resumed on mount) explains itself and its log hint, and
 *    "Retry on <runner>" deploys again on the same runner to Deployed.
 */

import { test, expect } from '@playwright/test';
import { signedInPage } from './support/backend';
import { PIPELINE_ID, RUNNER_DEFAULT, RUNNER_PROD, deploy, stubDeployablePipeline } from './support/fixtures/deploys';

test('pick a runner, follow the deploy through its stages, and cancel it', async ({ page }) => {
  const api = await signedInPage(page);
  const srv = stubDeployablePipeline(api);
  srv.poll('rq-d1');
  api.on(`POST ${srv.path}/deploys`, () => {
    srv.deploys.set('rq-d1', deploy({ requestId: 'rq-d1', status: 'deploying', stage: 'synthesizing', acceptedAt: '2026-11-27T10:00:05Z', deadlineAt: '2099-01-01T00:00:00Z' }));
    return { status: 202, json: { success: true, data: { requestId: 'rq-d1', status: 'queued', runnerLabel: 'prod', region: 'us-east-1', reused: false } } };
  });
  api.on(`POST ${srv.path}/deploys/rq-d1/cancel`, () => {
    const d = srv.deploys.get('rq-d1')!;
    // Accepted: the running build stops, and the next read reports it cancelled.
    srv.deploys.set('rq-d1', { ...d, status: 'cancelled', errorCode: 'DEPLOY_CANCELLED', failureClass: 'cancelled', retryable: true, finishedAt: '2026-11-27T10:01:00Z' });
    return { json: { success: true, data: d } };
  });

  await page.goto(`/dashboard/pipelines/${PIPELINE_ID}`);
  const panel = page.getByTestId('deploy-pipeline-panel');
  await expect(panel.getByRole('heading', { name: 'Deploy through a pipeline runner' })).toBeVisible();

  // Several deployable runners: nothing is pre-picked; the outdated one is offered disabled.
  const runner = panel.getByLabel('Pipeline runner');
  await expect(runner.locator('option', { hasText: 'legacy' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: /^Deploy to/ })).toHaveCount(0);
  await runner.selectOption({ label: 'prod' });
  await panel.getByRole('button', { name: 'Deploy to prod (us-east-1)' }).click();

  const stepUp = page.getByRole('dialog', { name: 'Deploy to prod (us-east-1)?' });
  await expect(stepUp).toBeVisible();
  await stepUp.getByPlaceholder('Password').fill('correct horse battery');
  await stepUp.getByRole('button', { name: 'Confirm' }).click();

  await expect.poll(() => api.calls(`POST ${srv.path}/deploys`).length).toBe(1);
  const start = api.calls(`POST ${srv.path}/deploys`)[0];
  expect(start.json).toEqual({ runnerId: RUNNER_PROD, region: 'us-east-1' });
  expect(start.headers['x-step-up-token']).toBe('su-deploy');
  await expect(stepUp).toBeHidden();

  // Progress: queued from the 202, then the polled stage.
  const progress = panel.getByTestId('deploy-progress');
  await expect(progress.getByText('Deploying:')).toBeVisible();
  await expect(progress.getByRole('listitem').filter({ hasText: 'Synthesizing' })).toHaveAttribute('aria-current', 'step');
  await expect(progress.getByRole('listitem').filter({ hasText: 'Fetching the pipeline' })).not.toHaveAttribute('aria-current', 'step');

  await progress.getByRole('button', { name: 'Cancel deploy' }).click();
  await expect(progress.getByText('Cancel requested: the runner is stopping the build.')).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Cancel deploy' })).toBeDisabled();
  expect(api.calls(`POST ${srv.path}/deploys/rq-d1/cancel`)).toHaveLength(1);

  // The next read says it stopped; it can be started again on the same runner.
  const ended = panel.getByTestId('deploy-failure');
  await expect(ended.getByText('The deploy was cancelled.')).toBeVisible();
  await expect(ended.getByRole('button', { name: 'Retry on prod' })).toBeVisible();
  await expect(ended.getByRole('button', { name: 'Change runner' })).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

test('a failed deploy explains itself, and Retry deploys again on its runner', async ({ page }) => {
  const api = await signedInPage(page);
  const failed = deploy({
    requestId: 'rq-old', runnerId: RUNNER_DEFAULT, runnerLabel: 'default', status: 'failed', stage: 'starting',
    errorCode: 'DEPLOY_GRANT_EXPIRED', failureClass: 'platform', retryable: true, finishedAt: '2026-11-27T09:30:00Z',
    logHint: { logGroup: '/aws/codebuild/pb-deploy', buildId: 'pb-deploy:42', project: 'pb-deploy' },
  });
  const srv = stubDeployablePipeline(api, { latest: failed });
  srv.poll('rq-d2');
  api.on(`POST ${srv.path}/deploys`, () => {
    srv.deploys.set('rq-d2', deploy({ requestId: 'rq-d2', runnerId: RUNNER_DEFAULT, runnerLabel: 'default', status: 'deployed', stage: 'done', finishedAt: '2026-11-27T10:05:00Z' }));
    return { status: 202, json: { success: true, data: { requestId: 'rq-d2', status: 'queued', runnerLabel: 'default', region: 'us-east-1', reused: false } } };
  });

  await page.goto(`/dashboard/pipelines/${PIPELINE_ID}`);
  const panel = page.getByTestId('deploy-pipeline-panel');
  const failure = panel.getByTestId('deploy-failure');
  await expect(failure.getByText('The deploy job started too late to use its credential.')).toBeVisible();
  await expect(failure.getByTestId('deploy-log-hint')).toHaveText(/log group \/aws\/codebuild\/pb-deploy, build pb-deploy:42/);
  await expect(failure.getByRole('listitem').filter({ hasText: 'Starting the build' }).first()).toBeVisible();

  await failure.getByRole('button', { name: 'Retry on default' }).click();
  const stepUp = page.getByRole('dialog', { name: 'Deploy to default (us-east-1)?' });
  await stepUp.getByPlaceholder('Password').fill('correct horse battery');
  await stepUp.getByRole('button', { name: 'Confirm' }).click();

  await expect.poll(() => api.calls(`POST ${srv.path}/deploys`).length).toBe(1);
  expect(api.calls(`POST ${srv.path}/deploys`)[0].json).toEqual({ runnerId: RUNNER_DEFAULT, region: 'us-east-1' });
  await expect(panel.getByText('Deployed to default (us-east-1).')).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});

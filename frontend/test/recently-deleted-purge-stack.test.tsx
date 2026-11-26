// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Purging a pipeline (change 5). Each Recently deleted row carries its
 * `deployment` (null = never registered), so the purge dialog states the ONE
 * true outcome for the stack: removed through its deploy-enabled runner, or
 * kept in the AWS account (remove it with cdk destroy / CloudFormation) — and
 * nothing for a pipeline that was never deployed. After the purge the panel
 * shows what happened (`undeploy` requested via the runner, or `stackRetained`
 * and why), and a refused purge (409, `details.stackRetainedReason`) says why
 * the stack blocks it. Other resources' purge dialogs carry no such notice.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ReactNode } from 'react';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RecentlyDeletedPanel } from '../src/components/RecentlyDeletedPanel';
import { ApiError, StepUpRequiredError } from '../src/lib/api/errors';

const listDeletedPipelines = jest.fn<AnyFn>();
const purgePipeline = jest.fn<AnyFn>();
const cancelPipelineDeploy = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listDeletedPipelines: (...a: unknown[]) => listDeletedPipelines(...a),
    purgePipeline: (...a: unknown[]) => purgePipeline(...a),
    cancelPipelineDeploy: (...a: unknown[]) => cancelPipelineDeploy(...a),
    listDeletedDashboards: async () => ({ success: true, data: { dashboards: [{ id: 'd1', name: 'Ops', visibility: 'org', createdBy: 'u1', deletedAt: '2026-11-19T10:00:00Z' }] } }),
    restorePipeline: jest.fn<AnyFn>(), purgeDashboard: jest.fn<AnyFn>(), restoreDashboard: jest.fn<AnyFn>(),
  },
}));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ details, onConfirmed }: { details?: ReactNode; onConfirmed: (t: string) => void }) => (
    <div data-testid="stepup-modal">{details}<button type="button" onClick={() => onConfirmed('tok')}>confirm-step-up</button></div>
  ),
}));
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const row = (deployment: unknown) => ({ id: 'p1', pipelineName: 'web', visibility: 'org', createdBy: 'u1', deletedAt: '2026-11-19T10:00:00Z', deployment });
const DEPLOYED_CAPABLE = { stackName: 'web-stack', region: 'us-east-1', runner: { id: 'r1', label: 'Production', capabilities: ['deploy:1'] }, stackRemovedOnPurge: true };
const DEPLOYED_KEPT = { stackName: 'web-stack', region: 'us-east-1', runner: { id: 'r1', label: 'Production', capabilities: [] }, stackRemovedOnPurge: false };

async function openPurge(deployment: unknown) {
  listDeletedPipelines.mockResolvedValue({ success: true, data: { pipelines: [row(deployment)] } });
  render(<RecentlyDeletedPanel resource="pipeline" />);
  fireEvent.click(await screen.findByRole('button', { name: /Purge/ }));
  return screen.findByTestId('stepup-modal');
}

beforeEach(() => { jest.clearAllMocks(); });

describe('RecentlyDeletedPanel — a pipeline purge names what happens to its stack', () => {
  it('removed through a deploy-enabled runner: only that outcome', async () => {
    await openPurge(DEPLOYED_CAPABLE);
    const note = await screen.findByTestId('pipeline-stack-notice');
    expect(note).toHaveTextContent(/Purging asks Production to delete the stack web-stack \(us-east-1\)/);
    expect(note).toHaveTextContent(/tagged for this pipeline/);
    expect(note).not.toHaveTextContent(/otherwise|stays in your AWS account/);
  });

  it('kept in the account: cdk destroy / CloudFormation, and no "if"', async () => {
    await openPurge(DEPLOYED_KEPT);
    const note = await screen.findByTestId('pipeline-stack-notice');
    expect(note).toHaveTextContent(/web-stack \(us-east-1\) stays in your AWS account/);
    expect(note).toHaveTextContent(/cdk destroy/);
    expect(note).not.toHaveTextContent(/If its runner/);
  });

  it('never deployed: no stack notice', async () => {
    await openPurge(null);
    expect(screen.queryByTestId('pipeline-stack-notice')).not.toBeInTheDocument();
  });

  it('deployment unknown (an older answer): both outcomes, stated plainly', async () => {
    await openPurge(undefined);
    const note = await screen.findByTestId('pipeline-stack-notice');
    expect(note).toHaveTextContent(/If this pipeline is deployed and its runner has deploys enabled/);
  });

  it('after the purge: the undeploy requested through the runner', async () => {
    purgePipeline.mockResolvedValue({ success: true, data: { undeploy: { requestId: 'u1', runnerLabel: 'Production' }, stackRetained: null } });
    await openPurge(DEPLOYED_CAPABLE);
    fireEvent.click(screen.getByText('confirm-step-up'));
    const result = await screen.findByTestId('pipeline-purge-result');
    expect(result).toHaveTextContent(/Production was asked to delete its stack/);
  });

  it('after the purge: the stack retained, and why', async () => {
    purgePipeline.mockResolvedValue({ success: true, data: { undeploy: null, stackRetained: { stackName: 'web-stack', region: 'us-east-1', reason: 'runner_not_deploy_capable' } } });
    await openPurge(DEPLOYED_KEPT);
    fireEvent.click(screen.getByText('confirm-step-up'));
    const result = await screen.findByTestId('pipeline-purge-result');
    expect(result).toHaveTextContent(/web-stack \(us-east-1\) stays in your AWS account/);
    expect(result).toHaveTextContent(/deploys are not enabled/);
    expect(result).toHaveTextContent(/cdk destroy/);
  });

  it('a purge refused because the stack is still deployed says why', async () => {
    purgePipeline.mockRejectedValue(new ApiError('still deployed', 409, 'CONFLICT', { stackName: 'web-stack', region: 'us-east-1', stackRetainedReason: 'no_runner' }));
    await openPurge(DEPLOYED_KEPT);
    fireEvent.click(screen.getByText('confirm-step-up'));
    const result = await screen.findByTestId('pipeline-purge-result');
    await waitFor(() => expect(result).toHaveTextContent(/Not purged/));
    expect(result).toHaveTextContent(/No pipeline runner is linked to it/);
    expect(result).toHaveTextContent(/cdk destroy/);
  });

  it('another resource: no stack notice', async () => {
    render(<RecentlyDeletedPanel resource="dashboard" />);
    fireEvent.click(await screen.findByRole('button', { name: /Purge/ }));
    await screen.findByTestId('stepup-modal');
    expect(screen.queryByTestId('pipeline-stack-notice')).not.toBeInTheDocument();
  });
});

describe('RecentlyDeletedPanel — a purge replayed after the global step-up dialog', () => {
  it('shows the REPLAY\'s stack outcome', async () => {
    const err = new StepUpRequiredError('Confirm it is you', 'STEP_UP_METHOD_REQUIRED');
    err.attachResume(Promise.resolve({ success: true, data: { undeploy: { requestId: 'u1', runnerLabel: 'Production' }, stackRetained: null } }));
    purgePipeline.mockRejectedValue(err);
    await openPurge(DEPLOYED_CAPABLE);
    fireEvent.click(screen.getByText('confirm-step-up'));
    const result = await screen.findByTestId('pipeline-purge-result');
    expect(result).toHaveTextContent(/Production was asked to delete its stack/);
  });

  it('a replay refused because the stack is still deployed says why', async () => {
    const err = new StepUpRequiredError('Confirm it is you', 'STEP_UP_METHOD_REQUIRED');
    const refusal = new ApiError('still deployed', 409, 'CONFLICT', { stackName: 'web-stack', region: 'us-east-1', stackRetainedReason: 'no_runner' });
    const replay = Promise.reject(refusal);
    replay.catch(() => {});
    err.attachResume(replay);
    purgePipeline.mockRejectedValue(err);
    await openPurge(DEPLOYED_KEPT);
    fireEvent.click(screen.getByText('confirm-step-up'));
    const result = await screen.findByTestId('pipeline-purge-result');
    expect(result).toHaveTextContent(/Not purged/);
  });
});

describe('RecentlyDeletedPanel — a purge refused while a runner deploy is in flight', () => {
  const inProgress = () => new ApiError('This pipeline is being deployed through a pipeline runner.', 409, 'DEPLOY_IN_PROGRESS', { requestId: 'dep-1' });

  it('says a deploy is running, and Cancel the deploy cancels it by its requestId', async () => {
    purgePipeline.mockRejectedValue(inProgress());
    cancelPipelineDeploy.mockResolvedValue({ success: true, data: { requestId: 'dep-1', status: 'cancelled' } });
    await openPurge(DEPLOYED_CAPABLE);
    fireEvent.click(screen.getByText('confirm-step-up'));
    const result = await screen.findByTestId('pipeline-purge-result');
    expect(result).toHaveTextContent(/being deployed through a pipeline runner/);
    fireEvent.click(screen.getByRole('button', { name: /Cancel the deploy/ }));
    await waitFor(() => expect(cancelPipelineDeploy).toHaveBeenCalledWith('p1', 'dep-1'));
    expect(await screen.findByText(/Cancel requested/)).toBeInTheDocument();
    // The row stays: nothing was purged.
    expect(screen.getByText('web')).toBeInTheDocument();
  });

  it('a refused cancel says so', async () => {
    purgePipeline.mockRejectedValue(inProgress());
    cancelPipelineDeploy.mockRejectedValue(new ApiError('It already finished.', 409, 'DEPLOY_NOT_CANCELLABLE'));
    await openPurge(DEPLOYED_CAPABLE);
    fireEvent.click(screen.getByText('confirm-step-up'));
    fireEvent.click(await screen.findByRole('button', { name: /Cancel the deploy/ }));
    expect(await screen.findByTestId('purge-cancel-deploy-error')).toBeInTheDocument();
  });

  it('the same on a step-up replay', async () => {
    const err = new StepUpRequiredError('Confirm it is you', 'STEP_UP_METHOD_REQUIRED');
    const replay = Promise.reject(inProgress());
    replay.catch(() => {});
    err.attachResume(replay);
    purgePipeline.mockRejectedValue(err);
    await openPurge(DEPLOYED_CAPABLE);
    fireEvent.click(screen.getByText('confirm-step-up'));
    const result = await screen.findByTestId('pipeline-purge-result');
    expect(result).toHaveTextContent(/being deployed through a pipeline runner/);
    expect(screen.getByRole('button', { name: /Cancel the deploy/ })).toBeInTheDocument();
  });
});

describe('RecentlyDeletedPanel — a pipeline tombstone the retention sweep keeps past its purge date', () => {
  const PAST = '2026-01-01T00:00:00Z';
  const FUTURE = '2999-06-15T12:00:00Z';
  async function renderRow(deployment: unknown, purgeAfter: string) {
    listDeletedPipelines.mockResolvedValue({ success: true, data: { pipelines: [{ ...row(deployment), purgeAfter }] } });
    render(<RecentlyDeletedPanel resource="pipeline" />);
    return screen.findByTestId('pipeline-purge-date-p1');
  }

  it('a still-deployed pipeline whose runner removes the stack says it is kept, not a past date', async () => {
    const cell = await renderRow(DEPLOYED_CAPABLE, PAST);
    expect(cell).toHaveTextContent('Kept: still deployed. Purge it to remove the stack.');
    expect(cell).not.toHaveTextContent(/2026/);
  });

  it('a still-deployed pipeline no runner can remove says to remove the stack first', async () => {
    const cell = await renderRow(DEPLOYED_KEPT, PAST);
    expect(cell).toHaveTextContent(/Kept: still deployed\. Remove its stack/);
  });

  it('a never-registered pipeline kept past its date is held by a deploy in flight', async () => {
    const cell = await renderRow(null, PAST);
    expect(cell).toHaveTextContent(/Kept: a deploy through a runner is in flight/);
  });

  it('a purge date still ahead is shown as the date', async () => {
    const cell = await renderRow(DEPLOYED_CAPABLE, FUTURE);
    expect(cell).toHaveTextContent(/2999/);
    expect(cell).not.toHaveTextContent(/Kept/);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DeployPipelinePanel — deploying a never-deployed pipeline through a pipeline
 * runner (GET …/deploy-targets, POST …/deploys behind step-up, then
 * GET …/deploys/:requestId until it settles):
 *  - none deployable: why (each eligible runner's reason) + the setup command
 *    and a link to Settings → Pipeline runners;
 *  - exactly one: pre-selected, one button "Deploy to <label> (<region>)" and
 *    the step-up dialog;
 *  - several: a dropdown of the runners, the non-deployable ones disabled with
 *    their reason, "shared by <org>", and a region select when the runner
 *    allows several;
 *  - progress: stage steps and Cancel; failure: the code's copy, next steps,
 *    the build's log location, Retry / Change runner when retryable;
 *  - resume: the latest deploy on mount, the targets' activeRequestId, and a
 *    DEPLOY_IN_PROGRESS refusal's requestId.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DEPLOY_SETUP_COMMAND } from '@pipeline-builder/api-core/pipeline-runners';
import { ApiError, StepUpRequiredError } from '../src/lib/api/errors';
import { PIPELINE_RUNNERS_HREF } from '../src/lib/pipeline-runners';
import { DEPLOY_ERROR_COPY } from '../src/lib/pipeline-deploys';

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, title }: { onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; title?: string }) => (
    <div data-testid="stepup-modal">
      <h2>{title}</h2>
      <button type="button" onClick={async () => { await onConfirmed('tok'); onClose(); }}>Confirm step-up</button>
      <button type="button" onClick={onClose}>Cancel step-up</button>
    </div>
  ),
}));

const api = {
  getDeployTargets: jest.fn<AnyFn>(),
  startPipelineDeploy: jest.fn<AnyFn>(),
  getPipelineDeploy: jest.fn<AnyFn>(),
  getLatestPipelineDeploy: jest.fn<AnyFn>(),
  cancelPipelineDeploy: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

import { DeployPipelinePanel } from '../src/components/pipeline/DeployPipelinePanel';

const runner = (over: Record<string, unknown> = {}) => ({
  id: 'r1', label: 'prod', isOwn: true, ownerOrgName: null, regions: ['us-east-1'], deployable: true, reason: null, ...over,
});
const targets = (runners: unknown[], over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    pipelineId: 'p1', available: true, unavailableReason: null, alreadyDeployed: false, activeRequestId: null, runners,
    autoRunnerId: null, setupCommand: DEPLOY_SETUP_COMMAND, ...over,
  },
});
const deploy = (over: Record<string, unknown> = {}) => ({
  requestId: 'd1', pipelineId: 'p1', status: 'queued', stage: 'queued', runnerId: 'r1', runnerLabel: 'prod', region: 'us-east-1',
  errorCode: null, failureClass: null, retryable: false, requestedAt: new Date().toISOString(), acceptedAt: null, finishedAt: null,
  deadlineAt: null, logHint: null, ...over,
});
const QUEUED = { success: true, data: { requestId: 'd1', status: 'queued', runnerLabel: 'prod', region: 'us-east-1', reused: false } };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: null });
  api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'delivering' }) });
  api.startPipelineDeploy.mockResolvedValue(QUEUED);
  api.cancelPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'cancelled', errorCode: 'DEPLOY_CANCELLED', failureClass: 'cancelled', retryable: true }) });
});
afterEach(() => { jest.useRealTimers(); });

describe('no deployable runner', () => {
  it('no runner at all: says why, shows the setup command and links to the runners settings', async () => {
    api.getDeployTargets.mockResolvedValue(targets([]));
    render(<DeployPipelinePanel pipelineId="p1" />);
    expect(await screen.findByText(/No pipeline runner can deploy this pipeline/)).toBeInTheDocument();
    expect(screen.getByText(/has no pipeline runner/i)).toBeInTheDocument();
    expect(screen.getByText(DEPLOY_SETUP_COMMAND)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /pipeline runners/i })).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
    expect(screen.queryByRole('button', { name: /^Deploy/ })).not.toBeInTheDocument();
  });

  it('eligible runners that cannot deploy: each is listed with its reason', async () => {
    api.getDeployTargets.mockResolvedValue(targets([
      runner({ deployable: false, reason: 'deploy_not_enabled' }),
      runner({ id: 'r2', label: 'staging', deployable: false, reason: 'prefix_mismatch' }),
    ]));
    render(<DeployPipelinePanel pipelineId="p1" />);
    const why = await screen.findByTestId('deploy-no-runner-reasons');
    expect(within(why).getByText(/prod/)).toBeInTheDocument();
    expect(why).toHaveTextContent(/deploys are not enabled/i);
    expect(why).toHaveTextContent(/staging/);
    expect(why).toHaveTextContent(/prefix/i);
    // One runner has deploys off, so the setup command still helps.
    expect(screen.getByText(/Turn deploys on for a runner/)).toBeInTheDocument();
  });

  it('only a prefix mismatch: no "turn deploys on" command (deploys are already on); the reason says how to fix it', async () => {
    api.getDeployTargets.mockResolvedValue(targets([
      runner({ deployable: false, reason: 'prefix_mismatch' }),
    ]));
    render(<DeployPipelinePanel pipelineId="p1" />);
    const why = await screen.findByTestId('deploy-no-runner-reasons');
    expect(why).toHaveTextContent(/set the pipeline's organization/i);
    expect(why).toHaveTextContent(/--pipeline-prefix/);
    expect(screen.queryByText(/Turn deploys on for a runner/)).not.toBeInTheDocument();
  });

  it('runners unavailable on the platform: says so', async () => {
    api.getDeployTargets.mockResolvedValue(targets([], { available: false, unavailableReason: 'paused' }));
    render(<DeployPipelinePanel pipelineId="p1" />);
    expect(await screen.findByText(/Pipeline runs are paused/)).toBeInTheDocument();
  });
});

describe('exactly one deployable runner', () => {
  it('is pre-selected: one click, step-up, and the deploy is queued and followed', async () => {
    api.getDeployTargets.mockResolvedValue(targets([runner(), runner({ id: 'r2', label: 'old', deployable: false, reason: 'update_required' })], { autoRunnerId: 'r1' }));
    render(<DeployPipelinePanel pipelineId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy to prod (us-east-1)' }));
    expect(screen.queryByRole('combobox', { name: /pipeline runner/i })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await waitFor(() => expect(api.startPipelineDeploy).toHaveBeenCalledWith('p1', { runnerId: 'r1', region: 'us-east-1' }, 'tok'));
    expect(await screen.findByTestId('deploy-progress')).toHaveTextContent(/prod/);
    expect(screen.getByTestId('deploy-stage-steps')).toBeInTheDocument();
  });

  it('a runner with several regions asks for the region', async () => {
    api.getDeployTargets.mockResolvedValue(targets([runner({ regions: ['us-east-1', 'eu-west-1'] })], { autoRunnerId: 'r1' }));
    render(<DeployPipelinePanel pipelineId="p1" />);
    const region = await screen.findByRole('combobox', { name: /region/i });
    fireEvent.change(region, { target: { value: 'eu-west-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deploy to prod (eu-west-1)' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await waitFor(() => expect(api.startPipelineDeploy).toHaveBeenCalledWith('p1', { runnerId: 'r1', region: 'eu-west-1' }, 'tok'));
  });
});

describe('several runners', () => {
  it('a dropdown: non-deployable disabled with its reason, a shared one names its org', async () => {
    api.getDeployTargets.mockResolvedValue(targets([
      runner(),
      runner({ id: 'r2', label: 'parent-prod', isOwn: false, ownerOrgName: 'Acme', regions: ['eu-west-1'] }),
      runner({ id: 'r3', label: 'old', deployable: false, reason: 'unhealthy' }),
    ]));
    render(<DeployPipelinePanel pipelineId="p1" />);
    const select = await screen.findByRole('combobox', { name: /pipeline runner/i });
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    const old = options.find((o) => o.textContent?.includes('old'));
    expect(old?.disabled).toBe(true);
    expect(old?.textContent).toMatch(/not answering/i);
    expect(options.find((o) => o.textContent?.includes('parent-prod'))?.textContent).toMatch(/shared by Acme/);
    // Nothing is picked for the person when several can deploy.
    expect(screen.queryByRole('button', { name: /^Deploy to/ })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'r2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deploy to parent-prod (eu-west-1)' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await waitFor(() => expect(api.startPipelineDeploy).toHaveBeenCalledWith('p1', { runnerId: 'r2', region: 'eu-west-1' }, 'tok'));
  });

  it('a refusal shows its copy, and DEPLOY_IN_PROGRESS follows the deploy already running', async () => {
    api.getDeployTargets.mockResolvedValue(targets([runner()], { autoRunnerId: 'r1' }));
    api.startPipelineDeploy.mockRejectedValueOnce(new ApiError('rate', 429, 'DEPLOY_RATE_LIMITED'));
    render(<DeployPipelinePanel pipelineId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy to prod (us-east-1)' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    expect(await screen.findByText(/Too many deploys/i)).toBeInTheDocument();

    jest.useFakeTimers();
    api.startPipelineDeploy.mockRejectedValueOnce(new ApiError('busy', 409, 'DEPLOY_IN_PROGRESS', { requestId: 'd9' }));
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ requestId: 'd9', status: 'deploying', stage: 'deploying' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Deploy to prod (us-east-1)' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    expect(api.getPipelineDeploy).toHaveBeenCalledWith('p1', 'd9', expect.anything());
  });
});

describe('progress, cancel, failure, resume', () => {
  it('resumes the latest active deploy: stage steps, and Cancel', async () => {
    api.getDeployTargets.mockResolvedValue(targets([runner()], { autoRunnerId: 'r1', activeRequestId: 'd1' }));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'synthesizing', acceptedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 7_200_000).toISOString() }) });
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'synthesizing' }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    const steps = await screen.findByTestId('deploy-stage-steps');
    expect(within(steps).getByText(/Synthesizing/).closest('li')).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: /Cancel deploy/ }));
    await waitFor(() => expect(api.cancelPipelineDeploy).toHaveBeenCalledWith('p1', 'd1'));
  });

  it('a retryable failure: its copy, next steps, where the logs are, Retry and Change runner', async () => {
    api.getDeployTargets.mockResolvedValue(targets([runner(), runner({ id: 'r2', label: 'dr' })]));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({
      status: 'failed', stage: 'deploying', errorCode: 'CFN_DEPLOY_FAILED', failureClass: 'cloudformation', retryable: true,
      logHint: { project: 'pipeline-builder-runner-deploy-r1', logGroup: '/aws/codebuild/pipeline-builder-runner-deploy-r1', buildId: 'pipeline-builder-runner-deploy-r1:abc' },
    }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    const failure = await screen.findByTestId('deploy-failure');
    expect(failure).toHaveTextContent(DEPLOY_ERROR_COPY.CFN_DEPLOY_FAILED.title);
    expect(failure).toHaveTextContent(DEPLOY_ERROR_COPY.CFN_DEPLOY_FAILED.nextSteps[0]);
    expect(failure).toHaveTextContent('/aws/codebuild/pipeline-builder-runner-deploy-r1');
    expect(failure).toHaveTextContent('pipeline-builder-runner-deploy-r1:abc');
    expect(failure).toHaveTextContent(/CloudWatch in the runner's AWS account/);
    fireEvent.click(screen.getByRole('button', { name: /^Retry/ }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await waitFor(() => expect(api.startPipelineDeploy).toHaveBeenCalledWith('p1', { runnerId: 'r1', region: 'us-east-1' }, 'tok'));
  });

  it('Change runner returns to the runner choice', async () => {
    api.getDeployTargets.mockResolvedValue(targets([runner(), runner({ id: 'r2', label: 'dr' })]));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'failed', errorCode: 'DEPLOY_TIMED_OUT', failureClass: 'timeout', retryable: true }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Change runner/ }));
    expect(await screen.findByRole('combobox', { name: /pipeline runner/i })).toBeInTheDocument();
  });

  it('a non-retryable failure offers no Retry', async () => {
    api.getDeployTargets.mockResolvedValue(targets([runner()], { autoRunnerId: 'r1' }));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'failed', errorCode: 'STACK_OWNED_BY_OTHER_PIPELINE', failureClass: 'definition', retryable: false }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    expect(await screen.findByTestId('deploy-failure')).toHaveTextContent(DEPLOY_ERROR_COPY.STACK_OWNED_BY_OTHER_PIPELINE.title);
    expect(screen.queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument();
  });

  it('a deployed pipeline reports it once', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()], { autoRunnerId: 'r1' }));
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deployed', stage: 'done' }) });
    const onDeployed = jest.fn<AnyFn>();
    render(<DeployPipelinePanel pipelineId="p1" onDeployed={onDeployed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy to prod (us-east-1)' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    expect(await screen.findByText(/Deployed to prod \(us-east-1\)/)).toBeInTheDocument();
    expect(onDeployed).toHaveBeenCalledTimes(1);
  });
});

describe('round 7 regressions', () => {
  it('Change runner after a resumed active deploy fails does not re-follow the targets\' stale activeRequestId', async () => {
    jest.useFakeTimers();
    api.getDeployTargets
      .mockResolvedValueOnce(targets([runner(), runner({ id: 'r2', label: 'dr' })], { activeRequestId: 'd1' }))
      .mockResolvedValue(targets([runner(), runner({ id: 'r2', label: 'dr' })]));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'deploying' }) });
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'failed', stage: 'deploying', errorCode: 'DEPLOY_TIMED_OUT', failureClass: 'timeout', retryable: true }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    expect(screen.getByTestId('deploy-failure')).toBeInTheDocument();
    const reads = api.getPipelineDeploy.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Change runner/ }));
    await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByTestId('deploy-failure')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /pipeline runner/i })).toBeInTheDocument();
    expect(api.getPipelineDeploy.mock.calls.length).toBe(reads);
  });

  it('a Retry after a resumed deploy fails follows the NEW deploy, not the stale activeRequestId', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()], { activeRequestId: 'd1' }));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'deploying' }) });
    api.getPipelineDeploy.mockImplementation(async (_p: unknown, id: unknown) => ({
      success: true,
      data: id === 'd1'
        ? deploy({ status: 'failed', stage: 'deploying', errorCode: 'DEPLOY_TIMED_OUT', failureClass: 'timeout', retryable: true })
        : deploy({ requestId: 'd2', status: 'deploying', stage: 'synthesizing' }),
    }));
    api.startPipelineDeploy.mockResolvedValue({ success: true, data: { ...QUEUED.data, requestId: 'd2' } });
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    fireEvent.click(screen.getByRole('button', { name: /^Retry/ }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    const d1Reads = api.getPipelineDeploy.mock.calls.filter((c) => c[1] === 'd1').length;
    await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
    expect(api.getPipelineDeploy.mock.calls.filter((c) => c[1] === 'd1').length).toBe(d1Reads);
    expect(api.getPipelineDeploy).toHaveBeenCalledWith('p1', 'd2', expect.anything());
    expect(screen.getByTestId('deploy-progress')).toBeInTheDocument();
  });

  it('a refused progress read says the read failed, not that the deploy passed its deadline', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()]));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'deploying' }) });
    api.getPipelineDeploy.mockRejectedValue(new ApiError('You no longer have access to this pipeline.', 403, 'FORBIDDEN'));
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    const progress = screen.getByTestId('deploy-progress');
    expect(progress).toHaveTextContent(/You no longer have access to this pipeline/);
    expect(progress).not.toHaveTextContent(/deadline/);
  });

  it('a non-runner refusal of the start (compliance) shows the server\'s message, not runner copy', async () => {
    api.getDeployTargets.mockResolvedValue(targets([runner()]));
    api.startPipelineDeploy.mockRejectedValueOnce(new ApiError('Deploy blocked by compliance rules', 403, 'COMPLIANCE_VIOLATION'));
    render(<DeployPipelinePanel pipelineId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy to prod (us-east-1)' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    expect(await screen.findByText(/Deploy blocked by compliance rules/)).toBeInTheDocument();
    expect(screen.queryByText(/pipeline runner could not complete/)).not.toBeInTheDocument();
  });

  it('a failed cancel says the cancel failed, and its error does not carry into the next deploy', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()]));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'deploying' }) });
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'deploying' }) });
    api.cancelPipelineDeploy.mockRejectedValueOnce({});
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole('button', { name: /Cancel deploy/ }));
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('deploy-progress')).toHaveTextContent(/Could not cancel the deploy/);
    // The deploy fails anyway; a new one is started: the old cancel error is gone.
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'failed', errorCode: 'DEPLOY_TIMED_OUT', failureClass: 'timeout', retryable: true }) });
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    api.startPipelineDeploy.mockResolvedValue({ success: true, data: { ...QUEUED.data, requestId: 'd2' } });
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ requestId: 'd2', status: 'deploying', stage: 'deploying' }) });
    fireEvent.click(screen.getByRole('button', { name: /^Retry/ }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('deploy-progress')).not.toHaveTextContent(/Could not cancel/);
  });
});

describe('round 8 regressions', () => {
  it('a Retry refused with DEPLOY_IN_PROGRESS stops showing the old failure (and its Retry) while the running deploy loads', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()]));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'failed', errorCode: 'DEPLOY_TIMED_OUT', failureClass: 'timeout', retryable: true }) });
    api.startPipelineDeploy.mockRejectedValueOnce(new ApiError('busy', 409, 'DEPLOY_IN_PROGRESS', { requestId: 'd9' }));
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ requestId: 'd9', status: 'deploying', stage: 'deploying' }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole('button', { name: /^Retry/ }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    expect(screen.queryByTestId('deploy-failure')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument();
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    expect(screen.getByTestId('deploy-progress')).toBeInTheDocument();
  });

  it('a followed deploy whose first read is refused says so (it is not shown as the runner choice)', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()]));
    api.startPipelineDeploy.mockRejectedValueOnce(new ApiError('busy', 409, 'DEPLOY_IN_PROGRESS', { requestId: 'd9' }));
    api.getPipelineDeploy.mockRejectedValue(new ApiError('Deploy not found.', 404, 'NOT_FOUND'));
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole('button', { name: 'Deploy to prod (us-east-1)' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    expect(screen.getByTestId('deploy-pipeline-panel')).toHaveTextContent(/Could not read this deploy's progress: Deploy not found\./);
  });

  it('an accepted cancel shows its answer at once, and a running deploy says the cancel was requested', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()]));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'deploying' }) });
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'deploying', stage: 'deploying' }) });
    api.cancelPipelineDeploy.mockResolvedValueOnce({ success: true, data: deploy({ status: 'deploying', stage: 'deploying' }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole('button', { name: /Cancel deploy/ }));
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('deploy-progress')).toHaveTextContent(/Cancel requested/);
    expect(screen.getByRole('button', { name: /Cancel deploy/ })).toBeDisabled();

  });

  it('a queued deploy cancelled by the answer is shown cancelled without waiting for the next read', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()]));
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'queued' }) });
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ status: 'queued' }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole('button', { name: /Cancel deploy/ }));
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('deploy-failure')).toBeInTheDocument();
  });

  it('a step-up replay of the start refused with DEPLOY_IN_PROGRESS follows the running deploy', async () => {
    jest.useFakeTimers();
    api.getDeployTargets.mockResolvedValue(targets([runner()]));
    const refusal = new StepUpRequiredError('step up', 'STEP_UP_REQUIRED');
    const replay = Promise.reject(new ApiError('busy', 409, 'DEPLOY_IN_PROGRESS', { requestId: 'd9' }));
    replay.catch(() => undefined);
    refusal.attachResume(replay);
    api.startPipelineDeploy.mockRejectedValueOnce(refusal);
    api.getPipelineDeploy.mockResolvedValue({ success: true, data: deploy({ requestId: 'd9', status: 'deploying', stage: 'deploying' }) });
    render(<DeployPipelinePanel pipelineId="p1" />);
    await act(async () => { await jest.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole('button', { name: 'Deploy to prod (us-east-1)' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByText('Confirm step-up'));
    await act(async () => { await jest.advanceTimersByTimeAsync(2500); });
    expect(api.getPipelineDeploy).toHaveBeenCalledWith('p1', 'd9', expect.anything());
    expect(screen.getByTestId('deploy-progress')).toBeInTheDocument();
  });
});

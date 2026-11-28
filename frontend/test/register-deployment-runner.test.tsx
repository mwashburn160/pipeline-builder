// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Register deployment dialog names the pipeline runner the pipeline is
 * registered with: with only one runner (e.g. `default`) it asks to register
 * with that one; with several it lists them (an unreachable one can't be
 * picked) and asks which; with none it says why and registers without one. A
 * never-deployed pipeline is steered to Deploy. After registering it follows
 * the link probe and says whether the runner found the pipeline.
 */

import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { linkOutcome, LINK_POLL_MS, LINK_POLL_TRIES, RegisterDeploymentModal } from '@/components/deployments/RegisterDeploymentModal';

const getRegisterRunners = jest.fn<AnyFn>();
const registerPipelineDeployment = jest.fn<AnyFn>();
const getPipelineRunnerLink = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getRegisterRunners: (...a: unknown[]) => getRegisterRunners(...a),
    registerPipelineDeployment: (...a: unknown[]) => registerPipelineDeployment(...a),
    getPipelineRunnerLink: (...a: unknown[]) => getPipelineRunnerLink(...a),
  },
}));

const CONFIGS = [
  { id: 'p-1', pipelineName: 'axum-pipeline', project: 'axum', organization: 'system' },
  { id: 'p-2', pipelineName: 'web-pipeline', project: 'web', organization: 'system' },
];
const runner = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id, label, isOwn: true, ownerOrgName: null, regions: ['us-east-1'], health: 'healthy', ...extra,
});
const facts = (runners: unknown[], extra: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    pipelineId: 'p-1', available: true, unavailableReason: null, runners,
    // Deployed another way and reporting: the normal case for Register deployment.
    registered: false, hasEvents: true, linkedRunnerId: null, ...extra,
  },
});
const registeredAnswer = (runnerLink: string | null) => ({ success: true, data: { registry: { id: 'r-1', pipelineId: 'p-1' }, runnerLink } });

function open(props: Partial<Parameters<typeof RegisterDeploymentModal>[0]> = {}) {
  const onRegistered = jest.fn<AnyFn>();
  const onClose = jest.fn<AnyFn>();
  render(<RegisterDeploymentModal configs={CONFIGS} initialPipelineId="p-1" onClose={onClose} onRegistered={onRegistered} {...props} />);
  return { onRegistered, onClose };
}

beforeEach(() => {
  jest.clearAllMocks();
  registerPipelineDeployment.mockResolvedValue(registeredAnswer(null));
});
afterEach(() => { jest.useRealTimers(); });

describe('choosing the runner', () => {
  it('with only the default runner, asks to register with it and sends its id', async () => {
    getRegisterRunners.mockResolvedValue(facts([runner('run-default', 'default')]));
    const { onRegistered } = open();

    expect(await screen.findByText(/with the pipeline runner/)).toHaveTextContent('Register axum-pipeline with the pipeline runner default?');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Register with default' }));

    await waitFor(() => expect(onRegistered).toHaveBeenCalled());
    expect(registerPipelineDeployment).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'p-1', runnerId: 'run-default' }));
  });

  it('with several runners, lists them; an unreachable one cannot be picked', async () => {
    getRegisterRunners.mockResolvedValue(facts([
      runner('run-default', 'default'),
      runner('run-prod', 'prod'),
      runner('run-old', 'old', { health: 'unreachable' }),
      runner('run-shared', 'shared', { isOwn: false, ownerOrgName: 'Parent Co' }),
    ]));
    const { onRegistered } = open();

    expect(await screen.findAllByRole('radio')).toHaveLength(4);
    expect(screen.getByLabelText('old — unreachable')).toBeDisabled();
    expect(screen.getByLabelText('shared (shared by Parent Co)')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('prod'));
    fireEvent.click(screen.getByRole('button', { name: 'Register with prod' }));

    await waitFor(() => expect(onRegistered).toHaveBeenCalled());
    expect(registerPipelineDeployment).toHaveBeenCalledWith(expect.objectContaining({ runnerId: 'run-prod' }));
  });

  it('pre-picks the runner the pipeline is linked to now, and the only one that can answer', async () => {
    getRegisterRunners.mockResolvedValue(facts([runner('run-a', 'a'), runner('run-b', 'b')], { linkedRunnerId: 'run-b' }));
    open();
    expect(await screen.findByLabelText('b — linked now')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Register with b' })).toBeEnabled();
  });

  it('changing the pipeline clears the runner picked for the previous one', async () => {
    getRegisterRunners.mockImplementation(async (id: string) => facts([runner(`${id}-a`, 'a'), runner(`${id}-b`, 'b')], { pipelineId: id }));
    open();
    fireEvent.click(await screen.findByLabelText('a'));
    expect(screen.getByRole('button', { name: 'Register with a' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Pipeline'), { target: { value: 'p-2' } });
    await waitFor(() => expect(getRegisterRunners).toHaveBeenCalledWith('p-2', expect.anything()));
    expect(await screen.findByLabelText('a')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
  });

  it('fills the Region from a runner with one region, and suggests several', async () => {
    getRegisterRunners.mockResolvedValue(facts([runner('run-a', 'a', { regions: ['eu-west-1'] }), runner('run-b', 'b', { regions: ['us-east-1', 'us-west-2'] })]));
    open();
    fireEvent.click(await screen.findByLabelText('a'));
    expect(screen.getByLabelText(/Region/)).toHaveValue('eu-west-1');
    fireEvent.click(screen.getByLabelText('b'));
    expect(screen.getByLabelText(/Region/)).toHaveAttribute('list');
    // What the person types wins over the runner's region.
    fireEvent.change(screen.getByLabelText(/Region/), { target: { value: 'ap-south-1' } });
    fireEvent.click(screen.getByLabelText('a'));
    expect(screen.getByLabelText(/Region/)).toHaveValue('ap-south-1');
  });
});

describe('why there is no runner', () => {
  it('runners paused: names the reason, and registers without one', async () => {
    getRegisterRunners.mockResolvedValue(facts([], { available: false, unavailableReason: 'paused' }));
    const { onRegistered } = open();
    expect(await screen.findByText('Pipeline runs are paused on this platform.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(onRegistered).toHaveBeenCalled());
    expect(registerPipelineDeployment.mock.calls[0]![0]).not.toHaveProperty('runnerId');
  });

  it('no runner at all: says so and links to runner setup', async () => {
    getRegisterRunners.mockResolvedValue(facts([]));
    open();
    expect(await screen.findByText(/Your organization has no pipeline runner/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up a pipeline runner' })).toBeInTheDocument();
  });

  it('the only runner is unreachable: says so, and registers without it', async () => {
    getRegisterRunners.mockResolvedValue(facts([runner('run-default', 'default', { health: 'unreachable' })]));
    open();
    expect(await screen.findByText('The pipeline runner default is unreachable.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(registerPipelineDeployment).toHaveBeenCalled());
    expect(registerPipelineDeployment.mock.calls[0]![0]).not.toHaveProperty('runnerId');
  });

  it('a failed runner read shows the error with Retry, and still lets it register without one', async () => {
    getRegisterRunners.mockRejectedValueOnce(new Error('Service unavailable')).mockResolvedValue(facts([runner('run-default', 'default')]));
    open();
    expect(await screen.findByText(/Service unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Register with default' })).toBeInTheDocument();
  });
});

describe('a never-deployed pipeline', () => {
  it('steers to Deploy, and registers only once it is confirmed deployed another way', async () => {
    getRegisterRunners.mockResolvedValue(facts([runner('run-default', 'default')], { registered: false, hasEvents: false }));
    const onDeployInstead = jest.fn<AnyFn>();
    open({ onDeployInstead });

    expect(await screen.findByText('This pipeline is not deployed yet.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Register with default' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Deploy it instead' }));
    expect(onDeployInstead).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('It was deployed another way (CDK, CI)'));
    expect(submit).toBeEnabled();
  });

  it('links to the pipeline page to deploy when opened from the Deployments page', async () => {
    getRegisterRunners.mockResolvedValue(facts([], { registered: false, hasEvents: false }));
    open();
    expect(await screen.findByRole('link', { name: 'Deploy it instead' })).toHaveAttribute('href', '/dashboard/pipelines/p-1');
  });

  it('a pipeline that reported before (deployed, registration gone) is not flagged', async () => {
    getRegisterRunners.mockResolvedValue(facts([runner('run-default', 'default')], { registered: false, hasEvents: true }));
    open();
    await screen.findByRole('button', { name: 'Register with default' });
    expect(screen.queryByText('This pipeline is not deployed yet.')).not.toBeInTheDocument();
  });
});

describe('the link outcome', () => {
  it('follows a running probe until it settles, then says the runner linked it', async () => {
    jest.useFakeTimers();
    getRegisterRunners.mockResolvedValue(facts([runner('run-default', 'default')]));
    registerPipelineDeployment.mockResolvedValue(registeredAnswer('checking'));
    getPipelineRunnerLink
      .mockResolvedValueOnce({ success: true, data: { status: 'checking', runner: null, detail: null } })
      .mockResolvedValueOnce({ success: true, data: { status: 'linked', runner: { id: 'run-default', label: 'default' }, detail: null } });
    const { onClose } = open();

    fireEvent.click(await screen.findByRole('button', { name: 'Register with default' }));
    expect(await screen.findByText(/Checking whether default finds it/)).toBeInTheDocument();
    await act(async () => { await jest.advanceTimersByTimeAsync(LINK_POLL_MS * 2); });
    expect(await screen.findByText('Registered and linked to default.')).toBeInTheDocument();
    expect(getPipelineRunnerLink).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('gives up after its tries and points at the pipeline page', async () => {
    jest.useFakeTimers();
    getRegisterRunners.mockResolvedValue(facts([runner('run-default', 'default')]));
    registerPipelineDeployment.mockResolvedValue(registeredAnswer('checking'));
    getPipelineRunnerLink.mockResolvedValue({ success: true, data: { status: 'checking', runner: null, detail: null } });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Register with default' }));
    for (let i = 0; i <= LINK_POLL_TRIES; i++) {
      await act(async () => { await jest.advanceTimersByTimeAsync(LINK_POLL_MS); });
    }
    expect(await screen.findByText('Registered. The runner is still looking for it.')).toBeInTheDocument();
    expect(getPipelineRunnerLink).toHaveBeenCalledTimes(LINK_POLL_TRIES);
  });

  it('no probe ran (runners paused): says it registered without a link', async () => {
    getRegisterRunners.mockResolvedValue(facts([], { available: false, unavailableReason: 'paused' }));
    open();
    await screen.findByText('Pipeline runs are paused on this platform.');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(await screen.findByText('Registered.')).toBeInTheDocument();
    expect(getPipelineRunnerLink).not.toHaveBeenCalled();
  });

  it('linkOutcome: a picked runner that missed while another keeps the link says both', () => {
    expect(linkOutcome({ status: 'linked', runner: { id: 'run-a', label: 'a' } as never, detail: null }, { id: 'run-b', label: 'b' }))
      .toMatchObject({ variant: 'warning', title: 'b did not find this pipeline in its AWS account.', body: expect.stringContaining('stays linked to a') });
    expect(linkOutcome({ status: 'not_found', runner: null, detail: { runnersChecked: ['b'], matched: [], errorCode: 'PIPELINE_NOT_FOUND' } as never }, { id: 'run-b', label: 'b' }))
      .toMatchObject({ variant: 'warning', title: 'Registered, but b did not find this pipeline in its AWS account.' });
    expect(linkOutcome({ status: 'not_found', runner: null, detail: { runnersChecked: ['b'], matched: [], errorCode: 'RUNNER_UNREACHABLE' } as never }, { id: 'run-b', label: 'b' }))
      .toMatchObject({ variant: 'warning', title: expect.stringMatching(/^Registered, but not linked: /) });
    expect(linkOutcome({ status: 'ambiguous', runner: null, detail: null }, null)).toMatchObject({ variant: 'warning' });
  });
});

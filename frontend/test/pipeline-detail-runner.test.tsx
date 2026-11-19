// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline detail page × pipeline runners.
 *  - Re-run / Stop answered `202 { requestId, status: 'queued', runnerLabel }`:
 *    "Queued for runner <label>", then GET …/run-requests/:id with backoff until
 *    a terminal state → a success toast, or the error code's banner (linking to
 *    Settings → Pipeline runners where that is the fix). Polling stops on
 *    unmount, and a request still pending past its expiry reads as expired.
 *  - A synchronous refusal with a runner code gets the same banner.
 *  - Platform-account pipelines (`202 { executionId }`) are unchanged.
 *  - The Deployment card says "Runs via: <runner label>".
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import { ApiError } from '../src/lib/api/errors';
import { PIPELINE_RUNNERS_HREF, RUNNER_ERROR_COPY } from '../src/lib/pipeline-runners';
import { RUN_REQUEST_POLL } from '../src/hooks/useRunRequestTracker';
import { runnerErrorBanner } from '../src/components/pipeline/RunnerError';
import PipelineDetailPage from '../pages/dashboard/pipelines/[id]';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: false, isLoaded: true, label: 'x', description: '', unlocks: '', upsellHref: '/', reason: 'not on plan' }),
}));
jest.mock('@/components/pipeline/ScorecardCard', () => ({ __esModule: true, ScorecardCard: () => null }));
jest.mock('@/components/pipeline/PipelineContextCard', () => ({ __esModule: true, PipelineContextCard: () => null }));
// Runner surfaces show only with the per-org `cross_account_runners` feature.
let mockFeatures = new Set<string>(['cross_account_runners']);
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({
    isEnabled: (f: string) => mockFeatures.has(f), features: [...mockFeatures], isLoaded: true, isSuperAdmin: false, canReachBilling: false,
    supportAlias: '', supportAliases: [], deployTarget: 'aws-ec2', adminConsolesEnabled: true, tierPresets: undefined,
    askUiMode: 'ask-agent', cliNpmPackage: 'pb-cli', cliNpmUrl: 'https://npm.example/pb-cli',
  }),
}));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/pipelines/[id]', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const api = {
  getPipelineById: jest.fn<AnyFn>(),
  getExecutionCount: jest.fn<AnyFn>(),
  getOrganizationMembers: jest.fn<AnyFn>(),
  listPipelineDeployments: jest.fn<AnyFn>(),
  listPipelineExecutions: jest.fn<AnyFn>(),
  getPipelineSecurity: jest.fn<AnyFn>(),
  triggerPipelineExecution: jest.fn<AnyFn>(),
  stopPipelineExecution: jest.fn<AnyFn>(),
  getRunRequest: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

const pipeline = {
  id: 'p1', orgId: 'org-1', project: 'web', organization: 'acme', pipelineName: 'acme-web',
  props: {}, visibility: 'org', isActive: true, isDefault: false, createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
};
const row = (over: Record<string, unknown> = {}) => ({ pipelineId: 'p1', region: 'us-east-1', stackName: 'web-stack', lastDeployed: '2026-11-09T00:00:00Z', ...over });
const QUEUED = { requestId: 'rq1', status: 'queued', runnerLabel: 'Production' };
const rr = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    requestId: 'rq1', status: 'queued', action: 'start', runnerLabel: 'Production', executionId: null, errorCode: null,
    attempts: 1, requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), ...over,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset, not just clear: a once-queue left by a failed test must not leak.
  for (const fn of Object.values(api)) fn.mockReset();
  mockFeatures = new Set(['cross_account_runners']);
  mockRouter.query = { id: 'p1' };
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: { registered: true } } });
  api.getExecutionCount.mockResolvedValue({ success: true, data: { pipelines: [] } });
  api.getOrganizationMembers.mockResolvedValue({ success: true, data: { members: [], pagination: { hasMore: false } } });
  api.listPipelineDeployments.mockResolvedValue({ success: true, data: { registry: [row()], pagination: { hasMore: false } } });
  api.listPipelineExecutions.mockResolvedValue({ success: true, data: { executions: [
    { execution_id: 'e-run', status: 'in-progress', started_at: '2026-11-10T00:00:00Z', ended_at: null, duration_ms: 1000, failing_stage: null, failing_action: null },
  ] } });
  api.getPipelineSecurity.mockResolvedValue({ success: true, data: null });
  api.triggerPipelineExecution.mockResolvedValue({ success: true, data: QUEUED });
  api.stopPipelineExecution.mockResolvedValue({ success: true, data: QUEUED });
  api.getRunRequest.mockResolvedValue(rr());
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/** Advance the poll clock by `ms`, letting the reads it triggers settle. */
const advance = async (ms: number) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };

async function rerun() {
  const utils = render(<PipelineDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Re-run/ }));
  await waitFor(() => expect(api.triggerPipelineExecution).toHaveBeenCalledWith('p1'));
  return utils;
}

async function stop() {
  mockRouter.query = { id: 'p1', tab: 'runs' };
  const utils = render(<PipelineDetailPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: /^Cancel$/ }))[0]);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /Cancel execution/ }));
  await waitFor(() => expect(api.stopPipelineExecution).toHaveBeenCalledWith('p1', 'e-run', expect.anything()));
  return utils;
}

describe('Re-run through a pipeline runner', () => {
  it('queued → started: "Queued for runner <label>", polls the request, then toasts the execution id', async () => {
    api.getRunRequest
      .mockResolvedValueOnce(rr({ status: 'queued' }))
      .mockResolvedValueOnce(rr({ status: 'delivering' }))
      .mockResolvedValueOnce(rr({ status: 'started', executionId: 'e-9' }));
    await rerun();
    const status = await screen.findByTestId('run-request-status');
    expect(status).toHaveTextContent('Queued for runner Production');
    // Re-run is held while its request is in flight.
    expect(screen.getByRole('button', { name: /Re-run/ })).toBeDisabled();
    expect(pageToast.success).not.toHaveBeenCalled();

    await advance(RUN_REQUEST_POLL.initialMs);
    expect(api.getRunRequest).toHaveBeenCalledTimes(1);
    expect(api.getRunRequest).toHaveBeenCalledWith('p1', 'rq1', expect.anything());
    await advance(RUN_REQUEST_POLL.initialMs * RUN_REQUEST_POLL.factor);
    expect(api.getRunRequest).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('run-request-status')).toHaveTextContent(/delivering to the runner/);
    await advance(RUN_REQUEST_POLL.maxMs);
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Started execution e-9'));
    expect(screen.queryByTestId('run-request-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runner-error')).not.toBeInTheDocument();

    // Terminal: no further reads.
    await advance(60_000);
    expect(api.getRunRequest).toHaveBeenCalledTimes(3);
  });

  it('after started, follows executionStatus every 10 s until terminal, then toasts the result', async () => {
    const seq = [
      rr({ status: 'started', executionId: 'e-9', executionStatus: 'running' }),
      rr({ status: 'started', executionId: 'e-9', executionStatus: 'running' }),
      rr({ status: 'started', executionId: 'e-9', executionStatus: 'succeeded' }),
    ];
    const at: number[] = [];
    api.getRunRequest.mockImplementation(async () => { at.push(Date.now()); return seq[Math.min(at.length - 1, seq.length - 1)]; });
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Started execution e-9'));
    expect(screen.getByTestId('run-request-execution-status')).toHaveTextContent('running');
    expect(screen.getByTestId('run-request-status')).toHaveTextContent('e-9');
    // The run is going, so Re-run is available again.
    expect(screen.getByRole('button', { name: /Re-run/ })).not.toBeDisabled();
    await advance(3 * RUN_REQUEST_POLL.executionMs);
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Execution e-9 succeeded'));
    expect(screen.queryByTestId('run-request-status')).not.toBeInTheDocument();
    // Slower cadence once started: 10 s between execution reads.
    expect(at[1] - at[0]).toBe(RUN_REQUEST_POLL.executionMs);
    expect(at[2] - at[1]).toBe(RUN_REQUEST_POLL.executionMs);
    await advance(60_000);
    expect(api.getRunRequest).toHaveBeenCalledTimes(3);
  });

  it('a started run that then fails is reported (warning), and polling stops', async () => {
    api.getRunRequest
      .mockResolvedValueOnce(rr({ status: 'started', executionId: 'e-9', executionStatus: 'InProgress' }))
      .mockResolvedValueOnce(rr({ status: 'started', executionId: 'e-9', executionStatus: 'Failed' }));
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    await advance(RUN_REQUEST_POLL.executionMs);
    await waitFor(() => expect(pageToast.warning).toHaveBeenCalledWith('Execution e-9 failed'));
    await advance(60_000);
    expect(api.getRunRequest).toHaveBeenCalledTimes(2);
  });

  it('unmounting while following the execution stops polling', async () => {
    api.getRunRequest.mockResolvedValue(rr({ status: 'started', executionId: 'e-9', executionStatus: 'running' }));
    const { unmount } = await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    await screen.findByTestId('run-request-execution-status');
    const n = api.getRunRequest.mock.calls.length;
    unmount();
    await advance(10 * RUN_REQUEST_POLL.executionMs);
    expect(api.getRunRequest.mock.calls.length).toBe(n);
  });

  it('a 202 already "delivering" says so', async () => {
    api.triggerPipelineExecution.mockResolvedValue({ success: true, data: { ...QUEUED, status: 'delivering' } });
    await rerun();
    expect(await screen.findByTestId('run-request-status')).toHaveTextContent(/delivering to the runner/);
  });

  it('backs off between reads (1 s, then ×1.5, capped)', async () => {
    const at: number[] = [];
    api.getRunRequest.mockImplementation(async () => { at.push(Date.now()); return rr(); });
    const t0 = Date.now();
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(40_000);
    const gaps = at.map((t, i) => t - (i === 0 ? t0 : at[i - 1]));
    // The first read waits at least the initial delay; each gap then grows ×1.5 up to the cap.
    expect(gaps[0]).toBeGreaterThanOrEqual(RUN_REQUEST_POLL.initialMs);
    expect(gaps.slice(1, 5)).toEqual([1500, 2250, 3375, RUN_REQUEST_POLL.maxMs]);
    expect(gaps.slice(5).every((g) => g === RUN_REQUEST_POLL.maxMs)).toBe(true);
  });

  it.each(Object.keys(RUNNER_ERROR_COPY))('queued → failed %s: the banner with that code\'s copy', async (code) => {
    api.getRunRequest.mockResolvedValue(rr({ status: 'failed', errorCode: code }));
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveAttribute('data-code', code);
    expect(banner).toHaveTextContent(RUNNER_ERROR_COPY[code].title);
    expect(banner).toHaveTextContent(RUNNER_ERROR_COPY[code].body);
    expect(banner).toHaveTextContent('Runner: Production');
    const link = within(banner).queryByRole('link');
    if (RUNNER_ERROR_COPY[code].link) expect(link).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
    else expect(link).toBeNull();
    expect(screen.queryByTestId('run-request-status')).not.toBeInTheDocument();
    expect(pageToast.success).not.toHaveBeenCalled();
  });

  it('has copy for every code the spec names', () => {
    expect(Object.keys(RUNNER_ERROR_COPY).sort()).toEqual([
      'AMBIGUOUS_PIPELINE', 'AMBIGUOUS_RUNNER', 'NOT_YET_VISIBLE', 'NO_MATCH', 'NO_RUNNER', 'PIPELINE_IDENTITY_MISMATCH', 'PIPELINE_NOT_FOUND',
      'PIPELINE_NOT_FOUND_IN_RUNNERS', 'PIPELINE_NOT_TAGGED', 'RUNNERS_NOT_ENABLED', 'RUNNERS_UNAVAILABLE', 'RUNNER_ERROR', 'RUNNER_LIMIT',
      'RUNNER_PENDING', 'RUNNER_PERMISSION_DENIED', 'RUNNER_PING_FAILED', 'RUNNER_REFUSED', 'RUNNER_REVOKED', 'RUNNER_UNREACHABLE',
      'RUNNER_UPDATE_REQUIRED', 'RUN_REQUEST_EXPIRED', 'RUN_REQUEST_RATE_LIMITED', 'SIGNATURE_INVALID', 'TOO_MANY_PENDING',
    ]);
  });

  it('an unknown failure code still gets a banner naming it', () => {
    render(<>{runnerErrorBanner('SOMETHING_NEW', { runnerLabel: 'Production' })}</>);
    const banner = screen.getByTestId('runner-error');
    expect(banner).toHaveTextContent('SOMETHING_NEW');
    expect(within(banner).getByRole('link')).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
  });

  it('expired: the request-expired copy', async () => {
    api.getRunRequest.mockResolvedValue(rr({ status: 'expired', errorCode: null }));
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveAttribute('data-code', 'RUN_REQUEST_EXPIRED');
    expect(banner).toHaveTextContent(RUNNER_ERROR_COPY.RUN_REQUEST_EXPIRED.title);
    expect(banner).toHaveTextContent(/not delivered to the pipeline runner within 10 minutes/);
  });

  it('a request still pending well past its expiry reads as expired (and stops polling)', async () => {
    api.getRunRequest.mockImplementation(async () => rr({ status: 'queued', expiresAt: new Date(Date.now() - RUN_REQUEST_POLL.expiryGraceMs - 1000).toISOString() }));
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    expect(await screen.findByTestId('runner-error')).toHaveAttribute('data-code', 'RUN_REQUEST_EXPIRED');
    const n = api.getRunRequest.mock.calls.length;
    await advance(60_000);
    expect(api.getRunRequest.mock.calls.length).toBe(n);
  });

  it('a transient read failure is retried', async () => {
    api.getRunRequest
      .mockRejectedValueOnce(new ApiError('bad gateway', 502))
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(rr({ status: 'started', executionId: 'e-2' }));
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    await advance(RUN_REQUEST_POLL.maxMs);
    await advance(RUN_REQUEST_POLL.maxMs);
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Started execution e-2'));
  });

  it('a 404 on the request read ends it (no endless polling)', async () => {
    api.getRunRequest.mockRejectedValue(new ApiError('not found', 404, 'NOT_FOUND'));
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    // The READ was refused — not the runner: "could not follow", no runner banner.
    expect(await screen.findByText(/Could not follow the Re-run request/)).toBeInTheDocument();
    expect(screen.queryByTestId('runner-error')).not.toBeInTheDocument();
    await advance(60_000);
    expect(api.getRunRequest).toHaveBeenCalledTimes(1);
  });

  it('unmounting stops polling', async () => {
    const { unmount } = await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    expect(api.getRunRequest).toHaveBeenCalledTimes(1);
    unmount();
    await advance(120_000);
    expect(api.getRunRequest).toHaveBeenCalledTimes(1);
    expect(pageToast.success).not.toHaveBeenCalled();
  });

  it('a synchronous refusal with a runner code (409 NO_RUNNER) gets its banner, with the install link', async () => {
    api.triggerPipelineExecution.mockRejectedValue(new ApiError('No runner', 409, 'NO_RUNNER'));
    await rerun();
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveTextContent(RUNNER_ERROR_COPY.NO_RUNNER.title);
    expect(within(banner).getByRole('link', { name: /Install a pipeline runner/ })).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
    expect(api.getRunRequest).not.toHaveBeenCalled();
  });

  it('409 RUNNER_UNREACHABLE names the runner and its last delivery', async () => {
    api.triggerPipelineExecution.mockRejectedValue(new ApiError('unreachable', 409, 'RUNNER_UNREACHABLE', { runnerLabel: 'Production', lastDeliveryAt: '2026-11-17T00:00:00Z' }));
    await rerun();
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveTextContent('Runner: Production');
    expect(banner).toHaveTextContent(/last delivered/);
    expect(within(banner).getByRole('link', { name: /Test the runner/ })).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
  });

  it('404 PIPELINE_NOT_FOUND_IN_RUNNERS lists the runners checked', async () => {
    api.triggerPipelineExecution.mockRejectedValue(new ApiError('nf', 404, 'PIPELINE_NOT_FOUND_IN_RUNNERS', { runnersChecked: ['Production', 'Staging'] }));
    await rerun();
    expect(await screen.findByTestId('runner-error')).toHaveTextContent('Runners checked: Production, Staging.');
  });

  it('409 RUNNERS_NOT_ENABLED: "no longer enabled for your organization", no link', async () => {
    api.triggerPipelineExecution.mockRejectedValue(new ApiError('off', 409, 'RUNNERS_NOT_ENABLED'));
    await rerun();
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveTextContent('Cross-account runners are no longer enabled for your organization');
    expect(within(banner).queryByRole('link')).toBeNull();
  });

  it('any other refusal keeps the plain message', async () => {
    api.triggerPipelineExecution.mockRejectedValue(new ApiError('Pipeline not deployed', 404, 'NOT_FOUND'));
    await rerun();
    expect(await screen.findByText('Pipeline not deployed')).toBeInTheDocument();
    expect(screen.queryByTestId('runner-error')).not.toBeInTheDocument();
  });

  it('platform-account pipelines are unchanged: 202 { executionId } toasts at once, no polling', async () => {
    api.triggerPipelineExecution.mockResolvedValue({ success: true, data: { executionId: 'e-new' } });
    await rerun();
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Started execution e-new'));
    expect(screen.queryByTestId('run-request-status')).not.toBeInTheDocument();
    await advance(30_000);
    expect(api.getRunRequest).not.toHaveBeenCalled();
  });
});

describe('Stop through a pipeline runner', () => {
  it('queued → stopped: "Queued for runner", then "Execution canceled"', async () => {
    api.getRunRequest.mockResolvedValue(rr({ action: 'stop', status: 'stopped' }));
    await stop();
    expect(await screen.findByTestId('run-request-status')).toHaveTextContent('Stop: Queued for runner Production');
    expect(pageToast.success).not.toHaveBeenCalled();
    await advance(RUN_REQUEST_POLL.initialMs);
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Execution canceled'));
    expect(screen.queryByTestId('run-request-status')).not.toBeInTheDocument();
  });

  it('queued → failed: the banner with the code\'s copy', async () => {
    api.getRunRequest.mockResolvedValue(rr({ action: 'stop', status: 'failed', errorCode: 'RUNNER_REFUSED' }));
    await stop();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveTextContent(RUNNER_ERROR_COPY.RUNNER_REFUSED.title);
    expect(pageToast.success).not.toHaveBeenCalled();
  });

  it('expired: the request-expired copy', async () => {
    api.getRunRequest.mockResolvedValue(rr({ action: 'stop', status: 'expired' }));
    await stop();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    expect(await screen.findByTestId('runner-error')).toHaveAttribute('data-code', 'RUN_REQUEST_EXPIRED');
  });

  it('a synchronous 409 PIPELINE_IDENTITY_MISMATCH: redeploy copy, no link', async () => {
    api.stopPipelineExecution.mockRejectedValue(new ApiError('mismatch', 409, 'PIPELINE_IDENTITY_MISMATCH'));
    await stop();
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveTextContent(/not this pipeline/);
    expect(banner).toHaveTextContent('pb.pipeline-id');
    expect(within(banner).queryByRole('link')).toBeNull();
  });

  it('unmounting stops polling', async () => {
    const { unmount } = await stop();
    await screen.findByTestId('run-request-status');
    unmount();
    await advance(120_000);
    expect(api.getRunRequest).not.toHaveBeenCalled();
  });

  it('platform-account pipelines are unchanged: toast at once, no polling', async () => {
    api.stopPipelineExecution.mockResolvedValue({ success: true, data: { stopped: true } });
    await stop();
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Execution canceled'));
    await advance(30_000);
    expect(api.getRunRequest).not.toHaveBeenCalled();
  });
});

describe('Deployment card — runner', () => {
  it('shows "Runs via: <runner label>"', async () => {
    api.listPipelineDeployments.mockResolvedValue({ success: true, data: { registry: [row({ runner: { id: 'r1', label: 'Production' } })], pagination: { hasMore: false } } });
    render(<PipelineDetailPage />);
    const runner = await screen.findByTestId('deployment-runner');
    expect(runner).toHaveTextContent('Production');
    expect(runner.previousElementSibling).toHaveTextContent('Runs via');
  });

  it('no row for the platform\'s own account (runner null or absent)', async () => {
    api.listPipelineDeployments.mockResolvedValue({ success: true, data: { registry: [row({ runner: null })], pagination: { hasMore: false } } });
    render(<PipelineDetailPage />);
    expect(await screen.findByText('web-stack')).toBeInTheDocument();
    expect(screen.queryByTestId('deployment-runner')).not.toBeInTheDocument();
  });
});

describe('without the cross_account_runners feature', () => {
  beforeEach(() => { mockFeatures = new Set(); });

  it('the Deployment card has no "Runs via" row, even if the registry carried one', async () => {
    api.listPipelineDeployments.mockResolvedValue({ success: true, data: { registry: [row({ runner: { id: 'r1', label: 'Production' } })], pagination: { hasMore: false } } });
    render(<PipelineDetailPage />);
    expect(await screen.findByText('web-stack')).toBeInTheDocument();
    expect(screen.queryByTestId('deployment-runner')).not.toBeInTheDocument();
    expect(screen.queryByText(/Runs via/)).not.toBeInTheDocument();
  });

  it('Re-run behaves exactly as before: 202 { executionId } toasts, nothing is polled', async () => {
    api.triggerPipelineExecution.mockResolvedValue({ success: true, data: { executionId: 'e-new' } });
    await rerun();
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Started execution e-new'));
    await advance(30_000);
    expect(api.getRunRequest).not.toHaveBeenCalled();
    expect(screen.queryByTestId('run-request-status')).not.toBeInTheDocument();
  });

  it('Stop behaves exactly as before', async () => {
    api.stopPipelineExecution.mockResolvedValue({ success: true, data: { stopped: true } });
    await stop();
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Execution canceled'));
    await advance(30_000);
    expect(api.getRunRequest).not.toHaveBeenCalled();
  });

  it('a queued 202 the server does return is still followed (handled generically)', async () => {
    api.getRunRequest.mockResolvedValue(rr({ status: 'started', executionId: 'e-7' }));
    await rerun();
    expect(await screen.findByTestId('run-request-status')).toHaveTextContent('Queued for runner Production');
    await advance(RUN_REQUEST_POLL.initialMs);
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Started execution e-7'));
  });
});

describe('review fixes', () => {
  it('a final refusal of the STATUS READ is "lost track", not blamed on the runner (the run may still go ahead)', async () => {
    api.getRunRequest.mockRejectedValue(new ApiError('Session expired', 403, 'FORBIDDEN'));
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.initialMs);
    expect(await screen.findByText(/Could not follow the Re-run request/)).toBeInTheDocument();
    expect(screen.getByText(/It may still go ahead/)).toBeInTheDocument();
    expect(screen.queryByTestId('runner-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-request-status')).not.toBeInTheDocument();
  });

  it('reads failing until the hard cap are "lost track", not RUN_REQUEST_EXPIRED ("nothing was started")', async () => {
    api.getRunRequest.mockRejectedValue(new TypeError('network down'));
    await rerun();
    await screen.findByTestId('run-request-status');
    await advance(RUN_REQUEST_POLL.hardCapMs + 10 * RUN_REQUEST_POLL.maxMs);
    expect(await screen.findByText(/Could not follow the Re-run request/)).toBeInTheDocument();
    expect(screen.queryByTestId('runner-error')).not.toBeInTheDocument();
    const n = api.getRunRequest.mock.calls.length;
    await advance(60_000);
    expect(api.getRunRequest.mock.calls.length).toBe(n);
  });

  it('stopping an execution the page is following toasts ONCE ("Execution canceled"), not again when it ends Stopped', async () => {
    let stopped = false;
    api.triggerPipelineExecution.mockResolvedValue({ success: true, data: { requestId: 'rq1', status: 'queued', runnerLabel: 'Production' } });
    api.stopPipelineExecution.mockImplementation(async () => ({ success: true, data: { requestId: 'rq2', status: 'queued', runnerLabel: 'Production' } }));
    api.getRunRequest.mockImplementation(async (_p: unknown, requestId: unknown) => {
      if (requestId === 'rq2') { stopped = true; return rr({ requestId: 'rq2', action: 'stop', status: 'stopped', executionId: 'e-run' }); }
      return rr({ status: 'started', executionId: 'e-run', executionStatus: stopped ? 'Stopped' : 'InProgress' });
    });
    mockRouter.query = { id: 'p1', tab: 'runs' };
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-run/ }));
    await advance(RUN_REQUEST_POLL.initialMs);
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Started execution e-run'));
    fireEvent.click((await screen.findAllByRole('button', { name: /^Cancel$/ }))[0]);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Cancel execution/ }));
    await advance(RUN_REQUEST_POLL.initialMs);
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Execution canceled'));
    await advance(3 * RUN_REQUEST_POLL.executionMs);
    // The follow-up saw it end Stopped and stopped polling — without a second toast.
    expect(screen.queryByTestId('run-request-execution-status')).not.toBeInTheDocument();
    expect(pageToast.warning).not.toHaveBeenCalled();
  });

  it('a followed execution that ends Stopped WITHOUT this page stopping it is still reported', async () => {
    api.getRunRequest
      .mockResolvedValueOnce(rr({ status: 'started', executionId: 'e-9', executionStatus: 'InProgress' }))
      .mockResolvedValueOnce(rr({ status: 'started', executionId: 'e-9', executionStatus: 'Stopped' }));
    await rerun();
    await advance(RUN_REQUEST_POLL.initialMs);
    await advance(RUN_REQUEST_POLL.executionMs);
    await waitFor(() => expect(pageToast.warning).toHaveBeenCalledWith('Execution e-9 stopped'));
  });
});

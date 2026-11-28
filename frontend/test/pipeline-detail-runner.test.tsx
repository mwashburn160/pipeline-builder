// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline detail page × pipeline runners.
 *  - Re-run / Stop answered `202 { requestId, status: 'queued', runnerLabel }`:
 *    "Queued for runner <label>", then GET …/run-requests/:id with backoff until
 *    a terminal state → a success toast, or the error code's banner (linking to
 *    Settings → Pipeline runners where that is the fix). Polling stops on
 *    unmount, and a request still pending past its expiry reads as expired.
 *  - A synchronous refusal with a runner code gets the same banner (NO_RUNNER,
 *    the expected first-run state, links to Install a runner).
 *  - Every run goes through a runner: there is no `{ executionId }` answer and
 *    no feature gate.
 *  - The Deployment card's "Runs via" is the runner link status (Linked / Not
 *    linked yet / Not found / Two runners matched / Checking) with Find runner
 *    again behind step-up; the page shows pause and unhealthy-runner banners.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import { ApiError, MfaRequiredError } from '../src/lib/api/errors';
import { PIPELINE_RUNNERS_HREF, RUNNER_ERROR_COPY } from '../src/lib/pipeline-runners';
import { RUN_REQUEST_POLL } from '../src/hooks/useRunRequestTracker';
import { runnerErrorBanner, runnerErrorMessage } from '../src/components/pipeline/RunnerError';
import { RUNNER_LINK_CHECK_STALE_MS } from '../src/components/pipeline/RunnerLinkStatus';
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
// The step-up dialog has its own suite: here it shows its copy and confirms with a fixed token.
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
  getPipelineRunnerLink: jest.fn<AnyFn>(),
  refreshPipelineRunnerLink: jest.fn<AnyFn>(),
  testPipelineRunner: jest.fn<AnyFn>(),
  getRegisterRunners: jest.fn<AnyFn>(),
  registerPipelineDeployment: jest.fn<AnyFn>(),
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
const linkDto = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    pipelineId: 'p1', status: 'linked', runner: { id: 'r1', label: 'Production', health: 'healthy', lastDeliveryAt: '2026-11-17T00:00:00Z', ownerOrgName: null, isOwn: true },
    checkedAt: '2026-11-18T00:00:00Z', detail: { runnersChecked: ['Production'], matched: ['Production'], errorCode: null }, deliveriesPaused: false, ...over,
  },
});
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
  api.getPipelineRunnerLink.mockResolvedValue(linkDto());
  api.refreshPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'checking' }));
  api.testPipelineRunner.mockResolvedValue({ success: true, data: { ok: true, outcome: 'pong' } });
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
      'PIPELINE_NOT_FOUND_IN_RUNNERS', 'PIPELINE_NOT_TAGGED', 'RUNNERS_UNAVAILABLE', 'RUNNER_ERROR', 'RUNNER_KEY_CONFIRMATION_MISMATCH',
      'RUNNER_KEY_EXISTS', 'RUNNER_KEY_INHERITED', 'RUNNER_KEY_MISSING', 'RUNNER_KEY_MODE_ROOT_ORG', 'RUNNER_KEY_NO_ROTATION',
      'RUNNER_KEY_RETIRE_TOO_EARLY', 'RUNNER_KEY_TRANSITION_IN_PROGRESS', 'RUNNER_KEY_UNREADABLE', 'RUNNER_LIMIT', 'RUNNER_NOT_ELIGIBLE',
      'RUNNER_PENDING', 'RUNNER_PERMISSION_DENIED', 'RUNNER_PING_FAILED', 'RUNNER_REFUSED', 'RUNNER_REVOKED', 'RUNNER_UNREACHABLE',
      'RUNNER_UPDATE_REQUIRED', 'RUN_REQUEST_EXPIRED', 'RUN_REQUEST_RATE_LIMITED', 'SIGNATURE_INVALID', 'TOO_MANY_PENDING',
      // The deploy-through-a-runner codes (placeholder copy from lane A0).
      'ALREADY_DEPLOYED', 'DEPLOY_BUILD_NOT_FOUND', 'DEPLOY_BUSY', 'DEPLOY_GRANT_INVALID', 'DEPLOY_IN_PROGRESS', 'DEPLOY_NOT_CANCELLABLE',
      'DEPLOY_NOT_ENABLED', 'DEPLOY_RATE_LIMITED', 'DEPLOY_REGION_NOT_ALLOWED', 'DEPLOY_RUNNER_REQUIRED', 'PIPELINE_ALREADY_DEPLOYED',
      'RUNNER_DEPLOY_UNSUPPORTED', 'RUNNER_NOT_DEPLOYABLE', 'TOOLCHAIN_TOO_OLD_FOR_DEPLOY', 'TOO_MANY_DEPLOYS',
    ].sort());
  });

  it('RUNNERS_UNAVAILABLE names its reason: a key-service outage is not an operator pause', () => {
    const { unmount } = render(<>{runnerErrorMessage(new ApiError('x', 409, 'RUNNERS_UNAVAILABLE', { reason: 'key_service' }))}</>);
    const banner = screen.getByTestId('runner-error');
    expect(banner).toHaveTextContent("Runs can't be signed right now because the key service is unreachable. Queued runs retry automatically.");
    expect(banner).not.toHaveTextContent(/paused/i);
    unmount();
    render(<>{runnerErrorMessage(new ApiError('x', 409, 'RUNNERS_UNAVAILABLE', { reason: 'paused' }))}</>);
    expect(screen.getByTestId('runner-error')).toHaveTextContent('Pipeline runs are paused on this platform.');
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

  it('a synchronous refusal with a runner code (409 NO_RUNNER, the first-run state) gets its banner, with the install link', async () => {
    api.triggerPipelineExecution.mockRejectedValue(new ApiError('No runner', 409, 'NO_RUNNER'));
    await rerun();
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveTextContent('This pipeline needs a runner.');
    expect(banner).toHaveTextContent('one per account per organization');
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

  it('409 RUNNER_KEY_UNREADABLE: the unreadable-key copy, linking to the Signing key card\'s panel', async () => {
    api.triggerPipelineExecution.mockRejectedValue(new ApiError('unreadable', 409, 'RUNNER_KEY_UNREADABLE'));
    await rerun();
    const banner = await screen.findByTestId('runner-error');
    expect(banner).toHaveTextContent("Your signing key can't be read.");
    expect(banner).toHaveTextContent('Runs through your runners are paused until your platform operator fixes it.');
    expect(within(banner).getByRole('link')).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
  });

  it('there is no RUNNERS_NOT_ENABLED copy any more (no feature gate)', () => {
    expect(Object.hasOwn(RUNNER_ERROR_COPY, 'RUNNERS_NOT_ENABLED')).toBe(false);
  });

  it('any other refusal keeps the plain message', async () => {
    api.triggerPipelineExecution.mockRejectedValue(new ApiError('Pipeline not deployed', 404, 'NOT_FOUND'));
    await rerun();
    expect(await screen.findByText('Pipeline not deployed')).toBeInTheDocument();
    expect(screen.queryByTestId('runner-error')).not.toBeInTheDocument();
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

});

describe('Deployment card — runner link', () => {
  it('Linked: "Runs via: <runner label>", last checked', async () => {
    render(<PipelineDetailPage />);
    const status = await screen.findByTestId('runner-link-status');
    expect(status).toHaveAttribute('data-status', 'linked');
    expect(screen.getByTestId('deployment-runner')).toHaveTextContent('Production');
    expect(status).toHaveTextContent(/Linked · checked/);
    expect(screen.getByTestId('runner-link').firstElementChild).toHaveTextContent('Runs via');
    expect(api.getPipelineRunnerLink).toHaveBeenCalledWith('p1', expect.anything());
  });

  it('a parent\'s shared runner names its owner', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ runner: { id: 'r9', label: 'Shared prod', health: 'healthy', lastDeliveryAt: null, ownerOrgName: 'Acme Root', isOwn: false } }));
    render(<PipelineDetailPage />);
    expect(await screen.findByTestId('deployment-runner')).toHaveTextContent('Shared prod (shared by Acme Root)');
  });

  it('Not linked yet', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'unlinked', runner: null, checkedAt: null, detail: null }));
    render(<PipelineDetailPage />);
    const status = await screen.findByTestId('runner-link-status');
    expect(status).toHaveAttribute('data-status', 'unlinked');
    expect(status).toHaveTextContent('Not linked yet');
    expect(screen.queryByTestId('deployment-runner')).not.toBeInTheDocument();
  });

  it('Not found: lists the runners checked, and says when an old link is kept', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'not_found', detail: { runnersChecked: ['Production', 'Staging'], matched: [], errorCode: 'PIPELINE_NOT_FOUND_IN_RUNNERS' } }));
    render(<PipelineDetailPage />);
    const status = await screen.findByTestId('runner-link-status');
    expect(status).toHaveTextContent('Not found');
    expect(status).toHaveTextContent('Runners checked: Production, Staging.');
    expect(screen.getByTestId('runner-link-kept')).toHaveTextContent('Still linked to Production.');
  });

  it('Not found with no runner at all links to Install a runner', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'not_found', runner: null, detail: { runnersChecked: [], matched: [], errorCode: 'NO_RUNNER' } }));
    render(<PipelineDetailPage />);
    const status = await screen.findByTestId('runner-link-status');
    expect(within(status).getByRole('link', { name: 'Install a runner' })).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
  });

  it('Two runners matched: names both, and the one-runner-per-account rule', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'ambiguous', runner: null, detail: { runnersChecked: ['Production', 'Old prod'], matched: ['Production', 'Old prod'], errorCode: 'AMBIGUOUS_RUNNER' } }));
    render(<PipelineDetailPage />);
    const status = await screen.findByTestId('runner-link-status');
    expect(status).toHaveTextContent('Two runners matched: Production and Old prod');
    expect(status).toHaveTextContent(/one runner per AWS account/);
  });

  it('a pipeline that is not registered (404) shows no link row', async () => {
    api.getPipelineRunnerLink.mockRejectedValue(new ApiError('nf', 404, 'NOT_FOUND'));
    render(<PipelineDetailPage />);
    expect(await screen.findByText('web-stack')).toBeInTheDocument();
    expect(screen.queryByTestId('runner-link')).not.toBeInTheDocument();
  });

  it('Find runner again: step-up, then Checking, then the new link once the probe settles', async () => {
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Find runner again/ }));
    expect(api.refreshPipelineRunnerLink).not.toHaveBeenCalled(); // not before the step-up
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.refreshPipelineRunnerLink).toHaveBeenCalledWith('p1', 'tok'));
    const status = await screen.findByTestId('runner-link-status');
    await waitFor(() => expect(screen.getByTestId('runner-link-status')).toHaveAttribute('data-status', 'checking'));
    expect(status).toHaveTextContent('Checking');
    expect(screen.getByRole('button', { name: /Find runner again/ })).toBeDisabled();
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ runner: { id: 'r2', label: 'New prod', health: 'healthy', lastDeliveryAt: null, ownerOrgName: null, isOwn: true } }));
    await advance(3_000);
    await waitFor(() => expect(screen.getByTestId('deployment-runner')).toHaveTextContent('New prod'));
  });

  it('a check that never settles stops polling and offers Find runner again (no permanent lock)', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'checking' }));
    render(<PipelineDetailPage />);
    await waitFor(() => expect(screen.getByTestId('runner-link-status')).toHaveAttribute('data-status', 'checking'));
    expect(screen.getByRole('button', { name: /Find runner again/ })).toBeDisabled();
    await advance(RUNNER_LINK_CHECK_STALE_MS + 3_000);
    await waitFor(() => expect(screen.getByTestId('runner-link-status')).toHaveTextContent('The last check did not finish'));
    expect(screen.getByRole('button', { name: /Find runner again/ })).toBeEnabled();
    const reads = api.getPipelineRunnerLink.mock.calls.length;
    await advance(30_000);
    expect(api.getPipelineRunnerLink.mock.calls.length).toBe(reads);
    // A new refresh starts a fresh check (spinner again, polling again).
    fireEvent.click(screen.getByRole('button', { name: /Find runner again/ }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.refreshPipelineRunnerLink).toHaveBeenCalledWith('p1', 'tok'));
    await waitFor(() => expect(screen.getByTestId('runner-link-status')).toHaveTextContent('Checking'));
    expect(screen.getByRole('button', { name: /Find runner again/ })).toBeDisabled();
  });

  it('Find runner again from a single-factor session: the shell\'s MFA dialog only, no second error on the page', async () => {
    api.refreshPipelineRunnerLink.mockRejectedValue(new MfaRequiredError('Two-factor authentication is required', 'MFA_REQUIRED'));
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Find runner again/ }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.refreshPipelineRunnerLink).toHaveBeenCalledWith('p1', 'tok'));
    await advance(0);
    expect(screen.queryByText('Two-factor authentication is required')).not.toBeInTheDocument();
  });

  it('Find runner again: cancelling the step-up sends nothing', async () => {
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Find runner again/ }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByRole('button', { name: 'Cancel step-up' }));
    expect(api.refreshPipelineRunnerLink).not.toHaveBeenCalled();
  });

  it('Find runner again is not offered to a viewer who cannot write the pipeline', async () => {
    mockAuthGuard({ user: { id: 'u2', organizationId: 'org-1' }, can: (p: string) => p === 'pipelines:read' });
    render(<PipelineDetailPage />);
    await screen.findByTestId('runner-link-status');
    expect(screen.queryByRole('button', { name: /Find runner again/ })).not.toBeInTheDocument();
  });
});

describe('runner banners', () => {
  it('the platform pause toggle shows a banner', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ deliveriesPaused: true }));
    render(<PipelineDetailPage />);
    expect(await screen.findByTestId('runner-paused-banner')).toHaveTextContent('Pipeline runs are paused on this platform.');
  });

  it('an unhealthy runner: last successful contact and a Test button (step-up) for its admins', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ runner: { id: 'r1', label: 'Production', health: 'unreachable', lastDeliveryAt: '2026-11-17T00:00:00Z', ownerOrgName: null, isOwn: true } }));
    render(<PipelineDetailPage />);
    const banner = await screen.findByTestId('runner-unhealthy-banner');
    expect(banner).toHaveTextContent('The runner Production is not answering.');
    expect(banner).toHaveTextContent('Last successful contact');
    fireEvent.click(within(banner).getByRole('button', { name: 'Test' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.testPipelineRunner).toHaveBeenCalledWith('r1', 'tok'));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Production answered'));
  });

  it('an unhealthy runner shared by a parent links to the panel instead of offering Test', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ runner: { id: 'r9', label: 'Shared prod', health: 'unreachable', lastDeliveryAt: null, ownerOrgName: 'Acme Root', isOwn: false } }));
    render(<PipelineDetailPage />);
    const banner = await screen.findByTestId('runner-unhealthy-banner');
    expect(within(banner).queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(within(banner).getByRole('link')).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
  });

  it('an unhealthy runner this org does not own (owner name unknown) offers no Test: isOwn decides, not ownerOrgName', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ runner: { id: 'r9', label: 'Shared prod', health: 'unreachable', lastDeliveryAt: null, ownerOrgName: null, isOwn: false } }));
    render(<PipelineDetailPage />);
    const banner = await screen.findByTestId('runner-unhealthy-banner');
    expect(within(banner).queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(within(banner).getByRole('link')).toHaveAttribute('href', PIPELINE_RUNNERS_HREF);
  });

  it('no banners while the runner answers and runs are not paused', async () => {
    render(<PipelineDetailPage />);
    await screen.findByTestId('runner-link-status');
    expect(screen.queryByTestId('runner-paused-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runner-unhealthy-banner')).not.toBeInTheDocument();
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

/**
 * Run pipeline by where the pipeline stands: registered and linked → it just
 * runs; not registered → register it with a runner, then run once that runner
 * found it; registered with no runner linked → choose the runner, then run.
 */
describe('Run pipeline by registration and runner link', () => {
  const runners = (list: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
    success: true,
    data: { pipelineId: 'p1', available: true, unavailableReason: null, registered: true, hasEvents: true, linkedRunnerId: null, runners: list, ...extra },
  });
  const runnerOf = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, isOwn: true, ownerOrgName: null, regions: ['us-east-1'], health: 'healthy', ...extra });

  it('registered and linked to a runner: Run just runs, no dialog', async () => {
    await rerun();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.getRegisterRunners).not.toHaveBeenCalled();
  });

  it('not registered: Register and run — registers with the runner, then runs once it linked the pipeline', async () => {
    api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: { registered: false, hasEvents: true } } });
    api.getPipelineRunnerLink.mockResolvedValue({ success: false });
    api.getRegisterRunners.mockResolvedValue(runners([runnerOf('r1', 'default')], { registered: false }));
    api.registerPipelineDeployment.mockImplementation(async () => {
      api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'linked', runner: { id: 'r1', label: 'default', health: 'healthy', lastDeliveryAt: null, ownerOrgName: null, isOwn: true } }));
      return { success: true, data: { registry: { id: 'reg-1', pipelineId: 'p1' }, runnerLink: 'checking' } };
    });
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-run/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Register and run' });
    expect(api.triggerPipelineExecution).not.toHaveBeenCalled();
    expect(await within(dialog).findByText(/with the pipeline runner/)).toHaveTextContent('Register acme-web with the pipeline runner default?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register with default and run' }));
    await waitFor(() => expect(api.registerPipelineDeployment).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'p1', runnerId: 'r1' })));

    await advance(2000);
    await waitFor(() => expect(api.triggerPipelineExecution).toHaveBeenCalledWith('p1'));
    expect(screen.queryByRole('dialog', { name: 'Register and run' })).not.toBeInTheDocument();
  });

  it('not registered, and the runner does not find it: registers, says so, and does not run', async () => {
    api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: { registered: false, hasEvents: true } } });
    api.getPipelineRunnerLink.mockResolvedValue({ success: false });
    api.getRegisterRunners.mockResolvedValue(runners([runnerOf('r1', 'default')], { registered: false }));
    api.registerPipelineDeployment.mockImplementation(async () => {
      api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'not_found', runner: null, detail: { runnersChecked: ['default'], matched: [], errorCode: 'PIPELINE_NOT_FOUND' } }));
      return { success: true, data: { registry: { id: 'reg-1', pipelineId: 'p1' }, runnerLink: 'checking' } };
    });
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-run/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Register and run' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Register with default and run' }));
    await waitFor(() => expect(api.registerPipelineDeployment).toHaveBeenCalled());
    await advance(2000);
    await advance(2000);
    expect(await screen.findByText(/default did not find this pipeline/)).toBeInTheDocument();
    expect(api.triggerPipelineExecution).not.toHaveBeenCalled();
  });

  it('registered with no runner linked: choose the runner, and the run goes through it', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'unlinked', runner: null }));
    api.getRegisterRunners.mockResolvedValue(runners([runnerOf('r1', 'default'), runnerOf('r2', 'prod'), runnerOf('r3', 'old', { health: 'unreachable' })]));
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-run/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Run pipeline' });
    expect(api.triggerPipelineExecution).not.toHaveBeenCalled();
    expect(await within(dialog).findByLabelText('old — unreachable')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Run' })).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText('prod'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run with prod' }));
    await waitFor(() => expect(api.triggerPipelineExecution).toHaveBeenCalledWith('p1', { runnerId: 'r2' }));
    expect(screen.queryByRole('dialog', { name: 'Run pipeline' })).not.toBeInTheDocument();
  });

  it('registered with no runner linked and only the default runner: asks to run with it', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'not_found', runner: null }));
    api.getRegisterRunners.mockResolvedValue(runners([runnerOf('r1', 'default')]));
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-run/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Run pipeline' });
    expect(await within(dialog).findByText(/with the pipeline runner/)).toHaveTextContent('Run acme-web with the pipeline runner default?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run with default' }));
    await waitFor(() => expect(api.triggerPipelineExecution).toHaveBeenCalledWith('p1', { runnerId: 'r1' }));
  });

  it('registered with no runner linked and no runner to run with: says why, Run is held', async () => {
    api.getPipelineRunnerLink.mockResolvedValue(linkDto({ status: 'unlinked', runner: null }));
    api.getRegisterRunners.mockResolvedValue(runners([], { available: false, unavailableReason: 'paused' }));
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-run/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Run pipeline' });
    expect(await within(dialog).findByText('Pipeline runs are paused on this platform.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Run' })).toBeDisabled();
  });
});

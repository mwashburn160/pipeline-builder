// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useDeployRequestTracker / pollDeployRequest:
 *  - reads GET …/deploys/:requestId at 2 s, backing off ×1.5 to 10 s, until a
 *    terminal status (deployed / failed / expired / cancelled);
 *  - transient read failures (network, 429, 5xx) are retried; any other
 *    refusal ends the follow as `lost`;
 *  - a deploy still active past its deadline (deadlineAt, or the 10-minute
 *    delivery lifetime before the runner accepted) plus the grace is `lost` —
 *    the server's sweep decides, never the page;
 *  - the hook resumes the pipeline's latest deploy on mount (GET …/deploys/latest),
 *    follows an active one, shows a finished one, and stops on unmount.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '../src/lib/api/errors';

const api = {
  getPipelineDeploy: jest.fn<AnyFn>(),
  getLatestPipelineDeploy: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

import { DEPLOY_POLL, pollDeployRequest, useDeployRequestTracker } from '../src/hooks/useDeployRequestTracker';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const dto = (over: Record<string, unknown> = {}) => ({
  requestId: 'd1', pipelineId: 'p1', status: 'queued', stage: 'queued', runnerId: 'r1', runnerLabel: 'prod', region: 'us-east-1',
  errorCode: null, failureClass: null, retryable: false, requestedAt: new Date(NOW).toISOString(), acceptedAt: null, finishedAt: null,
  deadlineAt: null, logHint: null, ...over,
});
const ok = (over: Record<string, unknown> = {}) => ({ success: true, data: dto(over) });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => { jest.useRealTimers(); });

const advance = async (ms: number) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };

describe('pollDeployRequest', () => {
  it('backs off 2 s → 10 s and settles on a terminal status', async () => {
    const read = jest.fn<AnyFn>()
      .mockResolvedValueOnce(ok({ status: 'delivering' }))
      .mockResolvedValueOnce(ok({ status: 'deploying', stage: 'synthesizing', deadlineAt: new Date(NOW + 7_200_000).toISOString() }))
      .mockResolvedValue(ok({ status: 'deployed', stage: 'done' }));
    const ctl = new AbortController();
    const onUpdate = jest.fn<AnyFn>();
    const p = pollDeployRequest(read, { signal: ctl.signal, onUpdate });
    expect(DEPLOY_POLL.initialMs).toBe(2000);
    expect(DEPLOY_POLL.maxMs).toBe(10_000);
    await jest.advanceTimersByTimeAsync(1999);
    expect(read).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(4500);
    const r = await p;
    expect(r).toEqual({ kind: 'settled', deploy: expect.objectContaining({ status: 'deployed' }) });
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it('never waits longer than 10 s between reads', async () => {
    const read = jest.fn<AnyFn>().mockResolvedValue(ok({ status: 'deploying', deadlineAt: new Date(NOW + 7_200_000).toISOString() }));
    const ctl = new AbortController();
    void pollDeployRequest(read, { signal: ctl.signal });
    await jest.advanceTimersByTimeAsync(60_000);
    const calls = read.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(read.mock.calls.length).toBe(calls + 1);
    ctl.abort();
  });

  it('retries transient failures and ends on a final refusal as lost', async () => {
    const read = jest.fn<AnyFn>()
      .mockRejectedValueOnce(new ApiError('busy', 503))
      .mockRejectedValueOnce(new ApiError('nope', 403, 'FORBIDDEN'));
    const p = pollDeployRequest(read, { signal: new AbortController().signal });
    await jest.advanceTimersByTimeAsync(2000 + 3000);
    expect(await p).toEqual({ kind: 'lost', error: expect.any(ApiError), deploy: null });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a deploy still active past its deadline plus the grace is lost, not failed', async () => {
    const deadline = NOW + 60_000;
    const read = jest.fn<AnyFn>().mockResolvedValue(ok({ status: 'deploying', deadlineAt: new Date(deadline).toISOString() }));
    const p = pollDeployRequest(read, { signal: new AbortController().signal });
    await jest.advanceTimersByTimeAsync(60_000 + DEPLOY_POLL.deadlineGraceMs + 20_000);
    expect(await p).toEqual({ kind: 'lost', error: expect.any(Error), deploy: expect.objectContaining({ status: 'deploying' }) });
  });

  it('before the runner accepted, the 10-minute delivery lifetime is the deadline', async () => {
    const read = jest.fn<AnyFn>().mockResolvedValue(ok({ status: 'queued' }));
    const p = pollDeployRequest(read, { signal: new AbortController().signal });
    await jest.advanceTimersByTimeAsync(600_000 + DEPLOY_POLL.deadlineGraceMs + 20_000);
    expect((await p)?.kind).toBe('lost');
  });

  it('resolves null on abort without another read', async () => {
    const read = jest.fn<AnyFn>().mockResolvedValue(ok({ status: 'queued' }));
    const ctl = new AbortController();
    const p = pollDeployRequest(read, { signal: ctl.signal });
    ctl.abort();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('useDeployRequestTracker', () => {
  it('resumes the latest active deploy on mount and follows it to the end', async () => {
    api.getLatestPipelineDeploy.mockResolvedValue(ok({ status: 'deploying', stage: 'deploying', deadlineAt: new Date(NOW + 7_200_000).toISOString() }));
    api.getPipelineDeploy.mockResolvedValue(ok({ status: 'deployed', stage: 'done' }));
    const onSettled = jest.fn<AnyFn>();
    const { result } = renderHook(() => useDeployRequestTracker('p1', { onSettled }));
    await waitFor(() => expect(result.current.deploy?.status).toBe('deploying'));
    expect(result.current.following).toBe(true);
    await advance(2000);
    await waitFor(() => expect(result.current.deploy?.status).toBe('deployed'));
    expect(result.current.following).toBe(false);
    expect(api.getPipelineDeploy).toHaveBeenCalledWith('p1', 'd1', expect.anything());
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'deployed' }));
  });

  it('shows a finished latest deploy without following it, and none when there is none', async () => {
    api.getLatestPipelineDeploy.mockResolvedValueOnce(ok({ status: 'failed', errorCode: 'CFN_DEPLOY_FAILED', failureClass: 'cloudformation', retryable: true }));
    const { result } = renderHook(() => useDeployRequestTracker('p1'));
    await waitFor(() => expect(result.current.deploy?.status).toBe('failed'));
    expect(result.current.following).toBe(false);
    await advance(20_000);
    expect(api.getPipelineDeploy).not.toHaveBeenCalled();

    api.getLatestPipelineDeploy.mockRejectedValueOnce(new ApiError('none', 404, 'NOT_FOUND'));
    const second = renderHook(() => useDeployRequestTracker('p2'));
    await waitFor(() => expect(second.result.current.resumed).toBe(true));
    expect(second.result.current.deploy).toBeNull();
  });

  it('track() follows a just-queued deploy; unmount stops polling', async () => {
    api.getLatestPipelineDeploy.mockResolvedValue({ success: true, data: null });
    api.getPipelineDeploy.mockResolvedValue(ok({ status: 'delivering' }));
    const { result, unmount } = renderHook(() => useDeployRequestTracker('p1'));
    await waitFor(() => expect(result.current.resumed).toBe(true));
    act(() => { result.current.track({ requestId: 'd1', status: 'queued', runnerLabel: 'prod', region: 'us-east-1', reused: false }); });
    expect(result.current.deploy).toEqual(expect.objectContaining({ requestId: 'd1', status: 'queued', runnerLabel: 'prod', region: 'us-east-1', stage: 'queued' }));
    await advance(2000);
    expect(api.getPipelineDeploy).toHaveBeenCalledTimes(1);
    unmount();
    await advance(60_000);
    expect(api.getPipelineDeploy).toHaveBeenCalledTimes(1);
  });
});

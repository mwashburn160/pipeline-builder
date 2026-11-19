// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** What a runner's answer means, and how one signed request is POSTed (no network). */

import { describe, expect, it } from '@jest/globals';
import { RUNNER_API_ERROR_CODES, RUNNER_ERRORS, RUNNER_REPLY_ERROR_CODES, runnerErrorStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { deliverPush, interpretReply } from '../../src/runners/delivery.js';
import { verifyEdDsaJws } from '../../src/runners/jws.js';
import { RunnerRouteError } from '../../src/runners/routing.js';
import { claimsOf, reply, runnerRow, testDeps, URL_A } from '../helpers/runner-fakes.js';

describe('interpretReply', () => {
  it.each([
    [200, { outcome: 'started', executionId: 'e-1', runnerVersion: '1.0' }, { kind: 'success', outcome: 'started', executionId: 'e-1', runnerVersion: '1.0' }],
    [200, { outcome: 'pong', regions: ['us-east-1', 'bogus', 7] }, { kind: 'success', outcome: 'pong', regions: ['us-east-1'] }],
    [200, { outcome: 'exploded' }, { kind: 'fail', code: 'RUNNER_ERROR' }],
    [200, 'not json', { kind: 'fail', code: 'RUNNER_ERROR' }],
    [429, {}, { kind: 'retry', code: 'http_429', transport: true }],
    [503, { errorCode: 'RUNNER_ERROR' }, { kind: 'retry', code: 'http_5xx', transport: true }],
    [409, { errorCode: 'NOT_YET_VISIBLE' }, { kind: 'not_yet_visible' }],
    [409, { errorCode: 'DUPLICATE' }, { kind: 'retry', code: 'DUPLICATE', transport: false }],
    [409, { errorCode: 'PIPELINE_IDENTITY_MISMATCH', runnerVersion: '2' }, { kind: 'fail', code: 'PIPELINE_IDENTITY_MISMATCH', runnerVersion: '2' }],
    [403, { errorCode: 'RUNNER_REFUSED' }, { kind: 'fail', code: 'RUNNER_REFUSED' }],
    [401, { errorCode: 'SIGNATURE_INVALID' }, { kind: 'fail', code: 'SIGNATURE_INVALID' }],
    [400, { errorCode: 'SOMETHING_NEW' }, { kind: 'fail', code: 'RUNNER_ERROR' }],
    [404, {}, { kind: 'fail', code: 'RUNNER_ERROR' }],
    // AWS (not the runner) refusing a deleted / re-authed Function URL.
    [403, { Message: 'Forbidden' }, { kind: 'retry', code: 'aws_403_url_gone', transport: true, immediate: true }],
    [200, { outcome: 'status', executionId: 'e', executionStatus: 'InProgress' }, { kind: 'success', outcome: 'status', executionId: 'e', executionStatus: 'InProgress' }],
  ])('HTTP %s %j', (status, body, verdict) => {
    expect(interpretReply(status, body)).toEqual(verdict);
  });

  // The catalog's `retryable` is the dispatcher's contract: a runner code is
  // delivered again exactly when the catalog says so, at the catalog's status.
  it.each([...RUNNER_REPLY_ERROR_CODES])('%s at its catalog status: retried iff the catalog says retryable', (code) => {
    const v = interpretReply(runnerErrorStatus(code), { errorCode: code });
    expect([code, v.kind !== 'fail']).toEqual([code, RUNNER_ERRORS[code].retryable]);
    if (v.kind === 'fail') expect(v.code).toBe(code);
  });
});

describe('RunnerRouteError', () => {
  it.each([...RUNNER_API_ERROR_CODES])('%s answers with the catalog status', (code) => {
    expect(new RunnerRouteError(code, 'm').status).toBe(RUNNER_ERRORS[code].httpStatus);
  });

  it('keeps the generic codes\' statuses', () => {
    expect(new RunnerRouteError('VALIDATION_ERROR', 'm').status).toBe(400);
    expect(new RunnerRouteError('NOT_FOUND', 'm').status).toBe(404);
    expect(new RunnerRouteError('AMBIGUOUS_PIPELINE', 'm').status).toBe(409);
  });
});

describe('deliverPush', () => {
  const claims = (action: 'start' | 'stop' | 'probe' | 'ping' = 'start') => ({ runnerId: 'r-1', requestId: 'q-1', action, pipelineId: 'p', requestedBy: 'u' });

  it('POSTs the compact JWS as application/jwt to the Function URL, 10 s timeout', async () => {
    const deps = testDeps();
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'started', executionId: 'e-9' }));
    const runner = runnerRow({ id: 'r-1' });
    expect(await deliverPush(deps, runner, claims())).toEqual({ kind: 'success', outcome: 'started', executionId: 'e-9' });
    const [url, opts] = deps.fetchMock.mock.calls[0]!;
    expect(url).toBe(URL_A);
    expect(opts).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/jwt' }, timeoutMs: 10_000 });
    const jws = String(opts.body);
    expect(verifyEdDsaJws(jws, deps.signer()!.jwks().keys).payload).toMatchObject({ aud: 'r-1', jti: 'q-1', action: 'start' });
    expect(claimsOf(jws).exp).toBe((claimsOf(jws).iat as number) + 600);
    expect(deps.counters).toContainEqual(['pipeline_runner_delivery_total', { outcome: 'started' }]);
  });

  it('classifies transport failures (timeout / conn_refused / dns_nxdomain — the last one immediate)', async () => {
    const deps = testDeps();
    deps.fetchMock.mockRejectedValueOnce(new Error('Request timed out'));
    expect(await deliverPush(deps, runnerRow(), claims())).toEqual({ kind: 'retry', code: 'timeout', transport: true });
    deps.fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    expect(await deliverPush(deps, runnerRow(), claims())).toEqual({ kind: 'retry', code: 'conn_refused', transport: true });
    deps.fetchMock.mockRejectedValueOnce(new Error('URL resolves to a private address'));
    expect(await deliverPush(deps, runnerRow(), claims())).toEqual({ kind: 'retry', code: 'conn_refused', transport: true });
    deps.fetchMock.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND abc.lambda-url.us-east-1.on.aws'), { code: 'ENOTFOUND' }));
    expect(await deliverPush(deps, runnerRow(), claims())).toEqual({ kind: 'retry', code: 'dns_nxdomain', transport: true, immediate: true });
  });

  it('a redirect is refused, an unparseable body is a runner error, and an outcome must fit the action', async () => {
    const deps = testDeps();
    deps.fetchMock.mockResolvedValueOnce(reply(302, {}, { redirected: true }));
    expect(await deliverPush(deps, runnerRow(), claims())).toEqual({ kind: 'fail', code: 'RUNNER_ERROR' });
    deps.fetchMock.mockResolvedValueOnce({ ...reply(200, {}), json: () => { throw new Error('bad json'); } });
    expect(await deliverPush(deps, runnerRow(), claims())).toEqual({ kind: 'fail', code: 'RUNNER_ERROR' });
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'pong' }));
    expect(await deliverPush(deps, runnerRow(), claims('start'))).toEqual({ kind: 'fail', code: 'RUNNER_ERROR' });
  });

  it('without a signer or a URL nothing is sent', async () => {
    const deps = testDeps({ signer: () => null });
    expect(await deliverPush(deps, runnerRow(), claims())).toEqual({ kind: 'fail', code: 'RUNNERS_UNAVAILABLE' });
    const d2 = testDeps();
    expect(await deliverPush(d2, runnerRow({ functionUrl: '' }), claims())).toEqual({ kind: 'fail', code: 'RUNNER_ERROR' });
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(d2.fetchMock).not.toHaveBeenCalled();
  });
});

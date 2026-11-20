// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** What a runner's answer means, and how one signed request is POSTed (no network). */

import { describe, expect, it } from '@jest/globals';
import { RUNNER_API_ERROR_CODES, RUNNER_DELIVERY_FAILURE_CLASSES, RUNNER_ERROR_CODES, RUNNER_ERRORS, RUNNER_REPLY_ERROR_CODES, runnerErrorStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { DELIVERY_METRIC_CODES, deliverPush, deliveryCodeLabel, interpretReply, primeRunnerMetrics } from '../../src/runners/delivery.js';
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
    expect(verifyEdDsaJws(jws, deps.testSigner.jwks().keys).payload).toMatchObject({ aud: 'r-1', jti: 'q-1', action: 'start' });
    // Signed with the key of the org that OWNS the runner (from its row).
    expect(deps.signerOrgs).toEqual([runner.orgId]);
    expect(claimsOf(jws).exp).toBe((claimsOf(jws).iat as number) + 600);
    expect(deps.counters).toContainEqual(['pipeline_runner_delivery_total', { outcome: 'started', code: 'none' }]);
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

  it('paused, a missing or unreadable org key, or no URL: nothing is signed or sent', async () => {
    const paused = testDeps();
    paused.availability.available = false;
    paused.availability.reason = 'paused';
    expect(await deliverPush(paused, runnerRow(), claims())).toEqual({ kind: 'fail', code: 'RUNNERS_UNAVAILABLE' });
    expect(paused.signerOrgs).toEqual([]);
    for (const code of ['RUNNER_KEY_MISSING', 'RUNNER_KEY_UNREADABLE'] as const) {
      const d = testDeps({ signerFor: async () => { throw new RunnerRouteError(code, 'm'); } });
      expect(await deliverPush(d, runnerRow(), claims())).toEqual({ kind: 'fail', code });
      expect(d.fetchMock).not.toHaveBeenCalled();
    }
    const odd = testDeps({ signerFor: async () => { throw new Error('boom'); } });
    expect(await deliverPush(odd, runnerRow(), claims())).toEqual({ kind: 'fail', code: 'RUNNERS_UNAVAILABLE' });
    const d2 = testDeps();
    expect(await deliverPush(d2, runnerRow({ functionUrl: '' }), claims())).toEqual({ kind: 'fail', code: 'RUNNER_ERROR' });
    expect(paused.fetchMock).not.toHaveBeenCalled();
    expect(d2.fetchMock).not.toHaveBeenCalled();
  });
});

describe('pipeline_runner_delivery_total{outcome, code}', () => {
  const claims = (action: 'start' | 'stop' = 'start') => ({ runnerId: 'r-secret-id', requestId: 'q-1', action, pipelineId: 'p', requestedBy: 'u' });
  const last = (deps: ReturnType<typeof testDeps>) => deps.counters.filter(([n]) => n === 'pipeline_runner_delivery_total').at(-1)?.[1];

  it.each([
    ['a start', () => reply(200, { outcome: 'started', executionId: 'e' }), { outcome: 'started', code: 'none' }],
    ['a bad signature', () => reply(401, { errorCode: 'SIGNATURE_INVALID' }), { outcome: 'refused', code: 'SIGNATURE_INVALID' }],
    ['a refusal', () => reply(403, { errorCode: 'RUNNER_REFUSED' }), { outcome: 'refused', code: 'RUNNER_REFUSED' }],
    ['an identity mismatch', () => reply(409, { errorCode: 'PIPELINE_IDENTITY_MISMATCH' }), { outcome: 'refused', code: 'PIPELINE_IDENTITY_MISMATCH' }],
    ['an ambiguous pipeline', () => reply(409, { errorCode: 'AMBIGUOUS_PIPELINE' }), { outcome: 'refused', code: 'AMBIGUOUS_PIPELINE' }],
    ['an unknown runner code', () => reply(400, { errorCode: 'https://attacker.example/x' }), { outcome: 'refused', code: 'RUNNER_ERROR' }],
    ['a 5xx', () => reply(503, {}), { outcome: 'retry', code: 'http_5xx' }],
    ['a 429', () => reply(429, {}), { outcome: 'retry', code: 'http_429' }],
    ['a gone Function URL', () => reply(403, {}), { outcome: 'retry', code: 'aws_403_url_gone' }],
    ['a duplicate', () => reply(409, { errorCode: 'DUPLICATE' }), { outcome: 'retry', code: 'DUPLICATE' }],
    ['a not-yet-visible pipeline', () => reply(409, { errorCode: 'NOT_YET_VISIBLE' }), { outcome: 'not_yet_visible', code: 'NOT_YET_VISIBLE' }],
  ])('%s', async (_name, answer, labels) => {
    const deps = testDeps();
    deps.fetchMock.mockResolvedValueOnce(answer());
    await deliverPush(deps, runnerRow({ id: 'r-secret-id' }), claims());
    expect(last(deps)).toEqual(labels);
  });

  it('a transport failure carries its failure class', async () => {
    const deps = testDeps();
    deps.fetchMock.mockRejectedValueOnce(new Error('Request timed out'));
    await deliverPush(deps, runnerRow(), claims());
    expect(last(deps)).toEqual({ outcome: 'retry', code: 'timeout' });
  });

  it('an outcome that does not fit the action is COUNTED as a refusal (it was not before)', async () => {
    const deps = testDeps();
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'pong' }));
    await deliverPush(deps, runnerRow(), claims('start'));
    expect(last(deps)).toEqual({ outcome: 'refused', code: 'RUNNER_ERROR' });
  });

  it('every delivery carries exactly the same label names (prom-client fixes them on first use)', async () => {
    const deps = testDeps();
    deps.fetchMock
      .mockResolvedValueOnce(reply(200, { outcome: 'started' }))
      .mockResolvedValueOnce(reply(401, { errorCode: 'SIGNATURE_INVALID' }))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    for (let i = 0; i < 3; i++) await deliverPush(deps, runnerRow(), claims());
    const sets = deps.counters.filter(([n]) => n === 'pipeline_runner_delivery_total').map(([, l]) => Object.keys(l).sort().join(','));
    expect(new Set(sets)).toEqual(new Set(['code,outcome']));
  });

  it('the code vocabulary is the catalog\'s error codes + failure classes + none, and nothing else', () => {
    expect([...DELIVERY_METRIC_CODES].sort()).toEqual([...RUNNER_ERROR_CODES, ...RUNNER_DELIVERY_FAILURE_CLASSES, 'none'].sort());
  });

  it('a code outside the vocabulary (an id, a URL) never reaches a label', () => {
    expect(deliveryCodeLabel({ kind: 'fail', code: 'https://abc.lambda-url.us-east-1.on.aws/' })).toBe('none');
    expect(deliveryCodeLabel({ kind: 'fail', code: 'r-1234' })).toBe('none');
    expect(deliveryCodeLabel({ kind: 'fail', code: 'SIGNATURE_INVALID' })).toBe('SIGNATURE_INVALID');
  });

  it('primeRunnerMetrics creates the alerted series at zero, so the FIRST failure shows in increase()', () => {
    const deps = testDeps();
    primeRunnerMetrics(deps);
    const zeroes = deps.counterAdds.filter(([, , v]) => v === 0);
    for (const code of ['SIGNATURE_INVALID', 'RUNNER_REFUSED', 'PIPELINE_IDENTITY_MISMATCH', 'AMBIGUOUS_PIPELINE']) {
      expect(zeroes).toContainEqual(['pipeline_runner_delivery_total', { outcome: 'refused', code }, 0]);
    }
    expect(zeroes).toContainEqual(['pipeline_runner_requests_total', { status: 'expired' }, 0]);
    expect(deps.counterAdds.every(([, , v]) => v === 0)).toBe(true);
  });
});

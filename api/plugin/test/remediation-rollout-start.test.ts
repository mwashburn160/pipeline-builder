// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * startTenantRollout's answer: taken, or the pipeline service's status /
 * network class and whether retrying can help (a 4xx other than 408 / 429 is
 * permanent; 5xx, 408, 429 and an unreachable service are transient).
 */

import { describe, it, expect, jest, afterAll } from '@jest/globals';
import { PIPELINE_REMEDIATION_UPGRADE_STATES, type ContractHttpClient } from '@pipeline-builder/api-core';

jest.unstable_mockModule('../src/services/ecosystem/remediation-fixes.js', () => ({
  clearedFacts: () => ({ advisoryIds: [], criticalCleared: 0, highCleared: 0, kev: false }),
}));

const { isPermanentStartStatus, setRolloutClientForTests, startTenantRollout } = await import('../src/services/remediation/rollout.js');

const ROW = {
  id: '00000000-0000-4000-8000-000000000001',
  orgId: 'aaaaaaaaaaaaaaaaaaaaaaa1',
  pluginName: 'lint',
  fromVersion: '1.0.0',
  toVersion: '1.0.1',
  toPluginId: '00000000-0000-4000-8000-000000000002',
  targeted: [],
  cleared: [],
} as never;

function client(post: (path: string) => Promise<unknown>): ContractHttpClient {
  return { post, get: post, put: post, delete: post } as unknown as ContractHttpClient;
}
const answering = (statusCode: number, body: unknown = {}) => client(async () => ({ statusCode, headers: {}, body }));

afterAll(() => setRolloutClientForTests());

describe('startTenantRollout', () => {
  it('answers ok when the pipeline service takes it', async () => {
    setRolloutClientForTests(answering(200, { data: { remediationId: 'x', created: true, orgDefault: null, counts: Object.fromEntries(PIPELINE_REMEDIATION_UPGRADE_STATES.map((s) => [s, 0])) } }));
    expect(await startTenantRollout(ROW)).toEqual({ ok: true });
  });

  it.each([
    [400, true], [403, true], [404, true], [409, true], [422, true],
    [408, false], [429, false], [500, false], [502, false], [503, false],
  ])('HTTP %i → permanent %s', async (code, permanent) => {
    setRolloutClientForTests(answering(code));
    expect(await startTenantRollout(ROW)).toEqual({ ok: false, status: String(code), permanent });
  });

  it('no answer, or a thrown network error, is transient (unreachable)', async () => {
    setRolloutClientForTests(client(async () => null));
    expect(await startTenantRollout(ROW)).toEqual({ ok: false, status: 'unreachable', permanent: false });
    setRolloutClientForTests(client(async () => { throw Object.assign(new Error('socket hang up'), { name: 'ECONNRESET' }); }));
    expect(await startTenantRollout(ROW)).toEqual({ ok: false, status: 'unreachable', permanent: false });
  });

  it('a 2xx it cannot read is transient (the start may have landed; the pipeline side is idempotent)', async () => {
    setRolloutClientForTests(answering(200, { nope: true }));
    expect(await startTenantRollout(ROW)).toEqual({ ok: false, status: 'invalid_response', permanent: false });
  });

  it('a row with no fix version is not startable (permanent), and nothing is sent', async () => {
    const post = jest.fn(async () => null);
    setRolloutClientForTests(client(post));
    expect(await startTenantRollout({ ...(ROW as object), toPluginId: null } as never)).toEqual({ ok: false, status: 'not_startable', permanent: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('classifies statuses', () => {
    expect(isPermanentStartStatus('request_invalid')).toBe(true);
    expect(isPermanentStartStatus('unreachable')).toBe(false);
    expect(isPermanentStartStatus('invalid_response')).toBe(false);
  });
});

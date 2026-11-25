// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy job's ONLY platform surface (utils/deploy-session-client.ts):
 * the grant exchange (body only, never a header; refusals by reason), and the
 * session-scoped facade that stands in for the API client during
 * fetchPipelineProps — it reaches exactly the facade routes under
 * /api/pipelines/runner/deploys/<requestId>/, for the session's own pipeline,
 * and refuses anything else before any request is sent.
 */

import { describe, expect, it } from '@jest/globals';
import { runnerDeployPath } from '@pipeline-builder/api-core/pipeline-runners';

const { DeployGrantRefusedError, DeploySessionClient, exchangeDeployGrant } = await import('../src/utils/deploy-session-client.js');
type SessionHttp = import('../src/utils/deploy-session-client.js').SessionHttp;

const GRANT = `pb_dg_${'G'.repeat(43)}`;
const TOKEN = `pb_ds_${'S'.repeat(43)}`;
const SESSION = {
  sessionToken: TOKEN,
  expiresAt: '2026-11-25T14:00:00.000Z',
  requestId: 'req-1',
  pipelineId: 'pipe-1',
  region: 'eu-west-2',
  pipelineName: 'acme-shop-pipeline',
  stackName: 'shop-acme',
  toolchainRelease: '1.4.0',
  protocol: 1,
};

interface Call { method: string; url: string; body?: unknown; headers: Record<string, string> }
function fakeHttp(answer: (c: Call) => unknown): { http: SessionHttp; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    http: {
      async request(method, url, body, headers) {
        const c = { method, url, ...(body !== undefined ? { body } : {}), headers };
        calls.push(c);
        const out = answer(c);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}
const refusal = (status: number, data: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

describe('exchangeDeployGrant', () => {
  it('POSTs the grant in the BODY to the request\'s session route, with no Authorization header', async () => {
    const f = fakeHttp(() => ({ success: true, data: SESSION }));
    const s = await exchangeDeployGrant({ requestId: 'req-1', grant: GRANT, http: f.http });
    expect(f.calls).toEqual([{ method: 'POST', url: runnerDeployPath('req-1', 'session'), body: { grant: GRANT }, headers: {} }]);
    expect(s).toEqual(SESSION);
  });

  it('accepts an unwrapped DTO too', async () => {
    const f = fakeHttp(() => SESSION);
    expect(await exchangeDeployGrant({ requestId: 'req-1', grant: GRANT, http: f.http })).toEqual(SESSION);
  });

  it.each([
    ['expired', 'expired'],
    ['reused', 'reused'],
    ['unknown', 'unknown'],
    ['wrong_state', 'wrong_state'],
    [undefined, undefined],
  ])('a 401 DEPLOY_GRANT_INVALID (reason %s) is a refusal carrying its reason', async (reason, expected) => {
    const f = fakeHttp(() => refusal(401, { code: 'DEPLOY_GRANT_INVALID', details: reason ? { reason } : {} }));
    const run = exchangeDeployGrant({ requestId: 'req-1', grant: GRANT, http: f.http });
    await expect(run).rejects.toBeInstanceOf(DeployGrantRefusedError);
    await expect(run).rejects.toMatchObject({ reason: expected });
  });

  it('refuses an answer that is not a session for THIS request (wrong id, malformed token)', async () => {
    for (const bad of [{ ...SESSION, requestId: 'req-2' }, { ...SESSION, sessionToken: 'Bearer x' }, { ...SESSION, protocol: '1' }, null]) {
      const f = fakeHttp(() => ({ data: bad }));
      await expect(exchangeDeployGrant({ requestId: 'req-1', grant: GRANT, http: f.http })).rejects.toThrow(/session/);
    }
  });

  it('a transport failure is thrown as-is (not a grant refusal)', async () => {
    const f = fakeHttp(() => new Error('ECONNREFUSED'));
    const run = exchangeDeployGrant({ requestId: 'req-1', grant: GRANT, http: f.http });
    await expect(run).rejects.toThrow('ECONNREFUSED');
    await expect(run).rejects.not.toBeInstanceOf(DeployGrantRefusedError);
  });

  it('never sends a malformed grant', async () => {
    const f = fakeHttp(() => SESSION);
    await expect(exchangeDeployGrant({ requestId: 'req-1', grant: 'pb_dg_x', http: f.http })).rejects.toThrow(/grant/);
    expect(f.calls).toEqual([]);
  });
});

describe('DeploySessionClient', () => {
  const make = (answer: (c: Call) => unknown = () => ({ ok: true })) => {
    const f = fakeHttp(answer);
    return { ...f, client: new DeploySessionClient({ baseUrl: 'https://platform.example', session: SESSION, http: f.http }) };
  };
  const auth = { Authorization: `Bearer ${TOKEN}` };

  it('looks like the CLI\'s config to fetchPipelineProps (the platform base URL, the standard pipeline route)', () => {
    const { client } = make();
    expect(client.getConfig().api).toMatchObject({ baseUrl: 'https://platform.example', pipelineUrl: '/api/pipelines' });
  });

  it('GET of the session\'s pipeline goes to the facade `pipeline` leaf, with the session token', async () => {
    const { client, calls } = make(() => ({ data: { pipeline: { id: 'pipe-1' } } }));
    expect(await client.get('/api/pipelines/pipe-1')).toEqual({ data: { pipeline: { id: 'pipe-1' } } });
    expect(calls).toEqual([{ method: 'GET', url: runnerDeployPath('req-1', 'pipeline'), headers: auth }]);
  });

  it('a plugin lookup goes to the facade `plugin-lookup` leaf, body unchanged', async () => {
    const { client, calls } = make();
    const body = { filter: { name: 'cdk-synth' }, releasePin: '1.4.0' };
    await client.post('/api/plugins/lookup', body);
    expect(calls).toEqual([{ method: 'POST', url: runnerDeployPath('req-1', 'plugin-lookup'), body, headers: auth }]);
  });

  it('progress, registry and result post to their leaves', async () => {
    const { client, calls } = make();
    await client.progress('synthesizing');
    await client.registry({ pipelineName: 'acme-shop-pipeline', stackName: 'shop-acme', region: 'eu-west-2', steps: [] });
    await client.result({ code: 'OK', stage: 'done' });
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      [runnerDeployPath('req-1', 'progress'), { stage: 'synthesizing' }],
      [runnerDeployPath('req-1', 'registry'), { pipelineName: 'acme-shop-pipeline', stackName: 'shop-acme', region: 'eu-west-2', steps: [] }],
      [runnerDeployPath('req-1', 'result'), { code: 'OK', stage: 'done' }],
    ]);
  });

  it('refuses, before sending anything: another pipeline, any other route, any write verb', async () => {
    const { client, calls } = make();
    await expect(client.get('/api/pipelines/pipe-2')).rejects.toThrow(/session/);
    await expect(client.get('/api/pipelines/registry')).rejects.toThrow(/session/);
    await expect(client.get('/api/plugins/lookup')).rejects.toThrow(/session/);
    await expect(client.post('/api/pipelines/registry', {})).rejects.toThrow(/session/);
    await expect(client.post('/api/pipelines', {})).rejects.toThrow(/session/);
    expect(calls).toEqual([]);
  });
});

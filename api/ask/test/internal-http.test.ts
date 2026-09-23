// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's token-forwarding clients must resolve their base URLs from the
 * REAL typed `server.services` config (PIPELINE_SERVICE_HOST/PORT,
 * PLUGIN_SERVICE_HOST/PORT — what every deploy sets). They previously read
 * PIPELINE_URL / PLUGIN_URL, which no deploy defines, so a non-default host or
 * port was silently ignored. Only `fetch` is stubbed.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';

process.env.PIPELINE_SERVICE_HOST = 'pipeline-svc.internal';
process.env.PIPELINE_SERVICE_PORT = '4100';
process.env.PLUGIN_SERVICE_HOST = 'plugin-svc.internal';
process.env.PLUGIN_SERVICE_PORT = '4200';
process.env.PLATFORM_SERVICE_HOST = 'platform-svc.internal';
process.env.PLATFORM_SERVICE_PORT = '4300';
process.env.COMPLIANCE_SERVICE_HOST = 'compliance-svc.internal';
process.env.COMPLIANCE_SERVICE_PORT = '4400';
process.env.REPORTING_SERVICE_HOST = 'reporting-svc.internal';
process.env.REPORTING_SERVICE_PORT = '4500';
process.env.QUOTA_SERVICE_HOST = 'quota-svc.internal';
process.env.QUOTA_SERVICE_PORT = '4600';
// Set to prove the dead env vars are NOT consulted.
process.env.PIPELINE_URL = 'http://wrong-pipeline:1';
process.env.PLUGIN_URL = 'http://wrong-plugin:1';

const { pipelineClient, pluginClient, platformClient, complianceClient, reportingClient, quotaClient, readInstanceEmailStatus } =
  await import('../src/services/internal-http.js');

const realFetch = globalThis.fetch;
const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe('internal-http service discovery', () => {
  it('pipelineClient targets server.services.pipelineHost:pipelinePort with the user token', async () => {
    await pipelineClient('Bearer USER').get('/pipelines?limit=1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://pipeline-svc.internal:4100/pipelines?limit=1');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer USER');
  });

  it('pluginClient targets server.services.pluginHost:pluginPort', async () => {
    await pluginClient('Bearer USER').post('/plugins/generate', { prompt: 'x' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://plugin-svc.internal:4200/plugins/generate');
    expect(init!.method).toBe('POST');
  });
});

describe('internal-http — the diagnosis clients', () => {
  /**
   * Every client the agent's tools use resolves from the SAME typed
   * `server.services` config and forwards the CALLER's bearer. The agent holds
   * no service principal, so a client that minted its own identity would let a
   * tool read something the asking user cannot.
   */
  it.each([
    ['platformClient', () => platformClient('Bearer USER'), '/config', 'http://platform-svc.internal:4300/config'],
    ['complianceClient', () => complianceClient('Bearer USER'), '/compliance/notification-preferences', 'http://compliance-svc.internal:4400/compliance/notification-preferences'],
    ['reportingClient', () => reportingClient('Bearer USER'), '/reports/execution/dora', 'http://reporting-svc.internal:4500/reports/execution/dora'],
    ['quotaClient', () => quotaClient('Bearer USER'), '/quotas', 'http://quota-svc.internal:4600/quotas'],
  ])('%s targets its configured host:port and forwards the user token', async (_name, make, path, expected) => {
    await make().get(path);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(expected);
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer USER');
  });

  it('forwards the user token on POST too (the compliance dry-run)', async () => {
    await complianceClient('Bearer USER').post('/compliance/validate/pipeline/dry-run', { attributes: {} });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://compliance-svc.internal:4400/compliance/validate/pipeline/dry-run');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer USER');
  });
});

describe('internal-http error surface', () => {
  it('reports status only — never the downstream error body (it reaches the model/user)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'SELECT * FROM secrets failed', stack: 'at internal.js:1' }), { status: 500 }));
    await expect(pipelineClient('Bearer USER').get('/pipelines/x')).rejects.toThrow(/^GET \/pipelines\/x -> 500$/);
  });
});

// ---------------------------------------------------------------------------
// The ONE call that does not forward the caller's token.
//
// `GET /internal/notify-email/status` is platform's AUTHORITATIVE answer to
// "can this instance send email at all", and it is `requireInternalService`, so
// it takes ask's OWN service identity. That is safe precisely because the answer
// is one instance-wide boolean — no org, no recipient, no provider — and because
// ask is NOT a caller of the send route, so the same identity can never make
// platform send anything.
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The claims of a compact JWS, without verifying it (the payload is all we assert). */
function claimsOf(header: string): Record<string, unknown> {
  const token = header.replace(/^Bearer /, '');
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('readInstanceEmailStatus — the authoritative email switch', () => {
  it('asks platform\'s INTERNAL status route with ask\'s own SERVICE token, not a user bearer', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { enabled: true } }));
    await readInstanceEmailStatus();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://platform-svc.internal:4300/internal/notify-email/status');
    const auth = (init!.headers as Record<string, string>).Authorization;
    expect(auth).not.toBe('Bearer USER');
    // A service principal naming THIS service — the claim the route's caller
    // list matches, cryptographically bound to ask's signing key.
    expect(claimsOf(auth)).toMatchObject({ sub: 'service:ask', principalType: 'service', role: 'member' });
  });

  it.each([
    [{ data: { enabled: true } }, 'enabled'],
    [{ data: { enabled: false } }, 'disabled'],
    [{ enabled: true }, 'enabled'],
    // A body that does not answer is not an answer.
    [{ data: {} }, 'unknown'],
  ])('maps %j to %s', async (body, expected) => {
    fetchMock.mockResolvedValueOnce(json(body));
    await expect(readInstanceEmailStatus()).resolves.toBe(expected);
  });

  it('resolves UNKNOWN (never "disabled") when platform refuses the token', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Internal service calls only' }, 403));
    await expect(readInstanceEmailStatus()).resolves.toBe('unknown');
  });

  it('resolves UNKNOWN when platform is unreachable — and never throws into the turn', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(readInstanceEmailStatus()).resolves.toBe('unknown');
  });
});

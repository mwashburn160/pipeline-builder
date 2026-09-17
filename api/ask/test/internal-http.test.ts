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
// Set to prove the dead env vars are NOT consulted.
process.env.PIPELINE_URL = 'http://wrong-pipeline:1';
process.env.PLUGIN_URL = 'http://wrong-plugin:1';

const { pipelineClient, pluginClient } = await import('../src/services/internal-http.js');

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

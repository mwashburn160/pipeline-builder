// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared observability upstream path: failure classification (a 5xx is an
 * unhealthy backend, NOT a rejected query) and the response mapping the read
 * routes use to degrade instead of erroring.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  observability: {
    prometheusUrl: 'http://prom.test:9090',
    lokiUrl: 'http://loki.test:3100',
    alertmanagerUrl: 'http://am.test:9093',
    alertmanagerTimeoutMs: 5000,
  },
}));

const { callUpstream, sendUpstreamFailure } = await import('../src/observability/upstream.js');
const loki = await import('../src/observability/loki-client.js');
const am = await import('../src/observability/alertmanager-client.js');

const fetchMock = jest.fn<AnyFn>();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}

describe('callUpstream', () => {
  it('classifies a 5xx as unreachable (backend unhealthy), not as a rejected query', async () => {
    fetchMock.mockResolvedValue(new Response('upstream down', { status: 503 }));
    await expect(callUpstream('http://x/', { backend: 'X', timeoutMs: 100 }))
      .rejects.toEqual({ kind: 'unreachable', message: 'upstream down' });
  });

  it('classifies a 4xx as upstream-4xx, taking the message from a JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'parse error' }), { status: 400 }));
    await expect(callUpstream('http://x/', { backend: 'X', timeoutMs: 100 }))
      .rejects.toEqual({ kind: 'upstream-4xx', status: 400, message: 'parse error' });
  });

  it('falls back to a generic message for an empty error body', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    await expect(callUpstream('http://x/', { backend: 'X', timeoutMs: 100 }))
      .rejects.toEqual({ kind: 'upstream-4xx', status: 404, message: 'X returned 404' });
  });

  it('classifies a connection failure as unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(callUpstream('http://x/', { backend: 'X', timeoutMs: 100 }))
      .rejects.toMatchObject({ kind: 'unreachable', message: 'ECONNREFUSED' });
  });

  it("does not parse the body with parse: 'none'", async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await expect(callUpstream('http://x/', { backend: 'X', timeoutMs: 100, parse: 'none' })).resolves.toBeUndefined();
  });
});

describe('sendUpstreamFailure', () => {
  const messages = { rejected: 'rejected', unreachable: 'gone' };

  it('degrades an unreachable backend to 200 + degraded when an empty body is given', () => {
    const r = res();
    sendUpstreamFailure(r, { kind: 'unreachable', message: 'x' }, messages, { series: [] });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json.mock.calls[0][0]).toMatchObject({ data: { series: [], degraded: true } });
  });

  it('maps unreachable to 502 without an empty body (writes)', () => {
    const r = res();
    sendUpstreamFailure(r, { kind: 'unreachable', message: 'x' }, messages);
    expect(r.status).toHaveBeenCalledWith(502);
  });

  it('maps a rejection to 500 even on a read', () => {
    const r = res();
    sendUpstreamFailure(r, { kind: 'upstream-4xx', status: 400, message: 'x' }, messages, { series: [] });
    expect(r.status).toHaveBeenCalledWith(500);
  });

  it('maps an unclassified error to 502', () => {
    const r = res();
    sendUpstreamFailure(r, new Error('boom'), messages, { series: [] });
    expect(r.status).toHaveBeenCalledWith(502);
  });
});

describe('loki-client', () => {
  it('a Loki 503 is unreachable (so the Logs page degrades) and carries the tenant header', async () => {
    fetchMock.mockResolvedValue(new Response('too many outstanding requests', { status: 503 }));
    await expect(loki.queryLogs('{a="b"}', 'org-1', { startMs: 0, endMs: 1, limit: 10 }))
      .rejects.toMatchObject({ kind: 'unreachable' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Scope-OrgID']).toBe('org-1');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^http:\/\/loki\.test:3100\/loki\/api\/v1\/query_range\?/);
  });

  it('a 200 with a non-success envelope is a rejection', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'error', error: 'bad' }), { status: 200 }));
    await expect(loki.queryLogs('{a="b"}', 'org-1', { startMs: 0, endMs: 1, limit: 10 }))
      .rejects.toMatchObject({ kind: 'upstream-4xx', message: 'bad' });
  });
});

describe('alertmanager-client', () => {
  it('expires a silence without parsing the empty 200 body', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await expect(am.deleteSilence('s-1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://am.test:9093/api/v2/silence/s-1');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('an Alertmanager 500 is unreachable', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 500 }));
    await expect(am.listSilences()).rejects.toMatchObject({ kind: 'unreachable' });
  });
});

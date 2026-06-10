// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for prometheus-client. Stubs `fetch` per-test; asserts
 * the request shape (URL, query params) and the response transformation.
 */

import { jest, describe, it, expect, beforeEach, afterAll, test } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { query, queryRange } = await import('../src/observability/prometheus-client.js');


const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.PROMETHEUS_URL = 'http://prom.test:9090';
});

afterAll(() => {
  delete process.env.PROMETHEUS_URL;
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('prometheus-client query (instant)', () => {
  it('hits /api/v1/query with the query param and parses result', async () => {
    fetchMock.mockResolvedValue(ok({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          { metric: { status: 'success' }, value: [1700000000, '42'] },
          { metric: { status: 'failed' }, value: [1700000000, '3'] },
        ],
      },
    }));

    const samples = await query('sum(rate(plugin_builds_total[5m]))');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin).toBe('http://prom.test:9090');
    expect(url.pathname).toBe('/api/v1/query');
    expect(url.searchParams.get('query')).toBe('sum(rate(plugin_builds_total[5m]))');

    expect(samples).toEqual([
      { time: 1700000000, value: '42', labels: { status: 'success' } },
      { time: 1700000000, value: '3', labels: { status: 'failed' } },
    ]);
  });

  it('returns empty array on valid query with no series', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'success', data: { resultType: 'vector', result: [] } }));
    const samples = await query('up{job="nonexistent"}');
    expect(samples).toEqual([]);
  });
});

describe('prometheus-client queryRange', () => {
  it('hits /api/v1/query_range with start, end, step and parses series', async () => {
    fetchMock.mockResolvedValue(ok({
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [
          { metric: { status: 'success' }, values: [[1700000000, '1'], [1700000060, '2']] },
        ],
      },
    }));

    const series = await queryRange('rate(plugin_builds_total[1m])', 1700000000, 1700003600, '15s');

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v1/query_range');
    expect(url.searchParams.get('query')).toBe('rate(plugin_builds_total[1m])');
    expect(url.searchParams.get('start')).toBe('1700000000');
    expect(url.searchParams.get('end')).toBe('1700003600');
    expect(url.searchParams.get('step')).toBe('15s');

    expect(series).toEqual([
      {
        labels: { status: 'success' },
        values: [
          { time: 1700000000, value: '1' },
          { time: 1700000060, value: '2' },
        ],
      },
    ]);
  });
});

describe('prometheus-client error mapping', () => {
  it('throws upstream-4xx when Prometheus returns 422', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'error', error: 'parse error: bad query' }), { status: 422 }));
    await expect(query('not a query')).rejects.toMatchObject({
      kind: 'upstream-4xx',
      status: 422,
    });
  });

  it('throws unreachable when fetch rejects (DNS/connection)', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND prom.test'));
    await expect(query('up')).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('throws upstream-4xx when 200 OK but status: error', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'error', error: 'bogus' }));
    await expect(query('up')).rejects.toMatchObject({
      kind: 'upstream-4xx',
    });
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for loki-client. Stubs `fetch` per-test; asserts the
 * Loki time-unit conversion (Loki wants nanoseconds, our API takes seconds)
 * and the streams-vs-matrix branching.
 */

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  errorMessage: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

import { queryStreams, queryMatrix } from '../src/observability/loki-client';

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.LOKI_URL = 'http://loki.test:3100';
});

afterAll(() => {
  delete process.env.LOKI_URL;
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('loki-client queryStreams', () => {
  it('converts seconds → nanoseconds for start/end and parses streams', async () => {
    fetchMock.mockResolvedValue(ok({
      status: 'success',
      data: {
        resultType: 'streams',
        result: [{
          stream: { eventCategory: 'audit', event: 'registry.tag.copy' },
          values: [['1700000000000000000', 'audit copy line']],
        }],
      },
    }));

    const entries = await queryStreams('{eventCategory="audit"}', 1700000000, 1700003600, 50);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/loki/api/v1/query_range');
    expect(url.searchParams.get('start')).toBe('1700000000000000000');
    expect(url.searchParams.get('end')).toBe('1700003600000000000');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('direction')).toBe('backward');

    expect(entries).toEqual([{
      time: '1700000000000000000',
      line: 'audit copy line',
      labels: { eventCategory: 'audit', event: 'registry.tag.copy' },
    }]);
  });

  it('returns empty array on valid query with no streams', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'success', data: { resultType: 'streams', result: [] } }));
    const entries = await queryStreams('{nonexistent="x"}', 1700000000, 1700003600, 50);
    expect(entries).toEqual([]);
  });

  it('returns empty when resultType is matrix (caller asked for streams)', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'success', data: { resultType: 'matrix', result: [] } }));
    const entries = await queryStreams('count_over_time({}[1h])', 1700000000, 1700003600, 50);
    expect(entries).toEqual([]);
  });
});

describe('loki-client queryMatrix', () => {
  it('hits /loki/api/v1/query_range with step and parses matrix result', async () => {
    fetchMock.mockResolvedValue(ok({
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [
          { metric: { event: 'registry.tag.copy' }, values: [[1700000000, '4'], [1700003600, '5']] },
        ],
      },
    }));

    const series = await queryMatrix(
      'sum by (event) (count_over_time({eventCategory="audit"}[1h]))',
      1700000000,
      1700003600,
      '15s',
    );

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('step')).toBe('15s');
    expect(url.searchParams.get('start')).toBe('1700000000000000000');

    expect(series).toEqual([{
      labels: { event: 'registry.tag.copy' },
      values: [
        { time: 1700000000, value: '4' },
        { time: 1700003600, value: '5' },
      ],
    }]);
  });
});

describe('loki-client error mapping', () => {
  it('throws upstream-4xx on Loki 400 (LogQL syntax error)', async () => {
    fetchMock.mockResolvedValue(new Response('parse error at line 1', { status: 400 }));
    await expect(queryStreams('not a query', 0, 1, 50)).rejects.toMatchObject({
      kind: 'upstream-4xx',
      status: 400,
    });
  });

  it('throws unreachable when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(queryStreams('{x="y"}', 0, 1, 50)).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });
});

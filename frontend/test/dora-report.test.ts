// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the DORA reporting client method + the seconds humanizer
 * used by the DORA cards. Locks the path/query shape of
 * `GET /api/reports/execution/dora` and the fmtSeconds formatting (incl. null → "—").
 */

import type { ApiCore } from '../src/lib/api/core';
import { reportingApi, type DoraMetrics, type DoraTrendPoint } from '../src/lib/api/domains/reporting';
import { fmtSeconds } from '../src/components/reports/ReportHelpers';

function makeApi(payload?: { dora?: DoraMetrics | null; trend?: DoraTrendPoint[] }) {
  const calls: string[] = [];
  const core = {
    request: jest.fn((path: string) => {
      calls.push(path);
      return Promise.resolve({ success: true, data: payload });
    }),
  } as unknown as ApiCore;
  return { api: reportingApi(core), calls };
}

describe('getDora', () => {
  it('GETs /api/reports/execution/dora with from/to/includeDescendants query params', async () => {
    const { api, calls } = makeApi({ dora: null });
    await api.getDora({ from: '2026-01-01', to: '2026-01-31', includeDescendants: true });
    expect(calls).toHaveLength(1);
    const [path, query] = calls[0].split('?');
    expect(path).toBe('/api/reports/execution/dora');
    const params = new URLSearchParams(query);
    expect(params.get('from')).toBe('2026-01-01');
    expect(params.get('to')).toBe('2026-01-31');
    expect(params.get('includeDescendants')).toBe('true');
  });

  it('omits empty params and unwraps data.dora', async () => {
    const dora: DoraMetrics = {
      window: { from: '2026-01-01', to: '2026-01-31' },
      basis: 'deploy',
      filters: { pipelineId: null, environment: 'production' },
      deploymentFrequency: { deployments: 8, perDay: 0.27, level: 'high' },
      changeFailureRate: { failed: 2, total: 8, pct: 25, level: 'medium' },
      meanTimeToRestore: { failures: 2, restored: 2, avgSeconds: 3720, level: 'high' },
      leadTime: { deployments: 8, medianSeconds: 300, approx: true, level: 'elite' },
    };
    const { api, calls } = makeApi({ dora });
    const result = await api.getDora();
    expect(calls[0]).toBe('/api/reports/execution/dora');
    expect(result).toEqual(dora);
  });
});

describe('getDoraTrend', () => {
  it('GETs /api/reports/execution/dora/trend with interval + filter params and unwraps data.trend', async () => {
    const trend: DoraTrendPoint[] = [
      { period: '2026-01-01', deployments: 3, failed: 1, total: 3, changeFailurePct: 33 },
      { period: '2026-01-08', deployments: 5, failed: 0, total: 5, changeFailurePct: 0 },
    ];
    const { api, calls } = makeApi({ trend });
    const result = await api.getDoraTrend({ interval: 'week', from: '2026-01-01', to: '2026-01-31', includeDescendants: true });
    expect(calls).toHaveLength(1);
    const [path, query] = calls[0].split('?');
    expect(path).toBe('/api/reports/execution/dora/trend');
    const params = new URLSearchParams(query);
    expect(params.get('interval')).toBe('week');
    expect(params.get('from')).toBe('2026-01-01');
    expect(params.get('to')).toBe('2026-01-31');
    expect(params.get('includeDescendants')).toBe('true');
    expect(result).toEqual(trend);
  });

  it('defaults to an empty array when data.trend is absent', async () => {
    const { api } = makeApi({});
    expect(await api.getDoraTrend()).toEqual([]);
  });
});

describe('fmtSeconds (MTTR / lead-time humanization)', () => {
  it('humanizes seconds', () => {
    expect(fmtSeconds(45)).toBe('45s');
    expect(fmtSeconds(300)).toBe('5m');
    expect(fmtSeconds(3720)).toBe('1h 2m');
  });

  it('humanizes the days branch (>= 86400s)', () => {
    expect(fmtSeconds(86400)).toBe('1d');           // exactly one day, no trailing hours
    expect(fmtSeconds(90000)).toBe('1d 1h');        // 1d + 3600s → 1h
    expect(fmtSeconds(180000)).toBe('2d 2h');       // 2d + 7200s → 2h
  });

  it('renders "—" for null (no failures / none restored)', () => {
    expect(fmtSeconds(null)).toBe('—');
    expect(fmtSeconds(undefined)).toBe('—');
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client contracts for the reporting + observability reads this slice changed:
 *  - every rollup-aware report forwards `includeDescendants` (one scope for all panels),
 *  - `getReportRetention` reads the reports:read-only `/api/reports/retention`,
 *  - dashboard panels (audit-trail filters included) go out as ONE batched POST,
 *  - the alert-rules list pages server-side (`offset` / `limit`).
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import type { ApiCore } from '../src/lib/api/core';
import { reportingApi } from '../src/lib/api/domains/reporting';
import { observabilityApi } from '../src/lib/api/domains/observability';

function makeCore(payload: unknown = {}) {
  const calls: string[] = [];
  const core = {
    request: jest.fn<AnyFn>((path: string) => {
      calls.push(path);
      return Promise.resolve({ success: true, data: payload });
    }),
  } as unknown as ApiCore;
  return { core, calls };
}

const queryOf = (path: string) => new URLSearchParams(path.split('?')[1] ?? '');

describe('reporting client — includeDescendants on every rollup-aware report', () => {
  const range = { from: '2026-01-01', to: '2026-01-31', includeDescendants: true };

  it.each([
    ['getStageFailures', '/api/reports/execution/stage-failures'],
    ['getStageBottlenecks', '/api/reports/execution/stage-bottlenecks'],
    ['getActionFailures', '/api/reports/execution/action-failures'],
    ['getExecutionErrors', '/api/reports/execution/errors'],
    ['getBuildSuccessRate', '/api/reports/plugins/build-success-rate'],
    ['getBuildDuration', '/api/reports/plugins/build-duration'],
    ['getBuildFailures', '/api/reports/plugins/build-failures'],
  ] as const)('%s forwards includeDescendants', async (method, path) => {
    const { core, calls } = makeCore();
    const api = reportingApi(core);
    await (api[method] as (p: typeof range) => Promise<unknown>)(range);
    expect(calls[0].split('?')[0]).toBe(path);
    expect(queryOf(calls[0]).get('includeDescendants')).toBe('true');
  });
});

describe('reporting client — effective retention', () => {
  it('GETs /api/reports/retention and unwraps data.retention', async () => {
    const retention = { eventRetentionDays: 120, doraRetentionDays: 180, eventMaxRangeDays: 120, doraMaxRangeDays: 180 };
    const { core, calls } = makeCore({ retention });
    expect(await reportingApi(core).getReportRetention()).toEqual(retention);
    expect(calls).toEqual(['/api/reports/retention']);
  });
});

describe('observability client', () => {
  it('sends every panel query (audit filters included) in ONE batched POST', async () => {
    const { core, calls } = makeCore({ results: {} });
    const queries = [
      { id: 'a', key: 'plugin_builds_per_min' },
      { id: 'b', key: 'audit_recent_events', audit: true, event: 'pipeline.delete', actor: 'a@b.c', requestId: 'req-123', limit: 50 },
    ];
    await observabilityApi(core).observabilityQueryBatch('6h', queries);
    expect(calls).toEqual(['/api/observability/query/batch']);
    const init = (core.request as jest.Mock).mock.calls[0][1] as { method: string; body: string };
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ range: '6h', queries });
  });

  it('pages the alert-rules list server-side', async () => {
    const { core, calls } = makeCore({ rules: [], pagination: { total: 0, offset: 25, limit: 25, hasMore: false } });
    await observabilityApi(core).listAlertRules({ offset: 25, limit: 25 });
    expect(calls[0].split('?')[0]).toBe('/api/observability/alert-rules');
    expect(queryOf(calls[0]).get('offset')).toBe('25');
    expect(queryOf(calls[0]).get('limit')).toBe('25');
  });
});

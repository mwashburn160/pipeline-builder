// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { highestPressure } from '../src/lib/quota-pressure';
import type { OrgQuotaResponse, QuotaSummary } from '../src/types';

// `quotaPercent` and `pressureLevel` are internal to `quota-pressure.ts` —
// they're exercised here through the public `highestPressure` wrapper.

const summary = (overrides: Partial<QuotaSummary> = {}): QuotaSummary => ({
  limit: 100,
  used: 0,
  remaining: 100,
  unlimited: false,
  resetAt: '2026-12-31T00:00:00Z',
  ...overrides,
});

describe('highestPressure', () => {
  const buildResponse = (quotas: Record<string, Partial<QuotaSummary>>): OrgQuotaResponse => ({
    orgId: 'org-1',
    name: 'Acme',
    slug: 'acme',
    quotas: Object.fromEntries(
      Object.entries(quotas).map(([k, v]) => [k, summary(v)]),
    ) as OrgQuotaResponse['quotas'],
  });

  it('returns level=none for empty/missing input', () => {
    expect(highestPressure(undefined)).toEqual({ level: 'none' });
    expect(highestPressure(null)).toEqual({ level: 'none' });
    expect(highestPressure(buildResponse({}))).toEqual({ level: 'none' });
  });

  it('returns level=none when all quotas are below 80%', () => {
    expect(highestPressure(buildResponse({
      plugins: { limit: 100, used: 50 },
      pipelines: { limit: 100, used: 79 },
      apiCalls: { limit: 100, used: 0 },
    }))).toEqual({ level: 'none' });
  });

  it('picks the highest-pressure quota when multiple are over threshold', () => {
    const result = highestPressure(buildResponse({
      plugins: { limit: 100, used: 85 },     // 85% info
      pipelines: { limit: 100, used: 96 },   // 96% warning
      apiCalls: { limit: 100, used: 100 },   // 100% critical
    }));
    expect(result.level).toBe('critical');
    expect(result.type).toBe('apiCalls');
    expect(result.percent).toBe(100);
  });

  it('returns label for the most-pressured type', () => {
    const result = highestPressure(buildResponse({
      pipelines: { limit: 100, used: 95 },
    }));
    expect(result.label).toBe('Pipelines');
    expect(result.level).toBe('warning');
  });

  it('ignores unlimited quotas even with high usage', () => {
    expect(highestPressure(buildResponse({
      plugins: { unlimited: true, limit: -1, used: 9999 },
      pipelines: { limit: 100, used: 50 },
    }))).toEqual({ level: 'none' });
  });

  it('treats apiCalls label as "API calls"', () => {
    const result = highestPressure(buildResponse({
      apiCalls: { limit: 100, used: 80 },
    }));
    expect(result.label).toBe('API calls');
  });
});

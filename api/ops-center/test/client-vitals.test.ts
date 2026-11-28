// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /observability/client-vitals` — the browser's real-user-monitoring
 * ingest (web vitals + error-boundary catches from the frontend's telemetry
 * module, src/lib/telemetry/web-vitals.ts).
 *
 * What is pinned here is the CARDINALITY contract: every label the endpoint
 * writes comes from a closed set (metric, rating, boundary, and a route that is
 * either one of the frontend's page patterns or `other`), values are range
 * checked, and nothing identifying — no user id, no URL, no query — can ride a
 * sample into Prometheus, because the body schema is strict.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

const observe = jest.fn();
const incCounter = jest.fn();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  observe: (...a: unknown[]) => observe(...a),
  incCounter: (...a: unknown[]) => incCounter(...a),
  setGauge: jest.fn(),
}));

const {
  clientVitalsSchema,
  clientVitals,
  FRONTEND_ROUTE_PATTERNS,
  MAX_SAMPLES_PER_BATCH,
  routeLabel,
} = await import('../src/observability/client-vitals.js');

function mockRes() {
  const r = {
    statusCode: 200,
    body: undefined as unknown,
    ended: false,
    headersSent: false,
    status(n: number) { r.statusCode = n; return r; },
    json(b: unknown) { r.body = b; r.headersSent = true; return r; },
    end() { r.ended = true; r.headersSent = true; return r; },
    setHeader() { /* sendError sets none we read */ },
  };
  return r;
}

const run = async (body: unknown) => {
  const res = mockRes();
  await clientVitals({ body, user: { sub: 'u-1', organizationId: 'org-1' } } as unknown as Request, res as unknown as Response);
  return res;
};

const lcp = (over: Record<string, unknown> = {}) => ({ kind: 'vital', metric: 'LCP', value: 2300, rating: 'good', route: '/dashboard', ...over });

beforeEach(() => { observe.mockClear(); incCounter.mockClear(); });

describe('client-vitals body schema', () => {
  it('accepts a batch of every metric and an error-boundary sample', () => {
    const ok = clientVitalsSchema.safeParse({
      samples: [
        lcp(),
        { kind: 'vital', metric: 'INP', value: 180, rating: 'good', route: '/dashboard/pipelines/[id]' },
        { kind: 'vital', metric: 'CLS', value: 0.12, rating: 'needs-improvement', route: '/dashboard' },
        { kind: 'vital', metric: 'FCP', value: 900, rating: 'good', route: '/login' },
        { kind: 'vital', metric: 'TTFB', value: 450, rating: 'good', route: '/' },
        { kind: 'error', boundary: 'chart', route: '/dashboard/logs' },
        { kind: 'error', boundary: 'app', route: '/_error' },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('refuses a metric outside the allow-list, an unknown rating and an unknown boundary', () => {
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ metric: 'FID' })] }).success).toBe(false);
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ rating: 'great' })] }).success).toBe(false);
    expect(clientVitalsSchema.safeParse({ samples: [{ kind: 'error', boundary: 'modal', route: '/dashboard' }] }).success).toBe(false);
  });

  it('range-checks values: no negatives, no NaN, no 10-minute LCP, no CLS of 50', () => {
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ value: -1 })] }).success).toBe(false);
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ value: Number.NaN })] }).success).toBe(false);
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ value: 600_000 })] }).success).toBe(false);
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ metric: 'CLS', value: 50 })] }).success).toBe(false);
  });

  it('is strict: a sample cannot carry a user id, a URL or a query', () => {
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ userId: 'u-1' })] }).success).toBe(false);
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ url: 'https://x/dashboard?token=abc' })] }).success).toBe(false);
    expect(clientVitalsSchema.safeParse({ samples: [lcp()], userId: 'u-1' }).success).toBe(false);
    // A concrete path with a query is not a route PATTERN.
    expect(clientVitalsSchema.safeParse({ samples: [lcp({ route: '/dashboard?tab=x' })] }).success).toBe(false);
  });

  it('bounds the batch size', () => {
    expect(clientVitalsSchema.safeParse({ samples: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_SAMPLES_PER_BATCH + 1 }, () => lcp());
    expect(clientVitalsSchema.safeParse({ samples: many }).success).toBe(false);
  });
});

describe('route label', () => {
  it('keeps a known page pattern and folds anything else into `other`', () => {
    expect(routeLabel('/dashboard/pipelines/[id]')).toBe('/dashboard/pipelines/[id]');
    expect(routeLabel('/dashboard/pipelines/0f3c9a')).toBe('other');
    expect(routeLabel('/not-a-page')).toBe('other');
  });

  it('lists exactly the frontend\'s page patterns (drift guard against frontend/pages)', () => {
    const pagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../frontend/pages');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
    const fromDisk = walk(pagesDir)
      .map((f) => relative(pagesDir, f).replace(/\\/g, '/'))
      // API routes and the server-only text routes are never a browser page view.
      .filter((f) => /\.tsx$/.test(f) && !f.startsWith('api/') && !/^_(app|document)\.tsx$/.test(f))
      .map((f) => `/${f.replace(/\.tsx$/, '')}`.replace(/\/index$/, '') || '/')
      .map((r) => (r === '' ? '/' : r));
    // Next's own error routes are page views too (router.pathname on them).
    expect([...FRONTEND_ROUTE_PATTERNS].sort()).toEqual([...fromDisk, '/404', '/_error'].sort());
  });
});

describe('POST /observability/client-vitals handler', () => {
  it('records each vital on frontend_web_vitals in seconds (CLS unitless) and answers 204', async () => {
    const res = await run({
      samples: [
        lcp({ value: 4200, rating: 'poor', route: '/dashboard/pipelines/[id]' }),
        { kind: 'vital', metric: 'CLS', value: 0.3, rating: 'poor', route: '/dashboard' },
      ],
    });
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(observe).toHaveBeenCalledWith('frontend_web_vitals', { metric: 'LCP', route: '/dashboard/pipelines/[id]', rating: 'poor' }, 4.2);
    expect(observe).toHaveBeenCalledWith('frontend_web_vitals', { metric: 'CLS', route: '/dashboard', rating: 'poor' }, 0.3);
  });

  it('counts an error-boundary catch by boundary and route pattern', async () => {
    await run({ samples: [{ kind: 'error', boundary: 'ask-panel', route: '/dashboard/help' }] });
    expect(incCounter).toHaveBeenCalledWith('frontend_error_boundary_caught_total', { boundary: 'ask-panel', route: '/dashboard/help' });
  });

  it('folds an unknown route into `other` and never writes a user or org label', async () => {
    await run({ samples: [lcp({ route: '/dashboard/pipelines/abc123' })] });
    expect(observe).toHaveBeenCalledWith('frontend_web_vitals', { metric: 'LCP', route: 'other', rating: 'good' }, 2.3);
    for (const call of [...observe.mock.calls, ...incCounter.mock.calls]) {
      expect(Object.keys(call[1] as object).sort()).not.toEqual(expect.arrayContaining(['user_id']));
      expect(JSON.stringify(call)).not.toMatch(/u-1|org-1/);
    }
  });

  it('answers 400 and records nothing for an invalid body', async () => {
    const res = await run({ samples: [lcp({ metric: 'FID' })] });
    expect(res.statusCode).toBe(400);
    expect(observe).not.toHaveBeenCalled();
    expect(incCounter).not.toHaveBeenCalled();
  });
});

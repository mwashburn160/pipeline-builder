// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * src/lib/telemetry/web-vitals.ts — the browser half of real-user monitoring.
 *
 * Pinned: each web vital is labelled by the Next.js route PATTERN the page
 * loaded on (never the concrete path, ids or query) and its rating; samples are
 * batched and posted to ops-center's `POST /api/observability/client-vitals`
 * by the api client's fetch core with `keepalive` (the endpoint is authenticated and a beacon
 * cannot carry the bearer header), flushed when the page is hidden; error-boundary
 * catches ride the same batch; and nothing is sent without a session.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

type Cb = (m: { name: string; value: number; rating: string }) => void;
const handlers: Record<string, Cb> = {};
jest.mock('web-vitals', () => ({
  __esModule: true,
  onLCP: (cb: Cb) => { handlers.LCP = cb; },
  onINP: (cb: Cb) => { handlers.INP = cb; },
  onCLS: (cb: Cb) => { handlers.CLS = cb; },
  onFCP: (cb: Cb) => { handlers.FCP = cb; },
  onTTFB: (cb: Cb) => { handlers.TTFB = cb; },
}));

import {
  MAX_BATCH,
  configureTelemetry,
  initWebVitals,
  reportBoundaryError,
  flushTelemetry,
  __resetTelemetryForTests,
} from '../src/lib/telemetry/web-vitals';
import { observabilityApi } from '../src/lib/api/domains/observability';
import type { ApiCore } from '../src/lib/api/core';

const fetchMock = jest.fn<(url: string, init: RequestInit) => Promise<Response>>();
let token: string | null = 'tok';
const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}`, 'x-org-id': 'org-1' } : {});
// The real transport (the api client's observability domain) over a fake core
// whose requestRaw adds the session headers the way the fetch core does.
const fakeCore = {
  isAuthenticated: () => token !== null,
  requestRaw: (endpoint: string, init: RequestInit) =>
    fetchMock(endpoint, { ...init, headers: { ...(init.headers as Record<string, string>), ...authHeaders() } }),
};
const { sendClientTelemetry: send } = observabilityApi(fakeCore as unknown as ApiCore);

const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url, init, body: JSON.parse(String(init.body)) as { samples: unknown[] } }));

function hide() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  __resetTelemetryForTests();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ status: 204 } as unknown as Response);
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  token = 'tok';
  for (const k of Object.keys(handlers)) delete handlers[k];
});

describe('web vitals reporting', () => {
  it('subscribes to all five metrics', () => {
    initWebVitals('/dashboard', { send });
    expect(Object.keys(handlers).sort()).toEqual(['CLS', 'FCP', 'INP', 'LCP', 'TTFB']);
  });

  it('labels every sample with the route PATTERN and rating, and sends on page hide', () => {
    initWebVitals('/dashboard/pipelines/[id]', { send });
    handlers.LCP!({ name: 'LCP', value: 2512.4, rating: 'needs-improvement' });
    handlers.CLS!({ name: 'CLS', value: 0.04, rating: 'good' });
    expect(fetchMock).not.toHaveBeenCalled(); // batched, not one request per metric
    hide();
    expect(sent()).toHaveLength(1);
    const [{ url, init, body }] = sent();
    expect(url).toBe('/api/observability/client-vitals');
    expect(init).toMatchObject({ method: 'POST', keepalive: true });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(body.samples).toEqual([
      { kind: 'vital', metric: 'LCP', value: 2512.4, rating: 'needs-improvement', route: '/dashboard/pipelines/[id]' },
      { kind: 'vital', metric: 'CLS', value: 0.04, rating: 'good', route: '/dashboard/pipelines/[id]' },
    ]);
  });

  it('never sends a concrete path, id or query, whatever the URL is', () => {
    window.history.pushState({}, '', '/dashboard/pipelines/0f3c9a?tab=runs&token=secret');
    initWebVitals('/dashboard/pipelines/[id]', { send });
    handlers.TTFB!({ name: 'TTFB', value: 120, rating: 'good' });
    flushTelemetry();
    const raw = String(fetchMock.mock.calls[0]![1].body);
    expect(raw).not.toMatch(/0f3c9a|tab=|secret|\?/);
  });

  it('sends a full batch at once, without waiting for the page to hide', () => {
    initWebVitals('/dashboard', { send });
    for (let i = 0; i < MAX_BATCH; i++) reportBoundaryError('chart', '/dashboard');
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.body.samples).toHaveLength(MAX_BATCH);
  });

  it('is idempotent: a second init does not double-subscribe or double-send', () => {
    initWebVitals('/dashboard', { send });
    const first = handlers.LCP;
    initWebVitals('/login', { send });
    expect(handlers.LCP).toBe(first);
  });

  it('sends nothing without a session (the endpoint is authenticated), and drops the batch on hide', () => {
    token = null;
    initWebVitals('/login', { send });
    handlers.FCP!({ name: 'FCP', value: 800, rating: 'good' });
    hide();
    expect(fetchMock).not.toHaveBeenCalled();
    token = 'tok';
    flushTelemetry();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws into the app when the network fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    initWebVitals('/dashboard', { send });
    handlers.LCP!({ name: 'LCP', value: 1000, rating: 'good' });
    expect(() => flushTelemetry()).not.toThrow();
    await Promise.resolve();
  });
});

describe('error-boundary reporting', () => {
  it('queues a bounded {boundary, route} sample — no message, no stack', () => {
    initWebVitals('/dashboard', { send });
    reportBoundaryError('ask-panel', '/dashboard/help');
    flushTelemetry();
    expect(sent()[0]!.body.samples).toEqual([{ kind: 'error', boundary: 'ask-panel', route: '/dashboard/help' }]);
  });

  it('works before (or without) web vitals being initialised, once a session exists', () => {
    configureTelemetry({ send });
    reportBoundaryError('page', '/dashboard');
    flushTelemetry();
    expect(sent()[0]!.body.samples).toEqual([{ kind: 'error', boundary: 'page', route: '/dashboard' }]);
  });
});

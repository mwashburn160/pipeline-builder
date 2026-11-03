// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DashboardQueryProvider: a dashboard's panels refresh as ONE batched request
 * per tick (one apiCalls), every 60s, never while the tab is hidden — instead of
 * each panel polling its own GET every 30s.
 */

import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen } from '@testing-library/react';
import { DASHBOARD_REFRESH_MS, DashboardQueryProvider, useDashboardPanelQuery, type PanelQuerySpec } from '../src/hooks/useDashboardQueries';
import { ObservabilityHealthProvider, useObservabilityHealth } from '../src/hooks/useObservabilityHealth';

const observabilityQueryBatch = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: { observabilityQueryBatch: (...a: unknown[]) => observabilityQueryBatch(...a) },
}));

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

type Slot = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; message: string };
let slotFor: (q: { id: string; key: string }) => Slot;

function Probe({ name, spec }: { name: string; spec: PanelQuerySpec }) {
  const { data, loading, error } = useDashboardPanelQuery<{ samples?: unknown[] }>(spec);
  const text = loading ? 'loading' : error ? `error:${error.message}` : `samples:${data?.samples?.length ?? 0}`;
  return <div data-testid={name}>{text}</div>;
}

function Degraded() {
  return <div data-testid="degraded">{String(useObservabilityHealth())}</div>;
}

const flush = async () => { await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); }); };

function renderDashboard(range: '1h' | '6h' = '1h') {
  return render(
    <ObservabilityHealthProvider>
      <DashboardQueryProvider range={range}>
        <Degraded />
        <Probe name="a" spec={{ key: 'k_a' }} />
        <Probe name="b" spec={{ key: 'k_b' }} />
        {/* A second panel asking the same thing shares a slot, not a query. */}
        <Probe name="a2" spec={{ key: 'k_a' }} />
        <Probe name="logs" spec={{ key: 'audit_recent_events', audit: true, requestId: 'r1' }} />
      </DashboardQueryProvider>
    </ObservabilityHealthProvider>,
  );
}

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

beforeEach(() => {
  jest.useFakeTimers();
  visibility = 'visible';
  slotFor = () => ({ ok: true, data: { samples: [1] } });
  observabilityQueryBatch.mockReset().mockImplementation(async (_range: unknown, queries: Array<{ id: string; key: string }>) => ({
    data: { results: Object.fromEntries(queries.map((q) => [q.id, slotFor(q)])) },
  }));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('DashboardQueryProvider', () => {
  it('fetches every panel in ONE request on mount, de-duplicating identical queries', async () => {
    renderDashboard();
    expect(screen.getByTestId('a').textContent).toBe('loading');
    await flush();
    expect(observabilityQueryBatch).toHaveBeenCalledTimes(1);
    const [range, queries] = observabilityQueryBatch.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(range).toBe('1h');
    expect(queries.map((q) => q.key)).toEqual(['k_a', 'k_b', 'audit_recent_events']);
    expect(queries[2]).toMatchObject({ audit: true, requestId: 'r1' });
    expect(screen.getByTestId('a').textContent).toBe('samples:1');
    expect(screen.getByTestId('a2').textContent).toBe('samples:1');
    expect(screen.getByTestId('logs').textContent).toBe('samples:1');
  });

  it('refreshes once per 60s tick (not per panel), and never while the tab is hidden', async () => {
    renderDashboard();
    await flush();
    observabilityQueryBatch.mockClear();

    await act(async () => { jest.advanceTimersByTime(DASHBOARD_REFRESH_MS - 1); });
    expect(observabilityQueryBatch).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(observabilityQueryBatch).toHaveBeenCalledTimes(1);

    act(() => { setVisibility('hidden'); });
    await act(async () => { jest.advanceTimersByTime(DASHBOARD_REFRESH_MS * 5); });
    expect(observabilityQueryBatch).toHaveBeenCalledTimes(1);

    // Back in view: one catch-up refresh, at once.
    await act(async () => { setVisibility('visible'); });
    expect(observabilityQueryBatch).toHaveBeenCalledTimes(2);
  });

  it('confines a failed slot to its panel, and surfaces a whole-batch failure on every panel', async () => {
    slotFor = (q) => (q.key === 'k_b' ? { ok: false, status: 403, message: 'Forbidden' } : { ok: true, data: { samples: [] } });
    renderDashboard();
    await flush();
    expect(screen.getByTestId('a').textContent).toBe('samples:0');
    expect(screen.getByTestId('b').textContent).toBe('error:Forbidden');

    observabilityQueryBatch.mockRejectedValueOnce(new Error('Quota exceeded'));
    await act(async () => { jest.advanceTimersByTime(DASHBOARD_REFRESH_MS); });
    await flush();
    expect(screen.getByTestId('a').textContent).toBe('error:Quota exceeded');
    expect(screen.getByTestId('logs').textContent).toBe('error:Quota exceeded');
  });

  it('raises the page-level degraded flag from a degraded slot', async () => {
    slotFor = (q) => ({ ok: true, data: q.key === 'k_a' ? { series: [], degraded: true } : { samples: [] } });
    renderDashboard();
    await flush();
    expect(screen.getByTestId('degraded').textContent).toBe('true');
  });

  it('re-fetches (once) for a new range, starting every panel from loading', async () => {
    const { rerender } = renderDashboard('1h');
    await flush();
    observabilityQueryBatch.mockClear();
    rerender(
      <ObservabilityHealthProvider>
        <DashboardQueryProvider range="6h">
          <Probe name="a" spec={{ key: 'k_a' }} />
        </DashboardQueryProvider>
      </ObservabilityHealthProvider>,
    );
    expect(screen.getByTestId('a').textContent).toBe('loading');
    await flush();
    expect(observabilityQueryBatch).toHaveBeenCalledTimes(1);
    expect(observabilityQueryBatch.mock.calls[0][0]).toBe('6h');
  });

  it('throws a clear error when a panel renders outside a provider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe name="x" spec={{ key: 'k' }} />)).toThrow(/inside <DashboardQueryProvider>/);
    spy.mockRestore();
  });
});

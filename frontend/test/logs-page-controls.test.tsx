// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Two capabilities the log API has always offered and the page never sent:
 *
 *  - `spanMs` on the context drill-down (server default 60s, clamp 600s). The
 *    page passed none, so "show context" was stuck at ±1 minute and could not
 *    be widened to see what a slow request did before it failed.
 *  - `name` on the export, which the server sanitises into Content-Disposition.
 *    Without one every download lands as `pipeline-builder-logs`.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import LogsPage from '../pages/dashboard/logs';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/observability/LogVolumeChart', () => ({
  __esModule: true,
  LogVolumeChart: () => null,
}));

const ENTRY = {
  time: 1_700_000_000_000,
  line: 'connection refused',
  labels: { level: 'error', service: 'platform', orgId: 'org-1' },
};

const logSearch = jest.fn<AnyFn>();
const logVolume = jest.fn<AnyFn>();
const logContext = jest.fn<AnyFn>();
const logExport = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const api = {
    logSearch: (...a: unknown[]) => logSearch(...a),
    logVolume: (...a: unknown[]) => logVolume(...a),
    logContext: (...a: unknown[]) => logContext(...a),
    logExport: (...a: unknown[]) => logExport(...a),
  };
  return { __esModule: true, default: api, api };
});
const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/csv-export', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ isAuthenticated: true, user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  logSearch.mockResolvedValue({ data: { entries: [ENTRY], window: { from: 0, to: 1, clamped: false } } });
  logVolume.mockResolvedValue({ data: { series: [], step: 60 } });
  logContext.mockResolvedValue({ data: { before: [], after: [] } });
  logExport.mockResolvedValue({ blob: new Blob(['x']), filename: 'incident-4821.log' });
});

/** Expand the one rendered entry and open its context drill-down. */
async function openContext() {
  render(<LogsPage />);
  await screen.findByText('connection refused');
  fireEvent.click(screen.getByRole('button', { name: /show log entry details/i }));
  fireEvent.click(screen.getByRole('button', { name: /show context/i }));
  return screen.findByRole('dialog', { name: /^context$/i });
}

describe('log context window', () => {
  it('asks for the server default on the first open', async () => {
    await openContext();
    await waitFor(() => expect(logContext).toHaveBeenCalledWith(expect.objectContaining({ spanMs: 60_000 })));
  });

  it('widens the same anchor in place, up to the 600s the server allows', async () => {
    const dialog = await openContext();
    await waitFor(() => expect(logContext).toHaveBeenCalledTimes(1));

    fireEvent.change(within(dialog).getByLabelText('Context window'), { target: { value: '600000' } });
    await waitFor(() => expect(logContext).toHaveBeenCalledTimes(2));
    // Same entry, wider window — not a fresh search.
    expect(logContext.mock.calls[1][0]).toMatchObject({ at: ENTRY.time, spanMs: 600_000 });
  });

  it('offers nothing beyond the server clamp', async () => {
    const dialog = await openContext();
    const values = within(dialog).getAllByRole('option').map((o) => Number((o as HTMLOptionElement).value));
    expect(Math.max(...values)).toBe(600_000);
  });
});

describe('log export name', () => {
  it('omits `name` until one is typed, then sends it trimmed', async () => {
    render(<LogsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /\.log$/i }));
    await waitFor(() => expect(logExport).toHaveBeenCalled());
    expect(logExport.mock.calls[0][0]).not.toHaveProperty('name');

    fireEvent.change(screen.getByLabelText('Download file name'), { target: { value: '  incident-4821  ' } });
    fireEvent.click(screen.getByRole('button', { name: /\.jsonl$/i }));
    await waitFor(() => expect(logExport).toHaveBeenCalledTimes(2));
    expect(logExport.mock.calls[1][0]).toMatchObject({ name: 'incident-4821', format: 'jsonl' });
  });

  it('is not offered without `logs:export`', async () => {
    mockAuthGuard({ isAuthenticated: true, user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p !== 'logs:export' });
    render(<LogsPage />);
    await screen.findByText('connection refused');
    expect(screen.queryByLabelText('Download file name')).not.toBeInTheDocument();
  });
});

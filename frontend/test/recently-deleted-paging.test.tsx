// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Recently deleted" paging.
 *
 * The paged list-deleted routes (pipelines, plugins, templates, messages,
 * compliance rules/policies) answer `?limit=&offset=` and default to 10 rows,
 * so a panel that read only the first page hid every older deletion — it could
 * never be found, so never restored. The panel now asks for a page explicitly
 * and offers "Load more" while a page comes back full, appending the next one.
 * Restore / purge keep working on appended rows, and the read-only gate applies
 * to them like any other.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RecentlyDeletedPanel } from '../src/components/RecentlyDeletedPanel';
import { pageToast } from './helpers/pageMocks';

const listDeletedPipelines = jest.fn<AnyFn>();
const restorePipeline = jest.fn<AnyFn>();
const purgePipeline = jest.fn<AnyFn>();
const listDeletedDashboards = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listDeletedPipelines: (...a: unknown[]) => listDeletedPipelines(...a),
    restorePipeline: (...a: unknown[]) => restorePipeline(...a),
    purgePipeline: (...a: unknown[]) => purgePipeline(...a),
    listDeletedDashboards: (...a: unknown[]) => listDeletedDashboards(...a),
    restoreDashboard: jest.fn<AnyFn>(),
    purgeDashboard: jest.fn<AnyFn>(),
  },
}));

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button onClick={() => onConfirmed('stepup-token')}>confirm-step-up</button>
  ),
}));

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const pipeline = (i: number) => ({
  id: `p${i}`, pipelineName: `pipe-${i}`, visibility: i === 27 ? 'public' : 'org', createdBy: 'u1',
  deletedAt: '2026-11-19T10:00:00Z', deletedBy: 'u1',
});

/** 30 tombstones behind the server's real limit/offset contract (default 10). */
let store = Array.from({ length: 30 }, (_, i) => pipeline(i));
function serveFromStore() {
  listDeletedPipelines.mockImplementation(async (params?: Record<string, string>) => {
    const limit = Number(params?.limit ?? 10);
    const offset = Number(params?.offset ?? 0);
    return { success: true, data: { pipelines: store.slice(offset, offset + limit) } };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  store = Array.from({ length: 30 }, (_, i) => pipeline(i));
  serveFromStore();
});

describe('RecentlyDeletedPanel — paging', () => {
  it('loads more than the server default page, then appends the next page on "Load more"', async () => {
    render(<RecentlyDeletedPanel resource="pipeline" />);
    // First page: more than the server's 10-row default.
    expect(await screen.findByText('pipe-24')).toBeInTheDocument();
    expect(screen.queryByText('pipe-25')).toBeNull();
    expect(listDeletedPipelines).toHaveBeenLastCalledWith({ limit: '25', offset: '0' });

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('pipe-29')).toBeInTheDocument();
    expect(listDeletedPipelines).toHaveBeenLastCalledWith({ limit: '25', offset: '25' });
    // Page 1 stays — appended, not replaced.
    expect(screen.getByText('pipe-0')).toBeInTheDocument();
    // A short page means the end: no further Load more.
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    expect(screen.getByText(/showing 30 deleted pipelines/i)).toBeInTheDocument();
  });

  it('restores a page-2 row with the step-up token and keeps the loaded pages', async () => {
    const onRestored = jest.fn<AnyFn>();
    restorePipeline.mockImplementation(async (id: string) => {
      store = store.filter((p) => p.id !== id);
      return { success: true };
    });
    render(<RecentlyDeletedPanel resource="pipeline" onRestored={onRestored} />);
    await screen.findByText('pipe-24');
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText('pipe-28');

    const row = screen.getByText('pipe-28').closest('tr')!;
    fireEvent.click(row.querySelector('button')!); // Restore is the row's first action
    fireEvent.click(screen.getByText('confirm-step-up'));

    await waitFor(() => expect(restorePipeline).toHaveBeenCalledWith('p28', 'stepup-token'));
    await waitFor(() => expect(screen.queryByText('pipe-28')).toBeNull());
    expect(onRestored).toHaveBeenCalled();
    // Still showing both pages (not reset to page 1).
    expect(screen.getByText('pipe-0')).toBeInTheDocument();
    expect(screen.getByText('pipe-29')).toBeInTheDocument();
  });

  it('keeps the next page aligned after removing a loaded row (no skipped tombstone)', async () => {
    restorePipeline.mockImplementation(async (id: string) => {
      store = store.filter((p) => p.id !== id);
      return { success: true };
    });
    render(<RecentlyDeletedPanel resource="pipeline" />);
    await screen.findByText('pipe-24');
    const row = screen.getByText('pipe-3').closest('tr')!;
    fireEvent.click(row.querySelector('button')!);
    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(screen.queryByText('pipe-3')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    // The server's offsets shifted down by one; pipe-25 must not be skipped.
    expect(await screen.findByText('pipe-25')).toBeInTheDocument();
    expect(listDeletedPipelines).toHaveBeenLastCalledWith({ limit: '25', offset: '24' });
    expect(screen.getAllByText('pipe-24')).toHaveLength(1);
  });

  it('a row restored while "Load more" is in flight does not make the next page skip a tombstone', async () => {
    restorePipeline.mockImplementation(async (id: string) => {
      store = store.filter((p) => p.id !== id);
      return { success: true };
    });
    render(<RecentlyDeletedPanel resource="pipeline" />);
    await screen.findByText('pipe-24');
    // Hold the next page; the server reads it only once released (after the restore).
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    listDeletedPipelines.mockImplementationOnce(async (params?: Record<string, string>) => {
      await gate;
      const limit = Number(params?.limit ?? 10);
      const offset = Number(params?.offset ?? 0);
      return { success: true, data: { pipelines: store.slice(offset, offset + limit) } };
    });
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    fireEvent.click(screen.getByText('pipe-3').closest('tr')!.querySelector('button')!);
    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(screen.queryByText('pipe-3')).toBeNull());
    release();
    // The page was asked for at offset 25 before the restore shifted the server's
    // rows down a slot: pipe-25 must still appear.
    expect(await screen.findByText('pipe-29')).toBeInTheDocument();
    expect(screen.getByText('pipe-25')).toBeInTheDocument();
    expect(screen.getAllByText('pipe-24')).toHaveLength(1);
    expect(screen.getByText(/showing 29 deleted pipelines/i)).toBeInTheDocument();
  });

  it('finishes a restore the global step-up dialog replayed after a refused token, without an error toast', async () => {
    const { StepUpRequiredError } = jest.requireActual<typeof import('../src/lib/api/errors')>('../src/lib/api/errors');
    const onRestored = jest.fn<AnyFn>();
    const refusal = new StepUpRequiredError('Confirm with a passkey', 'STEP_UP_METHOD_REQUIRED');
    refusal.attachResume(Promise.resolve({ success: true }));
    restorePipeline.mockRejectedValueOnce(refusal);
    render(<RecentlyDeletedPanel resource="pipeline" onRestored={onRestored} />);
    await screen.findByText('pipe-3');
    fireEvent.click(screen.getByText('pipe-3').closest('tr')!.querySelector('button')!);
    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(screen.queryByText('pipe-3')).toBeNull());
    expect(onRestored).toHaveBeenCalled();
    expect(pageToast.error).not.toHaveBeenCalled();
  });

  it('finishes a purge the global step-up dialog replayed', async () => {
    const { StepUpRequiredError } = jest.requireActual<typeof import('../src/lib/api/errors')>('../src/lib/api/errors');
    const refusal = new StepUpRequiredError('Confirm with a passkey', 'STEP_UP_METHOD_REQUIRED');
    refusal.attachResume(Promise.resolve({ success: true }));
    purgePipeline.mockRejectedValueOnce(refusal);
    render(<RecentlyDeletedPanel resource="pipeline" />);
    await screen.findByText('pipe-3');
    fireEvent.click(screen.getByText('pipe-3').closest('tr')!.querySelectorAll('button')[1]!);
    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(screen.queryByText('pipe-3')).toBeNull());
    expect(pageToast.error).not.toHaveBeenCalled();
  });

  it('applies the per-row restore gate to appended rows', async () => {
    render(<RecentlyDeletedPanel resource="pipeline" canRestoreRow={(r) => r.visibility !== 'public'} />);
    await screen.findByText('pipe-24');
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    const gated = (await screen.findByText('pipe-27')).closest('tr')!;
    expect(gated.querySelector('button')).toBeNull();
    expect(screen.getByText('pipe-26').closest('tr')!.querySelector('button')).not.toBeNull();
  });

  it('shows the empty state and no Load more when nothing is deleted', async () => {
    store = [];
    render(<RecentlyDeletedPanel resource="pipeline" />);
    expect(await screen.findByText('No recently deleted pipelines.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('shows a retry box when the first page fails', async () => {
    listDeletedPipelines.mockRejectedValueOnce(new Error('boom'));
    render(<RecentlyDeletedPanel resource="pipeline" />);
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByText('pipe-0')).toBeInTheDocument();
  });

  it('keeps loaded rows and the Load more button when a later page fails', async () => {
    render(<RecentlyDeletedPanel resource="pipeline" />);
    await screen.findByText('pipe-24');
    listDeletedPipelines.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(pageToast.error).toHaveBeenCalled());
    expect(screen.getByText('pipe-0')).toBeInTheDocument();
    // Retrying the same page works.
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('pipe-29')).toBeInTheDocument();
    expect(listDeletedPipelines).toHaveBeenLastCalledWith({ limit: '25', offset: '25' });
  });

  it('never offers Load more for an unpaged route (it already returns every tombstone)', async () => {
    listDeletedDashboards.mockResolvedValue({ success: true, data: { dashboards: Array.from({ length: 30 }, (_, i) => ({
      id: `d${i}`, name: `dash-${i}`, visibility: 'org', createdBy: 'u1', deletedAt: '2026-11-19T10:00:00Z', deletedBy: 'u1',
    })) } });
    render(<RecentlyDeletedPanel resource="dashboard" />);
    expect(await screen.findByText('dash-29')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });
});

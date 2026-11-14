// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stakeholder reports: what is on screen always belongs to what is selected.
 *
 *  - Picking a different report drops the previous report's open run (its review,
 *    publish and share controls) and its run list, instead of leaving them under the
 *    newly selected one.
 *  - The review is keyed by run, so per-run state (a freshly minted share token)
 *    can never sit under another run.
 *  - Deleting a report asks first, and says the share links die with it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const listReportDefinitions = jest.fn<AnyFn>();
const listReportRuns = jest.fn<AnyFn>();
const getReportRun = jest.fn<AnyFn>();
const deleteReportDefinition = jest.fn<AnyFn>();

jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({
  isReady: true, query: {}, pathname: '/dashboard/reports', replace: jest.fn<AnyFn>(),
})));

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listReportDefinitions: (...a: unknown[]) => listReportDefinitions(...a),
    listReportRecipients: () => Promise.resolve({ success: true, data: { recipients: [] } }),
    getReportPolicy: () => Promise.resolve({ success: true, data: { policy: { externalSharing: true, recipientDomains: null, requireApproval: true } } }),
    getReportDeliveryStatus: () => Promise.resolve({ success: true, data: { emailAvailable: true } }),
    listReportRuns: (...a: unknown[]) => listReportRuns(...a),
    getReportRun: (...a: unknown[]) => getReportRun(...a),
    deleteReportDefinition: (...a: unknown[]) => deleteReportDefinition(...a),
  },
}));

// The review is stubbed with a piece of MOUNT-TIME state, standing in for the
// real one's per-run state (notes draft, minted token): if the component were
// reused across runs it would keep showing the first run's id.
jest.mock('@/components/reports/stakeholder/ReportReview', () => ({
  __esModule: true,
  ReportReview: ({ run }: { run: { id: string } }) => {
    const [mountedFor] = useState(run.id);
    return <div data-testid="review">{`review:${mountedFor}`}</div>;
  },
}));

import { StakeholderTab } from '@/components/reports/tabs/StakeholderTab';

const definition = (id: string, name: string) => ({
  id, name, template: 'weekly_delivery', sections: ['success_rate'], cadence: 'weekly', timezone: 'UTC',
  weekStart: 'monday', scope: { kind: 'org' }, recipients: [], autoSend: false, isActive: true,
  pausedReason: null, ownerId: 'u1', nextRunAt: null, lastRunAt: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
});
const run = (id: string, definitionId: string, periodLabel: string) => ({
  id, definitionId, periodLabel, periodStart: '', periodEnd: '', version: 1, status: 'draft',
  leadNotes: null, aiDraft: null, failureReason: null, publishedAt: null, publishedBy: null, supersededBy: null, createdAt: '',
});

const renderTab = () => render(
  <StakeholderTab enabled orgId="acme" canAuthor canShare canRollup={false} canAdmin onStatus={jest.fn<AnyFn>()} />,
);

beforeEach(() => {
  jest.clearAllMocks();
  listReportDefinitions.mockResolvedValue({ success: true, data: { definitions: [definition('d1', 'Weekly'), definition('d2', 'Monthly')] } });
  listReportRuns.mockImplementation((defId: unknown) => Promise.resolve({
    success: true,
    data: { runs: defId === 'd1' ? [run('r1', 'd1', '2026-W38'), run('r2', 'd1', '2026-W39')] : [run('r9', 'd2', '2026-09')] },
  }));
  getReportRun.mockImplementation((id: unknown) => Promise.resolve({ success: true, data: { run: run(String(id), 'd1', 'x') } }));
  deleteReportDefinition.mockResolvedValue({ success: true, data: { deleted: true } });
});

describe('StakeholderTab selection', () => {
  it('switching report drops the previous report\'s open run and its runs', async () => {
    // d2's runs never arrive, so anything listed under d2 would be d1's.
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly' }));
    fireEvent.click(await screen.findByRole('button', { name: '2026-W38' }));
    expect(await screen.findByTestId('review')).toHaveTextContent('review:r1');

    listReportRuns.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));

    expect(screen.queryByTestId('review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2026-W38' })).not.toBeInTheDocument();
    expect(screen.getByText('Loading the run history…')).toBeInTheDocument();
  });

  it('remounts the review for each run, so per-run state never carries over', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Weekly' }));
    fireEvent.click(await screen.findByRole('button', { name: '2026-W38' }));
    expect(await screen.findByTestId('review')).toHaveTextContent('review:r1');
    fireEvent.click(screen.getByRole('button', { name: '2026-W39' }));
    await waitFor(() => expect(screen.getByTestId('review')).toHaveTextContent('review:r2'));
  });

  it('deleting a report asks first and says its share links stop working', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Weekly' }));
    expect(deleteReportDefinition).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Every share link/);
    expect(dialog).toHaveTextContent(/cannot be restored/);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete report' })); });
    expect(deleteReportDefinition).toHaveBeenCalledWith('d1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancelling the delete confirm deletes nothing', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Weekly' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(deleteReportDefinition).not.toHaveBeenCalled();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The support page and the staff queue page their case lists (100 a page, an
 * opaque `nextCursor` sent back verbatim by "Load more"); the support page shows
 * the account's one-time incident balance (hidden at 0, also on the LOCKED page —
 * an incident is the door for an org with no add-on), and exports through the
 * API client so the bearer token is sent and `X-Export-Truncated` is readable.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

let entitled = true;
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ isLoaded: true, entitled }),
}));
jest.mock('@/components/ui/FeatureLock', () => ({ __esModule: true, FeatureLock: () => <div>upsell</div> }));
jest.mock('@/components/message/SupportCaseNotes', () => ({ __esModule: true, SupportCaseNotes: () => null }));
jest.mock('@/components/message/CannedResponseManager', () => ({ __esModule: true, CannedResponseManager: () => null }));

const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/download', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));

const api = {
  getSupportCases: jest.fn<AnyFn>(),
  getSupportIncidentBalance: jest.fn<AnyFn>(),
  exportSupportCases: jest.fn<AnyFn>(),
  getSupportQueue: jest.fn<AnyFn>(),
  assignSupportCase: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

import SupportPage from '../pages/dashboard/support';
import SupportQueuePage from '../pages/dashboard/admin/support';

const kase = (n: number) => ({
  threadId: `t${n}`, displayNumber: n, status: 'open', severity: 'normal', level: 'support_standard',
  openedWithIncident: false, tenantContact: 'u1', createdAt: '2026-11-01T00:00:00Z',
});
const queueRow = (n: number) => ({
  threadId: `q${n}`, orgId: `org-${n}`, displayNumber: n, status: 'open', severity: 'normal', level: 'support_standard',
  assignedTo: null, waitingSeconds: 600, firstResponseAt: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  entitled = true;
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', organizationName: 'acme' }, can: () => true });
  api.getSupportCases.mockImplementation(async (page: { cursor?: string }) => (page.cursor === 'c2'
    ? { success: true, data: { cases: [kase(2)], hasMore: false } }
    : { success: true, data: { cases: [kase(1)], hasMore: true, nextCursor: 'c2' } }));
  api.getSupportIncidentBalance.mockResolvedValue({ success: true, data: { balance: 0, accountOrgId: 'root' } });
  api.exportSupportCases.mockResolvedValue({ blob: new Blob(['x']), truncated: false });
});

describe('support page — case paging', () => {
  it('"Load more" sends the server cursor back verbatim and appends the next page', async () => {
    render(<SupportPage />);
    expect(await screen.findByText('#1')).toBeInTheDocument();
    expect(api.getSupportCases).toHaveBeenCalledWith({});
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('#2')).toBeInTheDocument();
    expect(api.getSupportCases).toHaveBeenLastCalledWith({ cursor: 'c2' });
    expect(screen.getByText('#1')).toBeInTheDocument();
    // The last page said hasMore: false — no more button.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('a failed next page keeps the rows and offers a retry', async () => {
    render(<SupportPage />);
    await screen.findByText('#1');
    api.getSupportCases.mockRejectedValueOnce(new Error('page 2 failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('page 2 failed')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
  });

  it('no button on a single page', async () => {
    api.getSupportCases.mockResolvedValue({ success: true, data: { cases: [kase(1)], hasMore: false } });
    render(<SupportPage />);
    await screen.findByText('#1');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('support page — export', () => {
  it('downloads through the client and says nothing when the file is complete', async () => {
    render(<SupportPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export cases (CSV)' }));
    await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalledWith(expect.any(Blob), 'support-cases.csv'));
    expect(screen.queryByText(/stopped at its row limit/)).not.toBeInTheDocument();
  });

  it('says so when the server truncated the export', async () => {
    api.exportSupportCases.mockResolvedValue({ blob: new Blob(['x']), truncated: true });
    render(<SupportPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export cases (CSV)' }));
    expect(await screen.findByText(/stopped at its row limit/)).toBeInTheDocument();
    expect(triggerBlobDownload).toHaveBeenCalled();
  });

  it('shows a failed export', async () => {
    api.exportSupportCases.mockRejectedValue(new Error('Export failed'));
    render(<SupportPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export cases (CSV)' }));
    expect(await screen.findByText('Export failed')).toBeInTheDocument();
    expect(triggerBlobDownload).not.toHaveBeenCalled();
  });
});

describe('support page — one-time incident balance', () => {
  it('is hidden at 0', async () => {
    render(<SupportPage />);
    await screen.findByText('#1');
    await waitFor(() => expect(api.getSupportIncidentBalance).toHaveBeenCalled());
    expect(screen.queryByTestId('incident-balance')).not.toBeInTheDocument();
  });

  it('shows the balance, promising no response target', async () => {
    api.getSupportIncidentBalance.mockResolvedValue({ success: true, data: { balance: 2, accountOrgId: 'root' } });
    render(<SupportPage />);
    expect(await screen.findByTestId('incident-balance')).toHaveTextContent('2 one-time support incidents available');
    expect(screen.getByText(/no stated response target/)).toBeInTheDocument();
  });

  it('shows it on the LOCKED page too — an incident is the door for an org with no add-on', async () => {
    entitled = false;
    api.getSupportIncidentBalance.mockResolvedValue({ success: true, data: { balance: 1, accountOrgId: 'root' } });
    render(<SupportPage />);
    expect(await screen.findByTestId('incident-balance')).toHaveTextContent('1 one-time support incident available');
    expect(screen.getByText('upsell')).toBeInTheDocument();
    expect(screen.getByText(/opens a case with one, without a support add-on/)).toBeInTheDocument();
  });

  it('an unreadable balance (503) says so quietly and leaves the cases', async () => {
    api.getSupportIncidentBalance.mockRejectedValue(new Error('Could not resolve the organization\'s account; try again'));
    render(<SupportPage />);
    expect(await screen.findByText(/incident balance could not be read/)).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
  });
});

describe('staff support queue — paging', () => {
  beforeEach(() => {
    api.getSupportQueue.mockImplementation(async (page: { cursor?: string }) => (page.cursor === 'q-next'
      ? { success: true, data: { cases: [queueRow(8)], hasMore: false } }
      : { success: true, data: { cases: [queueRow(7)], hasMore: true, nextCursor: 'q-next' } }));
    api.assignSupportCase.mockResolvedValue({ success: true });
  });

  it('appends the next page with the cursor', async () => {
    render(<SupportQueuePage />);
    expect(await screen.findByText('#7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('#8')).toBeInTheDocument();
    expect(api.getSupportQueue).toHaveBeenLastCalledWith({ cursor: 'q-next' });
  });

  it('an action re-reads the FIRST page and drops the appended rows (the queue order moved)', async () => {
    render(<SupportQueuePage />);
    await screen.findByText('#7');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('#8');
    fireEvent.click(screen.getAllByRole('button', { name: 'Take case' })[0]);
    await waitFor(() => expect(api.assignSupportCase).toHaveBeenCalledWith('q7', 'me'));
    await waitFor(() => expect(screen.queryByText('#8')).not.toBeInTheDocument());
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});

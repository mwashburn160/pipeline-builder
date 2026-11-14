// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Share links on a published report: revoking one (a link already sent to an
 * executive) asks first; and the one-time raw token belongs to the run it was
 * minted for — switching runs must not leave it on screen with a Copy button.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

const listReportShareLinks = jest.fn<AnyFn>();
const createReportShareLink = jest.fn<AnyFn>();
const revokeReportShareLink = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOwnQuotas: async () => ({ success: true, data: { quota: { quotas: {} } } }),
    getOrgAIConfig: async () => ({ data: { providers: {}, aiEnabled: true } }),
    listReportShareLinks: (...a: unknown[]) => listReportShareLinks(...a),
    createReportShareLink: (...a: unknown[]) => createReportShareLink(...a),
    revokeReportShareLink: (...a: unknown[]) => revokeReportShareLink(...a),
  },
}));

import { ReportReview } from '@/components/reports/stakeholder/ReportReview';

const run = (id: string) => ({
  id, status: 'published', version: 1, periodLabel: 'October 2026',
  periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-10-31T00:00:00.000Z',
  leadNotes: '', snapshot: { sections: [], notes: [] },
}) as never;
const link = { id: 'l1', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, viewCount: 3, redactNames: false };

beforeEach(() => {
  jest.clearAllMocks();
  listReportShareLinks.mockResolvedValue({ success: true, data: { links: [link] } });
  createReportShareLink.mockResolvedValue({ success: true, data: { token: 'tok-for-A', notice: 'Shown once.' } });
  revokeReportShareLink.mockResolvedValue({ success: true });
});

const review = (id: string) => <ReportReview run={run(id)} canAuthor={false} canShare externalSharing onChanged={jest.fn<AnyFn>()} />;

describe('ShareLinks', () => {
  it('asks before revoking a live link, and Cancel revokes nothing', async () => {
    render(review('A'));
    fireEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('3 views so far');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(revokeReportShareLink).not.toHaveBeenCalled();
  });

  it('revokes on confirm and re-reads the links', async () => {
    render(review('A'));
    fireEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke link' }));
    await waitFor(() => expect(revokeReportShareLink).toHaveBeenCalledWith('l1'));
    await waitFor(() => expect(listReportShareLinks).toHaveBeenCalledTimes(2));
  });

  it('drops the minted token when the review moves to another run', async () => {
    const { rerender } = render(review('A'));
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('tok-for-A')).toBeInTheDocument();
    rerender(review('B'));
    await waitFor(() => expect(listReportShareLinks).toHaveBeenLastCalledWith('B', expect.anything()));
    expect(screen.queryByText('tok-for-A')).not.toBeInTheDocument();
  });
});

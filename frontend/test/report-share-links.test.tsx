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
  createReportShareLink.mockResolvedValue({ success: true, data: { token: 'tok-for-A', url: 'https://pb.example/reports/shared?token=tok-for-A', notice: 'Shown once.' } });
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

  it('shows the full share URL (not a bare token), and drops it when the review moves to another run', async () => {
    const { rerender } = render(review('A'));
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('https://pb.example/reports/shared?token=tok-for-A')).toBeInTheDocument();
    rerender(review('B'));
    await waitFor(() => expect(listReportShareLinks).toHaveBeenLastCalledWith('B', expect.anything()));
    expect(screen.queryByText('https://pb.example/reports/shared?token=tok-for-A')).not.toBeInTheDocument();
  });
});

describe('Share-link redaction copy', () => {
  // Redaction hides error messages as well as names; copy that said "names" alone
  // told the lead a redacted link still carried the raw error text.
  it('the checkbox says names AND error messages are hidden', async () => {
    render(review('A'));
    expect(await screen.findByText(/hide pipeline and project names and error messages/i)).toBeInTheDocument();
  });

  it('a redacted link is badged as hiding names and error messages', async () => {
    listReportShareLinks.mockResolvedValue({ success: true, data: { links: [{ ...link, redactNames: true }] } });
    render(review('A'));
    expect(await screen.findByText(/names and error messages hidden/i)).toBeInTheDocument();
  });
});

describe('Publish with an unsaved summary', () => {
  // Publishing sends the STORED summary — the publish route takes no body — so
  // an edit still in the box must be saved first, or recipients get the old one.
  const draft = { ...(run('A') as object), status: 'ready_for_review', leadNotes: 'Saved summary' } as never;

  it('holds Publish until the edited summary is saved', async () => {
    render(<ReportReview run={draft} canAuthor canShare externalSharing onChanged={jest.fn<AnyFn>()} />);
    const publish = await screen.findByRole('button', { name: 'Publish' });
    expect(publish).not.toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited, not saved' } });
    expect(publish).toBeDisabled();
    expect(screen.getByText(/save the summary before publishing/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Saved summary' } });
    expect(publish).not.toBeDisabled();
  });
});
